// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Outbox } from '../src/outbox.mjs';
import { text as QueueText } from '../src/outbox-text.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Inbox } from '../src/inbox.mjs';
import { BotUi, LABELS } from '../src/ui.mjs';
import { AttachmentStore } from '../src/attachments.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], sent = [], ipc = new EventEmitter();
  ipc.request = async (method, params, owner) => { calls.push({ method, params, owner }); return {}; };
  ipc.owner = async () => 'desktop'; ipc.follow = async () => {}; ipc.close = () => {};
  const tg = { async send(chat, value, markup) { sent.push({ text: value.text || value, markup }); return { message_id: sent.length }; } };
  const bridge = new Bridge(tg, 1, ipc), file = path.join(root, 'outbox.json');
  bridge.outbox = new Outbox(file);
  const w = { id: randomUUID(), title: 'Original chat', owner: 'desktop', synced: true, state: { turns: [{ id: randomUUID(), status: 'inProgress', items: [] }], threadRuntimeStatus: { type: 'active' } } };
  bridge.selected = w; bridge.watched.set(w.id, w);
  const inbox = new Inbox(bridge, { root: path.join(root, 'inbox') }), ui = new BotUi(bridge, inbox);
  return { root, file, bridge, w, calls, sent, ipc, inbox, ui };
}
function finish(w) { w.state.turns.at(-1).status = 'completed'; w.state.threadRuntimeStatus.type = 'idle'; }
function begin(w, entry, status = 'inProgress') {
  w.state.turns.push({ id: randomUUID(), status, items: [{ type: 'userMessage', clientId: entry.clientId }] });
  w.state.threadRuntimeStatus.type = status === 'inProgress' ? 'active' : 'idle';
}

test('busy messages persist in FIFO and wait for their own observed completion before the next dispatch', async t => {
  const f = await fixture(t);
  await f.ui.message({ text: 'First request' }); await f.ui.message({ text: 'Second request' });
  assert.equal(f.calls.length, 0); assert.equal(f.bridge.outbox.entries.length, 2);
  assert.equal(JSON.parse(await readFile(f.file)).entries[0].input[0].text, 'First request');
  finish(f.w); await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
  const first = f.bridge.outbox.entries[0]; assert.equal(first.status, 'awaiting');
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1); // Old idle snapshot is not completion.
  f.w.state.turns.push({ id: randomUUID(), status: 'completed', items: [] });
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1); // Unrelated turn is not completion.
  begin(f.w, first); await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
  finish(f.w); await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].params.turnStart.request.input[0].text, 'Second request');
  assert.equal(f.calls[1].params.conversationId, f.w.id);
  begin(f.w, f.bridge.outbox.entries[0], 'completed'); await f.bridge.outbox.flush(f.bridge);
  assert.equal(f.bridge.outbox.entries.length, 0);
});

test('changing the active chat does not redirect queued work, and offline owners never dispatch', async t => {
  const f = await fixture(t); await f.bridge.text('Original request');
  const second = { ...f.w, id: randomUUID(), title: 'Other', state: { turns: [], threadRuntimeStatus: { type: 'idle' } } };
  f.bridge.selected = second; f.bridge.watched.set(second.id, second);
  finish(f.w); f.w.synced = false; await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 0);
  f.w.synced = true; f.w.owner = null; await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 0);
  f.w.owner = 'desktop'; await f.bridge.outbox.flush(f.bridge);
  assert.equal(f.calls[0].params.conversationId, f.w.id); assert.equal(f.bridge.selected, second);
});

test('restart restores waiting messages, never replays accepted or ambiguous dispatches and reattaches their chats', async t => {
  const f = await fixture(t); await f.bridge.text('Persist me');
  f.bridge.outbox = new Outbox(f.file); f.bridge.watched.clear(); f.bridge.selected = null;
  await f.bridge.outbox.follow(f.bridge); assert.equal(f.bridge.selected, null);
  const watched = f.bridge.watched.get(f.w.id); assert.equal(watched.synced, false);
  watched.state = f.w.state; watched.synced = true; finish(watched);
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
  f.bridge.outbox = new Outbox(f.file); await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
  begin(watched, f.bridge.outbox.entries[0], 'completed'); await f.bridge.outbox.flush(f.bridge); assert.equal(f.bridge.outbox.entries.length, 0);
  const entry = f.bridge.outbox.enqueue(watched, [{ type: 'text', text: 'Uncertain' }], randomUUID());
  entry.status = 'dispatching'; f.bridge.outbox.save(); f.bridge.outbox = new Outbox(f.file);
  assert.equal(f.bridge.outbox.entries[0].status, 'uncertain'); await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
});

