// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Compatibility } from './compatibility.mjs';

// Private desktop coordination protocol, observed on desktop 26.930.7945.
// This attaches to the running app. It never starts a second agent server.
export const VERSIONS = {
  'thread-owner-discovery': 1, 'thread-stream-state-changed': 11,
  'thread-stream-following-changed': 1, 'thread-stream-following-status-requested': 1,
  'thread-follower-start-turn': 2, 'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4, 'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1, 'thread-follower-submit-user-input': 1,
  'thread-follower-read-model-settings': 1, 'thread-follower-update-thread-settings': 2,
};
export function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameReader {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > 32 * 1024 * 1024) throw Error('Invalid IPC frame size');
      if (this.buffer.length < size + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return messages;
  }
}
export class DesktopIpc extends EventEmitter {
  pending = new Map(); clientId = ''; socket = null; connecting = null;
  constructor(pipe = '\\\\.\\pipe\\codex-ipc') { super(); this.pipe = pipe; this.compatibility = new Compatibility(VERSIONS); }
  connect() {
    if (this.socket && this.clientId) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.pipe); const reader = new FrameReader();
      const timer = setTimeout(() => { socket.destroy(); reject(Error('Codex connection timed out')); }, 10000);
      socket.on('data', chunk => {
        try { for (const m of reader.push(chunk)) this.receive(m); }
        catch { socket.destroy(); }
      });
      socket.once('connect', async () => {
        this.socket = socket;
        try {
          const init = await this.request('initialize', { clientType: 'telegram-bridge' });
          this.clientId = init.result.clientId; clearTimeout(timer); resolve(); this.emit('connected');
        } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
      });
      socket.on('error', () => { clearTimeout(timer); reject(Error('Codex دسکتاپ باز نیست یا اتصال محلی در دسترس نیست.')); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (this.socket === socket) { this.socket = null; this.clientId = ''; }
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex disconnected; outcome may be unknown')); }
        this.pending.clear(); this.emit('disconnected');
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  write(m) { if (!this.socket?.writable) throw Error('Codex disconnected'); this.socket.write(frame(m)); }
  async request(method, params, targetClientId, timeout = 20000) {
    if (method !== 'initialize' && process.platform === 'win32' && this.pipe === '\\\\.\\pipe\\codex-ipc') await this.compatibility.assert(method);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('IPC timeout; do not automatically repeat an action')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, method,
        version: VERSIONS[method] ?? 0, params, targetClientId, timeoutMs: timeout }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  broadcast(method, params, targetClientIds) {
    this.write({ type: 'broadcast', sourceClientId: this.clientId, method,
      version: VERSIONS[method] ?? 0, params, targetClientIds });
  }
  receive(m) {
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId); if (!p) return;
      this.pending.delete(m.requestId); clearTimeout(p.timer);
      m.resultType === 'success' ? p.resolve(m) : p.reject(Error(m.error || 'IPC request failed'));
    } else if (m.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: false } });
    } else if (m.type === 'broadcast') this.emit('broadcast', m);
  }
  async owner(threadId) {
    await this.connect();
    const r = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
    return r.handledByClientId;
  }
  follow(threadId, owner, following = true) {
    const send = () => this.broadcast('thread-stream-following-changed', { conversationId: threadId, hostId: 'local', following }, [owner]);
    if (process.platform === 'win32' && this.pipe === '\\\\.\\pipe\\codex-ipc') return this.compatibility.assert('thread-stream-following-changed').then(send).catch(() => { this.emit('disconnected'); });
    else send();
  }
  compatibilityRead(force = false) { return this.compatibility.read(force); }
  close() { this.socket?.destroy(); }
}
