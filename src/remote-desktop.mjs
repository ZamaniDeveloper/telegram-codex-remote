// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
export class RemoteDesktop extends EventEmitter {
  connected = false; connecting = null; abort = null; closing = false;
  constructor(url, secret) {
    super(); const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) throw Error('Connector URL must be an SSH-forwarded localhost HTTP endpoint');
    if (!secret || secret.length < 32) throw Error('Connector secret is missing');
    this.url = parsed.origin; this.secret = secret;
  }
  async rpc(method, args) {
    let response;
    try { response = await fetch(this.url + '/rpc', { method: 'POST', headers: {
      authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(method === 'transcribeAttachment' ? 660000 : method === 'accountActivate' ? 300000 : ['models', 'projects', 'createChat', 'latestMessage'].includes(method) ? 180000 : ['request', 'quotaRead', 'quotaReset', 'accountsRead', 'accountLoginStart'].includes(method) ? 65000 : 25000) }); }
    catch { throw Error('رابط ویندوز در دسترس نیست؛ Codex و رابط محلی باید روشن باشند. درخواست خودکار تکرار نشد.'); }
    const body = await response.json();
    if (!response.ok || body.error) throw Error(body.error || 'Connector request failed');
    return body.result;
  }
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.closing = false;
    this.connecting = (async () => {
      const abort = new AbortController(); this.abort = abort;
      const timer = setTimeout(() => abort.abort(), 12000);
      let response;
      try { response = await fetch(this.url + '/events', { headers: { authorization: `Bearer ${this.secret}` }, signal: abort.signal }); }
      catch { throw Error('رابط ویندوز هنوز به سرور وصل نیست.'); }
      finally { clearTimeout(timer); }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) { abort.abort(); throw Error('Connector authentication or protocol failed'); }
      this.connected = true; this.emit('connected');
      this.consume(response).catch(() => {}).finally(() => {
        if (this.abort === abort) { this.connected = false; if (!this.closing) this.emit('disconnected'); }
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async consume(response) {
    const decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 40 * 1024 * 1024) throw Error('Event frame too large');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'broadcast') this.emit('broadcast', event.message);
        else if (event.type === 'disconnected') { this.emit('disconnected'); }
      }
    }
  }
  async owner(id) { await this.connect(); return this.rpc('owner', [id]); }
  follow(...args) { return this.rpc('follow', args).catch(() => { this.emit('disconnected'); }); }
  request(...args) { return this.rpc('request', args); }
  listThreads(...args) { return this.rpc('listThreads', args); }
  quotaRead() { return this.rpc('quotaRead', []); }
  quotaReset(value) { return this.rpc('quotaReset', [value]); }
  accountsRead() { return this.rpc('accountsRead', []); }
  accountLoginStart(value) { return this.rpc('accountLoginStart', [value]); }
  accountLoginCancel(value) { return this.rpc('accountLoginCancel', [value]); }
  accountActivate(value) { return this.rpc('accountActivate', [value]); }
  models() { return this.rpc('models', []); }
  projects() { return this.rpc('projects', []); }
  latestMessage(id) { return this.rpc('latestMessage', [id]); }
  createChat(value) { return this.rpc('createChat', [value]); }
  compatibilityRead(force = false) { return this.rpc('compatibilityRead', [force]); }
  transcriptionStatus() { return this.rpc('transcriptionStatus', []); }
  transcribeAttachment(meta) { return this.rpc('transcribeAttachment', [meta]); }
  openThread(id) { return this.rpc('openThread', [id]); }
  async uploadAttachment(meta, source) {
    let response;
    try {
      response = await fetch(`${this.url}/attachments/${meta.batchId}/${meta.id}`, { method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(meta.name), 'x-file-size': String(meta.size), 'x-file-sha256': meta.sha256,
          'content-length': String(meta.size) }, body: createReadStream(source), duplex: 'half', signal: AbortSignal.timeout(120000) });
      const body = await response.json();
      if (!response.ok || body.error) throw Error('upload failed');
      return body.result;
    } catch { throw Error('انتقال پیوست به ویندوز کامل نشد. بسته نگه داشته شد؛ اتصال رابط را بررسی کن و /send را دوباره بزن.'); }
  }
  close() { this.closing = true; this.connected = false; this.abort?.abort(); }
}
