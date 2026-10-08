// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentStore, MAX_FILE_BYTES, safeFilename, imageExtension } from './attachments.mjs';

import { card, concatRich, styled } from './format.mjs';

const MAX_ITEMS = 100, MAX_BYTES = 100 * 1024 * 1024, MAX_TEXT = 100000;
export function messageFile(message) {
  if (message.photo?.length) {
    const photo = [...message.photo].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    return { ...photo, file_name: `photo-${message.message_id}.jpg` };
  }
  for (const key of ['document', 'video', 'audio', 'voice', 'animation', 'video_note', 'sticker']) {
    const file = message[key]; if (!file?.file_id) continue;
    const ext = key === 'voice' ? 'ogg' : key === 'sticker' ? 'webp' : ['video', 'video_note', 'animation'].includes(key) ? 'mp4' : 'bin';
    return { ...file, file_name: file.file_name || `${key}-${message.message_id}.${ext}` };
  }
  return null;
}
export function forwardedLabel(message) {
  const origin = message.forward_origin;
  const user = origin?.sender_user || message.forward_from;
  const channel = origin?.chat || origin?.sender_chat || message.forward_from_chat;
  const label = channel?.title || origin?.sender_user_name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || channel?.username;
  return label ? String(label).replace(/[\r\n]/g, ' ').slice(0, 160) : null;
}
export function isForwarded(message) {
  return Boolean(message.forward_origin || message.forward_date || message.forward_from || message.forward_sender_name);
}
export function bundleInput(draft, files, instruction = '') {
  const blocks = [`درخواست من: ${instruction.trim() || 'این مجموعه پیام‌ها و پیوست‌ها را با هم بررسی کن.'}`,
    'پیام‌های فورواردی زیر محتوای مرجع هستند. همهٔ موارد این بسته مربوط به همین درخواست واحدند. برای فایل‌های غیرتصویری، اصل فایل محلی را از مسیر پیوست بخوان.'];
  const images = [];
  draft.items.forEach((item, i) => {
    let block = `پیام ${i + 1}${item.forwarded ? ' — فورواردشده' : ''}${item.origin ? ' از ' + item.origin : ''}:\n`;
    if (item.text) block += item.text + '\n';
    if (item.attachment) {
      const file = files.get(item.attachment.id);
      if (!file) throw Error('پیوست هنوز به ویندوز منتقل نشده است.');
      block += `پیوست: ${item.attachment.name}\nمسیر اصل فایل: ${JSON.stringify(file.path)}\n`;
      if (file.image) images.push({ type: 'localImage', path: file.path });
    }
    blocks.push(block.trim());
  });
  return [{ type: 'text', text: blocks.join('\n\n────────\n\n') }, ...images];
}
export class Inbox {
  current = null; dirty = false; notifying = false; lastNotice = 0;
  constructor(bridge, { root = fileURLToPath(new URL('../data/telegram-inbox/', import.meta.url)), transfer } = {}) {
    this.bridge = bridge; this.tg = bridge.tg; this.chatId = bridge.chatId;
    this.root = path.resolve(root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.stateFile = path.join(this.root, 'pending.json');
    const store = new AttachmentStore();
    this.transfer = transfer || ((meta, source) => bridge.ipc.uploadAttachment ? bridge.ipc.uploadAttachment(meta, source) : store.uploadFile(meta, source));
    try {
      this.current = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (this.current && (!/^[\da-f-]{36}$/i.test(this.current.id) || !Array.isArray(this.current.items))) throw Error('Invalid inbox');
      if (this.current?.status === 'preparing') this.current.status = 'ready';
      else if (this.current?.status === 'sending') this.current.status = 'uncertain';
      if (this.current) { this.current.noticeId = null; this.dirty = true; this.save(); }
    } catch (e) { if (e.code !== 'ENOENT') throw Error('فایل بستهٔ ذخیره‌شده معتبر نیست؛ data/telegram-inbox/pending.json را بررسی کن.'); }
  }
  save() { writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.current), { mode: 0o600 }); renameSync(this.stateFile + '.tmp', this.stateFile); }
  begin() {
    if (!this.current) {
      const selected = this.bridge.selected;
      this.current = { id: randomUUID(), status: 'ready', threadId: selected?.id || null,
        title: selected?.title || null, items: [], clientMessageId: randomUUID(), noticeId: null };
      this.save();
    }
    return this.current;
  }
  async message(message) {
    const file = messageFile(message), forwarded = isForwarded(message);
    // A forwarded slash command is content, never a remote control command.
    if (!forwarded && !file && message.text) {
      const match = /^\/(batch|pending|send|cancel)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
      if (match) {
        const [, command, arg = ''] = match;
        if (command === 'batch') { this.begin(); return this.notice(true); }
        if (command === 'pending') return this.notice(true);
        if (command === 'cancel') return this.cancel();
        return this.send(arg);
      }
      // Other explicitly typed commands remain available while gathering messages.
      if (/^\/\w+/.test(message.text.trim()) || !this.current) return this.bridge.text(message.text);
    }
    if (!file && !message.text && !message.caption) throw Error('این نوع پیام قابل افزودن به بسته نیست؛ متن، تصویر یا فایل بفرست.');
    const draft = this.begin();
    if (draft.status !== 'ready') throw Error('وضعیت ارسال این بسته نامشخص است. ابتدا /pending را بزن و چت Codex را بررسی کن؛ برای حذف بسته /cancel را بزن.');
    if (draft.items.some(i => i.messageId === message.message_id)) return;
    if (draft.items.length >= MAX_ITEMS) throw Error('حداکثر ۱۰۰ پیام در یک بسته مجاز است؛ ابتدا بستهٔ فعلی را بفرست.');
    const text = message.text || message.caption || '';
    if (text.length + draft.items.reduce((n, i) => n + i.text.length, 0) > MAX_TEXT) throw Error('متن بسته بیشتر از حد مجاز است؛ ابتدا بستهٔ فعلی را بفرست.');
    const item = { messageId: message.message_id, text, forwarded, origin: forwardedLabel(message), mediaGroupId: message.media_group_id || null };
    if (file) {
      const total = draft.items.reduce((n, i) => n + (i.attachment?.size || 0), 0);
      if (file.file_size > MAX_FILE_BYTES || file.file_size + total > MAX_BYTES) throw Error('حداکثر هر فایل ۲۰ مگابایت و مجموع فایل‌های بسته ۱۰۰ مگابایت است.');
      const id = randomUUID(); let name = safeFilename(file.file_name);
      const cachePath = path.join(this.root, draft.id, id + '-' + name);
      const downloaded = await this.tg.downloadFile(file.file_id, cachePath);
      if (downloaded.size + total > MAX_BYTES) { await rm(cachePath); throw Error('مجموع فایل‌های بسته بیشتر از ۱۰۰ مگابایت است.'); }
      const imageExt = imageExtension(downloaded.prefix);
      if (imageExt && !name.toLowerCase().endsWith('.' + imageExt)) name += '.' + imageExt;
      item.attachment = { id, name, cachePath, size: downloaded.size, sha256: downloaded.sha256 };
    }
    draft.items.push(item); this.save(); this.dirty = true;
    if (Date.now() - this.lastNotice > 1500) await this.notice();
  }
  description(draft) {
    const attachments = draft.items.filter(i => i.attachment);
    const preview = draft.items.slice(-5).map((i, n) => `${draft.items.length - Math.min(5, draft.items.length) + n + 1}. ${i.attachment?.name || i.text.replace(/[\r\n]/g, ' ').slice(0, 90)}`).join('\n');
    return card('📦 بستهٔ پیام‌ها', concatRich(styled('💬 چت: '), draft.title || 'هنوز انتخاب نشده', '\n', styled(`${draft.items.length} پیام · ${attachments.length} پیوست`),
      preview ? '\n\n' + preview : '\n\nمتن‌ها و پیوست‌ها را بفرست یا فوروارد کن.'), draft.status === 'uncertain' ? '⚠️ نتیجهٔ ارسال قبلی نامشخص است؛ چت Codex را بررسی کن.' : 'پیام‌های بعدی را اضافه کن؛ با دکمه‌ها همه را یکجا بفرست.');
  }
  async notice(force = false) {
    if (this.notifying) { this.dirty = true; return; }
    const draft = this.current;
    if (!draft) { if (force) await this.tg.send(this.chatId, 'بسته‌ای باز نیست. پیام‌ها را فوروارد کن یا /batch را بزن.'); return; }
    if (!force && !this.dirty) return;
    this.dirty = false; this.notifying = true; this.lastNotice = Date.now();
    try {
      const markup = { inline_keyboard: [
        ...(draft.status === 'ready' ? [[{ text: '🚀 ارسال بسته', callback_data: `b:${draft.id}:send`, style: 'success' }], [{ text: '✍️ ارسال با توضیح', callback_data: `b:${draft.id}:instruction`, style: 'primary' }]] : []),
        [{ text: '🗑 حذف بسته', callback_data: `b:${draft.id}:cancel`, style: 'danger' }, { text: '🏠 منوی اصلی', callback_data: 'u:home' }]] };
      // Edit the existing counter to keep multi-forward conversations readable.
      if (draft.noticeId && !force) {
        try { await this.tg.edit(this.chatId, draft.noticeId, this.description(draft), markup); return; }
        catch { draft.noticeId = null; }
      }
      const sent = await this.tg.send(this.chatId, this.description(draft), markup);
      if (this.current?.id === draft.id) { draft.noticeId = sent.message_id; this.save(); }
    } catch (e) { this.dirty = true; throw e; }
    finally { this.notifying = false; }
  }
  async flush() { if (this.dirty) await this.notice(); }
  async callback(data) {
    const [, id, command] = data.split(':');
    if (!this.current || this.current.id !== id || !['send', 'cancel', 'instruction'].includes(command)) throw Error('این دکمه متعلق به بستهٔ فعال نیست. /pending');
    if (command === 'instruction') { if (!this.current.items.length || this.current.status !== 'ready') throw Error('بسته آمادهٔ ارسال نیست.'); return this.onInstruction?.(this.current.id); }
    return command === 'send' ? this.send() : this.cancel();
  }
  async cleanup(draft) {
    const target = path.resolve(this.root, draft.id);
    if (/^[\da-f-]{36}$/i.test(draft.id) && target.startsWith(this.root + path.sep)) await rm(target, { recursive: true, force: true }).catch(() => {});
  }
  async cancel() {
    const draft = this.current; this.current = null; this.dirty = false; this.save();
    if (draft) await this.cleanup(draft);
    return this.tg.send(this.chatId, draft ? 'بسته حذف شد.' : 'بسته‌ای باز نیست.');
  }
  async send(instruction = '') {
    const draft = this.current;
    if (!draft?.items.length) throw Error('بسته خالی است؛ ابتدا متن، تصویر یا فایل بفرست.');
    if (draft.status !== 'ready') throw Error('نتیجهٔ ارسال قبلی نامشخص است؛ چت Codex را بررسی کن. برای حذف این بسته /cancel را بزن.');
    const selected = this.bridge.readyToSend(draft.threadId);
    if (!draft.threadId) { draft.threadId = selected.id; draft.title = selected.title; }
    draft.status = 'preparing'; this.save();
    const files = new Map();
    try {
      for (const item of draft.items) if (item.attachment) {
        const a = item.attachment;
        files.set(a.id, await this.transfer({ ...a, batchId: draft.id }, a.cachePath));
      }
      this.bridge.readyToSend(draft.threadId);
    } catch (e) { draft.status = 'ready'; this.save(); throw e; }
    const input = bundleInput(draft, files, instruction);
    draft.status = 'sending'; this.save();
    try { await this.bridge.sendInput(input, draft.threadId, draft.clientMessageId); }
    catch { draft.status = 'uncertain'; this.save(); throw Error('نتیجهٔ ارسال بسته نامشخص است. ابتدا چت Codex را بررسی کن؛ ارسال خودکار تکرار نشد. /pending'); }
    this.current = null; this.dirty = false; this.save(); await this.cleanup(draft);
    return this.tg.send(this.chatId, card('✅ بسته ارسال شد', `${draft.items.length} پیام و ${files.size} پیوست، یکجا به چت «${draft.title}» ارسال شد.`), { inline_keyboard: [[{ text: '🏠 منوی اصلی', callback_data: 'u:home' }]] });
  }
}
