// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { RemoteDesktop } from '../src/remote-desktop.mjs';

async function fixture(t, mode) {
  let reads = 0, writes = 0, receipts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/receipts/')) { receipts++; res.end('{"result":null}'); return; }
    let input = ''; for await (const chunk of req) input += chunk;
    const { method } = JSON.parse(input);
    if (method === 'listThreads') {
      reads++;
      if (mode === 'reject') { res.writeHead(400); res.end('{"error":"Protocol rejected"}'); }
      else if (mode === 'offline' || reads === 1) req.socket.destroy();
      else res.end('{"result":[{"id":"chat"}]}');
    } else { writes++; req.socket.destroy(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const remote = new RemoteDesktop(`http://127.0.0.1:${server.address().port}`, 'test-secret-'.repeat(5));
  t.after(async () => { remote.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { remote, counts: () => ({ reads, writes, receipts }) };
}

test('a transient read disconnect retries once and recovers the catalog', async t => {
  const f = await fixture(t, 'transient');
  assert.deepEqual(await f.remote.listThreads('', 10, 0), [{ id: 'chat' }]);
  assert.deepEqual(f.counts(), { reads: 2, writes: 0, receipts: 0 });
});

test('persistent read failure is bounded and an explicit rejection is never retried', async t => {
  const offline = await fixture(t, 'offline'); await assert.rejects(offline.remote.listThreads());
  assert.equal(offline.counts().reads, 2);
  const rejected = await fixture(t, 'reject'); await assert.rejects(rejected.remote.listThreads(), /Protocol rejected/);
  assert.equal(rejected.counts().reads, 1);
});

test('lost control response only reads the receipt and never repeats the control command', async t => {
  const f = await fixture(t, 'transient');
  await assert.rejects(f.remote.request('thread-follower-start-turn', { conversationId: randomUUID(), turnStart: { request: { clientUserMessageId: randomUUID() } } }, 'desktop'));
  assert.deepEqual(f.counts(), { reads: 0, writes: 1, receipts: 1 });
  await f.remote.follow('chat', 'desktop');
  assert.equal(f.counts().writes, 2);
});
