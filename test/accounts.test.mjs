// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Accounts } from '../src/accounts.mjs';
import { AccountVault, cacheIdentity, windowsVault } from '../src/account-vault.mjs';
import { localBusy, fileStoreConfig } from '../src/account-runtime.mjs';
import { LoginRpc } from '../src/account-rpc.mjs';
import { AccountUi } from '../src/account-ui.mjs';
import { Outbox } from '../src/outbox.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';

const cache = email => Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'fixture.' + Buffer.from(JSON.stringify({ sub: email, email, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-' + email, chatgpt_plan_type: 'plus' } })).toString('base64url') + '.fixture', account_id: 'workspace-' + email, access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }));
const protect = async (op, bytes) => op === 'secure' ? true : Buffer.from(bytes).map(b => b ^ 91);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-accounts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await mkdir(home); await writeFile(path.join(home, 'auth.json'), cache('first@example.invalid')); await writeFile(path.join(home, 'config.toml'), 'model = "fixture-model"\n[projects.test]\ntrust_level = "trusted"\n');
  const vault = new AccountVault(path.join(root, 'vault'), protect); await vault.ready();
  const workers = [], runtime = { calls: [], active: 0, failStart: 0, data: { projects: [{ id: 'P', name: 'Project' }], roots: [{ project_id: 'P', position: 0, path: 'C:/fixture' }], threads: ['T'] },
    async busy() { return this.active; }, async inspect() { return { pid: 123 }; }, async inventory() { return structuredClone(this.data); }, async stop() { this.calls.push('stop'); }, async backup() { this.calls.push('backup'); }, async start() { this.calls.push('start'); if (this.failStart-- > 0) throw Error('Fixture restart failure'); } };
  const rpc = async dir => {
    const worker = new EventEmitter(); worker.closed = false; worker.dir = dir; worker.calls = []; workers.push(worker);
    worker.request = async (method, params) => {
      worker.calls.push({ method, params });
      if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: randomUUID(), verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      return {};
    };
    worker.close = () => { worker.closed = true; worker.emit('closed'); }; return worker;
  };
  const accounts = new Accounts({ home, root: vault.root, vault, rpc, runtime }); t.after(() => accounts.close());
  return { root, home, vault, workers, runtime, accounts };
}
test('device login is isolated, cancellable and never changes active credentials', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.home, 'auth.json'));
  const first = await f.accounts.read(); assert.equal(first.accounts.length, 1); assert.equal(first.current.email, 'first@example.invalid'); assert.ok(!JSON.stringify(first).includes('fixture-access'));
  const key = randomUUID(), pending = await f.accounts.start({ key }); assert.equal(pending.status, 'waiting'); assert.equal(pending.userCode, 'ABCD-1234');
  assert.deepEqual(await f.accounts.start({ key }), pending); assert.equal(f.workers.length, 1);
  await assert.rejects(f.accounts.start({ key: randomUUID() }), /already pending/);
  await f.accounts.cancel({ key }); assert.equal((await f.accounts.read()).pending.status, 'cancelled');
  assert.deepEqual(await readFile(path.join(f.home, 'auth.json')), original); assert.equal(f.runtime.calls.length, 0);
  assert.ok(!JSON.stringify(await f.vault.rows()).includes('fixture-access'));
});
test('successful phone login stores a new encrypted profile without activating it', async t => {
  const f = await fixture(t); await f.accounts.read(); const key = randomUUID(); await f.accounts.start({ key });
  const p = f.accounts.pending; await writeFile(path.join(p.dir, 'auth.json'), cache('second@example.invalid')); f.workers[0].emit('completed', { loginId: p.loginId, success: true });
  const data = await f.accounts.read(); assert.equal(data.pending.status, 'complete'); assert.equal(data.accounts.length, 2); assert.equal(data.current.email, 'first@example.invalid'); assert.equal(f.workers[0].closed, true);
  assert.equal((await f.vault.get(data.pending.account.key)).row.email, 'second@example.invalid');
});
test('cancel waits for the login process to release Windows database files before cleanup', async t => {
  const f = await fixture(t), key = randomUUID(); await f.accounts.start({ key });
  let release; f.workers[0].close = () => new Promise(r => { release = r; });
  const cancelling = f.accounts.cancel({ key });
  while (!release) await new Promise(r => setTimeout(r, 1));
  await writeFile(path.join(f.accounts.pending.dir, 'worker-still-open.txt'), 'fixture');
  release(); await cancelling;
  await assert.rejects(readFile(path.join(f.accounts.pending.dir, 'worker-still-open.txt')), { code: 'ENOENT' });
});
test('activation guards all local work and stale selections before changing credentials', async t => {
  const f = await fixture(t), first = await f.accounts.read(), second = await f.vault.save(cache('second@example.invalid'));
  const value = { key: second.key, expectedCurrentKey: first.current.key, requestId: randomUUID() };
  f.runtime.active = 1; await assert.rejects(f.accounts.activate(value), /still working/); assert.equal(f.runtime.calls.length, 0);
  f.runtime.active = 0; await assert.rejects(f.accounts.activate({ ...value, expectedCurrentKey: randomUUID() }), /active account changed/);
  assert.equal(cacheIdentity(await readFile(path.join(f.home, 'auth.json'))).email, 'first@example.invalid');
});
test('activation restarts desktop once, retains projects/config and deduplicates completed requests', async t => {
  const f = await fixture(t), first = await f.accounts.read(), second = await f.vault.save(cache('second@example.invalid'));
  const value = { key: second.key, expectedCurrentKey: first.current.key, requestId: randomUUID() };
  const result = await f.accounts.activate(value); assert.equal(result.outcome, 'switched'); assert.equal(result.retainedProjects, 1);
  assert.equal((await f.accounts.read()).current.key, second.key); assert.deepEqual(f.runtime.calls, ['stop', 'backup', 'start']);
  const config = await readFile(path.join(f.home, 'config.toml'), 'utf8'); assert.ok(config.includes('[projects.test]')); assert.ok(config.includes('cli_auth_credentials_store = "file"'));
  assert.deepEqual(await f.accounts.activate(value), result); assert.equal(f.runtime.calls.length, 3);
  assert.deepEqual(f.runtime.data.threads, ['T']); assert.equal(f.workers[0].calls[0].params.refreshToken, true);
});
test('desktop restart failure restores previous credentials and config and cannot blindly replay', async t => {
  const f = await fixture(t), first = await f.accounts.read(), second = await f.vault.save(cache('second@example.invalid'));
  const original = await readFile(path.join(f.home, 'config.toml')); f.runtime.failStart = 1;
  const value = { key: second.key, expectedCurrentKey: first.current.key, requestId: randomUUID() };
  await assert.rejects(f.accounts.activate(value), /Fixture restart failure/);
  assert.equal((await f.accounts.read()).current.key, first.current.key); assert.deepEqual(await readFile(path.join(f.home, 'config.toml')), original); assert.equal(f.accounts.busy, false);
  await assert.rejects(f.accounts.activate(value), /uncertain or failed outcome/);
});
test('activity guard considers only the latest turn in every conversation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'telecodex-activity-')); t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, 'thread_history_1.sqlite')); db.exec("CREATE TABLE thread_turns(thread_id TEXT,rollout_ordinal INTEGER,status TEXT);INSERT INTO thread_turns VALUES ('old',1,'inProgress'),('old',2,'completed'),('other',1,'inProgress')"); db.close(); assert.equal(await localBusy(root), 1);
});
test('file-store configuration changes only the root credential option', () => {
  const config = 'cli_auth_credentials_store = "keyring"\nmodel = "test"\n[profiles.demo]\ncli_auth_credentials_store = "auto"\n';
  assert.equal(fileStoreConfig(config), config.replace('"keyring"', '"file"')); assert.ok(fileStoreConfig('[profiles.demo]\nmodel="x"').startsWith('cli_auth_credentials_store = "file"\n'));
});
test('authentication transport handles early notifications and denies tool/token RPCs', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const rpc = new LoginRpc(child), events = []; rpc.on('completed', e => events.push(e));
  child.stdout.write(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'fixture', success: true, error: 'secret-server-payload' } }) + '\n');
  assert.deepEqual(events, [{ loginId: 'fixture', success: true }]); await assert.rejects(rpc.request('thread/start', {})); await assert.rejects(rpc.request('account/logout', {})); rpc.close();
});
test('Windows DPAPI encrypts and decrypts synthetic credentials without plaintext storage', { skip: process.platform !== 'win32' }, async () => {
  const bytes = Buffer.from('synthetic vault roundtrip'); const encrypted = await windowsVault('protect', bytes); assert.notDeepEqual(encrypted, bytes); assert.deepEqual(await windowsVault('unprotect', encrypted), bytes);
});
test('account endpoints are authenticated, do not expose credentials and block competing RPC during activation', async t => {
  const f = await fixture(t), secret = 'fixture-account-connector-secret-'.repeat(2), ipc = new EventEmitter(); ipc.close = () => {};
  let release, started; const start = new Promise(r => { started = r; });
  const api = { read: () => f.accounts.read(), close: () => f.accounts.close(), async activate() { started(); await new Promise(r => { release = r; }); return { outcome: 'fixture' }; } };
  const server = createConnector({ secret, ipc, accounts: api }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`, remote = new RemoteDesktop(url, secret);
  try {
    const unauthorized = await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ method: 'accountsRead', args: [] }) }); assert.equal(unauthorized.status, 403);
    const data = await remote.accountsRead(); assert.equal(data.current.email, 'first@example.invalid'); assert.ok(!JSON.stringify(data).includes('fixture-access'));
    await assert.rejects(remote.rpc('account/logout', [])); await assert.rejects(remote.rpc('account/login/start', [{ type: 'apiKey', apiKey: 'fixture' }]));
    const switching = remote.accountActivate({}); await start;
    await assert.rejects(remote.quotaRead(), /switch in progress/); release(); assert.equal((await switching).outcome, 'fixture');
  } finally { release?.(); remote.close(); await server.shutdown(); }
});
test('account UI binds destination, requires explicit confirmation and pauses queued delivery', async t => {
  const f = await fixture(t), data = await f.accounts.read(), second = await f.vault.save(cache('second@example.invalid')), sent = [];
  const bridge = { chatId: 1, watched: new Map(), tg: { async send(chat, value, markup) { sent.push({ value, markup }); } }, ipc: { accountsRead: () => f.accounts.read(), async accountActivate(value) { assert.equal(bridge.accountSwitching, true); return f.accounts.activate(value); } }, outbox: new Outbox(path.join(f.root, 'outbox.json')) };
  const ui = new AccountUi(bridge); await ui.show(); const choose = sent[0].markup.inline_keyboard.flat().find(b => b.text.includes('second@example.invalid')); await ui.callback(choose.callback_data); assert.equal(f.runtime.calls.length, 0);
  const confirm = sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  await ui.callback(confirm); assert.equal((await f.accounts.read()).current.key, second.key); assert.equal(bridge.accountSwitching, false); await assert.rejects(ui.callback(confirm));
  bridge.accountSwitching = true; bridge.outbox.enqueue({ id: randomUUID() }, [{ type: 'text', text: 'queued' }], randomUUID()); await bridge.outbox.flush(bridge); assert.equal(bridge.outbox.entries[0].status, 'queued'); assert.equal(data.current.email, 'first@example.invalid');
});
