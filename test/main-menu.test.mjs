// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Inbox } from '../src/inbox.mjs';
import { BotUi, LABELS } from '../src/ui.mjs';
import { Outbox } from '../src/outbox.mjs';
import { dispatchCallback } from '../src/callback-dispatch.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-mainmenu-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [], reads = [], ipc = new EventEmitter(), row = { id: randomUUID(), title: 'Other conversation' };
  const tg = { async send(chat, value, markup) { sent.push({ text: value.text || value, markup }); return { message_id: sent.length }; }, async call() { throw Error('Expired query'); } };
  ipc.close = () => {};
  ipc.projects = async () => { reads.push('projects'); return [{ id: randomUUID(), name: 'Fixture project' }]; };
  ipc.models = async () => { reads.push('models'); return [{ model: 'fixture-model', displayName: 'Fixture model' }]; };
  ipc.request = async method => { assert.equal(method, 'thread-follower-read-model-settings'); reads.push(method); return { settings: { model: 'fixture-model' } }; };
  ipc.latestMessage = async id => { assert.equal(id, row.id); reads.push('latest'); return { role: 'Codex', text: 'Latest for the other conversation' }; };
  ipc.compatibilityRead = async () => { reads.push('compatibility'); return { status: 'compatible', version: 'fixture', incompatible: [] }; };
  ipc.transcriptionStatus = async () => ({ ready: true });
  const bridge = new Bridge(tg, 1, ipc, async () => { reads.push('catalog'); return [row]; });
  const w = { id: randomUUID(), title: 'Active conversation', owner: 'desktop', synced: true, state: { turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } } };
  bridge.selected = w; bridge.watched.set(w.id, w); bridge.outbox = new Outbox(path.join(root, 'outbox.json'));
  const inbox = new Inbox(bridge, { root: path.join(root, 'inbox') }), ui = new BotUi(bridge, inbox);
  ui.quota.show = async () => tg.send(1, 'Fixture quota screen');
  ui.accounts.show = async () => tg.send(1, 'Fixture account screen');
  return { sent, reads, bridge, w, ui, inbox, tg, row };
}

test('all ways of opening main menu attach action buttons even with the reply keyboard hidden', async t => {
  const f = await fixture(t);
  for (const open of [() => f.ui.message({ text: '/menu' }), () => f.ui.message({ text: LABELS.home }), () => dispatchCallback({ id: 'expired', data: 'u:home' }, f.tg, f.ui, f.inbox, f.bridge)]) {
    f.sent.length = 0; await open(); assert.equal(f.sent.length, 1);
    const keyboard = f.sent[0].markup;
    assert.equal(keyboard.keyboard, undefined);
    const actions = keyboard.inline_keyboard.flat().map(b => b.callback_data);
    for (const action of ['chats', 'search', 'last-list', 'newchat', 'projects', 'newproject', 'models', 'compat', 'status', 'history', 'bundle', 'questions', 'queue', 'usage', 'accounts', 'help', 'premium']) assert.ok(actions.includes('u:' + action), action);
    assert.equal(new Set(actions).size, actions.length);
    assert.ok(actions.every(data => Buffer.byteLength(data) <= 64));
    assert.equal(f.bridge.selected, f.w); assert.equal(f.reads.length, 0);
  }
});

test('main menu actions open their own screens without selecting a chat or submitting model input', async t => {
  const f = await fixture(t); await f.ui.home(); const homeText = f.sent.at(-1).text;
  const buttons = f.sent.at(-1).markup.inline_keyboard.flat();
  for (const button of buttons) {
    await dispatchCallback({ id: 'expired', data: button.callback_data }, f.tg, f.ui, f.inbox, f.bridge);
    assert.notEqual(f.sent.at(-1).text, homeText, button.callback_data);
    assert.equal(f.bridge.selected, f.w);
  }
  assert.ok(f.reads.includes('catalog')); assert.ok(f.reads.includes('projects'));
  assert.ok(f.reads.includes('models')); assert.ok(f.reads.includes('compatibility'));
  await f.ui.callback('u:last-list'); const other = f.sent.at(-1).markup.inline_keyboard[0][0];
  await f.ui.features.callback(other.callback_data); assert.ok(f.sent.at(-1).text.includes('Latest for the other conversation'));
  assert.equal(f.bridge.selected, f.w);
});

test('updated menu installs quick access separately and returning home cancels input but preserves collected messages', async t => {
  const f = await fixture(t); await f.ui.home(true);
  assert.equal(f.sent[0].markup.is_persistent, true); assert.ok(f.sent[1].markup.inline_keyboard.length);
  await f.ui.callback('u:newproject'); assert.equal(f.ui.features.input.kind, 'project');
  const prompt = f.ui.features.input;
  f.inbox.begin(); await f.inbox.message({ message_id: 1, text: 'Collected content' }); const draft = f.inbox.current;
  await f.ui.callback('u:home'); assert.equal(prompt.used, true); assert.equal(f.ui.features.input, null);
  assert.equal(f.inbox.current, draft); assert.equal(draft.items[0].text, 'Collected content');
  await f.ui.callback('u:queue'); assert.equal(f.inbox.current, draft); assert.equal(draft.items.length, 1);
  await assert.rejects(f.ui.callback('u:unknown-action'));
});
