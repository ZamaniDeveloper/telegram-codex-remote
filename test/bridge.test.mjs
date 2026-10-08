// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { DesktopIpc, FrameReader, frame } from '../src/ipc.mjs';
import { applyPatches, lastTurn, assistantText, splitText } from '../src/state.mjs';
import { isPrivateOwner, matchesPairCode } from '../src/auth.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Telegram } from '../src/telegram.mjs';

class FakeIpc extends EventEmitter {
  calls = []; followCalls = [];
  connect() { return Promise.resolve(); }
  owner() { return Promise.resolve('desktop-owner'); }
  follow(...args) { this.followCalls.push(args); }
  request(method, params, target) { this.calls.push({ method, params, target }); return Promise.resolve({ result: {} }); }
  close() {}
}
class FakeTelegram {
  sent = []; edited = [];
  async send(chat, text, markup) { this.sent.push({ chat, text: typeof text === 'string' ? text : text.text, entities: text.entities, markup }); return { message_id: this.sent.length }; }
  async edit(chat, id, text) { this.edited.push({ chat, id, text }); }
}
function fixture() {
  const ipc = new FakeIpc(); const tg = new FakeTelegram(); const bridge = new Bridge(tg, 123, ipc);
  const w = { id: 'thread-A', title: 'چت آزمون', owner: 'desktop-owner', synced: true, initialized: true,
    revision: 1, state: { id: 'thread-A', cwd: 'C:\\demo', turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } },
    messages: new Map(), sentRequests: new Set(), seenTurns: new Set() };
  bridge.watched.set(w.id, w); bridge.selected = w;
  return { bridge, ipc, tg, w };
}
test('fragmented/coalesced UTF-8 frames and frame bounds', () => {
  const messages = [{ text: 'سلام 👋' }, { text: 'دوم' }]; const bytes = Buffer.concat(messages.map(frame));
  const reader = new FrameReader(); const out = [];
  for (const b of bytes) out.push(...reader.push(Buffer.from([b])));
  assert.deepEqual(out, messages);
  assert.throws(() => new FrameReader().push(Buffer.from([255, 255, 255, 255])), /frame/);
});
test('real socket handshake, discovery rejection, owner lookup and snapshot', async () => {
  const server = net.createServer(socket => {
    const parser = new FrameReader();
    socket.on('data', b => { for (const m of parser.push(b)) {
      if (m.type === 'request') socket.write(frame({ type: 'response', requestId: m.requestId,
        resultType: 'success', method: m.method, handledByClientId: 'desktop-owner', result: { clientId: 'test-client' } }));
      if (m.type === 'broadcast') socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed',
        version: 11, sourceClientId: 'desktop-owner', params: { hostId: 'local', conversationId: m.params.conversationId,
          change: { type: 'snapshot', revision: 1, conversationState: { id: m.params.conversationId } } } }));
    } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ipc = new DesktopIpc({ host: '127.0.0.1', port: server.address().port });
  try {
    assert.equal(await ipc.owner('thread-A'), 'desktop-owner');
    const event = new Promise(r => ipc.once('broadcast', r)); ipc.follow('thread-A', 'desktop-owner');
    assert.equal((await event).params.change.conversationState.id, 'thread-A');
  } finally { ipc.close(); await new Promise(r => server.close(r)); }
});
test('canonical paginated history resolves turn entity keys', () => {
  const turn = { turnId: 'T', status: 'completed', items: [{ type: 'agentMessage', text: 'پاسخ' }] };
  const state = { turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'key' }] }], entitiesByKey: { key: turn } } } };
  assert.equal(lastTurn(state), turn); assert.equal(assistantText(lastTurn(state)), 'پاسخ');
});
test('Immer patches update arrays and reject prototype pollution', () => {
  const state = { turns: [{ items: ['a', 'c'] }] };
  applyPatches(state, [{ op: 'add', path: ['turns', 0, 'items', 1], value: 'b' }, { op: 'remove', path: ['turns', 0, 'items', 0] }]);
  assert.deepEqual(state.turns[0].items, ['b', 'c']);
  assert.throws(() => applyPatches(state, [{ op: 'add', path: ['__proto__', 'bad'], value: true }]));
  assert.equal({}.bad, undefined);
});
test('unauthorized users, groups, forwarded callbacks and pairing fail closed', () => {
  const privateMessage = { from: { id: 123 }, chat: { id: 123, type: 'private' } };
  assert.equal(isPrivateOwner({ message: privateMessage }, 123), true);
  assert.equal(isPrivateOwner({ message: privateMessage }, null), false);
  assert.equal(isPrivateOwner({ message: { ...privateMessage, from: { id: 456 } } }, 123), false);
  assert.equal(isPrivateOwner({ message: { ...privateMessage, chat: { id: 123, type: 'group' } } }, 123), false);
  assert.equal(isPrivateOwner({ callback_query: { from: { id: 456 }, message: privateMessage } }, 123), false);
  assert.equal(matchesPairCode('/pair good', 'good'), true);
  assert.equal(matchesPairCode('/pair bad', 'good'), false);
});
test('new turn preserves thread and delegates inherited desktop settings', async () => {
  const { bridge, ipc } = fixture(); await bridge.text('فقط این فایل را بررسی کن');
  assert.equal(ipc.calls[0].method, 'thread-follower-start-turn');
  assert.equal(ipc.calls[0].params.turnStart.request.threadId, 'thread-A');
  assert.equal(ipc.calls[0].params.turnStart.context.inheritThreadSettings, true);
  assert.equal(ipc.calls[0].target, 'desktop-owner');
});
test('running turn cannot start another turn; steer and stop use existing owner and turn', async () => {
  const { bridge, ipc, w } = fixture(); w.state.turns = [{ turnId: 'T', status: 'inProgress', items: [] }];
  await assert.rejects(bridge.text('پیام'), /steer/); assert.equal(ipc.calls.length, 0);
  await bridge.text('/steer همین فایل'); await bridge.text('/stop');
  assert.equal(ipc.calls[0].method, 'thread-follower-steer-turn');
  assert.equal(ipc.calls[1].params.expectedTurnId, 'T');
});
test('revision gaps trigger resnapshot; foreign owner events are ignored', () => {
  const { bridge, ipc, w } = fixture();
  bridge.onBroadcast({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'foreign', params: { hostId: 'local', conversationId: w.id, change: { type: 'snapshot', revision: 5, conversationState: {} } } });
  assert.equal(w.revision, 1);
  bridge.onBroadcast({ method: 'thread-stream-state-changed', version: 11, sourceClientId: w.owner, params: { hostId: 'local', conversationId: w.id, change: { type: 'patches', baseRevision: 7, revision: 8, patches: [] } } });
  assert.equal(w.synced, false); assert.equal(ipc.followCalls.length, 1);
  assert.throws(() => bridge.requireSelected());
});
test('approval stays bound to original thread and cannot be reused or used after resolution', async () => {
  const { bridge, ipc, w } = fixture();
  const req = { id: 99, method: 'item/commandExecution/requestApproval', params: { turnId: 'T', command: 'git status' } }; w.state.requests = [req];
  const token = bridge.action({ type: 'approval', threadId: w.id, requestId: 99, turnId: 'T', method: req.method });
  bridge.selected = { id: 'other' }; await bridge.callback(`a:${token}:accept`);
  assert.equal(ipc.calls[0].params.conversationId, 'thread-A');
  await assert.rejects(bridge.callback(`a:${token}:accept`));
  const old = bridge.action({ type: 'approval', threadId: w.id, requestId: 99, turnId: 'T', method: req.method });
  w.state.requests = []; await assert.rejects(bridge.callback(`a:${old}:accept`));
  assert.equal(ipc.calls.length, 1);
});
test('multiple user questions submit a complete response once and retire old buttons', async () => {
  const { bridge, ipc, tg, w } = fixture();
  const req = { id: 'R', method: 'item/tool/requestUserInput', params: { turnId: 'T', questions: [
    { id: 'one', question: 'اول؟', options: [{ label: 'بله' }] }, { id: 'two', question: 'دوم؟', options: [{ label: 'خیر' }] },
  ] } }; w.state.requests = [req]; await bridge.flush();
  const first = tg.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  await bridge.callback(first); assert.equal(ipc.calls.length, 0);
  await assert.rejects(bridge.callback(first));
  await bridge.answer('پاسخ دوم');
  assert.deepEqual(ipc.calls[0].params.response.answers, { one: { answers: ['بله'] }, two: { answers: ['پاسخ دوم'] } });
  await assert.rejects(bridge.answer('تکرار'));
});
test('long final answer is complete, Unicode-safe and emitted once', async () => {
  const { bridge, tg, w } = fixture(); const text = 'الف👋'.repeat(2200);
  w.state.turns = [{ turnId: 'T', status: 'completed', items: [{ type: 'agentMessage', text }] }];
  await bridge.flush(); const sent = tg.sent.map(m => m.text).join('');
  assert.ok(sent.includes(text)); assert.ok(tg.sent.every(m => m.text.length <= 3800));
  await bridge.flush(); assert.equal(tg.sent.map(m => m.text).join(''), sent);
  assert.equal(splitText(text).join(''), text);
});
test('Telegram network failures never expose the bot token', async () => {
  const tg = new Telegram('123:TOP_SECRET', async () => { throw Error('https://api.telegram.org/bot123:TOP_SECRET'); });
  await assert.rejects(tg.call('getMe'), e => !e.message.includes('TOP_SECRET'));
});
