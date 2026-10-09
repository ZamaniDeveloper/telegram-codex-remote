// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.mjs';
import { Inbox } from '../src/inbox.mjs';
import { BotUi, LABELS, chatKeyboard } from '../src/ui.mjs';
import { dispatchCallback } from '../src/callback-dispatch.mjs';
import { readLatestMessage, messageFromItem } from '../src/latest-message.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-nav-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [], calls = [], rows = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), title: 'Chat ' + i }));
  const ipc = new EventEmitter(); ipc.close = () => {};
  ipc.latestMessage = async id => { calls.push(id); return { role: 'Codex', text: 'Latest for ' + id }; };
  ipc.createChat = async () => { throw Error('Navigation must not create a chat'); };
  const tg = { async send(chat, value, markup) { sent.push({ text: value.text || value, markup }); return { message_id: sent.length }; }, async call() { throw Error('Query is too old'); } };
  const bridge = new Bridge(tg, 1, ipc, async (search, limit, offset = 0) => rows.slice(offset, offset + limit));
  bridge.selected = { id: randomUUID(), title: 'Active', synced: true };
  const inbox = new Inbox(bridge, { root }), ui = new BotUi(bridge, inbox);
  return { ui, bridge, inbox, tg, ipc, sent, calls, rows };
}

test('main menu overrides creation ForceReply, retires its prompt and preserves a bundle', async t => {
  const f = await fixture(t); f.inbox.begin(); const bundle = f.inbox.current;
  await f.ui.features.prompt('chat', { projectId: randomUUID() }); const promptId = f.sent.length;
  await f.ui.message({ text: LABELS.home, reply_to_message: { message_id: promptId } });
  assert.equal(f.ui.features.input, null); assert.ok(f.sent.at(-1).markup.inline_keyboard.flat().some(b => b.callback_data === 'u:chats'));
  assert.equal(f.inbox.current, bundle); assert.equal(bundle.items.length, 0);
  await assert.rejects(f.ui.message({ text: 'Old title', reply_to_message: { message_id: promptId } }));
  for (const text of ['/menu', '/home@ExampleBot']) {
    await f.ui.features.prompt('project'); await f.ui.message({ text });
    assert.equal(f.ui.features.input, null); assert.ok(f.sent.at(-1).markup.inline_keyboard.flat().some(b => b.callback_data === 'u:chats'));
  }
  assert.equal(f.calls.length, 0);
});

test('inline main menu works after expired callback acknowledgement and cancels search Reply', async t => {
  const f = await fixture(t); await f.ui.prompt('search'); const promptId = f.sent.length;
  await dispatchCallback({ id: 'expired', data: 'u:home' }, f.tg, f.ui, f.inbox, f.bridge);
  assert.ok(f.sent.at(-1).markup.inline_keyboard.flat().some(b => b.callback_data === 'u:chats')); assert.equal(f.ui.input, null);
  await assert.rejects(f.ui.message({ text: 'Old search', reply_to_message: { message_id: promptId } }));
  let executions = 0;
  await assert.rejects(dispatchCallback({ id: 'expired', data: 'u:home' }, f.tg, { callback() { executions++; throw Error('action failure'); } }, {}, {}), /action failure/);
  assert.equal(executions, 1);
});

test('latest picker pages through every chat and reads a closed chat without selecting it', async t => {
  const f = await fixture(t), selected = f.bridge.selected;
  await f.ui.features.route('last'); const first = f.sent.at(-1).markup.inline_keyboard;
  assert.equal(first.length, 10);
  await f.ui.features.callback(first[8][0].callback_data);
  const second = f.sent.at(-1).markup.inline_keyboard;
  assert.equal(second[0][0].text, 'Chat 8');
  const read = second[0][0].callback_data; await f.ui.features.callback(read);
  assert.deepEqual(f.calls, [f.rows[8].id]); assert.match(f.sent.at(-1).text, /Chat 8/);
  assert.ok(f.sent.at(-1).text.includes('Latest for ' + f.rows[8].id));
  assert.equal(f.bridge.selected, selected); assert.equal(f.bridge.watched.size, 0);
  await assert.rejects(f.ui.features.callback(read)); assert.equal(f.calls.length, 1);
  await f.ui.route('chats'); const shortcut = f.sent.at(-1).markup.inline_keyboard[0][1];
  await f.ui.features.callback(shortcut.callback_data); assert.equal(f.calls.at(-1), f.rows[0].id);
  assert.equal(f.bridge.selected, selected);
});

