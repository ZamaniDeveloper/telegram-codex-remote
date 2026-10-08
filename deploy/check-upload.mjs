// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Read/write transport check only: no Telegram message or model turn is sent.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
const env = parseEnv(await fs.readFile(new URL('../.env', import.meta.url), 'utf8'));
const remote = new RemoteDesktop(env.CONNECTOR_URL, env.CONNECTOR_SECRET);
const dir = await fs.mkdtemp(path.join(tmpdir(), 'codex-upload-check-'));
const batchId = randomUUID();
try {
  const fixtures = [
    ['آزمون انتقال.txt', Buffer.from('تست انتقال فایل به ویندوز\n'.repeat(1000))],
    ['test.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')],
  ];
  for (const [name, bytes] of fixtures) {
    const source = path.join(dir, name); await fs.writeFile(source, bytes);
    const meta = { batchId, id: randomUUID(), name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const result = await remote.uploadAttachment(meta, source);
    if (result.sha256 !== meta.sha256 || result.size !== bytes.length) throw Error('Transport checksum failed');
    console.log(JSON.stringify({ transfer: 'verified', ...result, batchId }));
  }
} finally { remote.close(); await fs.rm(dir, { recursive: true, force: true }); }
