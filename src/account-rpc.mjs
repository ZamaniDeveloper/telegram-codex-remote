// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { codexExecutable } from './quota-client.mjs';

const ALLOWED = new Set(['initialize', 'account/read', 'account/login/start', 'account/login/cancel']);
// This worker only authenticates. It cannot start a turn or execute a tool.
export class LoginRpc extends EventEmitter {
  pending = new Map(); next = 0; closed = false;
  constructor(child, timeout = 25000) {
    super(); this.child = child; this.timeout = timeout;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 1024 * 1024) return this.close();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const m = JSON.parse(line), p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id); clearTimeout(p.timer);
            m.error ? p.reject(Error('Codex authentication request failed. Enable device-code login in ChatGPT security settings and check Compatibility.')) : p.resolve(m.result);
          } else if (m.method === 'account/login/completed') {
            // No raw errors, auth tokens or server payloads leave the worker.
            this.emit('completed', { loginId: m.params?.loginId, success: m.params?.success === true });
          }
        } catch { this.close(); }
      }
    });
    child.stderr.resume(); child.stdin.on('error', () => this.close());
    child.on('error', () => this.close()); child.on('exit', () => this.close());
  }
  request(method, params) {
    if (!ALLOWED.has(method)) return Promise.reject(Error('Authentication RPC method not allowed'));
    if (this.closed) return Promise.reject(Error('Authentication connection closed; inspect status before retrying.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Authentication response timed out; inspect status before retrying.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'telecodex_accounts', version: '0.8.4' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write('{"method":"initialized"}\n');
  }
  close() {
    if (this.closed) return this.termination; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Authentication connection closed; inspect status before retrying.')); }
    this.pending.clear();
    this.termination = new Promise(resolve => {
      const timer = setTimeout(resolve, 5000); timer.unref?.();
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.child.kill(); this.emit('closed'); return this.termination;
  }
}
export async function openLoginRpc(home) {
  const env = { ...process.env, CODEX_HOME: home };
  // An inherited API key must never turn this into an API login.
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
  const rpc = new LoginRpc(spawn(await codexExecutable(), ['-c', 'cli_auth_credentials_store="file"', 'app-server', '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  try { await rpc.initialize(); return rpc; } catch (e) { await rpc.close(); throw e; }
}