test('chat-menu latest message stays bound to its conversation after the active chat changes', async t => {
  const f = await fixture(t), original = f.bridge.selected;
  f.bridge.watched.set(original.id, original);
  const latest = chatKeyboard(original.id).inline_keyboard.flat().find(b => b.callback_data.startsWith('u:last:'));
  assert.ok(latest); assert.ok(Buffer.byteLength(latest.callback_data) <= 64);
  f.bridge.selected = { id: randomUUID(), title: 'Other active chat' };
  f.inbox.begin(); const bundle = f.inbox.current;
  await f.ui.callback(latest.callback_data);
  assert.deepEqual(f.calls, [original.id]); assert.equal(f.inbox.current, bundle);
  assert.equal(f.bridge.selected.title, 'Other active chat'); assert.ok(f.sent.at(-1).text.includes(original.title));
  await f.ui.callback('u:last'); assert.equal(f.calls.at(-1), f.bridge.selected.id);
  await assert.rejects(f.ui.callback('u:last:invalid-id'));
});

test('descending persisted history skips tools, pages and returns the newest user message', async () => {
  const id = randomUUID(), calls = [], rpc = { async request(method, params) {
    calls.push({ method, params });
    return params.cursor ? { data: [{ item: { type: 'userMessage', content: [{ type: 'text', text: 'Newest' }] } }, { item: { type: 'agentMessage', text: 'Older' } }] } : { data: [{ item: { type: 'commandExecution' } }], nextCursor: 'page2' };
  } };
  assert.deepEqual(await readLatestMessage(rpc, id), { role: 'User', text: 'Newest' });
  assert.ok(calls.every(c => c.method === 'thread/items/list' && c.params.sortDirection === 'desc' && c.params.threadId === id));
  await assert.rejects(readLatestMessage(rpc, '../sessions'), /Invalid thread/); assert.equal(calls.length, 2);
  assert.equal(await readLatestMessage({ request: async () => ({ data: [] }) }, id), null);
  await assert.rejects(readLatestMessage({ request: async () => ({ data: [{}] }) }, id), /schema/);
  await assert.rejects(readLatestMessage({ request: async () => ({ data: [], nextCursor: 'same' }) }, id), /repeated/);
  assert.deepEqual(messageFromItem({ type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: 'Guide' }] }), { role: 'User', text: 'Guide' });
  assert.equal(messageFromItem({ type: 'steeringUserMessage', status: 'rejected', text: 'Rejected' }), null);
});

test('remote latest-message request remains authenticated and returns only its scoped result', async t => {
  const id = randomUUID(), secret = 'fixture-secret-'.repeat(4), ipc = new EventEmitter(); ipc.close = () => {};
  const server = createConnector({ secret, ipc, control: { latestMessage: requested => readLatestMessage({ request: async () => ({ data: [{ item: { type: 'agentMessage', text: 'Remote latest' } }] }) }, requested) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.shutdown());
  const url = 'http://127.0.0.1:' + server.address().port, remote = new RemoteDesktop(url, secret);
  assert.deepEqual(await remote.latestMessage(id), { role: 'Codex', text: 'Remote latest' });
  await assert.rejects(remote.latestMessage('bad'), /Invalid thread/);
  await assert.rejects(remote.rpc('thread/items/list', [id]), /not allowed/);
  assert.equal((await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ method: 'latestMessage', args: [id] }) })).status, 403);
});
