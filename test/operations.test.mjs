// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { port, tunnelOptions } from '../src/config.mjs';
import { acquirePidLock } from '../src/pid-lock.mjs';
import { startConnector } from '../src/connector-supervisor.mjs';

const environment = { CONNECTOR_SECRET: 'fixture-'.repeat(8), CONNECTOR_SSH_HOST: 'server.example.com', CONNECTOR_SSH_USER: 'codexbridge' };
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-ops-'));
  t.after(() => rm(root, { recursive: true, force: true })); return path.join(root, 'project with spaces');
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(r => server.close(r)); return value;
}
function child() {
  const value = new EventEmitter(); value.stderr = new PassThrough();
  value.kill = () => value.emit('close', 0); return value;
}

test('configuration rejects unsafe endpoints and malformed ports before startup', () => {
  for (const value of ['0', '-1', '65536', '80/abc', '3.14', ' 22 ']) assert.throws(() => port(value, 22, 'SSH'));
  assert.equal(port('', 22, 'SSH'), 22);
  for (const override of [{ CONNECTOR_SSH_HOST: '-oProxyCommand=bad' }, { CONNECTOR_SSH_HOST: 'a b' }, { CONNECTOR_SSH_USER: 'root@other' }, { CONNECTOR_SECRET: 'short' }, { CONNECTOR_REMOTE_PORT: 'x' }]) assert.throws(() => tunnelOptions({ ...environment, ...override }));
  const options = tunnelOptions({ ...environment, CONNECTOR_SSH_HOST: '::1', CONNECTOR_SSH_KEY: 'data/custom key', CONNECTOR_KNOWN_HOSTS: 'data/pins' }, '/project');
  assert.equal(options.sshPort, 22); assert.equal(options.keyFile, path.resolve('/project', 'data/custom key'));
});

test('fresh process locks create the data folder, reject duplicates and recover stale PIDs', async t => {
  const root = await temporary(t), file = path.join(root, 'data', 'service.pid');
  const release = acquirePidLock(file, 'fixture');
  assert.equal(await readFile(file, 'utf8'), String(process.pid));
  assert.throws(() => acquirePidLock(file, 'fixture'), /already running/);
  release(); await assert.rejects(access(file));
  await writeFile(file, 'invalid stale PID'); const releaseNew = acquirePidLock(file, 'fixture');
  await writeFile(file, '999999'); releaseNew(); assert.equal(await readFile(file, 'utf8'), '999999');
});

test('fresh connector boots without preexisting data and confines SSH to pinned loopback forwarding', async t => {
  const root = await temporary(t), calls = [], localPort = await freePort();
  const instance = startConnector({ root, env: { ...environment, CONNECTOR_PORT: String(localPort) }, spawnSsh: (...args) => { calls.push(args); return child(); } });
  t.after(() => instance.stop()); await once(instance.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${localPort}/health`, { headers: { authorization: `Bearer ${environment.CONNECTOR_SECRET}` } });
  assert.equal(response.status, 200); assert.equal(instance.server.address().address, '127.0.0.1');
  const [, args, options] = calls[0];
  assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes(`127.0.0.1:27841:127.0.0.1:${localPort}`));
  assert.ok(args.includes(`UserKnownHostsFile=${path.join(root, 'data', 'connector_known_hosts')}`));
  assert.equal(options.windowsHide, true);
  await instance.stop(); await assert.rejects(access(path.join(root, 'data', 'connector.pid')));
});

test('SSH spawn errors and close events schedule one reconnect and stop cancels it', async t => {
  const root = await temporary(t), children = [], localPort = await freePort();
  const instance = startConnector({ root, retryMs: 20, env: { ...environment, CONNECTOR_PORT: String(localPort) }, spawnSsh: () => {
    const value = child(); children.push(value);
    if (children.length === 1) queueMicrotask(() => { value.emit('error', Error('missing executable')); value.emit('close', -1); });
    return value;
  } });
  t.after(() => instance.stop()); await once(instance.server, 'listening');
  const deadline = Date.now() + 2000;
  while (children.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(children.length, 2); await instance.stop();
  await new Promise(r => setTimeout(r, 60)); assert.equal(children.length, 2);
});

test('invalid fresh connector configuration leaves no PID lock', async t => {
  const root = await temporary(t);
  assert.throws(() => startConnector({ root, env: { ...environment, CONNECTOR_SSH_PORT: 'invalid' } }));
  await assert.rejects(access(path.join(root, 'data', 'connector.pid')));
});
