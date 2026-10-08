// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { card, concatRich, styled } from './format.mjs';
import { QuotaClient, validateReset } from './quota-client.mjs';

const button = (text, callback_data, style) => ({ text, callback_data, ...(style ? { style } : {}) });
const number = value => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(value);
export function resetCount(data) { const n = data.rateLimitResetCredits?.availableCount; return Number.isInteger(n) && n >= 0 ? n : null; }
function date(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'نامشخص';
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short' }).format(new Date(seconds * 1000));
}
function windowLabel(minutes) {
  if (minutes === 300) return '۵ ساعته'; if (minutes === 10080) return 'هفتگی';
  if (minutes >= 1440) return `${number(minutes / 1440)} روزه`;
  if (minutes >= 60) return `${number(minutes / 60)} ساعته`;
  return Number.isFinite(minutes) ? `${number(minutes)} دقیقه‌ای` : 'بازهٔ مصرف';
}
function windowText(window) {
  if (!window) return 'اطلاعات این بازه در دسترس نیست.';
  const used = window.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return `${windowLabel(window.windowDurationMins)}: مصرف نامشخص\nبازنشانی: ${date(window.resetsAt)}`;
  const remaining = Math.min(100, Math.max(0, 100 - used)), filled = Math.round(remaining / 10);
  return `${windowLabel(window.windowDurationMins)}\n${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  ${number(remaining)}٪ باقی‌مانده\nمصرف: ${number(used)}٪ · بازنشانی: ${date(window.resetsAt)}`;
}
export function quotaBody(data) {
  const buckets = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? Object.entries(data.rateLimitsByLimitId) : data.rateLimits ? [[data.rateLimits.limitId || 'codex', data.rateLimits]] : [];
  let body = concatRich(styled('🧠 پلن: '), data.planType || data.rateLimits?.planType || 'نامشخص', '\n\n');
  if (!buckets.length) body = concatRich(body, 'اطلاعات سهمیه در دسترس نیست.\n\n');
  for (const [id, bucket] of buckets.slice(0, 8)) {
    body = concatRich(body, styled(`📊 ${bucket.limitName || (id === 'codex' ? 'Codex' : id)}`), '\n', windowText(bucket.primary), bucket.secondary ? '\n\n' + windowText(bucket.secondary) : '', '\n\n');
    if (bucket.spendControlReached) body = concatRich(body, '⚠️ سقف هزینهٔ فضای کاری رسیده است.\n\n');
    if (bucket.credits?.balance != null) body = concatRich(body, `💳 موجودی اعتبار مصرف: ${bucket.credits.balance}\n\n`);
  }
  const count = resetCount(data);
  body = concatRich(body, styled('♻️ اعتبار ریست: '), count === null ? 'اطلاعات موجود نیست' : number(count));
  for (const credit of (data.rateLimitResetCredits?.credits || []).filter(c => c.status === 'available').slice(0, 5)) body = concatRich(body, `\n• ${credit.title || 'ریست سهمیه'}${credit.expiresAt != null ? '\n  انقضا: ' + date(credit.expiresAt) : ''}`);
  return body;
}
export class QuotaUi {
  actions = new Map(); current = null; busy = false;
  constructor(bridge, { stateFile, api } = {}) {
    this.tg = bridge.tg; this.chatId = bridge.chatId; this.stateFile = stateFile;
    this.api = api || (bridge.ipc.quotaRead ? { read: () => bridge.ipc.quotaRead(), consume: value => bridge.ipc.quotaReset(value) } : new QuotaClient());
    if (stateFile) try {
      this.current = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (this.current) { validateReset(this.current.intent); this.current.status = 'uncertain'; this.save(); }
    } catch (e) { if (e.code !== 'ENOENT') throw Error('وضعیت ذخیره‌شدهٔ ریست معتبر نیست؛ فایل quota-reset.json را بررسی کن.'); }
  }
  save() { if (this.stateFile) { writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.current), { mode: 0o600 }); renameSync(this.stateFile + '.tmp', this.stateFile); } }
  action(value) {
    const token = randomBytes(12).toString('hex'); this.actions.set(token, { ...value, expires: Date.now() + 10 * 60 * 1000 });
    if (this.actions.size > 100) this.actions.delete(this.actions.keys().next().value); return token;
  }
  resetButtons(data) {
    if (this.current || !data.accountId || !(resetCount(data) > 0)) return [];
    const credits = (data.rateLimitResetCredits?.credits || []).filter(c => c.status === 'available' && (c.expiresAt == null || c.expiresAt > Date.now() / 1000)).slice(0, 5);
    return (credits.length ? credits : [null]).map(credit => {
      const token = this.action({ kind: 'choose', expectedAccountId: data.accountId, creditId: credit?.id, title: credit?.title || 'ریست سهمیه' });
      return [button(`♻️ ${credit?.title || 'ریست سهمیه'}`.slice(0, 64), `r:${token}:choose`, 'primary')];
    });
  }
  async show() {
    const data = await this.api.read();
    const footer = 'زمان‌ها به وقت تهران هستند؛ این سهمیه با مصرف همان حساب در سایر برنامه‌ها مشترک است.';
    const rows = this.resetButtons(data);
    if (this.current) rows.push([button('🔎 بررسی نتیجهٔ ریست قبلی', `r:${this.action({ kind: 'retry', intent: this.current.intent })}:retry`, 'primary')]);
    rows.push([button('🔄 تازه‌سازی', 'u:usage'), button('🏠 منوی اصلی', 'u:home')]);
    const body = concatRich(quotaBody(data), this.current ? '\n\n⚠️ نتیجهٔ ریست قبلی هنوز قطعی نیست. دکمهٔ بررسی، همان درخواست را با همان شناسه پیگیری می‌کند.' : '');
    return this.tg.send(this.chatId, card('📈 سهمیهٔ حساب Codex', body, footer), { inline_keyboard: rows });
  }
  async callback(data) {
    const [, token, command] = data.split(':'); const a = this.actions.get(token);
    if (!a || a.expires < Date.now()) throw Error('این دکمهٔ سهمیه منقضی شده؛ صفحهٔ سهمیه را دوباره باز کن.');
    if (command === 'cancel' && a.kind === 'confirm') {
      this.actions.delete(token); return this.tg.send(this.chatId, card('ریست لغو شد', 'اعتباری مصرف نشد.'), { inline_keyboard: [[button('📈 سهمیه', 'u:usage')]] });
    }
    if (command === 'choose' && a.kind === 'choose') {
      if (this.current || this.busy) throw Error('ابتدا نتیجهٔ درخواست ریست قبلی را بررسی کن.');
      const fresh = await this.api.read();
      if (fresh.accountId !== a.expectedAccountId) throw Error('حساب Codex عوض شده؛ سهمیه را دوباره باز کن.');
      if (!(resetCount(fresh) > 0)) throw Error('اعتبار ریست موجود نیست. سهمیه را تازه‌سازی کن.');
      if (a.creditId && !(fresh.rateLimitResetCredits?.credits || []).some(c => c.id === a.creditId && c.status === 'available' && (c.expiresAt == null || c.expiresAt > Date.now() / 1000))) throw Error('این اعتبار دیگر قابل استفاده نیست؛ صفحهٔ سهمیه را تازه‌سازی کن.');
      const intent = { expectedAccountId: a.expectedAccountId, idempotencyKey: randomUUID(), ...(a.creditId ? { creditId: a.creditId } : {}) };
      const confirm = this.action({ kind: 'confirm', intent }); this.actions.delete(token);
      return this.tg.send(this.chatId, card('♻️ تأیید ریست سهمیه', concatRich(styled(a.title), '\n\nبا تأیید، یک اعتبار ریست از حساب فعلی مصرف می‌شود. نوع بازنشانی به همین اعتبار و شرایط حساب بستگی دارد.'), 'برای مصرف اعتبار، «تأیید و ریست» را بزن.'),
        { inline_keyboard: [[button('✅ تأیید و ریست', `r:${confirm}:confirm`, 'success')], [button('انصراف', `r:${confirm}:cancel`)]] });
    }
    if (command === 'confirm' && a.kind === 'confirm') {
      if (this.current || this.busy) throw Error('درخواست ریست دیگری در حال بررسی است.');
      this.actions.clear(); this.current = { intent: a.intent, status: 'sending' }; this.save();
      return this.dispatch();
    }
    if (command === 'retry' && a.kind === 'retry' && this.current?.intent.idempotencyKey === a.intent.idempotencyKey) {
      this.actions.delete(token); return this.dispatch();
    }
    throw Error('این دکمهٔ ریست دیگر فعال نیست.');
  }
  async dispatch() {
    if (this.busy || !this.current) throw Error('درخواست ریست در حال بررسی است.'); this.busy = true;
    const wasUncertain = this.current.status === 'uncertain';
    let result;
    try {
      this.current.status = 'sending'; this.save();
      result = await this.api.consume(this.current.intent);
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit', 'accountChanged'].includes(result?.outcome)) throw Error('unknown outcome');
    } catch {
      this.current.status = 'uncertain'; this.save(); this.busy = false;
      return this.tg.send(this.chatId, card('⚠️ نتیجهٔ ریست نامشخص است', 'ممکن است درخواست انجام شده باشد. برای بررسی، همان درخواست با همان شناسه پیگیری می‌شود؛ درخواست ریست جدید ساخته نمی‌شود.'),
        { inline_keyboard: [[button('🔎 بررسی همان درخواست', `r:${this.action({ kind: 'retry', intent: this.current.intent })}:retry`, 'primary')], [button('📈 سهمیه', 'u:usage')]] });
    }
    if (result.outcome === 'accountChanged' && wasUncertain) {
      this.current.status = 'uncertain'; this.save(); this.busy = false;
      return this.tg.send(this.chatId, card('حساب Codex عوض شده است', 'در حساب جدید ریستی اجرا نشد. نتیجهٔ درخواست قبلی هنوز قطعی نیست؛ برای بررسی همان درخواست، به حساب اصلی برگرد.'), { inline_keyboard: [[button('📈 سهمیه', 'u:usage')]] });
    }
    this.current = null; this.save(); this.busy = false;
    const messages = { reset: ['✅ سهمیه ریست شد', 'یک اعتبار ریست مصرف شد.'], alreadyRedeemed: ['✅ ریست قبلاً انجام شده بود', 'همان درخواست تأیید شد؛ اعتبار دیگری مصرف نشد.'], nothingToReset: ['ℹ️ بازه‌ای برای ریست وجود ندارد', 'سرویس هیچ بازهٔ واجد شرایطی برای این ریست پیدا نکرد.'], noCredit: ['ℹ️ اعتبار ریست موجود نیست', 'سرویس اعتبار قابل استفاده‌ای پیدا نکرد.'], accountChanged: ['حساب Codex عوض شده است', 'ریست انجام نشد. سهمیهٔ حساب فعلی را دوباره بررسی کن.'] };
    await this.tg.send(this.chatId, card(...messages[result.outcome]), { inline_keyboard: [[button('📈 سهمیهٔ تازه', 'u:usage')]] });
    try { await this.show(); } catch { await this.tg.send(this.chatId, 'نتیجهٔ عملیات مشخص شد، اما آمار تازه دریافت نشد؛ دکمهٔ سهمیه را دوباره بزن.'); }
  }
}
