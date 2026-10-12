// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CommandReceipts, EventJournal } from '../src/reliability.mjs';
import { DeliveryState } from '../src/delivery-state.mjs';
import { LiveStream } from '../src/live-stream.mjs';
import { applyPatches } from '../src/state.mjs';
import { maintenanceScheduler } from '../src/maintenance.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
import { Outbox } from '../src/outbox.mjs';
import { Bridge } from '../src/bridge.mjs';

async function directory(t) { const root = await mkdtemp(path.join(tmpdir(), 'telecodex-reliable-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const secret = 'test-reliability-secret-'.repeat(3);

test('durable receipts reject concurrent, conflicting and interrupted replays across restart', async t => {
  const root = await directory(t), file = path.join(root, 'receipts.sqlite'), id = randomUUID();
  let ledger = new CommandReceipts(file), calls = 0, finish;
  const pending = ledger.execute(id, 'request', ['start'], async () => { calls++; return await new Promise(r => finish = r); });
  await assert.rejects(ledger.execute(id, 'request', ['start'], () => calls++), /uncertain/);
  await assert.rejects(ledger.execute(id, 'request', ['different'], () => calls++), /conflicts/);
  finish({ turn: { id: 'accepted' } }); await pending; ledger.close();
  ledger = new CommandReceipts(file);
  assert.deepEqual(await ledger.execute(id, 'request', ['start'], () => calls++), { turn: { id: 'accepted' } });
  const interrupted = randomUUID();
  await assert.rejects(ledger.execute(interrupted, 'request', [], () => { throw Error('Disconnected after write'); }));
  ledger.close(); ledger = new CommandReceipts(file);
  await assert.rejects(ledger.execute(interrupted, 'request', [], () => calls++), /uncertain/);
  assert.equal(calls, 1); ledger.close();
});

test('event journal bounds retention and rejects stale, future and previous-process cursors', () => {
  const journal = new EventJournal({ maxEntries: 2 });
  journal.append({ n: 1 }); journal.append({ n: 2 }); journal.append({ n: 3 });
  assert.equal(journal.replay(`${journal.session}:0`), null);
  assert.equal(journal.replay(`${journal.session}:1`).length, 2);
  assert.deepEqual(journal.replay(`${journal.session}:3`), []);
  assert.equal(journal.replay(`${journal.session}:4`), null);
  assert.equal(journal.replay(`${randomUUID()}:2`), null);
  const bounded = new EventJournal({ maxBytes: 1 }); bounded.append({ payload: 'large' });
  assert.equal(bounded.bytes, 0); assert.equal(bounded.replay(`${bounded.session}:0`), null);
});

test('compact deltas preserve the exact mirror while reducing a small edit in long history by over 95 percent', () => {
  const relay = new LiveStream({ delta: true });
  const message = change => ({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: 'A', change } });
  const state = { requests: [], turns: Array.from({ length: 100 }, (_, i) => ({ id: String(i), status: 'completed', items: [{ type: 'agentMessage', text: 'History '.repeat(500) }] })) };
  let mirror = relay.project(message({ type: 'snapshot', revision: 1, conversationState: state })).params.change.conversationState;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(mirror));
  const delta = relay.project(message({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns', 99, 'items', 0, 'text'], value: 'Live update' }] })).params.change;
  assert.equal(delta.type, 'patches'); assert.equal(delta.baseRevision, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < snapshotBytes * 0.05);
  mirror = applyPatches(mirror, delta.patches);
  assert.equal(mirror.turns[99].items[0].text, 'Live update'); assert.equal(mirror.turns[0].items[0].text, state.turns[0].items[0].text);
  const inserted = relay.project(message({ type: 'patches', baseRevision: 2, revision: 3, patches: [{ op: 'add', path: ['turns', 99, 'items', 0], value: { type: 'mcpToolCall', result: 'hidden' } }, { op: 'replace', path: ['turns', 99, 'status'], value: 'interrupted' }] })).params.change;
  mirror = inserted.type === 'snapshot' ? inserted.conversationState : applyPatches(mirror, inserted.patches);
  assert.equal(mirror.turns[99].status, 'interrupted'); assert.equal(mirror.turns[99].items.length, 1);
});

async function transport(t, journal = new EventJournal()) {
  const ipc = new EventEmitter(); ipc.connect = async () => {}; ipc.close = () => {}; ipc.owner = async () => 'desktop'; ipc.follow = () => {};
  let calls = 0; ipc.request = async () => { calls++; return { resultType: 'success', result: { turn: { id: randomUUID() } } }; };
  const server = createConnector({ secret, ipc, journal }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`, remote = new RemoteDesktop(url, secret);
  t.after(async () => { remote.close(); await server.shutdown(); });
  return { ipc, remote, url, server, calls: () => calls };
}

test('real HTTP/SSE transport replays missed events in order and resets an expired cursor', async t => {
  const f = await transport(t, new EventJournal({ maxEntries: 2 })); await f.remote.connect();
  let event = once(f.remote, 'broadcast'); f.ipc.emit('broadcast', { method: 'first' }); await event;
  const dropped = once(f.remote, 'disconnected'); f.remote.abort.abort(); await dropped;
  f.ipc.emit('broadcast', { method: 'second' }); f.ipc.emit('broadcast', { method: 'third' });
  const received = []; f.remote.on('broadcast', m => received.push(m.method));
  event = new Promise(resolve => { const listener = () => { if (received.length === 2) { f.remote.off('broadcast', listener); resolve(); } }; f.remote.on('broadcast', listener); });
  await f.remote.connect(); await event; assert.deepEqual(received, ['second', 'third']);
  const droppedAgain = once(f.remote, 'disconnected'); f.remote.abort.abort(); await droppedAgain;
  f.ipc.emit('broadcast', { method: 'fourth' }); f.ipc.emit('broadcast', { method: 'fifth' }); f.ipc.emit('broadcast', { method: 'sixth' });
  const reset = once(f.remote, 'disconnected'); await f.remote.connect(); await reset;
  assert.equal(f.remote.eventCursor, null); assert.equal(f.calls(), 0);
});

test('connector deduplicates accepted starts and exposes only authenticated bound receipts', async t => {
  const f = await transport(t), clientId = randomUUID(), threadId = randomUUID();
  const args = ['thread-follower-start-turn', { conversationId: threadId, turnStart: { request: { clientUserMessageId: clientId, input: [] } } }, 'desktop'];
  const first = await f.remote.request(...args), second = await f.remote.request(...args);
  assert.deepEqual(first, second); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.remote.startReceipt(threadId, clientId), first);
  assert.equal(await f.remote.startReceipt(randomUUID(), clientId), null);
  assert.equal((await fetch(`${f.url}/receipts/${clientId}`)).status, 403);
  args[1].turnStart.request.input = [{ type: 'text', text: 'Changed' }];
  await assert.rejects(f.remote.request(...args), /conflicts/); assert.equal(f.calls(), 1);
});

test('reconnect can read the live connector mirror only after verifying the current desktop owner', async t => {
  const f = await transport(t), id = randomUUID();
  const message = change => ({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: id, change } });
  f.ipc.emit('broadcast', message({ type: 'snapshot', revision: 1, conversationState: { id, latestModel: 'first', turns: [] } }));
  f.ipc.emit('broadcast', message({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['latestModel'], value: 'updated' }] }));
  assert.equal((await f.remote.snapshot(id, 'desktop')).state.latestModel, 'updated');
  assert.equal(await f.remote.snapshot(id, 'other-owner'), null);
  f.ipc.emit('broadcast', message({ type: 'patches', baseRevision: 99, revision: 100, patches: [] }));
  assert.equal(await f.remote.snapshot(id, 'desktop'), null); // A gap invalidates the cache.
  f.ipc.emit('broadcast', message({ type: 'snapshot', revision: 3, conversationState: { id, turns: [] } }));
  f.ipc.emit('disconnected'); assert.equal(await f.remote.snapshot(id, 'desktop'), null);
});

test('a network-lost acceptance response is recovered by reading the receipt without a second control write', async t => {
  const f = await transport(t);
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(f.url + req.url, { method: req.method, headers: { authorization: `Bearer ${secret}` }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const body = await response.text();
    if (req.url === '/rpc') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); res.destroy(); }
    else { res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(body); }
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r)); t.after(async () => { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); });
  const remote = new RemoteDesktop(`http://127.0.0.1:${proxy.address().port}`, secret);
  const threadId = randomUUID(), clientId = randomUUID();
  const result = await remote.request('thread-follower-start-turn', { conversationId: threadId, turnStart: { request: { clientUserMessageId: clientId, input: [] } } }, 'desktop');
  assert.equal(result.resultType, 'success'); assert.equal(f.calls(), 1);
});

test('uncertain queue recovers a persisted receipt and never repeats the completed request', async t => {
  const root = await directory(t), outbox = new Outbox(path.join(root, 'outbox.json'));
  const w = { id: randomUUID(), title: 'Test', owner: 'desktop', synced: true, state: { threadRuntimeStatus: { type: 'idle' }, turns: [] } };
  const entry = outbox.enqueue(w, [{ type: 'text', text: 'Accepted before disconnect' }], randomUUID()); entry.status = 'uncertain';
  const turnId = randomUUID(); w.state.turns = [{ turnId, status: 'completed', items: [] }];
  let starts = 0, reads = 0;
  await outbox.flush({ watched: new Map([[w.id, w]]), ipc: { startReceipt: async (id, client) => { reads++; assert.equal(client, entry.clientId); return { turn: { id: turnId } }; }, request: () => starts++ } });
  assert.equal(reads, 1); assert.equal(starts, 0); assert.equal(outbox.entries.length, 0);
});

test('desktop maintenance continues while Telegram delivery hangs, with no overlapping lane runs', async () => {
  let release, deliveries = 0, desktops = 0;
  const scheduler = maintenanceScheduler({ bridge: { reconnect: async () => desktops++, flush: async () => {}, outbox: { follow: async () => {}, flush: async () => {} } }, inbox: { flush: async () => { deliveries++; await new Promise(r => release = r); } }, ui: { accounts: { poll: async () => {} } } });
  scheduler.tick(); await new Promise(r => setImmediate(r));
  scheduler.tick(); await new Promise(r => setImmediate(r));
  assert.equal(desktops, 2); assert.equal(deliveries, 1);
  scheduler.stop(); release(); await scheduler.idle(); scheduler.tick(); assert.equal(desktops, 2);
});

test('delivery restart retains Telegram message IDs and sends all missed completed turns before the current turn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-delivery-')), file = path.join(root, 'delivery.sqlite'), threadId = randomUUID(), oldTurn = randomUUID(), newTurn = randomUUID();
  let store = new DeliveryState(file);
  const existing = { id: threadId, seenTurns: new Set(), messages: new Map([[oldTurn, { id: 77, signature: 'old' }]]) };
  store.save(existing); store.close(); store = new DeliveryState(file); t.after(async () => { store.close(); await rm(root, {recursive:true,force:true}); });
  const ipc = new EventEmitter(), sent = [], edited = [];
  const tg = { send: async (id, value) => { sent.push(value.text); return { message_id: 88 }; }, edit: async (id, message, value) => edited.push({ message, text: value.text }), pin: async () => {} };
  const bridge = new Bridge(tg, 1, ipc, undefined, { deliveryStore: store });
  const w = { id: threadId, owner: 'desktop', synced: true, seenTurns: new Set(), messages: new Map(), sentRequests: new Set(), state: { requests: [], turns: [{ id: oldTurn, status: 'completed', items: [{ type: 'agentMessage', text: 'Final answer while offline' }] }, { id: newTurn, status: 'inProgress', items: [{ type: 'agentMessage', text: 'Current live answer' }] }] } };
  bridge.restoreDelivery(w); bridge.watched.set(threadId, w); await bridge.flush();
  assert.equal(edited[0].message, 77); assert.ok(edited[0].text.includes('Final answer while offline'));
  assert.ok(sent[0].includes('Current live answer')); assert.ok(store.read(threadId).seenTurns.includes(oldTurn));
  await bridge.flush(); assert.equal(sent.length, 1); assert.equal(edited.length, 1);
});
