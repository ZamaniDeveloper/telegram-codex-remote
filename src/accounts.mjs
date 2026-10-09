// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { readFile, writeFile, rename, mkdir, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountVault, cacheIdentity, sameIdentity, UUID } from './account-vault.mjs';
import { openLoginRpc } from './account-rpc.mjs';
import { WindowsAccountRuntime, assertRetained, fileStoreConfig } from './account-runtime.mjs';

const TTL = 15 * 60 * 1000;
const optional = async file => { try { return await readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export class Accounts {
  busy = false; pending = null; tail = Promise.resolve(); readyPromise = null;
  constructor({ home = process.env.CODEX_HOME || path.join(homedir(), '.codex'), root = fileURLToPath(new URL('../data/account-vault/', import.meta.url)), vault, rpc = openLoginRpc, runtime, ipc } = {}) {
    this.home = path.resolve(home); this.root = path.resolve(root); this.vault = vault || new AccountVault(this.root); this.rpc = rpc; this.runtime = runtime || new WindowsAccountRuntime(this.home, ipc);
  }
  serial(operation) { const next = this.tail.then(operation); this.tail = next.catch(() => {}); return next; }
  async ready() {
    if (!this.readyPromise) this.readyPromise = (async () => {
      await this.vault.ready(); await mkdir(path.join(this.root, 'operations'), { recursive: true });
      // A connector restart cancels login workers. Remove only our private
      // staging directories; never touch CODEX_HOME or project directories.
      for (const name of await readdir(this.root)) if (/^login-[\da-f-]{36}$/i.test(name)) await this.clean(path.join(this.root, name));
    })().catch(e => { this.readyPromise = null; throw e; });
    return this.readyPromise;
  }
  async clean(dir) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== this.root || !/^login-[\da-f-]{36}$/i.test(path.basename(resolved))) throw Error('Invalid login staging directory.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
  async current() {
    const bytes = await optional(path.join(this.home, 'auth.json'));
    if (!bytes) return null;
    return { ...await this.vault.save(bytes), identity: cacheIdentity(bytes), bytes };
  }
  publicPending(p) { return p ? { key: p.key, status: p.status, expiresAt: p.expiresAt, account: p.account || null, ...(p.status === 'waiting' ? { verificationUrl: p.verificationUrl, userCode: p.userCode } : {}) } : null; }
  read() { return this.serial(async () => { await this.ready(); const current = await this.current(); return { current: current ? { key: current.key, email: current.email, planType: current.planType } : null, accounts: (await this.vault.rows()).map(row => this.vault.public(row)), pending: this.publicPending(this.pending), switching: this.busy }; }); }
  start(value) {
    return this.serial(async () => {
      if (!UUID.test(value?.key || '')) throw Error('Invalid login request.');
      await this.ready();
      if (this.pending?.key === value.key) return this.publicPending(this.pending);
      if (this.pending && ['starting', 'waiting'].includes(this.pending.status)) throw Error('A login is already pending. Finish or cancel it first.');
      const dir = path.join(this.root, 'login-' + value.key); await mkdir(dir, { mode: 0o700 });
      const p = { key: value.key, dir, status: 'starting', expiresAt: Date.now() + TTL }; this.pending = p;
      try {
        p.rpc = await this.rpc(dir);
        p.rpc.on('completed', event => { p.completion = event; if (p.loginId) void this.serial(() => this.finish(p, event)).catch(() => {}); });
        p.rpc.on('closed', () => { if (p.status === 'waiting') void this.serial(() => this.finish(p, { success: false })).catch(() => {}); });
        const r = await p.rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
        const url = new URL(r?.verificationUrl);
        if (r.type !== 'chatgptDeviceCode' || !UUID.test(r.loginId || '') || url.origin !== 'https://auth.openai.com' || url.pathname !== '/codex/device' || url.search || url.hash || !/^[A-Z\d-]{4,32}$/i.test(r.userCode || '')) throw Error('Unsupported Codex device-login response. Check Compatibility.');
        Object.assign(p, { loginId: r.loginId, verificationUrl: url.href, userCode: r.userCode, status: 'waiting' });
        p.timer = setTimeout(() => void this.serial(() => this.cancelPending(p, 'expired')).catch(() => {}), TTL); p.timer.unref?.();
        if (p.completion) await this.finish(p, p.completion);
        return this.publicPending(p);
      } catch (e) { await this.cancelPending(p, 'failed'); throw e; }
    });
  }
  async finish(p, event) {
    if (this.pending !== p || p.status !== 'waiting' || (event.loginId && event.loginId !== p.loginId)) return;
    clearTimeout(p.timer); p.status = 'failed';
    try { if (event.success) { p.account = await this.vault.save(await readFile(path.join(p.dir, 'auth.json'))); p.status = 'complete'; } }
    finally { await p.rpc.close(); await this.clean(p.dir); delete p.userCode; }
  }
  async cancelPending(p, status) {
    clearTimeout(p.timer); p.status = status;
    try { if (p.loginId && p.rpc && !p.rpc.closed) await p.rpc.request('account/login/cancel', { loginId: p.loginId }); } catch {}
    await p.rpc?.close(); await this.clean(p.dir); delete p.userCode;
  }
  cancel(value) { return this.serial(async () => { if (!UUID.test(value?.key || '') || this.pending?.key !== value.key || !['starting', 'waiting'].includes(this.pending.status)) throw Error('This login is no longer pending.'); await this.cancelPending(this.pending, 'cancelled'); return this.publicPending(this.pending); }); }
  async freshAccount(key, requestId) {
    const saved = await this.vault.get(key), dir = path.join(this.root, 'login-' + requestId);
    await mkdir(dir, { mode: 0o700 }); let rpc;
    try {
      await writeFile(path.join(dir, 'auth.json'), saved.bytes, { mode: 0o600 }); rpc = await this.rpc(dir);
      const result = await rpc.request('account/read', { refreshToken: true });
      const bytes = await readFile(path.join(dir, 'auth.json'));
      if (result.account?.type !== 'chatgpt' || !sameIdentity(saved.row, cacheIdentity(bytes))) throw Error('Saved login is invalid. Add this account again.');
      await this.vault.save(bytes); return bytes;
    } finally { await rpc?.close(); await this.clean(dir); }
  }
  activate(value) {
    return this.serial(async () => {
      if (!UUID.test(value?.key || '') || !UUID.test(value?.requestId || '') || (value.expectedCurrentKey !== null && !UUID.test(value?.expectedCurrentKey || ''))) throw Error('Invalid account activation request.');
      await this.ready(); const journal = path.join(this.root, 'operations', value.requestId + '.json');
      const existing = await optional(journal);
      if (existing) {
        const saved = JSON.parse(existing);
        if (saved.key !== value.key) throw Error('Activation request identity changed.');
        if (saved.status === 'complete') return saved.result;
        throw Error('This activation has an uncertain or failed outcome. Inspect the account screen before trying another activation.');
      }
      if (this.pending && ['starting', 'waiting'].includes(this.pending.status)) throw Error('Finish or cancel the pending login before switching.');
      if (await this.runtime.busy()) throw Error('Codex is still working. Wait for all active chats to finish before switching accounts.');
      let current = await this.current();
      if ((current?.key || null) !== value.expectedCurrentKey) throw Error('The active account changed. Reopen Accounts before switching.');
      if (current?.key === value.key) return { outcome: 'unchanged', account: { key: current.key, email: current.email, planType: current.planType } };
      this.busy = true; let stopped = false, changed = false, stopAttempted = false, config, before, phase = 'preparing', recoveryPhase = null;
      try {
        const bytes = await this.freshAccount(value.key, value.requestId), desktop = await this.runtime.inspect();
        if (!desktop?.pid) throw Error('Open Codex on Windows before switching accounts.');
        before = await this.runtime.inventory();
        if (await this.runtime.busy()) throw Error('A Codex task started during preparation. Finish it before switching.');
        // Refreshing another profile cannot overwrite the current account.
        const previous = await this.current();
        if ((previous?.key || null) !== value.expectedCurrentKey) throw Error('The active account changed during preparation.');
        current = previous;
        config = await optional(path.join(this.home, 'config.toml'));
        await writeFile(journal, JSON.stringify({ key: value.key, status: 'activating', previousKey: previous?.key || null }), { flag: 'wx', mode: 0o600 });
        phase = 'stopping'; stopAttempted = true; await this.runtime.stop(desktop.pid); stopped = true;
        phase = 'backingUp';
        await this.runtime.backup(path.join(this.root, 'operations', value.requestId));
        phase = 'writingCredentials';
        await this.writeAuth(bytes); changed = true;
        await writeFile(path.join(this.home, 'config.toml'), fileStoreConfig(config?.toString('utf8') || ''), { mode: 0o600 });
        phase = 'starting'; stopped = false; await this.runtime.start();
        phase = 'verifying';
        assertRetained(before, await this.runtime.inventory());
        const active = await this.current();
        if (active?.key !== value.key) throw Error('The new account was not verified.');
        const result = { outcome: 'switched', account: { key: active.key, email: active.email, planType: active.planType }, retainedProjects: before.projects.length, retainedChats: before.threads.length };
        await writeFile(journal, JSON.stringify({ key: value.key, status: 'complete', result }), { mode: 0o600 }); return result;
      } catch (e) {
        // Rollback only after a stopped desktop: never replace credentials below
        // an active process. Retain the journal if recovery cannot be verified.
        let recovered = !changed, recoveryCode = null;
        try {
          recoveryPhase = 'stopping';
          if (changed) { if (!stopped) { const desktop = await this.runtime.inspect(); if (desktop) { if (await this.runtime.busy()) throw Error('Recovery requires idle Codex.'); await this.runtime.stop(desktop.pid); } stopped = true; }
            recoveryPhase = 'restoringCredentials';
            if (current) await this.writeAuth(current.bytes); else await rm(path.join(this.home, 'auth.json'), { force: true });
            if (config) await writeFile(path.join(this.home, 'config.toml'), config, { mode: 0o600 }); else await rm(path.join(this.home, 'config.toml'), { force: true }); recovered = true;
          }
          if (stopAttempted && !changed && !stopped && !await this.runtime.inspect()) stopped = true;
          if (stopped) { recoveryPhase = 'starting'; stopped = false; await this.runtime.start(); }
          recoveryPhase = 'verifying';
          if (stopAttempted && before) assertRetained(before, await this.runtime.inventory());
          if (changed && (await this.current())?.key !== (current?.key || undefined)) throw Error('Recovered account identity was not verified.');
        } catch (recoveryError) { recovered = false; recoveryCode = diagnosticCode(recoveryError); }
        // Persist only phases and allow-listed codes, never raw authentication
        // errors or token-bearing server payloads.
        if (await optional(journal)) await writeFile(journal, JSON.stringify({ key: value.key, status: recovered ? 'failed' : 'uncertain', previousKey: current?.key || null, phase, errorCode: diagnosticCode(e), recoveryPhase, recoveryCode, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        if (!recovered) throw Error('Account activation needs recovery on Windows. Requests were not retried; inspect Codex and the account screen.');
        throw e;
      } finally { this.busy = false; }
    });
  }
  async writeAuth(bytes) { const file = path.join(this.home, 'auth.json'); await writeFile(file + '.telecodex.tmp', bytes, { mode: 0o600 }); await rename(file + '.telecodex.tmp', file); }
  async close() { if (this.pending && ['starting', 'waiting'].includes(this.pending.status)) await this.serial(() => this.cancelPending(this.pending, 'cancelled')); }
}
function diagnosticCode(error) {
  return /^CODEX_(RECONNECT_TIMEOUT|DESKTOP_(INSPECT|START|STOP)_FAILED)$/.test(error?.code || '') ? error.code : 'ACCOUNT_OPERATION_FAILED';
}
