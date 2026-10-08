// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const ALLOWED = new Set(['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume']);
export function validateReset(value) {
  if (!value || !/^[\da-f-]{36}$/i.test(value.idempotencyKey || '') || typeof value.expectedAccountId !== 'string' || !value.expectedAccountId || value.expectedAccountId.length > 300 || (value.creditId !== undefined && (typeof value.creditId !== 'string' || !value.creditId || value.creditId.length > 300))) throw Error('درخواست ریست معتبر نیست.');
  return value;
}
export async function codexExecutable() {
  if (process.env.CODEX_QUOTA_BIN) return process.env.CODEX_QUOTA_BIN;
  if (process.platform !== 'win32') return 'codex';
  // The task scheduler does not necessarily inherit the desktop's CLI PATH.
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) {
    const file = path.join(root, entry.name, 'codex.exe');
    const info = await stat(file).catch(() => null); if (info?.isFile()) candidates.push({ file, time: info.mtimeMs });
  }
  return candidates.sort((a, b) => b.time - a.time)[0]?.file || 'codex.exe';
}
export class AccountRpc {
  pending = new Map(); nextId = 0; closed = false;
  constructor(child, timeoutMs = 20000) {
    this.child = child; this.timeoutMs = timeoutMs;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 4 * 1024 * 1024) return this.close();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const m = JSON.parse(line), p = this.pending.get(m.id); if (!p) continue;
          this.pending.delete(m.id); clearTimeout(p.timer);
          m.error ? p.reject(Error('دریافت نتیجه از Codex ممکن نشد؛ نتیجهٔ عملیات ممکن است نامشخص باشد.')) : p.resolve(m.result);
        } catch { this.close(); }
      }
    });
    // No credentials or diagnostic payloads from the CLI enter logs/Telegram.
    child.stderr.resume(); child.on('error', () => this.close()); child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
  }
  request(method, params) {
    if (method !== 'initialize' && !ALLOWED.has(method)) return Promise.reject(Error('Account RPC method not allowed'));
    if (this.closed) return Promise.reject(Error('رابط سهمیهٔ Codex در دسترس نیست.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('پاسخ سهمیهٔ Codex به‌موقع دریافت نشد؛ نتیجه ممکن است نامشخص باشد.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'telegram_codex_quota', version: '0.5.1' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('رابط سهمیهٔ Codex قطع شد؛ نتیجه ممکن است نامشخص باشد.')); }
    this.pending.clear(); this.child.kill();
  }
}
async function withAccountRpc(operation) {
  // A short-lived account-control process. No thread is created/resumed and no
  // model or tool execution is requested. Existing desktop chats keep their owner.
  const child = spawn(await codexExecutable(), ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new AccountRpc(child);
  const deadline = setTimeout(() => rpc.close(), 55000);
  try { await rpc.initialize(); return await operation(rpc); } finally { clearTimeout(deadline); rpc.close(); }
}
export class QuotaClient {
  tail = Promise.resolve();
  constructor(run = withAccountRpc) { this.run = run; }
  serial(operation) { const next = this.tail.then(() => this.run(operation)); this.tail = next.catch(() => {}); return next; }
  async current(rpc) {
    const { account } = await rpc.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw Error('نمایش و ریست سهمیه نیاز به ورود Codex با حساب ChatGPT دارد.');
    const limits = await rpc.request('account/rateLimits/read', {});
    return { ...limits, planType: account.planType || limits.rateLimits?.planType || null };
  }
  read() { return this.serial(rpc => this.current(rpc)); }
  consume(value) {
    validateReset(value);
    return this.serial(async rpc => {
      const current = await this.current(rpc);
      if (!current.accountId || current.accountId !== value.expectedAccountId) return { outcome: 'accountChanged' };
      // The service validates eligibility/credit ownership and deduplicates retries.
      const result = await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: value.idempotencyKey, ...(value.creditId ? { creditId: value.creditId } : {}) });
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw Error('نتیجهٔ ریست شناخته نشد؛ برای بررسی دوباره از همان درخواست استفاده کن.');
      return { outcome: result.outcome };
    });
  }
}
