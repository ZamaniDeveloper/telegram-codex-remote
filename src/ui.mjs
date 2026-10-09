// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { card, concatRich, styled } from './format.mjs';
import { isForwarded, messageFile } from './inbox.mjs';
import { lastTurn, turnId } from './state.mjs';
import path from 'node:path';
import { QuotaUi } from './quota-ui.mjs';
import { Features, featureRows } from './features.mjs';
import { text as T } from './feature-text.mjs';

export const UI_REVISION = 7;
export const UI_EDITION = 'fa';
export const LABELS = {
  chats: '💬 چت‌ها', search: '🔎 جستجو', status: '📊 وضعیت', history: '🗂 پاسخ‌های اخیر',
  bundle: '📦 ارسال‌گروهی‌پیام‌ها', questions: '❓ سؤال‌های Codex', home: '🏠 منوی اصلی', help: 'ℹ️ راهنما',
  usage: '📈 سهمیه', queue: '⏳ صف ارسال',
};
export function button(text, callback_data, style) { return { text, callback_data, ...(style ? { style } : {}) }; }
export function mainKeyboard() {
  return { keyboard: [[LABELS.chats, LABELS.search], ...featureRows(), [LABELS.status, LABELS.history], [LABELS.bundle, LABELS.questions], [LABELS.usage, LABELS.help], [LABELS.queue], [LABELS.home]].map(row => row.map(text => ({ text }))),
    resize_keyboard: true, is_persistent: true, input_field_placeholder: 'پیام بنویس یا از دکمه‌ها استفاده کن' };
}
export function navKeyboard() { return { inline_keyboard: [[button('💬 چت‌ها', 'u:chats', 'primary'), button('🏠 منوی اصلی', 'u:home')]] }; }
export function chatKeyboard(threadId) {
  return { inline_keyboard: [
    [button('📊 وضعیت', 'u:status'), button('🗂 پاسخ‌های اخیر', 'u:history')],
    [button(T.last, threadId ? `u:last:${threadId}` : 'u:last'), button(LABELS.queue, 'u:queue')],
    [button(LABELS.bundle, 'u:bundle'), button('❓ سؤال‌ها', 'u:questions', 'primary')],
    [button('📈 سهمیه و اعتبار ریست', 'u:usage', 'primary')],
    [button('✍️ راهنمایی حین کار', 'u:steer'), button('⏹ توقف', 'u:stop', 'danger')],
    [button('💬 تغییر چت', 'u:chats'), button('🏠 منوی اصلی', 'u:home')],
  ] };
}
export class BotUi {
  input = null; replies = new Map();
  constructor(bridge, inbox) { this.bridge = bridge; this.inbox = inbox; this.tg = bridge.tg; this.chatId = bridge.chatId; this.quota = new QuotaUi(bridge, { stateFile: path.join(inbox.root, 'quota-reset.json') }); this.features = new Features(this); this.bridge.latestButton = row => button('🕘', this.features.action({ kind: 'last', row, offset: 0 })); }
  cancelInput() { if (this.input) this.input.used = true; this.input = null; }
  async home(updated = false) {
    this.cancelInput(); this.features.cancelInput(); const w = this.bridge.selected;
    const body = concatRich(updated ? 'رابط جدید آماده است ✨\n\n' : '',
      styled('💬 چت فعال: '), w?.title || 'هنوز انتخاب نشده', '\n',
      styled('🔗 اتصال: '), w?.synced ? 'متصل به Codex' : 'چت را از دکمهٔ «چت‌ها» انتخاب کن', '\n',
      styled('📦 ارسال‌گروهی‌پیام‌ها: '), this.inbox.current ? `${this.inbox.current.items.length} پیام آماده` : 'بسته‌ای باز نیست',
      '\n\nپیام‌ها و پیوست‌ها را بفرست؛ پاسخ‌ها و سؤال‌های Codex همین‌جا نمایش داده می‌شوند.');
    return this.tg.send(this.chatId, card('🤖 TeleCodex', body, 'از دکمه‌های پایین استفاده کن.'), mainKeyboard());
  }
  async help() {
    return this.tg.send(this.chatId, card('✨ راهنمای ربات', concatRich(
      styled('۱. انتخاب چت\n'), 'دکمهٔ «چت‌ها» را بزن و یکی از چت‌های فعلی را انتخاب کن.\n\n',
      styled('۲. فرستادن پیام و فایل\n'), 'پیام معمولی به چت فعال ارسال می‌شود؛ هنگام اجرای کار در صف می‌ماند و پس از پایان، به‌ترتیب ارسال می‌شود. از «صف ارسال» پیام‌های منتظر را ببین یا حذف کن. فورواردها، تصویرها و فایل‌ها در «ارسال‌گروهی‌پیام‌ها» جمع می‌شوند؛ با دکمهٔ ارسال همه را یکجا بفرست.\n\n',
      styled('۳. کنترل کار\n'), 'زیر پاسخ زنده، دکمه‌های توقف و راهنمایی حین کار را می‌بینی.\n\n',
      styled('۴. پاسخ به سؤال\n'), 'گزینه را انتخاب کن یا روی پیام سؤال Reply بزن و پاسخت را بنویس. پاسخ آزاد بدون نوشتن دستور هم پذیرفته می‌شود.\n\n',
      styled('۵. سهمیه و ریست\n'), 'دکمهٔ «سهمیه» مصرف و زمان بازنشانی را نشان می‌دهد. اگر اعتبار ریست موجود باشد، دکمهٔ آن نمایش داده می‌شود؛ مصرف اعتبار با تأیید تو انجام می‌شود.\n\n',
      'هر فایل: حداکثر ۲۰ مگابایت · هر بسته: ۱۰۰ پیام\nکامپیوتر و Codex باید روشن باشند.'
    ), 'Developed by Mohsen Zamani · ZamaniDeveloper'), navKeyboard());
  }
  async bundle() {
    if (this.inbox.current) return this.inbox.notice(true);
    return this.tg.send(this.chatId, card(LABELS.bundle, 'چند متن، تصویر و فایل را در یک درخواست بفرست.\n\nفورواردها خودکار جمع می‌شوند. برای جمع‌کردن چند متن مستقیم، «بسته جدید» را بزن.'),
      { inline_keyboard: [[button('➕ بسته جدید', 'u:batch', 'primary')], [button('🏠 منوی اصلی', 'u:home')]] });
  }
  async prompt(kind, context = {}) {
    const descriptions = {
      search: ['🔎 جستجوی چت', 'عنوان چت یا مسیر پروژه را بنویس.', 'عنوان چت یا مسیر پروژه'],
      steer: ['✍️ راهنمایی حین کار', 'متن راهنمایی را بنویس؛ به همان کار در حال اجرا فرستاده می‌شود.', 'راهنمایی را بنویس'],
      instruction: ['🚀 ارسال بسته با توضیح', 'بگو Codex با پیام‌ها و پیوست‌های این بسته چه کاری انجام دهد.', 'توضیح درخواست را بنویس'],
    };
    const [title, body, placeholder] = descriptions[kind];
    const sent = await this.tg.send(this.chatId, card(title, body), { force_reply: true, input_field_placeholder: placeholder });
    this.input = { kind, ...context, messageId: sent.message_id, expires: Date.now() + 15 * 60 * 1000 };
    this.replies.set(sent.message_id, this.input); if (this.replies.size > 100) this.replies.delete(this.replies.keys().next().value);
  }
  async route(route) {
    this.cancelInput(); this.features.cancelInput();
    if (route === 'home' || route === 'start') return this.home();
    if (route === 'help') return this.help();
    if (route === 'usage') return this.quota.show();
    if (route === 'queue') {
      if (!this.bridge.outbox) throw Error('صف ارسال در دسترس نیست.');
      return this.bridge.outbox.show(this.bridge);
    }
    if (route === 'chats') return this.bridge.chats();
    if (route === 'last') return this.features.showLast(this.bridge.selected || this.bridge.requireSelected());
    if (route === 'search') return this.prompt('search');
    if (route === 'status' || route === 'history' || route === 'stop') return this.bridge.text('/' + route);
    if (route === 'questions') return this.bridge.questions.show();
    if (route === 'bundle') return this.bundle();
    if (route === 'batch') { this.inbox.begin(); this.inbox.dirty = true; return this.inbox.notice(true); }
    if (route === 'instruction') {
      if (!this.inbox.current?.items.length) throw Error('بسته خالی است؛ اول پیام‌ها و پیوست‌ها را بفرست.');
      return this.prompt('instruction', { batchId: this.inbox.current.id });
    }
    if (route === 'steer') {
      const w = this.bridge.requireSelected(); const turn = lastTurn(w.state);
      if (turn?.status !== 'inProgress') throw Error('این چت کار فعالی ندارد؛ پیام معمولی بفرست.');
      return this.prompt('steer', { threadId: w.id, turnId: turnId(turn) });
    }
    throw Error('این دکمه معتبر نیست؛ منوی اصلی را باز کن.');
  }
  async callback(data) {
    const last = /^u:last:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(data);
    if (last) {
      this.cancelInput(); this.features.cancelInput();
      return this.features.showLast(this.bridge.watched.get(last[1]) || { id: last[1] });
    }
    const route = data.slice(2);
    if (!['home', 'help', 'chats', 'last', 'queue', 'search', 'status', 'history', 'stop', 'questions', 'bundle', 'batch', 'instruction', 'steer', 'usage'].includes(route)) throw Error('دکمه معتبر نیست.');
    return this.route(route);
  }
  async consumePrompt(input, text) {
    if (input.expires < Date.now() || input.used) throw Error('این ورودی دیگر فعال نیست؛ دکمهٔ مربوط را دوباره بزن.');
    if (!text.trim()) throw Error('یک پاسخ متنی بنویس.');
    input.used = true; if (this.input === input) this.input = null;
    if (input.kind === 'search') return this.bridge.chats(text.trim());
    if (input.kind === 'steer') return this.bridge.steer(text, input.threadId, input.turnId);
    if (this.inbox.current?.id !== input.batchId) throw Error('این بسته عوض شده یا قبلاً ارسال شده است.');
    return this.inbox.send(text);
  }
  async message(message) {
    if (!isForwarded(message) && !messageFile(message) && message.text) {
      const route = Object.keys(LABELS).find(key => LABELS[key] === message.text.trim());
      if (route) return this.route(route);
      if (['📦 بسته پیام‌ها', '📦 بستهٔ پیام‌ها'].includes(message.text.trim())) return this.route('bundle');
      if (/^\/queue(?:@\w+)?\s*$/.test(message.text.trim())) return this.route('queue');
      if (/^\/(usage|quota)(?:@\w+)?\s*$/.test(message.text.trim())) return this.route('usage');
      if (/^\/(start|menu|home|help)(?:@\w+)?\s*$/.test(message.text.trim())) return this.route(message.text.trim().startsWith('/help') ? 'help' : 'home');
      if (await this.features.message(message)) return;
      const steer = /^\/steer(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
      if (steer) {
        if (!steer[1]?.trim()) return this.route('steer');
        this.input = null;
        return this.bridge.text('/steer ' + steer[1]);
      }
      const replyId = message.reply_to_message?.message_id;
      if (replyId && this.replies.has(replyId)) return this.consumePrompt(this.replies.get(replyId), message.text);
      if (replyId && await this.bridge.questions.reply(message.text, replyId)) return;
      if (replyId && /^(❓ سؤال Codex|✍️ پاسخ آزاد)/.test(message.reply_to_message.text || '')) throw Error('این پیام سؤال مربوط به اجرای قبلی ربات است؛ دکمهٔ «سؤال‌های Codex» را بزن و به سؤال تازه پاسخ بده.');
      if (!/^\/\w+/.test(message.text.trim())) {
        if (this.input && this.input.expires >= Date.now()) return this.consumePrompt(this.input, message.text);
        if (await this.bridge.questions.reply(message.text)) return;
      }
    }
    return this.inbox.message(message);
  }
}
