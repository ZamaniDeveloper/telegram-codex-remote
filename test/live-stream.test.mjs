// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveStream } from '../src/live-stream.mjs';
import { Bridge } from '../src/bridge.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';

const snapshot = (state, revision = 1, owner = 'desktop') => ({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: owner, params: { hostId: 'local', conversationId: 'A', change: { type: 'snapshot', revision, conversationState: state } } });
const patch = (patches, baseRevision = 1, revision = 2) => ({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: 'A', change: { type: 'patches', baseRevision, revision, patches } } });
const state = () => ({ id: 'A', cwd: 'C:/project', latestModel: 'test-model', requests: [], threadRuntimeStatus: { type: 'active' }, turns: [{ turnId: 'T', status: 'inProgress', items: [{ id: 'tool', type: 'mcpToolCall', result: 'large'.repeat(4_000_000) }, { id: 'msg', type: 'agentMessage', text: 'Answer', questions: [{ title: 'Question?', options: ['Yes', 'No'] }] }, { id: 'user', type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: 'Guide' }] }] }] });

test('large tool history is compacted while text, questions, context and revisions remain exact', () => {
  const relay = new LiveStream(), original = state(), input = snapshot(original);
  const projected = relay.project(input);
  assert.ok(JSON.stringify(input).length > 19_000_000);
  assert.ok(JSON.stringify(projected).length < 2000);
  const value = projected.params.change.conversationState;
  assert.equal(value.cwd, original.cwd); assert.equal(value.latestModel, original.latestModel);
  assert.deepEqual(value.turns[0].items, original.turns[0].items.slice(1));
  assert.equal(projected.params.change.revision, 1);
  const next = relay.project(patch([{ op: 'replace', path: ['turns', 0, 'items', 1, 'text'], value: 'Updated' }, { op: 'replace', path: ['turns', 0, 'items', 0, 'result'], value: 'Even larger output' }]));
  assert.equal(next.params.change.type, 'snapshot'); assert.equal(next.params.change.revision, 2);
  assert.equal(next.params.change.conversationState.turns[0].items[0].text, 'Updated');
  assert.equal(original.turns[0].items[1].text, 'Answer');
  const removed = relay.project(patch([{ op: 'remove', path: ['turns', 0, 'items', 0] }, { op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }], 2, 3));
  assert.equal(removed.params.change.conversationState.turns[0].status, 'completed');
  assert.equal(removed.params.change.conversationState.turns[0].items[0].id, 'msg');
});

test('canonical history and pending approval details survive projection; invalid patches fail closed', () => {
  const relay = new LiveStream(), approval = { id: 'approve', type: 'fileChange', changes: [{ path: 'app.js', diff: 'actual diff' }] };
  const source = { requests: [{ id: 'R', params: { itemId: 'approve' }, method: 'item/fileChange/requestApproval' }], turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'key' }] }], entitiesByKey: { key: { id: 'T', status: 'inProgress', items: [approval, { type: 'agentMessage', text: 'Text' }] } } } } };
  const value = relay.project(snapshot(source)).params.change.conversationState;
  assert.equal(value.turns[0].id, 'T'); assert.deepEqual(value.turns[0].items[0], approval); assert.deepEqual(value.requests, source.requests);
  assert.equal(relay.project(patch([], 99)).params.change.baseRevision, null);
  assert.equal(relay.project(patch([{ op: 'add', path: ['__proto__', 'bad'], value: true }])).params.change.baseRevision, null);
  assert.equal({}.bad, undefined); assert.equal(relay.states.size, 0);
  relay.project(snapshot(source)); relay.forget('A'); assert.equal(relay.project(patch([])).params.change.baseRevision, null);
});

function fixture(options) {
  const ipc = new EventEmitter(); ipc.owner = async () => 'desktop'; ipc.connect = async () => {}; ipc.follow = () => {}; ipc.close = () => {};
  const bridge = new Bridge({ async send() {} }, 1, ipc, () => [], options);
  return { ipc, bridge };
}

test('reselecting an already synced chat does not wait for a duplicate snapshot', async () => {
  const { bridge, ipc } = fixture({ snapshotTimeoutMs: 50 });
  const w = { id: 'A', owner: 'desktop', synced: true, state: { cwd: 'C:/project' } };
  bridge.watched.set('A', w); let follows = 0; ipc.follow = () => follows++;
  await bridge.select({ id: 'A', title: 'DMC' }, { notify: false });
  assert.equal(bridge.selected, w); assert.equal(follows, 0);
});

test('overlapping selections share a snapshot safely and superseded selection cannot become active', async () => {
  const { bridge } = fixture({ snapshotTimeoutMs: 1000 }), selected = [];
  bridge.onSelected = row => selected.push(row.id);
  const first = bridge.select({ id: 'A' }, { notify: false });
  await new Promise(r => setImmediate(r));
  const second = bridge.select({ id: 'A' }, { notify: false });
  await new Promise(r => setImmediate(r));
  bridge.onBroadcast(snapshot({ id: 'A', turns: [] }));
  await Promise.all([first, second]); assert.deepEqual(selected, ['A']);
  assert.equal(bridge.watched.get('A').snapshotWaiters.size, 0);
  const earlier = bridge.select({ id: 'B' }, { notify: false }); await new Promise(r => setImmediate(r));
  await bridge.select({ id: 'A' }, { notify: false });
  const b = snapshot({ id: 'B', turns: [] }); b.params.conversationId = 'B'; bridge.onBroadcast(b);
  await earlier; assert.equal(bridge.selected.id, 'A'); assert.deepEqual(selected, ['A', 'A']);
});

test('failed selection preserves the previous ready chat and retires its timed-out waiter', async () => {
  const { bridge } = fixture({ snapshotTimeoutMs: 30 });
  const old = { id: 'old', owner: 'desktop', synced: true }; bridge.selected = old;
  await assert.rejects(bridge.select({ id: 'A' }, { notify: false }));
  assert.equal(bridge.selected, old); assert.equal(bridge.watched.get('A').snapshotWaiters.size, 0);
});

test('large snapshot and subsequent private patches reach the remote bridge as compact coherent states', async t => {
  const { ipc } = fixture(), secret = 'test-secret-'.repeat(4);
  ipc.follow = (id, owner, following = true) => { if (following) ipc.emit('broadcast', snapshot(state())); };
  const server = createConnector({ secret, ipc }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.shutdown());
  const remote = new RemoteDesktop('http://127.0.0.1:' + server.address().port, secret);
  const bridge = new Bridge({ async send() {} }, 1, remote, () => [], { snapshotTimeoutMs: 3000 }); t.after(() => remote.close());
  await bridge.select({ id: 'A', title: 'DMC' }, { notify: false });
  assert.ok(JSON.stringify(bridge.selected.state).length < 2000);
  const updated = new Promise(resolve => remote.once('broadcast', resolve));
  ipc.emit('broadcast', patch([{ op: 'replace', path: ['turns', 0, 'items', 1, 'text'], value: 'Live update' }]));
  await updated; assert.equal(bridge.selected.state.turns[0].items[0].text, 'Live update'); assert.equal(bridge.selected.revision, 2);
});
