// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export function extractVersions(source) {
  const anchor = source.indexOf('"thread-owner-discovery":');
  if (anchor < 0) return null;
  const start = source.lastIndexOf('{', anchor), end = source.indexOf('}', anchor);
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    if (!value['thread-stream-state-changed'] || !Object.values(value).every(Number.isSafeInteger)) return null;
    return value;
  } catch { return null; }
}
export function compareVersions(expected, observed) {
  return Object.keys(expected).filter(key => observed[key] !== expected[key]);
}
export class Compatibility {
  cached = null; checkedAt = 0;
  constructor(expected, inspect = inspectInstalledDesktop) { this.expected = expected; this.inspect = inspect; }
  async read(force = false) {
    if (!force && this.cached && Date.now() - this.checkedAt < 30000) return this.cached;
    try {
      const profile = await this.inspect();
      const incompatible = compareVersions(this.expected, profile.versions);
      this.cached = { status: incompatible.length ? 'incompatible' : 'compatible', version: profile.version, incompatible, verified: true };
    } catch { this.cached = { status: 'unknown', version: null, incompatible: [], verified: false }; }
    this.checkedAt = Date.now(); return this.cached;
  }
  async assert(method) {
    const report = await this.read();
    if (report.incompatible.includes(method) || report.incompatible.includes('thread-stream-state-changed')) throw Error('Installed Codex protocol changed. This action is disabled; update TeleCodex and open Compatibility.');
    // A protocol write is allowed only after inspecting the installed adapter version.
    if (!report.verified) throw Error('Cannot verify installed Codex protocol. Open Compatibility and check the Windows installation.');
  }
}
export async function inspectInstalledDesktop() {
  if (process.platform !== 'win32') throw Error('Windows desktop required');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 InstallLocation,Version | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  const app = JSON.parse(stdout); if (!app.InstallLocation) throw Error('Codex desktop not found');
  const file = await open(path.join(app.InstallLocation, 'app', 'resources', 'app.asar'), 'r');
  try {
    const prefix = Buffer.alloc(8); await file.read(prefix, 0, 8, 0);
    const size = prefix.readUInt32LE(4); if (size < 16 || size > 64 * 1024 * 1024) throw Error('Invalid ASAR header');
    const header = Buffer.alloc(size); await file.read(header, 0, size, 8);
    const length = header.readUInt32LE(4); if (length > size - 8) throw Error('Invalid ASAR JSON');
    const tree = JSON.parse(header.subarray(8, 8 + length).toString('utf8'));
    const build = tree.files?.['.vite']?.files?.build?.files || {};
    for (const [name, entry] of Object.entries(build)) {
      if (!name.endsWith('.js') || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 12 * 1024 * 1024) continue;
      const bytes = Buffer.alloc(entry.size); await file.read(bytes, 0, bytes.length, 8 + size + Number(entry.offset));
      const versions = extractVersions(bytes.toString('utf8'));
      if (versions) return { version: String(app.Version), versions };
    }
    throw Error('Protocol manifest was not found');
  } finally { await file.close(); }
}
