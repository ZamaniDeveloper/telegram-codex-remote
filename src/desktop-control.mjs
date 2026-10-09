// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { codexExecutable } from './quota-client.mjs';
import { readLatestMessage } from './latest-message.mjs';

const ALLOWED = new Set(['model/list', 'project/list', 'project/create', 'thread/start', 'thread/name/set', 'thread/items/list']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ControlRpc {
  pending = new Map(); next = 0; closed = false;
  constructor(child, timeout = 45000) {
    this.child = child; this.timeout = timeout;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 8 * 1024 * 1024) return this.close();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const m = JSON.parse(line), p = this.pending.get(m.id); if (!p) continue;
          this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(Error('Codex rejected the operation. Check protocol compatibility; creation was not retried.'));
          else p.resolve(m.result);
        } catch { this.close(); }
      }
    });
    child.stderr.resume(); child.on('error', () => this.close()); child.on('exit', () => this.close()); child.stdin.on('error', () => this.close());
  }
  request(method, params) {
    if (method !== 'initialize' && !ALLOWED.has(method)) return Promise.reject(Error('Control RPC method not allowed'));
    if (this.closed) return Promise.reject(Error('Codex control process unavailable'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex control timeout; creation outcome may be unknown. Do not repeat blindly.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex control disconnected; outcome may be unknown.')); }
    this.pending.clear(); this.child.kill();
  }
}
export async function withControlRpc(operation) {
  const rpc = new ControlRpc(spawn(await codexExecutable(), ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  const deadline = setTimeout(() => rpc.close(), 120000);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'telecodex_control', version: '0.7.3' }, capabilities: { experimentalApi: true } });
    rpc.child.stdin.write('{"method":"initialized"}\n'); return await operation(rpc);
  } finally { clearTimeout(deadline); rpc.close(); }
}
export function projectFolder(name, root) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 80 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === '.' || name === '..') throw Error('Use a simple project name without path separators (1-80 characters).');
  return path.join(path.resolve(root), name);
}
export class DesktopControl {
  tail = Promise.resolve();
  constructor({ run = withControlRpc, root = process.env.TELECODEX_PROJECT_ROOT || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Documents', 'TeleCodex Projects'), journal = fileURLToPath(new URL('../data/creation-journal/', import.meta.url)) } = {}) {
    this.run = run; this.root = root; this.journal = journal;
  }
  serial(operation) { const next = this.tail.then(() => this.run(operation)); this.tail = next.catch(() => {}); return next; }
  async pages(rpc, method) {
    const rows = []; let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await rpc.request(method, { limit: 100, ...(cursor ? { cursor } : {}), ...(method === 'model/list' ? { includeHidden: false } : {}) });
      if (!Array.isArray(r?.data) || r.data.some(row => method === 'model/list' ? typeof row.model !== 'string' || !Array.isArray(row.supportedReasoningEfforts) : !ID.test(row.id || '') || !Array.isArray(row.roots))) throw Error('Codex catalog schema changed'); rows.push(...r.data); cursor = r.nextCursor;
      if (!cursor) return rows;
    }
    throw Error('Codex catalog exceeds supported page limit');
  }
  models() { return this.serial(rpc => this.pages(rpc, 'model/list')); }
  projects() { return this.serial(rpc => this.pages(rpc, 'project/list')); }
  latestMessage(id) { return this.serial(rpc => readLatestMessage(rpc, id)); }
  async create(value) {
    if (!value || !ID.test(value.key || '') || !['chat', 'project'].includes(value.kind) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || (value.projectId && !ID.test(value.projectId))) throw Error('Invalid creation request');
    await mkdir(this.journal, { recursive: true }); const file = path.join(this.journal, value.key + '.json');
    // Atomic exclusive intent prevents double clicks or lost HTTP responses creating duplicates.
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.status === 'complete' || saved.status === 'created') return saved.result;
      throw Error('This creation request has an uncertain outcome. Inspect Codex before starting another request.');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await writeFile(file, JSON.stringify({ status: 'creating', name: value.name }), { flag: 'wx', mode: 0o600 });
    return this.serial(async rpc => {
      let project;
      if (value.kind === 'project') {
        const folder = projectFolder(value.name, this.root);
        await mkdir(path.dirname(folder), { recursive: true }); await mkdir(folder); // Never overwrite an existing directory.
        const r = await rpc.request('project/create', { idempotencyKey: value.key, name: value.name, roots: [{ path: folder }] });
        project = r.project;
        if (!project || !ID.test(project.id || '') || !Array.isArray(project.roots)) throw Error('Codex project schema changed; inspect projects before retrying');
      } else if (value.projectId) {
        project = (await this.pages(rpc, 'project/list')).find(p => p.id === value.projectId);
        if (!project) throw Error('Selected project no longer exists');
      }
      const cwd = project?.roots?.[0]?.path;
      if (value.kind === 'chat' && !cwd) throw Error('Select a project before creating a chat');
      const r = await rpc.request('thread/start', { cwd, projectId: project.id, ephemeral: false });
      if (!ID.test(r.thread?.id || '')) throw Error('Codex thread schema changed; inspect desktop before retrying');
      // Persist identity before setting the title: later failure must never lose the created chat ID.
      const result = { id: r.thread.id, title: value.name, cwd, projectId: project.id };
      await writeFile(file, JSON.stringify({ status: 'created', result }), { mode: 0o600 });
      await rpc.request('thread/name/set', { threadId: result.id, name: value.name });
      await writeFile(file + '.tmp', JSON.stringify({ status: 'complete', result }), { mode: 0o600 }); await rename(file + '.tmp', file);
      return result;
    });
  }
}
