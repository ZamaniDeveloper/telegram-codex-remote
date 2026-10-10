// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DesktopIpc, VERSIONS } from './ipc.mjs';
import { listThreads } from './catalog.mjs';
import { AttachmentStore } from './attachments.mjs';
import { QuotaClient, validateReset } from './quota-client.mjs';
import { DesktopControl } from './desktop-control.mjs';
import { Transcriber } from './transcription.mjs';
import { LiveStream } from './live-stream.mjs';
import { Accounts } from './accounts.mjs';
import { DesktopRecovery } from './desktop-recovery.mjs';

export function createConnector({ secret, ipc = new DesktopIpc(), catalog = listThreads, openThread, attachments = new AttachmentStore(), quota = new QuotaClient(), control = new DesktopControl(), transcriber = new Transcriber(), accounts = new Accounts({ ipc }), desktopRecovery = process.platform === 'win32' && ipc instanceof DesktopIpc && ipc.pipe === '\\\\.\\pipe\\codex-ipc' && process.env.CONNECTOR_AUTO_START_CODEX !== '0', recoveryRuntime } = {}) {
  if (!secret || secret.length < 32) throw Error('Connector secret must be at least 32 characters');
  const clients = new Set(), stream = new LiveStream();
  let activeRpc = 0, accountChanging = false;
  const recovery = desktopRecovery ? new DesktopRecovery(ipc, { ...(recoveryRuntime ? { runtime: recoveryRuntime } : {}), blocked: () => accountChanging || accounts.busy, report: status => console.log('Codex desktop recovery:', status) }) : null;
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
      if (accountChanging && method !== 'accountsRead') throw Error('Account switch in progress. Wait for Codex to reconnect.');
      if (method === 'accountActivate') {
        if (activeRpc) throw Error('Another connector operation is running. Try switching after it finishes.');
        accountChanging = true;
      }
      activeRpc++;
      try {
      if (method === 'listThreads') result = await catalog(String(args[0] || '').slice(0, 200), Math.min(20, Math.max(1, Number(args[1]) || 10)), Math.max(0, Number(args[2]) || 0));
      else if (method === 'accountsRead' && args.length === 0) result = await accounts.read();
      else if (method === 'accountLoginStart' && args.length === 1) result = await accounts.start(args[0]);
      else if (method === 'accountLoginCancel' && args.length === 1) result = await accounts.cancel(args[0]);
      else if (method === 'accountActivate' && args.length === 1) { await recovery?.drain(); result = await accounts.activate(args[0]); }
      else if (method === 'quotaRead' && args.length === 0) result = await quota.read();
      else if (method === 'quotaReset' && args.length === 1) result = await quota.consume(validateReset(args[0]));
      else if (method === 'models' && args.length === 0) result = await control.models();
      else if (method === 'projects' && args.length === 0) result = await control.projects();
      else if (method === 'latestMessage' && args.length === 1) result = await control.latestMessage(args[0]);
      else if (method === 'createChat' && args.length === 1) result = await control.create(args[0]);
      else if (method === 'compatibilityRead' && args.length <= 1) result = await ipc.compatibilityRead(Boolean(args[0]));
      else if (method === 'transcriptionStatus' && args.length === 0) result = await transcriber.status();
      else if (method === 'transcribeAttachment' && args.length === 1) result = await transcriber.transcribe(args[0], attachments.root);
      else if (method === 'owner') result = await ipc.owner(args[0]);
      else if (method === 'follow') { await ipc.connect(); if (args[2] === false) stream.forget(args[0]); await ipc.follow(...args); result = true; }
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
      } finally { activeRpc--; if (method === 'accountActivate') accountChanging = false; }
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  const broadcast = m => {
    m = stream.project(m);
    for (const client of clients) {
      if (client.writableLength > 32 * 1024 * 1024) { client.destroy(); continue; }
      client.write(`data: ${JSON.stringify({ type: 'broadcast', message: m })}\n\n`);
    }
  };
  const disconnected = () => { stream.clear(); for (const client of clients) client.write('data: {"type":"disconnected"}\n\n'); };
  ipc.on('broadcast', broadcast); ipc.on('disconnected', disconnected);
  server.once('listening', () => recovery?.start());
  server.on('close', () => { void recovery?.stop(); ipc.off('broadcast', broadcast); ipc.off('disconnected', disconnected); });
  server.shutdown = async () => { await recovery?.stop(); await accounts.close(); for (const c of clients) c.end(); ipc.close(); await new Promise(r => server.close(r)); };
  return server;
}
