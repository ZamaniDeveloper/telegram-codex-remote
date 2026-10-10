// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopRecovery } from '../src/desktop-recovery.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { Bridge } from '../src/bridge.mjs';

function fixture() {
  const calls = [], ipc = { connect: async () => calls.push('connect') };
  const runtime = { inspect: async () => null, start: async () => calls.push('start') };
  return { calls, ipc, runtime };
}
test('closed desktop is reopened; running desktop is reattached without restart', async () => {
  const { calls, ipc, runtime } = fixture(); const recovery = new DesktopRecovery(ipc, { runtime });
  await recovery.ensure(); assert.deepEqual(calls, ['start']);
  runtime.inspect = async () => ({ pid: 42 }); await recovery.ensure();
  assert.deepEqual(calls, ['start', 'connect']); await recovery.stop();
});
test('recovery is single-flight and waits for startup to finish', async () => {
  const { calls, ipc, runtime } = fixture(); let finish;
  runtime.start = () => { calls.push('start'); return new Promise(r => { finish = r; }); };
  const recovery = new DesktopRecovery(ipc, { runtime });
  const first = recovery.ensure(); await Promise.resolve();
  assert.equal(recovery.ensure(), first); let drained = false;
  const drain = recovery.drain().then(() => { drained = true; });
  assert.equal(drained, false); finish(); await drain; assert.equal(calls.length, 1); await recovery.stop();
});
test('account-switch guard is checked again after inspection and stop cancels future launches', async () => {
  const { calls, ipc, runtime } = fixture(); let blocked = false, finish;
  runtime.inspect = () => new Promise(r => { finish = r; });
  const recovery = new DesktopRecovery(ipc, { runtime, blocked: () => blocked });
  const pending = recovery.ensure(); blocked = true; finish(null); await pending;
  assert.deepEqual(calls, []); await recovery.ensure(); await recovery.stop();
  blocked = false; await recovery.ensure(); assert.deepEqual(calls, []);
});
test('failed startup retries recovery only and logs no private error payload', async () => {
  const { calls, ipc, runtime } = fixture(); const reports = [];
  runtime.start = async () => { throw Error('private credential payload'); };
  const recovery = new DesktopRecovery(ipc, { runtime, report: value => reports.push(value) });
  await recovery.ensure(); await recovery.ensure();
  assert.equal(reports.filter(r => r === 'unavailable').length, 1);
  assert.ok(!reports.join().includes('credential')); runtime.start = async () => calls.push('start');
  await recovery.ensure(); assert.equal(reports.at(-1), 'ready'); await recovery.stop();
});
test('timer continues after an existing desktop closes and stops cleanly', async () => {
  const { calls, ipc, runtime } = fixture(); let open = true;
  runtime.inspect = async () => open ? { pid: 42 } : null;
  runtime.start = async () => { calls.push('start'); open = true; };
  const recovery = new DesktopRecovery(ipc, { runtime, intervalMs: 5 }); recovery.start();
  await recovery.drain(); open = false;
  const deadline = Date.now() + 1000;
  while (!calls.includes('start') && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  await recovery.stop(); assert.equal(calls.filter(c => c === 'start').length, 1);
  const count = calls.length; await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, count);
});
test('connector account activation waits for recovery and recovery does not relaunch during switching', async t => {
  const ipc = new EventEmitter(); ipc.connect = async () => {}; ipc.close = () => {};
  let finish, inspected = 0, activated = false;
  const runtime = { inspect: async () => { inspected++; return null; }, start: () => new Promise(r => { finish = r; }) };
  const accounts = { close: async () => {}, activate: async () => { activated = true; return { outcome: 'unchanged' }; } };
  const secret = 'test-secret-'.repeat(4);
  const server = createConnector({ secret, ipc, accounts, desktopRecovery: true, recoveryRuntime: runtime });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.shutdown());
  await Promise.resolve();
  const request = fetch(`http://127.0.0.1:${server.address().port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'accountActivate', args: [{}] }) });
  await new Promise(r => setTimeout(r, 20)); assert.equal(activated, false); finish();
  const response = await request; assert.equal(response.status, 200); assert.equal(activated, true); assert.equal(inspected, 1);
});
test('reconnect restores selected chat through URI once, then follows without resending a turn', async () => {
  const ipc = new EventEmitter(), calls = []; let open = false;
  ipc.connect = async () => {};
  ipc.owner = async () => { if (!open) throw Error('closed'); return 'owner'; };
  ipc.openThread = async id => calls.push(['open', id]);
  ipc.follow = async (...args) => calls.push(['follow', ...args]);
  ipc.request = async () => { throw Error('must never resend'); };
  const bridge = new Bridge({}, 1, ipc); const selected = { id: '12345678-1234-1234-1234-123456789abc', owner: null, synced: false };
  bridge.selected = selected; bridge.watched.set(selected.id, selected);
  bridge.watched.set('87654321-1234-1234-1234-123456789abc', { id: '87654321-1234-1234-1234-123456789abc', owner: null });
  await bridge.reconnect(); await bridge.reconnect(); assert.deepEqual(calls, [['open', selected.id]]);
  open = true; await bridge.reconnect(); assert.equal(selected.owner, 'owner'); assert.equal(calls[1][0], 'follow');
  bridge.accountSwitching = true; selected.owner = null; const before = calls.length;
  await bridge.reconnect(); assert.equal(calls.length, before);
});
