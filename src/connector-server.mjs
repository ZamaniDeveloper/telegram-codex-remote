// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DesktopIpc, VERSIONS } from './ipc.mjs';
import { listThreads } from './catalog.mjs';
import { AttachmentStore } from './attachments.mjs';
import { QuotaClient, validateReset } from './quota-client.mjs';

export function createConnector({ secret, ipc = new DesktopIpc(), catalog = listThreads, openThread, attachments = new AttachmentStore(), quota = new QuotaClient() } = {}) {
  if (!secret || secret.length < 32) throw Error('Connector secret must be at least 32 characters');
  const clients = new Set();
  const authorized = header => {
    const a = Buffer.from(header || ''); const b = Buffer.from(`Bearer ${secret}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin || !authorized(req.headers.authorization)) return json(res, 403, { error: 'Forbidden' });
    const upload = /^\/attachments\/([\da-f-]{36})\/([\da-f-]{36})$/i.exec(req.url);
    if (upload && req.method === 'POST') {
      try {
        const meta = { batchId: upload[1], id: upload[2], name: decodeURIComponent(req.headers['x-file-name'] || 'file'),
          size: Number(req.headers['x-file-size']), sha256: req.headers['x-file-sha256'] };
        return json(res, 200, { result: await attachments.put(meta, req) });
      } catch { return json(res, 400, { error: 'انتقال فایل کامل نشد یا مشخصات فایل معتبر نیست.' }); }
    }
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { ready: true, protocol: 1 });
    if (req.url === '/events' && req.method === 'GET') {
      if (clients.size >= 4) return json(res, 503, { error: 'Too many subscribers' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': connected\n\n'); clients.add(res);
      const keepAlive = setInterval(() => res.write(': heartbeat\n\n'), 10000);
      res.on('close', () => { clearInterval(keepAlive); clients.delete(res); }); return;
    }
    if (req.url !== '/rpc' || req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    try {
      const chunks = []; let size = 0;
      for await (const b of req) { size += b.length; if (size > 1024 * 1024) throw Error('Request too large'); chunks.push(b); }
      const { method, args = [] } = JSON.parse(Buffer.concat(chunks).toString('utf8')); let result;
      if (!Array.isArray(args)) throw Error('Invalid arguments');
      if (method === 'listThreads') result = await catalog(String(args[0] || '').slice(0, 200), Math.min(20, Math.max(1, Number(args[1]) || 10)), Math.max(0, Number(args[2]) || 0));
      else if (method === 'quotaRead' && args.length === 0) result = await quota.read();
      else if (method === 'quotaReset' && args.length === 1) result = await quota.consume(validateReset(args[0]));
      else if (method === 'owner') result = await ipc.owner(args[0]);
      else if (method === 'follow') { await ipc.connect(); ipc.follow(...args); result = true; }
      else if (method === 'request') {
        if (!Object.hasOwn(VERSIONS, args[0]) || !args[0].startsWith('thread-follower-')) throw Error('RPC method not allowed');
        await ipc.connect(); result = await ipc.request(...args);
      } else if (method === 'openThread') {
        if (!/^[\da-f-]{36}$/i.test(args[0])) throw Error('Invalid thread ID');
        if (openThread) await openThread(args[0]);
        else await new Promise((resolve, reject) => {
          if (process.platform !== 'win32') return reject(Error('Windows connector required'));
          const child = spawn('explorer.exe', [`codex://threads/${args[0]}`], { windowsHide: true, stdio: 'ignore' });
          child.once('error', reject); child.once('spawn', resolve);
        });
        result = true;
      } else throw Error('RPC method not allowed');
      json(res, 200, { result });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  const broadcast = m => {
    for (const client of clients) {
      if (client.writableLength > 32 * 1024 * 1024) { client.destroy(); continue; }
      client.write(`data: ${JSON.stringify({ type: 'broadcast', message: m })}\n\n`);
    }
  };
  const disconnected = () => { for (const client of clients) client.write('data: {"type":"disconnected"}\n\n'); };
  ipc.on('broadcast', broadcast); ipc.on('disconnected', disconnected);
  server.on('close', () => { ipc.off('broadcast', broadcast); ipc.off('disconnected', disconnected); });
  server.shutdown = async () => { for (const c of clients) c.end(); ipc.close(); await new Promise(r => server.close(r)); };
  return server;
}
