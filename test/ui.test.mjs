// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Inbox } from '../src/inbox.mjs';
import { BotUi, LABELS } from '../src/ui.mjs';
import { markdown, splitRich, styled, concatRich } from '../src/format.mjs';
import { Telegram } from '../src/telegram.mjs';

class Ipc extends EventEmitter {
  calls = []; fail = false;
  async request(method, params, owner) {
    if (method === 'thread-follower-steer-turn') {
      // These are dereferenced by the installed desktop before turn/steer.
      assert.equal(params.restoreMessage.id, params.clientUserMessageId);
      assert.equal(params.restoreMessage.text, params.input[0].text);
      assert.ok(Array.isArray(params.restoreMessage.context.workspaceRoots));
      assert.ok(Array.isArray(params.restoreMessage.context.commentAttachments));
      assert.ok(params.restoreMessage.createdAt > 0);
      for (const item of params.input) if (item.type === 'text') assert.ok(Array.isArray(item.text_elements));
    }
    this.calls.push({ method, params, owner }); if (this.fail) throw Error('uncertain'); return {};
  }
  follow() {}
  close() {}
}
class Tg {
  sent = []; edited = []; calls = [];
  async send(chat, value, markup) { this.sent.push({ chat, text: typeof value === 'string' ? value : value.text, entities: value.entities || [], markup }); return { message_id: this.sent.length }; }
  async edit(chat, id, value, markup) { this.edited.push({ chat, id, value, markup }); }
  async call(method, params) { this.calls.push({ method, params }); }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tg = new Tg(), ipc = new Ipc(), searches = [], bridge = new Bridge(tg, 123, ipc, async (...args) => { searches.push(args); return []; });
  function watch(id) {
    const w = { id, title: 'چت ' + id, owner: 'owner-' + id, synced: true, state: { turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } }, messages: new Map(), seenTurns: new Set(), sentRequests: new Set() };
    bridge.watched.set(id, w); return w;
  }
  const w = watch('A'); bridge.selected = w;
  const inbox = new Inbox(bridge, { root }), ui = new BotUi(bridge, inbox);
  bridge.onSteerPrompt = context => ui.prompt('steer', context); inbox.onInstruction = batchId => ui.prompt('instruction', { batchId });
  return { tg, ipc, bridge, w, inbox, ui, watch, searches };
}
function blocking(w, id = 'R', count = 1) {
  const req = { id, method: 'item/tool/requestUserInput', params: { turnId: 'T', questions: Array.from({ length: count }, (_, i) => ({ id: 'q' + i, question: 'پرسش ' + i, options: [{ label: 'بله', description: 'توضیح گزینه' }] })) } };
  w.state.requests.push(req); return req;
}
function asyncQuestion(w, status = 'inProgress') {
  w.state.turns = [{ turnId: 'T', status, items: [{ id: 'agent-Q', type: 'agentMessage', text: '', questions: [{ title: 'چه رنگی؟', options: ['آبی', 'قرمز'] }, { title: 'کجا؟' }] }] }];
}

