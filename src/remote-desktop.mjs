// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
export class RemoteDesktop extends EventEmitter {
  eventCursor = null; connected = false; connecting = null; abort = null; closing = false;
  constructor(url, secret, { eventTimeoutMs = 35000 } = {}) {
    super(); const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) throw Error('Connector URL must be an SSH-forwarded localhost HTTP endpoint');
    if (!secret || secret.length < 32) throw Error('Connector secret is missing');
    this.url = parsed.origin; this.secret = secret; this.eventTimeoutMs = eventTimeoutMs;
  }
  async receipt(id) {
    const response = await fetch(`${this.url}/receipts/${id}`, { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null; return (await response.json()).result;
  }
  async startReceipt(threadId, clientId) {
    const receipt = await this.receipt(clientId);
    if (receipt?.state !== 'complete' || receipt.metadata?.command !== 'thread-follower-start-turn'
      || receipt.metadata.threadId !== threadId || receipt.metadata.clientId !== clientId) return null;
    return receipt.result;
  }
  async rpc(method, args, readAttempt = 0) {
    const mutating = ['request', 'createChat', 'quotaReset', 'accountActivate', 'accountLoginStart', 'accountLoginCancel'].includes(method);
    const operationId = mutating ? (method === 'request' && args[0] === 'thread-follower-start-turn' ? args[1]?.turnStart?.request?.clientUserMessageId || randomUUID() : randomUUID()) : undefined;
    let response, body;
    try { response = await fetch(this.url + '/rpc', { method: 'POST', headers: {
      authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args, operationId }), signal: AbortSignal.timeout(method === 'transcribeAttachment' ? 660000 : method === 'accountActivate' ? 300000 : ['models', 'projects', 'createChat', 'latestMessage'].includes(method) ? 180000 : ['request', 'quotaRead', 'quotaReset', 'accountsRead', 'accountLoginStart'].includes(method) ? 65000 : 25000) }); body = await response.json(); }
    catch (error) {
      // Retry only explicitly read-only RPCs, never follower/control methods.
      const readable = ['listThreads', 'owner', 'snapshot', 'compatibilityRead', 'transcriptionStatus', 'models', 'projects', 'latestMessage', 'quotaRead', 'accountsRead'].includes(method);
      const code = String(error.cause?.code || error.code || error.name || 'NETWORK').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48);
      console.warn('Connector transport failure:', method, code, 'readAttempt', readAttempt);
      if (readable && readAttempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 400));
        return this.rpc(method, args, 1);
      }
      if (operationId) {
        try { const receipt = await this.receipt(operationId); if (receipt?.state === 'complete') return receipt.result; } catch {}
      }
      throw Error('ارتباط با رابط ویندوز برقرار نشد؛ روشن‌بودن و اتصال اینترنت ویندوز را بررسی کن. درخواست خودکار تکرار نشد.'); }
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
      try { response = await fetch(this.url + '/events', { headers: { authorization: `Bearer ${this.secret}`, ...(this.eventCursor ? { 'last-event-id': this.eventCursor } : {}) }, signal: abort.signal }); }
      catch { throw Error('رابط ویندوز هنوز به سرور وصل نیست.'); }
      finally { clearTimeout(timer); }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) { abort.abort(); throw Error('Connector authentication or protocol failed'); }
      this.connected = true; this.emit('connected');
      this.consume(response, abort).catch(() => {}).finally(() => {
        if (this.abort === abort) { this.connected = false; if (!this.closing) this.emit('disconnected'); }
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async consume(response, abort) {
    const decoder = new TextDecoder(); let buffer = '';
    let silence;
    const heartbeat = () => { clearTimeout(silence); silence = setTimeout(() => abort.abort(), this.eventTimeoutMs); silence.unref?.(); };
    heartbeat();
    try {
    for await (const chunk of response.body) {
      heartbeat();
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 40 * 1024 * 1024) throw Error('Event frame too large');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        const id = frame.split('\n').find(line => line.startsWith('id: '))?.slice(4);
        if (id) {
          const incoming = /^([0-9a-f-]{36}):(\d+)$/.exec(id);
          if (!incoming) throw Error('Invalid event sequence');
          const previous = /^([0-9a-f-]{36}):(\d+)$/.exec(this.eventCursor || '');
          if (previous && previous[1] === incoming[1]) {
            if (Number(incoming[2]) <= Number(previous[2])) continue;
            if (Number(incoming[2]) !== Number(previous[2]) + 1) this.emit('disconnected');
          }
          this.eventCursor = id;
        }
        if (event.type === 'reset') { this.eventCursor = null; this.emit('disconnected'); continue; }
        if (event.type === 'broadcast') this.emit('broadcast', event.message);
        else if (event.type === 'disconnected') { this.emit('disconnected'); }
      }
    }
    } finally { clearTimeout(silence); }
  }
  async owner(id) { await this.connect(); return this.rpc('owner', [id]); }
  snapshot(id, owner) { return this.rpc('snapshot', [id, owner]); }
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
