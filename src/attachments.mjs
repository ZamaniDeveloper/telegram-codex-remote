// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function safeFilename(name) {
  let value = String(name || 'file').split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/[ .]+$/g, '').slice(0, 140);
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = 'file-' + (value || 'attachment');
  return value;
}
export function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
export class AttachmentStore {
  busy = new Set();
  constructor(root = fileURLToPath(new URL('../data/attachments/', import.meta.url))) { this.root = path.resolve(root); }
  async put(meta, stream) {
    if (!UUID.test(meta.batchId) || !UUID.test(meta.id) || !/^[a-f0-9]{64}$/.test(meta.sha256)
      || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > MAX_FILE_BYTES) throw Error('Invalid attachment metadata');
    const name = safeFilename(meta.name);
    const key = meta.batchId + '/' + meta.id;
    if (this.busy.has(key)) throw Error('Attachment transfer already in progress');
    this.busy.add(key);
    const dir = path.join(this.root, meta.batchId);
    const target = path.join(dir, meta.id + '-' + name);
    const temp = path.join(dir, '.' + randomUUID() + '.part');
    let handle;
    const result = bytes => ({ path: target, name, size: bytes.length, sha256: meta.sha256, image: Boolean(imageExtension(bytes)) });
    try {
      await mkdir(dir, { recursive: true });
      try {
        const existing = await readFile(target);
        if (existing.length !== meta.size || createHash('sha256').update(existing).digest('hex') !== meta.sha256) throw Error('Attachment ID already has different content');
        // Drain duplicate uploads before answering; a retry never replaces the original.
        let received = 0;
        for await (const chunk of stream) { received += chunk.length; if (received > MAX_FILE_BYTES) throw Error('Attachment exceeds size limit'); }
        if (received !== meta.size) throw Error('Attachment size mismatch');
        return result(existing);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      handle = await open(temp, 'wx', 0o600);
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > meta.size || size > MAX_FILE_BYTES) throw Error('Attachment exceeds size limit');
        hash.update(bytes); await handle.writeFile(bytes);
      }
      if (size !== meta.size || hash.digest('hex') !== meta.sha256) throw Error('Attachment checksum mismatch');
      await handle.close(); handle = null;
      await rename(temp, target);
      return result(await readFile(target));
    } finally {
      await handle?.close(); await unlink(temp).catch(() => {}); this.busy.delete(key);
    }
  }
  uploadFile(meta, source) { return this.put(meta, createReadStream(source)); }
}
