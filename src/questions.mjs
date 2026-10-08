// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID } from 'node:crypto';
import { steeringParams } from './bridge.mjs';
import { pendingRequests, lastTurn, turnId, turnsOf } from './state.mjs';
import { card, concatRich, styled } from './format.mjs';

function answeredIds(state) {
  const ids = new Set();
  for (const turn of turnsOf(state)) for (const item of turn.items || []) {
    if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const input = item.content || item.input;
    if (!Array.isArray(input) || input.length !== 1 || input[0].type !== 'text') continue;
    const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(input[0].text || '');
    if (!match) continue;
    try { const parsed = JSON.parse(match[1]); for (const reply of Array.isArray(parsed) ? parsed : [parsed]) if (reply.questionItemId) ids.add(reply.questionItemId); } catch {}
  }
  return ids;
}
function options(q) { return (q.options || []).map(o => typeof o === 'string' ? { label: o } : o).filter(o => o?.label); }

export class QuestionManager {
  sessions = new Map(); replies = new Map();
  constructor(bridge) { this.bridge = bridge; }
  active(s) {
    const w = this.bridge.watched.get(s.threadId);
    if (!w?.synced || !w.owner || s.done) return false;
    if (s.kind === 'blocking') return pendingRequests(w.state).some(r => String(r.id) === String(s.req.id) && r.method === s.req.method && r.params?.turnId === s.req.params?.turnId);
    const answered = answeredIds(w.state);
    return turnId(lastTurn(w.state)) === s.turnId && (lastTurn(w.state)?.items || []).some(i => i.id === s.sourceItemId && i.questions?.length) && s.questions.every(q => !answered.has(q.id));
  }
  async sync(w) {
    for (const req of pendingRequests(w.state)) if (req.method === 'item/tool/requestUserInput') {
      const key = JSON.stringify([w.id, 'blocking', req.id, req.params?.turnId]);
      if (!this.sessions.has(key)) await this.ask(w, req);
    }
    const turn = lastTurn(w.state), answered = answeredIds(w.state);
    for (const item of turn?.items || []) if (item.type === 'agentMessage' && item.questions?.length) {
      const questions = item.questions.map((q, i) => ({ ...q, question: q.title, id: JSON.stringify(['request_user_input_async', item.id, i]) })).filter(q => !answered.has(q.id));
      if (!questions.length) continue;
      const key = JSON.stringify([w.id, 'async', item.id, turnId(turn), questions.map(q => q.id)]);
      if (this.sessions.has(key)) continue;
      const s = { key, kind: 'async', threadId: w.id, sourceItemId: item.id, turnId: turnId(turn), questions, index: 0, answers: {}, done: false };
      this.sessions.set(key, s); await this.present(s);
    }
    // Keep recent retired message IDs so replying to an old question fails closed.
    if (this.sessions.size > 200) for (const [key, s] of this.sessions) if (!this.active(s)) { this.sessions.delete(key); if (this.sessions.size <= 200) break; }
  }
  async ask(w, req, index = 0, answers = {}) {
    const key = JSON.stringify([w.id, 'blocking', req.id, req.params?.turnId]);
    let s = this.sessions.get(key);
    if (!s) { s = { key, kind: 'blocking', threadId: w.id, req, questions: req.params?.questions || [], index, answers, done: false }; this.sessions.set(key, s); }
    if (s.questions.length) await this.present(s);
  }
  async present(s) {
    const w = this.bridge.watched.get(s.threadId), q = s.questions[s.index];
    if (!q || !this.active(s)) return;
    const token = this.bridge.action({ type: 'question', sessionKey: s.key, index: s.index });
    const opts = options(q);
    const keyboard = opts.map((o, i) => [{ text: o.label.slice(0, 64), callback_data: `q:${token}:${i}`, style: 'primary' }]);
    keyboard.push([{ text: '✍️ پاسخ آزاد', callback_data: `q:${token}:free` }]);
    const descriptions = opts.filter(o => o.description).map(o => `${o.label}\n${o.description}`).join('\n\n');
    const sent = await this.bridge.tg.send(this.bridge.chatId, card(`❓ سؤال Codex · ${s.index + 1} از ${s.questions.length}`,
      concatRich(styled(w.title || 'چت', 'italic'), '\n\n', styled(q.question || q.title || 'پاسخت را بنویس'), descriptions ? '\n\n' + descriptions : ''),
      'گزینه را انتخاب کن یا روی همین پیام Reply بزن.'), { inline_keyboard: keyboard, force_reply: true });
    s.messageId = sent.message_id; this.replies.set(sent.message_id, { key: s.key, index: s.index });
    if (this.replies.size > 500) this.replies.delete(this.replies.keys().next().value);
  }
  eligible() { return [...this.sessions.values()].filter(s => this.active(s)); }
  choose() {
    const eligible = this.eligible(), selected = eligible.filter(s => s.threadId === this.bridge.selected?.id);
    const candidates = selected.length ? selected : eligible;
    if (candidates.length > 1) throw Error('چند سؤال باز است؛ روی پیام سؤال موردنظر Reply بزن یا گزینهٔ همان سؤال را انتخاب کن.');
    return candidates[0];
  }
  async show() {
    for (const w of this.bridge.watched.values()) if (w.synced) await this.sync(w);
    const list = this.eligible();
    if (!list.length) return this.bridge.tg.send(this.bridge.chatId, card('❓ سؤال‌های Codex', 'در چت‌های پیگیری‌شده سؤال بازی وجود ندارد.'), { inline_keyboard: [[{ text: '🏠 منوی اصلی', callback_data: 'u:home' }]] });
    for (const s of list) await this.present(s);
  }
  async reply(text, messageId) {
    if (messageId) {
      const binding = this.replies.get(messageId); if (!binding) return false;
      const s = this.sessions.get(binding.key);
      if (!s || !this.active(s) || s.index !== binding.index) throw Error('این سؤال قبلاً پاسخ داده شده یا دیگر فعال نیست.');
      await this.answer(text, s); return true;
    }
    const s = this.choose(); if (!s) return false;
    await this.answer(text, s); return true;
  }
  async callback(action, option) {
    const s = this.sessions.get(action.sessionKey);
    if (!s || !this.active(s) || s.index !== action.index) throw Error('این سؤال قبلاً پاسخ داده شده یا دیگر فعال نیست.');
    if (option === 'free') {
      const sent = await this.bridge.tg.send(this.bridge.chatId, card('✍️ پاسخ آزاد', s.questions[s.index].question || s.questions[s.index].title), { force_reply: true, input_field_placeholder: 'پاسخ سؤال را بنویس' });
      this.replies.set(sent.message_id, { key: s.key, index: s.index }); return;
    }
    if (!/^\d+$/.test(option) || !options(s.questions[s.index])[Number(option)]) throw Error('گزینه معتبر نیست.');
    return this.answer(options(s.questions[s.index])[Number(option)].label, s);
  }
  async answer(text, s = this.choose()) {
    if (!text.trim() || !s || !this.active(s)) throw Error('سؤال بازی برای این پاسخ وجود ندارد.');
    const w = this.bridge.watched.get(s.threadId), q = s.questions[s.index];
    if (s.kind === 'async' && lastTurn(w.state)?.status !== 'inProgress' && w.state.threadRuntimeStatus?.type === 'active') throw Error('وضعیت Codex هنوز همگام نشده؛ سؤال را دوباره باز کن.');
    Object.defineProperty(s.answers, q.id, { value: { answers: [text] }, enumerable: true, configurable: true });
    for (const [id, a] of this.bridge.actions) if (a.sessionKey === s.key && a.index === s.index) this.bridge.actions.delete(id);
    if (s.messageId) await this.bridge.tg.call?.('editMessageReplyMarkup', { chat_id: this.bridge.chatId, message_id: s.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    s.index++;
    if (s.index < s.questions.length) return this.present(s);
    // Consume before RPC: an uncertain result must not resend the same answer.
    if (!this.active(s)) { s.done = true; throw Error('این سؤال در Codex پاسخ داده شده یا دیگر فعال نیست.'); }
    s.done = true;
    if (s.kind === 'blocking') await this.bridge.ipc.request('thread-follower-submit-user-input', { conversationId: w.id, requestId: s.req.id, response: { answers: s.answers } }, w.owner);
    else {
      const replies = s.questions.map(q => ({ questionItemId: q.id, question: q.question || q.title, answer: s.answers[q.id].answers[0] }));
      const text = `<send_user_message_question_reply>\n${JSON.stringify(replies).replaceAll('<', '\\u003c')}\n</send_user_message_question_reply>`;
      const input = [{ type: 'text', text }];
      if (lastTurn(w.state)?.status === 'inProgress') await this.bridge.ipc.request('thread-follower-steer-turn', steeringParams(w, input), w.owner);
      else await this.bridge.ipc.request('thread-follower-start-turn', { conversationId: w.id, turnStart: { request: { threadId: w.id, input, clientUserMessageId: randomUUID() }, context: { inheritThreadSettings: true } } }, w.owner, 60000);
    }
    await this.bridge.tg.send(this.bridge.chatId, card('✅ پاسخ ارسال شد', `پاسخ سؤال‌ها به چت «${w.title || 'Codex'}» فرستاده شد.`));
  }
}
