// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { spawn, execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFilename, MAX_FILE_BYTES } from './attachments.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resolveAudio(meta, storeRoot) {
  if (!meta || !ID.test(meta.batchId || '') || !ID.test(meta.id || '') || !/^[a-f0-9]{64}$/.test(meta.sha256 || '') || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > MAX_FILE_BYTES) throw Error('Invalid audio metadata');
  const base = await realpath(storeRoot), target = await realpath(path.join(base, meta.batchId, meta.id + '-' + safeFilename(meta.name)));
  if (!target.startsWith(base + path.sep) || !(await stat(target)).isFile()) throw Error('Audio path escapes attachment storage');
  const bytes = await readFile(target);
  if (bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw Error('Audio checksum mismatch');
  return target;
}
export function runWhisper(python, request, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'scripts', 'transcribe.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1' } });
    const terminate = () => {
      // Windows venv launchers spawn the real Python process; kill its process tree.
      if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill();
    };
    let bytes = ''; const timer = setTimeout(() => { terminate(); reject(Error('Local transcription timed out. Original audio remains in the bundle.')); }, timeout);
    child.stderr.resume();
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { bytes += chunk; if (bytes.length > 300000) terminate(); });
    child.once('error', () => { clearTimeout(timer); reject(Error('Whisper Python unavailable. Run install-whisper.ps1 on Windows.')); });
    child.stdin.on('error', () => {});
    child.once('exit', code => {
      clearTimeout(timer);
      try { const r = JSON.parse(bytes); if (code || r.error || typeof r.text !== 'string' || !r.text.trim()) throw Error(); resolve(r); }
      catch { reject(Error('Local transcription failed. Original audio remains in the bundle; check Whisper and the 10-minute audio limit.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export class Transcriber {
  tail = Promise.resolve(); queued = 0;
  constructor({ python = process.env.WHISPER_PYTHON || path.join(root, 'data', 'whisper-venv', 'Scripts', 'python.exe'), modelPath = process.env.WHISPER_MODEL_PATH || path.join(root, 'data', 'whisper-model'), language = process.env.WHISPER_LANGUAGE || null, run = runWhisper } = {}) { this.python = python; this.modelPath = modelPath; this.language = language; this.run = run; }
  async status() { return { ready: Boolean(await stat(path.join(this.modelPath, 'model.bin')).catch(() => null)) && Boolean(await stat(this.python).catch(() => null)), engine: 'faster-whisper', device: 'cpu', maxSeconds: 600 }; }
  async transcribe(meta, storeRoot) {
    if (this.queued >= 4) throw Error('Whisper queue full. Try sending the bundle later.');
    this.queued++;
    const next = this.tail.then(async () => {
      const audioPath = await resolveAudio(meta, storeRoot);
      if (!(await this.status()).ready) throw Error('Whisper is not installed. Run install-whisper.ps1 on Windows; original audio is preserved.');
      return this.run(this.python, { audioPath, modelPath: this.modelPath, language: this.language });
    });
    this.tail = next.catch(() => {}); try { return await next; } finally { this.queued--; }
  }
}
