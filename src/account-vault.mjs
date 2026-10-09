// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function cacheIdentity(bytes) {
  if (bytes.length > 65536) throw Error('Unsupported authentication cache size.');
  let cache, claims;
  try { cache = JSON.parse(bytes.toString('utf8')); claims = JSON.parse(Buffer.from(cache.tokens.id_token.split('.')[1], 'base64url').toString('utf8')); } catch { throw Error('A managed ChatGPT file login is required.'); }
  const accountId = cache.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id;
  const userId = claims['https://api.openai.com/auth']?.chatgpt_user_id || claims.sub;
  if (!accountId || !userId || !cache.tokens.access_token || !cache.tokens.refresh_token || (cache.auth_mode && cache.auth_mode !== 'chatgpt') || cache.OPENAI_API_KEY) throw Error('A managed ChatGPT file login is required.');
  return { accountId: String(accountId), userId: String(userId), email: typeof claims.email === 'string' ? claims.email.slice(0, 254) : 'ChatGPT', planType: claims['https://api.openai.com/auth']?.chatgpt_plan_type || null };
}
export function sameIdentity(a, b) { return a?.accountId === b?.accountId && a?.userId === b?.userId; }
export function windowsVault(op, value) {
  if (process.platform !== 'win32') return Promise.reject(Error('Account switching requires the Windows connector.'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/account-vault.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, settled = false;
    const fail = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(Error('Windows account vault unavailable.')); };
    const timer = setTimeout(fail, 15000);
    child.stdout.on('data', b => { size += b.length; if (size > 256 * 1024) fail(); else chunks.push(b); });
    child.stderr.resume(); child.on('error', fail); child.stdin.on('error', fail);
    child.on('exit', code => { if (code !== 0) return fail(); if (settled) return; settled = true; clearTimeout(timer); const out = Buffer.concat(chunks).toString('utf8').trim(); resolve(op === 'secure' ? true : Buffer.from(out, 'base64')); });
    child.stdin.end(JSON.stringify(op === 'secure' ? { op, path: value } : { op, value: Buffer.from(value).toString('base64') }));
  });
}
export class AccountVault {
  constructor(root, protect = windowsVault) { this.root = path.resolve(root); this.protect = protect; this.file = path.join(this.root, 'accounts.json'); }
  async ready() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.protect('secure', this.root); }
  async rows() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 30 || data.accounts.some(a => !UUID.test(a.key) || typeof a.protectedCache !== 'string' || !a.accountId || !a.userId)) throw Error('Invalid account vault.');
      return data.accounts;
    } catch (e) { if (e.code === 'ENOENT') return []; throw Error('Account vault is invalid; no credentials were changed.'); }
  }
  async save(bytes) {
    const identity = cacheIdentity(bytes), rows = await this.rows();
    let row = rows.find(a => sameIdentity(a, identity));
    if (!row) { if (rows.length >= 30) throw Error('Account vault is full.'); row = { key: randomUUID() }; rows.push(row); }
    Object.assign(row, identity, { updatedAt: Date.now(), protectedCache: (await this.protect('protect', bytes)).toString('base64') });
    await writeFile(this.file + '.tmp', JSON.stringify({ version: 1, accounts: rows }), { mode: 0o600 }); await rename(this.file + '.tmp', this.file);
    return this.public(row);
  }
  public(row) { const { key, email, planType, updatedAt } = row; return { key, email, planType, updatedAt }; }
  async get(key) { if (!UUID.test(key || '')) throw Error('Invalid account selection.'); const row = (await this.rows()).find(a => a.key === key); if (!row) throw Error('Saved account no longer exists.'); const bytes = await this.protect('unprotect', Buffer.from(row.protectedCache, 'base64')); if (!sameIdentity(row, cacheIdentity(bytes))) throw Error('Account vault identity mismatch.'); return { row, bytes }; }
}
