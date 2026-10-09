// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { DatabaseSync, backup } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function newestDatabase(home, prefix) {
  const names = (await readdir(home)).filter(n => new RegExp(`^${prefix}_\\d+\\.sqlite$`).test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!names.length) throw Error('Cannot verify local project/activity database. Open Codex and check Compatibility.');
  return path.join(home, names[0]);
}
export async function localBusy(home) {
  const db = new DatabaseSync(await newestDatabase(home, 'thread_history'), { readOnly: true });
  try {
    // Older unfinished records can precede a later completed turn. Only the
    // latest turn of each chat blocks switching, regardless of bot selection.
    return db.prepare("SELECT a.thread_id FROM thread_turns a WHERE a.status NOT IN ('completed','failed','interrupted') AND NOT EXISTS (SELECT 1 FROM thread_turns b WHERE b.thread_id=a.thread_id AND b.rollout_ordinal>a.rollout_ordinal)").all().length;
  } catch { throw Error('Cannot verify current Codex activity; account switch disabled.'); } finally { db.close(); }
}
export async function inventory(home) {
  const db = new DatabaseSync(await newestDatabase(home, 'state'), { readOnly: true });
  try { return { projects: db.prepare('SELECT id,name FROM projects ORDER BY id').all(), roots: db.prepare('SELECT project_id,position,path FROM project_roots ORDER BY project_id,position').all(), threads: db.prepare('SELECT id FROM threads ORDER BY id').all().map(r => r.id) }; }
  finally { db.close(); }
}
export function assertRetained(before, after) {
  for (const row of before.projects) if (!after.projects.some(p => p.id === row.id && p.name === row.name)) throw Error('Local project inventory changed during account activation.');
  for (const row of before.roots) if (!after.roots.some(p => p.project_id === row.project_id && p.position === row.position && p.path === row.path)) throw Error('Local project folders changed during account activation.');
  const ids = new Set(after.threads); if (before.threads.some(id => !ids.has(id))) throw Error('Local chat inventory changed during account activation.');
}
export function fileStoreConfig(text) {
  const at = text.search(/^\s*\[/m), head = at < 0 ? text : text.slice(0, at), tail = at < 0 ? '' : text.slice(at);
  return (head.match(/^\s*cli_auth_credentials_store\s*=/m) ? head.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, 'cli_auth_credentials_store = "file"') : 'cli_auth_credentials_store = "file"\n' + head) + tail;
}
export class WindowsAccountRuntime {
  constructor(home, ipc) { this.home = home; this.ipc = ipc; }
  busy() { return localBusy(this.home); }
  inventory() { return inventory(this.home); }
  async desktop(op, pid) {
    if (process.platform !== 'win32') throw Error('Account switching requires the Windows connector.');
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/account-desktop.ps1', import.meta.url)), '-Operation', op, ...(pid ? ['-DesktopPid', String(pid)] : [])], { windowsHide: true, timeout: 20000, maxBuffer: 65536 }).catch(() => { throw Error('Codex desktop operation failed; check the Windows connector.'); });
    return JSON.parse(stdout);
  }
  inspect() { return this.desktop('inspect'); }
  async stop(pid) { if (await this.busy()) throw Error('Codex started working; switch cancelled before closing the desktop.'); await this.desktop('stop', pid); this.ipc?.close(); }
  async start() {
    await this.desktop('start');
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try { await this.ipc.connect(); return; } catch {}
    }
    throw Error('Codex did not reconnect after the account change.');
  }
  async backup(root) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(await newestDatabase(this.home, 'state'), { readOnly: true });
    try { await backup(db, path.join(root, 'state.sqlite')); } finally { db.close(); }
    for (const file of ['.codex-global-state.json', 'config.toml']) try { await writeFile(path.join(root, file), await readFile(path.join(this.home, file)), { mode: 0o600 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
