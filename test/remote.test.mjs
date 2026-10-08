// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
import { AttachmentStore } from '../src/attachments.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const secret = 'test_secret_'.repeat(5);
class FakeIpc extends EventEmitter {
  calls = [];
  async connect() {}
  async owner(id) { return 'owner-of-' + id; }
  follow(id, owner) {
    this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: owner,
      params: { hostId: 'local', conversationId: id, change: { type: 'snapshot', revision: 0, conversationState: { id } } } });
  }
  async request(...args) { this.calls.push(args); return { result: { ok: true } }; }
  close() {}
}
async function fixture() {
  const ipc = new FakeIpc(); const server = createConnector({ secret, ipc, catalog: () => [{ id: 'a', title: 'آزمون' }] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { ipc, server, url, remote: new RemoteDesktop(url, secret) };
}
test('connector rejects missing auth, browser origins and unrestricted RPC', async () => {
  const { server, url } = await fixture();
  try {
    assert.equal((await fetch(url + '/health')).status, 403);
    assert.equal((await fetch(url + '/health', { headers: { authorization: `Bearer ${secret}`, origin: 'https://example.com' } })).status, 403);
    const response = await fetch(url + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ method: 'request', args: ['account/logout', {}] }) });
    assert.equal(response.status, 400);
  } finally { await server.shutdown(); }
});
test('remote catalog, live snapshot and control RPC cross the connector', async () => {
  const { ipc, server, remote } = await fixture();
  try {
    assert.equal((await remote.listThreads('', 10, 0))[0].title, 'آزمون');
    const owner = await remote.owner('a'); assert.equal(owner, 'owner-of-a');
    const snapshot = new Promise(r => remote.once('broadcast', r)); remote.follow('a', owner);
    assert.equal((await snapshot).params.change.conversationState.id, 'a');
    await remote.request('thread-follower-steer-turn', { conversationId: 'a' }, owner);
    assert.equal(ipc.calls[0][0], 'thread-follower-steer-turn');
    assert.equal(ipc.calls[0][2], owner);
  } finally { remote.close(); await server.shutdown(); }
});
test('remote endpoint must be localhost behind the SSH tunnel', () => {
  assert.throws(() => new RemoteDesktop('http://0.0.0.0:80', secret));
  assert.throws(() => new RemoteDesktop('http://public.example.com', secret));
});
test('authenticated binary transfer crosses the connector with original UTF-8 file bytes and checksum', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-upload-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AttachmentStore(path.join(root, 'inbox'));
  const server = createConnector({ secret, ipc: new FakeIpc(), attachments: store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`; const remote = new RemoteDesktop(url, secret);
  try {
    const bytes = Buffer.from('متن فایل فارسی 👋\n'.repeat(5000)); const source = path.join(root, 'source.txt'); await writeFile(source, bytes);
    const meta = { batchId: randomUUID(), id: randomUUID(), name: '../فایل فارسی.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const endpoint = `${url}/attachments/${meta.batchId}/${meta.id}`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: 'invalid' })).status, 403);
    const result = await remote.uploadAttachment(meta, source); assert.deepEqual(await readFile(result.path), bytes);
    assert.equal(result.image, false); assert.equal(result.sha256, meta.sha256); assert.ok(result.path.startsWith(store.root + path.sep));
    assert.equal((await remote.uploadAttachment(meta, source)).path, result.path);
    await assert.rejects(remote.uploadAttachment({ ...meta, sha256: '0'.repeat(64) }, source), /انتقال/);
  } finally { remote.close(); await server.shutdown(); }
});
test('large Persian RPC input remains intact across UTF-8 transport chunks', async () => {
  const { ipc, server, remote } = await fixture();
  try {
    const text = 'سلام 👋'.repeat(10000);
    await remote.request('thread-follower-start-turn', { input: [{ type: 'text', text }] }, 'owner');
    assert.equal(ipc.calls[0][1].input[0].text, text);
  } finally { remote.close(); await server.shutdown(); }
});
