// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Telegram } from '../src/telegram.mjs';
import { Bridge } from '../src/bridge.mjs';

function fixture() {
  const sent = [], edits = [], pins = [];
  const tg = {
    async send(chat, text, markup) { sent.push({ chat, text, markup }); return { message_id: sent.length }; },
    async edit(chat, id, text, markup) { edits.push({ chat, id, text, markup }); },
    async pin(chat, id) { pins.push({ chat, id }); },
  };
  const ipc = new EventEmitter(); ipc.request = async () => { throw Error('No model request allowed'); };
  const bridge = new Bridge(tg, 123, ipc);
  const w = { id: 'thread', title: 'Test chat', owner: 'owner', synced: true, initialized: true,
    state: { turns: [{ turnId: 'T', status: 'inProgress', items: [{ type: 'agentMessage', text: 'Working' }] }], requests: [] },
    messages: new Map(), seenTurns: new Set(), sentRequests: new Set() };
  bridge.watched.set(w.id, w); return { tg, bridge, w, sent, edits, pins };
}
test('live message is pinned once; updates and final response preserve that message', async () => {
  const { bridge, w, sent, edits, pins } = fixture();
  await bridge.flush(); await bridge.flush(); assert.deepEqual(pins, [{ chat: 123, id: 1 }]);
  w.state.turns[0].items[0].text = 'More progress'; await bridge.flush();
  w.state.turns[0].status = 'completed'; w.state.turns[0].items[0].text = 'Done'; await bridge.flush(); await bridge.flush();
  assert.equal(sent.length, 1); assert.deepEqual(edits.map(e => e.id), [1, 1]); assert.equal(pins.length, 1);
  w.state.turns = [{ turnId: 'NEW', status: 'inProgress', items: [{ type: 'agentMessage', text: 'Next task' }] }];
  await bridge.flush(); assert.deepEqual(pins[1], { chat: 123, id: 2 });
});
test('failed pin does not block updates or final response; rate-limited retries keep the same message', async () => {
  const { bridge, tg, w, edits } = fixture(); let attempts = 0;
  tg.pin = async () => { attempts++; throw Object.assign(Error('Temporary Telegram failure'), { retryAfter: 90 }); };
  await bridge.flush(); const record = w.messages.get('T');
  assert.ok(record.nextPinAt >= Date.now() + 89000);
  await bridge.flush(); assert.equal(attempts, 1);
  w.state.turns[0].status = 'completed'; await bridge.flush(); assert.equal(edits.length, 1); assert.ok(w.seenTurns.has('T'));
  const pins = []; tg.pin = async (chat, id) => pins.push({ chat, id }); record.nextPinAt = 0;
  await bridge.flush(); assert.deepEqual(pins, [{ chat: 123, id: 1 }]); assert.equal(edits.length, 1);
});
test('history/final-only responses are not auto-pinned', async () => {
  const { bridge, w, pins } = fixture(); w.state.turns[0].status = 'completed';
  await bridge.flush(); assert.deepEqual(pins, []);
});
test('Telegram pins only the specified chat and message, without notifications', async () => {
  let request;
  const tg = new Telegram('fixture', async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { json: async () => ({ ok: true, result: true }) }; });
  assert.equal(await tg.pin(123, 456), true);
  assert.ok(request.url.endsWith('/pinChatMessage'));
  assert.deepEqual(request.body, { chat_id: 123, message_id: 456, disable_notification: true });
});
