// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function acquirePidLock(file, label) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const create = () => { const fd = openSync(file, 'wx', 0o600); try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); } };
  try { create(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(file, 'utf8')); let active = false;
    try { if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); active = true; } }
    catch (e) { if (e.code !== 'ESRCH') active = true; }
    if (active) throw Error(`${label} is already running`);
    unlinkSync(file); create();
  }
  return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch {} };
}