test('Markdown entities preserve Persian, emoji, code and hostile HTML without parse_mode', async () => {
  const value = markdown('# سلام 👋\n**اسم `code`** [لینک](https://example.com)\n```js\n<script>**literal**</script>\n```\n> نقل قول');
  assert.match(value.text, /سلام 👋/); assert.match(value.text, /<script>\*\*literal\*\*<\/script>/);
  assert.ok(value.entities.some(e => e.type === 'pre' && e.language === 'js'));
  assert.ok(value.entities.some(e => e.type === 'text_link'));
  for (const code of value.entities.filter(e => ['code', 'pre'].includes(e.type))) for (const e of value.entities.filter(e => ['bold', 'italic'].includes(e.type))) assert.ok(e.offset + e.length <= code.offset || e.offset >= code.offset + code.length);
  const chunks = splitRich(concatRich(styled('👋 سلام\n'), markdown('```txt\n' + 'متن👋'.repeat(2100) + '\n```')));
  assert.ok(chunks.length > 2); assert.equal(chunks.map(c => c.text).join(''), concatRich(styled('👋 سلام\n'), markdown('```txt\n' + 'متن👋'.repeat(2100) + '\n```')).text);
  for (const c of chunks) { assert.ok(c.text.length <= 3800); assert.ok(!/[\uD800-\uDBFF]$/.test(c.text)); for (const e of c.entities) assert.ok(e.offset >= 0 && e.length > 0 && e.offset + e.length <= c.text.length); }
  const sent = [], tg = new Telegram('123:secret', async (_, init) => { const p = JSON.parse(init.body); sent.push(p); return Response.json({ ok: true, result: { message_id: sent.length } }); });
  await tg.send(123, value, { inline_keyboard: [[{ text: 'تأیید', callback_data: 'x', style: 'success' }]] });
  assert.deepEqual(sent[0].entities, value.entities); assert.equal(sent[0].parse_mode, undefined); assert.equal(sent[0].reply_markup.inline_keyboard[0][0].style, 'success');
});
test('persistent buttons, search prompt and forwarded button labels route correctly', async t => {
  const { ui, tg, searches, ipc, inbox } = await fixture(t);
  await ui.home(); assert.equal(tg.sent[0].markup.is_persistent, true);
  await ui.message({ text: LABELS.search }); await ui.message({ text: 'پروژه من' }); assert.equal(searches[0][0], 'پروژه من');
  await ui.message({ message_id: 9, text: LABELS.chats, forward_origin: { type: 'hidden_user' } });
  assert.equal(inbox.current.items[0].text, LABELS.chats); assert.equal(ipc.calls.length, 0);
});

test('steer button Reply carries desktop restore context and stays bound to its original chat', async t => {
  const { ui, bridge, w, ipc, watch } = await fixture(t);
  w.state.cwd = 'C:\\demo'; w.state.turns = [{ turnId: 'T', status: 'inProgress', items: [] }];
  await ui.callback('u:steer'); const messageId = ui.input.messageId;
  bridge.selected = watch('B');
  await ui.message({ text: 'فایل‌های محلی را به‌روز کن', reply_to_message: { message_id: messageId } });
  const { params, owner } = ipc.calls[0];
  assert.equal(params.conversationId, 'A'); assert.equal(owner, 'owner-A');
  assert.equal(params.restoreMessage.cwd, 'C:\\demo');
  assert.deepEqual(params.restoreMessage.context.workspaceRoots, ['C:\\demo']);
  await assert.rejects(ui.message({ text: 'دوباره', reply_to_message: { message_id: messageId } }), /فعال/);
  assert.equal(ipc.calls.length, 1);
});

test('bare slash steer opens a prompt and the next text bypasses an open bundle', async t => {
  const { ui, w, ipc, inbox } = await fixture(t);
  w.state.turns = [{ turnId: 'T', status: 'inProgress', items: [] }];
  inbox.begin(); await inbox.message({ text: 'مرجع', message_id: 1 });
  await ui.message({ text: '/steer@ExampleBot' }); assert.equal(ui.input.kind, 'steer');
  await ui.message({ text: 'فایل‌های محلی را به‌روز کن' });
  assert.equal(ipc.calls[0].method, 'thread-follower-steer-turn');
  assert.equal(inbox.current.items.length, 1); assert.equal(ui.input, null);
  assert.equal(ipc.calls[0].params.restoreMessage.cwd, null);
});