test('an ambiguous RPC freezes only its conversation and removal cannot cancel already accepted work', async t => {
  const f = await fixture(t); await f.bridge.text('Uncertain request'); await f.bridge.text('Waiting behind it'); finish(f.w);
  const request = f.ipc.request; f.ipc.request = async (...args) => { await request(...args); throw Error('Connection lost'); };
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.bridge.outbox.entries[0].status, 'uncertain');
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 1);
  const second = { ...f.w, id: randomUUID(), state: { turns: [], threadRuntimeStatus: { type: 'idle' } } };
  f.bridge.watched.set(second.id, second); f.ipc.request = request;
  const accepted = f.bridge.outbox.enqueue(second, [{ type: 'text', text: 'Independent' }], randomUUID());
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 2);
  await assert.rejects(f.bridge.outbox.callback(`o:${accepted.id}:cancel`, f.bridge));
  const ambiguous = f.bridge.outbox.entries[0]; await f.bridge.outbox.callback(`o:${ambiguous.id}:cancel`, f.bridge);
  await f.bridge.outbox.flush(f.bridge); assert.equal(f.calls.length, 3);
  await assert.rejects(f.bridge.outbox.callback(`o:${ambiguous.id}:cancel`, f.bridge));
});

test('same submission ID deduplicates and concurrent sends cannot leapfrog an in-flight dispatch', async t => {
  const f = await fixture(t); finish(f.w);
  let release; f.ipc.request = async (method, params) => { f.calls.push({ method, params }); await new Promise(resolve => release = resolve); };
  const clientId = randomUUID(), first = f.bridge.sendInput([{ type: 'text', text: 'First' }], f.w.id, clientId);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const next = await f.bridge.sendInput([{ type: 'text', text: 'Second' }]); assert.equal(next.queued, true);
  assert.equal(f.bridge.outbox.enqueue(f.w, [{ type: 'text', text: 'Duplicate' }], clientId), f.bridge.outbox.entries[0]);
  release(); await first; assert.equal(f.calls.length, 1); assert.equal(f.bridge.outbox.entries.length, 2);
});

