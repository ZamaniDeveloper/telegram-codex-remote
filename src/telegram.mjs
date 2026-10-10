// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { asRich, splitRich } from './format.mjs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_FILE_BYTES } from './attachments.mjs';
export class Telegram {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async call(method, params = {}) {
    let response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 20000),
      });
    } catch { throw Error('ارتباط با تلگرام قطع شد. وضعیت ارسال ممکن است نامشخص باشد.'); }
    const body = await response.json();
    if (!body.ok) {
      if (body.description?.includes('message is not modified')) return null;
      const e = Error(`Telegram ${body.error_code}: ${(body.description || 'request failed').replaceAll(this.token, '[redacted]')}`);
      e.retryAfter = body.parameters?.retry_after; e.errorCode = body.error_code; throw e;
    }
    return body.result;
  }
  async send(chatId, text, replyMarkup) {
    let result;
    const parts = splitRich(text);
    for (let i = 0; i < parts.length; i++) result = await this.deliver('sendMessage', {
      chat_id: chatId, text: parts[i].text, entities: parts[i].entities, link_preview_options: { is_disabled: true },
      ...(i === parts.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return result;
  }
  edit(chatId, messageId, value, replyMarkup) {
    const { text, entities } = asRich(value);
    return this.deliver('editMessageText', { chat_id: chatId, message_id: messageId, text, entities,
      link_preview_options: { is_disabled: true }, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  pin(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  }
  deliver(method, params) { return this.premium ? this.premium.deliver(method, params) : this.call(method, params); }
  async downloadFile(fileId, destination) {
    const meta = await this.call('getFile', { file_id: fileId });
    if (meta.file_size > MAX_FILE_BYTES) throw Error('حداکثر اندازهٔ هر فایل ۲۰ مگابایت است.');
    if (!meta.file_path || meta.file_path.split('/').some(x => !x || x === '..' || x === '.')) throw Error('مسیر دانلود تلگرام معتبر نیست.');
    const url = `https://api.telegram.org/file/bot${this.token}/${meta.file_path.split('/').map(encodeURIComponent).join('/')}`;
    const temp = destination + '.' + randomUUID() + '.part'; let handle;
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!response.ok || !response.body) throw Error('download failed');
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw Error('size limit');
      await mkdir(path.dirname(destination), { recursive: true }); handle = await open(temp, 'wx', 0o600);
      const hash = createHash('sha256'); let size = 0, prefixBytes = 0; const prefix = [];
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_FILE_BYTES) throw Error('size limit');
        if (prefixBytes < 16) { const head = bytes.subarray(0, 16 - prefixBytes); prefix.push(head); prefixBytes += head.length; }
        hash.update(bytes); await handle.writeFile(bytes);
      }
      if (!size || (meta.file_size != null && size !== meta.file_size)) throw Error('incomplete download');
      await handle.close(); handle = null; await rename(temp, destination);
      return { size, sha256: hash.digest('hex'), prefix: Buffer.concat(prefix) };
    } catch { throw Error('دانلود فایل از تلگرام کامل نشد؛ فایل را دوباره بفرست. حداکثر اندازه ۲۰ مگابایت است.'); }
    finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
}