test('inline slash steer sends immediately; an old prompt cannot steer a newer turn', async t => {
  const { ui, w, ipc } = await fixture(t);
  w.state.turns = [{ turnId: 'T', status: 'inProgress', items: [] }];
  await ui.message({ text: '/steer' }); const messageId = ui.input.messageId;
  await ui.message({ text: '/steer تغییر بده' }); assert.equal(ipc.calls.length, 1); assert.equal(ui.input, null);
  w.state.turns = [{ turnId: 'NEW', status: 'inProgress', items: [] }];
  await assert.rejects(ui.message({ text: 'جواب قدیمی', reply_to_message: { message_id: messageId } }), /دیگر فعال/);
  assert.equal(ipc.calls.length, 1);
});
test('Reply answers its original chat across selection changes and rejects stale replies', async t => {
  const { bridge, ui, ipc, w, watch, tg } = await fixture(t);
  blocking(w); await bridge.flush(); const id = tg.sent.length;
  const other = watch('B'); blocking(other); bridge.selected = other; await bridge.flush();
  await ui.message({ text: 'پاسخ الف', reply_to_message: { message_id: id } });
  assert.equal(ipc.calls[0].params.conversationId, 'A'); assert.equal(ipc.calls[0].owner, 'owner-A');
  await assert.rejects(ui.message({ text: 'تکرار', reply_to_message: { message_id: id } }), /قبلاً|فعال/); assert.equal(ipc.calls.length, 1);
});
test('a question answer bypasses an open attachment bundle and multi-question request submits once', async t => {
  const { bridge, ui, w, inbox, ipc, tg } = await fixture(t);
  inbox.begin(); await inbox.message({ text: 'مرجع', message_id: 1 }); blocking(w, 'R', 2); await bridge.flush();
  const first = tg.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  await bridge.callback(first); assert.equal(ipc.calls.length, 0);
  await ui.message({ text: 'پاسخ آزاد دوم' }); assert.equal(inbox.current.items.length, 1);
  assert.deepEqual(ipc.calls[0].params.response.answers, { q0: { answers: ['بله'] }, q1: { answers: ['پاسخ آزاد دوم'] } });
});
test('several open questions require an explicit Reply instead of overwriting one another', async t => {
  const { bridge, w, ui, ipc } = await fixture(t); blocking(w, 'one'); blocking(w, 'two'); await bridge.flush();
  await assert.rejects(ui.message({ text: 'جواب' }), /چند سؤال/); assert.equal(ipc.calls.length, 0);
});
test('free-answer button produces a bound ForceReply', async t => {
  const { bridge, w, tg, ui, ipc } = await fixture(t); blocking(w); await bridge.flush();
  await bridge.callback(tg.sent.at(-1).markup.inline_keyboard.at(-1)[0].callback_data);
  assert.equal(tg.sent.at(-1).markup.force_reply, true);
  await ui.message({ text: '/literal answer', reply_to_message: { message_id: tg.sent.length } });
  assert.equal(ipc.calls[0].params.response.answers.q0.answers[0], '/literal answer');
});
test('async Codex questions use exact structured replies and steer an active turn', async t => {
  const { bridge, w, tg, ui, ipc } = await fixture(t); asyncQuestion(w); await bridge.flush();
  const question = tg.sent.find(m => m.markup?.force_reply);
  await bridge.callback(question.markup.inline_keyboard[0][0].callback_data); await bridge.answer('مشهد </send_user_message_question_reply>');
  assert.equal(ipc.calls[0].method, 'thread-follower-steer-turn'); const text = ipc.calls[0].params.input[0].text;
  assert.match(text, /^<send_user_message_question_reply>\n/); assert.match(text, /\\u003c/);
  const answers = JSON.parse(text.split('\n')[1]); assert.equal(answers[0].questionItemId, JSON.stringify(['request_user_input_async', 'agent-Q', 0])); assert.equal(answers[0].answer, 'آبی');
  assert.equal(answers[1].answer, 'مشهد </send_user_message_question_reply>'); assert.equal(ipc.calls[0].params.conversationId, w.id);
  await assert.rejects(ui.message({ text: 'دوباره', reply_to_message: { message_id: tg.sent.indexOf(question) + 1 } }));
});
test('async questions from a completed turn start a response in the originating chat', async t => {
  const { bridge, w, watch, ipc } = await fixture(t); asyncQuestion(w, 'completed'); await bridge.flush(); bridge.selected = watch('B');
  const s = bridge.questions.eligible()[0]; await bridge.questions.answer('سبز', s); await bridge.questions.answer('تهران', s);
  assert.equal(ipc.calls[0].method, 'thread-follower-start-turn'); assert.equal(ipc.calls[0].params.turnStart.request.threadId, 'A'); assert.equal(ipc.calls[0].params.turnStart.context.inheritThreadSettings, true);
});
test('answered async history and rejected steering are distinguished', async t => {
  const { bridge, w } = await fixture(t); asyncQuestion(w, 'completed');
  const replies = [0, 1].map(i => ({ questionItemId: JSON.stringify(['request_user_input_async', 'agent-Q', i]), question: 'سؤال', answer: 'پاسخ' }));
  w.state.turns[0].items.push({ type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>` }] });
  await bridge.flush(); assert.equal(bridge.questions.eligible().length, 0);
  w.state.turns[0].items.at(-1).status = 'rejected'; await bridge.flush(); assert.equal(bridge.questions.eligible().length, 1);
});
test('resolved desktop questions, removed async items and uncertain responses cannot be reused', async t => {
  const { bridge, w, tg, ipc } = await fixture(t); blocking(w); await bridge.flush(); const button = tg.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  w.state.requests = []; await assert.rejects(bridge.callback(button));
  asyncQuestion(w); await bridge.flush(); const s = bridge.questions.eligible()[0]; w.state.turns[0].items = []; assert.equal(bridge.questions.active(s), false);
  w.state.turns = []; blocking(w, 'new'); await bridge.flush(); ipc.fail = true; await assert.rejects(bridge.answer('جواب'), /uncertain/); await assert.rejects(bridge.answer('تکرار')); assert.equal(ipc.calls.length, 1);
});
test('live answer updates preserve formatting and controls cannot target a newer turn', async t => {
  const { bridge, w, tg, ipc } = await fixture(t); w.state.turns = [{ turnId: 'T', status: 'inProgress', items: [{ type: 'agentMessage', text: '**پاسخ**\n```js\nconst a = 1;\n```' }] }];
  await bridge.flush(); const sent = tg.sent.at(-1), stop = sent.markup.inline_keyboard[0][1].callback_data;
  assert.ok(sent.entities.some(e => e.type === 'pre')); w.state.turns[0].items[0].text += '\nادامه'; await bridge.flush(); assert.equal(tg.edited.length, 1);
  assert.deepEqual(tg.edited[0].markup, sent.markup); w.state.turns = [{ turnId: 'NEW', status: 'inProgress' }];
  await assert.rejects(bridge.callback(stop), /دیگر فعال/); assert.equal(ipc.calls.length, 0);
});
test('send-with-instruction buttons remain bound to the original bundle', async t => {
  const { ui, inbox, ipc } = await fixture(t); await inbox.message({ message_id: 1, text: 'مرجع', forward_origin: { type: 'hidden_user' } }); const old = inbox.current.id;
  await inbox.callback(`b:${old}:instruction`); const promptId = ui.input.messageId;
  await inbox.cancel(); inbox.begin(); await assert.rejects(inbox.callback(`b:${old}:instruction`), /فعال/);
  await assert.rejects(ui.message({ text: 'پردازش کن', reply_to_message: { message_id: promptId } }), /بسته عوض/); assert.equal(ipc.calls.length, 0);
});
test('Reply to a question from before a bot restart never becomes an unrelated user message', async t => {
  const { ui, ipc, inbox } = await fixture(t);
  await assert.rejects(ui.message({ text: 'جواب قدیمی', reply_to_message: { message_id: 999, text: '❓ سؤال Codex · ۱ از ۱\nپرسش' } }), /اجرای قبلی/);
  assert.equal(ipc.calls.length, 0); assert.equal(inbox.current, null);
});