test('grouped attachments stay usable after local draft cleanup and queue rejection leaves the draft retryable', async t => {
  const f = await fixture(t), bytes = Buffer.from('original file');
  const store = new AttachmentStore(path.join(f.root, 'windows')); f.inbox.transfer = (meta, source) => store.uploadFile(meta, source);
  f.inbox.begin(); const draft = f.inbox.current, cachePath = path.join(f.root, 'inbox', draft.id, 'file.txt');
  await mkdir(path.dirname(cachePath)); await writeFile(cachePath, bytes);
  draft.items = [{ messageId: 1, text: 'First forwarded message', forwarded: true }, { messageId: 2, text: 'File caption', attachment: { id: randomUUID(), name: 'file.txt', cachePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }];
  f.inbox.save(); await f.inbox.send('Together'); assert.equal(f.calls.length, 0); assert.equal(f.inbox.current, null);
  const input = f.bridge.outbox.entries[0].input;
  const transferredPath = JSON.parse(input[0].text.match(/"[^"\n]+file\.txt"/)[0]);
  assert.deepEqual(await readFile(transferredPath), bytes); await assert.rejects(readFile(cachePath));
  finish(f.w); await f.bridge.outbox.flush(f.bridge); assert.deepEqual(f.calls[0].params.turnStart.request.input, input);
  f.inbox.begin(); f.inbox.current.items.push({ messageId: 3, text: 'Retryable' });
  f.bridge.outbox.enqueue = () => { throw Error('Queue full'); };
  await assert.rejects(f.inbox.send(), /Queue full/); assert.equal(f.inbox.current.status, 'ready'); assert.equal(f.calls.length, 1);
});

test('all queue pages are reachable; menu buttons preserve groups and steering bypasses the queue', async t => {
  const f = await fixture(t);
  f.inbox.begin(); const draft = f.inbox.current;
  for (let i = 0; i < 12; i++) f.bridge.outbox.enqueue(f.w, [{ type: 'text', text: 'Request ' + i }], randomUUID());
  await f.ui.message({ text: LABELS.queue }); assert.equal(f.inbox.current, draft);
  const next = f.sent.at(-1).markup.inline_keyboard[0][0]; assert.equal(next.callback_data, 'o:page:5');
  await f.bridge.outbox.callback(next.callback_data, f.bridge);
  await f.bridge.outbox.callback('o:page:10', f.bridge); assert.ok(f.sent.some(s => s.text.includes('Request 11')));
  await f.ui.message({ text: '/steer Guide now' }); assert.equal(f.calls.at(-1).method, 'thread-follower-steer-turn'); assert.equal(f.bridge.outbox.entries.length, 12);
  await f.ui.message({ text: LABELS.bundle }); assert.equal(f.inbox.current, draft); assert.equal(draft.items.length, 0);
  await f.ui.message({ text: LABELS.bundle, message_id: 123, forward_origin: { type: 'hidden_user' } }); assert.equal(draft.items.length, 1);
});

test('capacity and size limits reject before dispatch, and an unrelated idle watcher can yield its slot on restart', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.sendInput([{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }]), error => error.notDispatched === true);
  assert.equal(f.calls.length, 0); assert.equal(f.bridge.outbox.entries.length, 0);
  f.bridge.outbox.enqueue(f.w, [{ type: 'text', text: 'Retained' }], randomUUID()); f.bridge.watched.delete(f.w.id); f.bridge.selected = null;
  for (let i = 0; i < 8; i++) { const id = randomUUID(); f.bridge.watched.set(id, { id, owner: 'desktop', state: { turns: [] } }); }
  await f.bridge.outbox.follow(f.bridge); assert.ok(f.bridge.watched.has(f.w.id)); assert.equal(f.bridge.watched.size, 8);
});

test('status and queue receipts count only waiting requests, scoped to the original chat and the whole queue', async t => {
  const f = await fixture(t), other = {...f.w,id:randomUUID(),title:'Other chat'};
  const bundle = f.bridge.outbox.enqueue(f.w,[{type:'text',text:'One'},{type:'text',text:'Two'},{type:'image',url:'fixture'}],randomUUID());
  const queued = f.bridge.outbox.enqueue(f.w,[{type:'text',text:'Next'}],randomUUID());
  f.bridge.outbox.enqueue(other,[{type:'text',text:'Elsewhere'}],randomUUID());
  for(const status of ['awaiting','dispatching','uncertain']) {
    const entry = f.bridge.outbox.enqueue(f.w,[{type:'text',text:status}],randomUUID());entry.status=status;
  }
  f.bridge.outbox.save();
  assert.equal(f.bridge.outbox.count(f.w.id),2);assert.equal(f.bridge.outbox.count(),3);
  await f.ui.callback('u:status');assert.ok(f.sent.at(-1).text.includes(QueueText.chatCount+': 2'));assert.ok(f.sent.at(-1).text.includes(QueueText.totalCount+': 3'));
  await f.bridge.outbox.notice(f.bridge,bundle);assert.ok(f.sent.at(-1).text.includes(QueueText.chatCount+': 2'));
  await f.ui.home();assert.match(f.sent.at(-1).text,/⏳[^\n]*: 3/);
  f.bridge.selected=other;await f.ui.callback('u:status');assert.ok(f.sent.at(-1).text.includes(QueueText.chatCount+': 1'));assert.ok(f.sent.at(-1).text.includes(QueueText.totalCount+': 3'));
  await f.bridge.outbox.callback(`o:${queued.id}:cancel`,f.bridge);assert.equal(f.bridge.outbox.count(f.w.id),1);assert.equal(f.bridge.outbox.count(),2);
  bundle.status='awaiting';f.bridge.outbox.save();assert.equal(f.bridge.outbox.count(f.w.id),0);
  const restored = new Outbox(f.file);assert.equal(restored.count(),1);assert.equal(restored.count(f.w.id),0);assert.equal(f.calls.length,0);
});
