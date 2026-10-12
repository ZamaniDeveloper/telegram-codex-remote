// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Receipts survive connector restarts. A pending receipt never permits a replay.
export class CommandReceipts {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, metadata TEXT NOT NULL, result TEXT, created INTEGER NOT NULL)');
  }
  read(id) {
    const row = this.db.prepare('SELECT state, metadata, result FROM receipts WHERE id=?').get(id);
    return row ? { state: row.state, metadata: JSON.parse(row.metadata), ...(row.result ? { result: JSON.parse(row.result) } : {}) } : null;
  }
  async execute(id, method, args, operation) {
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw Error('Invalid command identity');
    const digest = createHash('sha256').update(JSON.stringify({ method, args })).digest('hex');
    const previous = this.db.prepare('SELECT digest FROM receipts WHERE id=?').get(id);
    if (previous) {
      if (previous.digest !== digest) throw Error('Command identity conflicts with an earlier request');
      const receipt = this.read(id);
      if (receipt.state === 'complete') return receipt.result;
      throw Error('Command outcome is uncertain. The original action was not repeated.');
    }
    // Keep pending rows: deleting one could let an uncertain command run twice.
    this.db.prepare("DELETE FROM receipts WHERE state='complete' AND created < ?").run(Date.now() - 7 * 86400000);
    const count = this.db.prepare('SELECT count(*) AS n FROM receipts').get().n;
    if (count >= 10000) throw Error('Command receipt capacity reached; inspect the connector journal');
    const request = args[1]?.turnStart?.request;
    const metadata = { method, command: method === 'request' ? args[0] : method,
      threadId: args[1]?.conversationId || null, clientId: request?.clientUserMessageId || null };
    this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?)').run(id, digest, 'pending', JSON.stringify(metadata), null, Date.now());
    const result = await operation();
    this.db.prepare("UPDATE receipts SET state='complete', result=? WHERE id=?").run(JSON.stringify(result ?? null), id);
    return result;
  }
  close() { this.db.close(); }
}

// Bounded replay within a connector session; a restart explicitly requires a
// fresh desktop snapshot, never the resurrection of a stale process mirror.
export class EventJournal {
  session = randomUUID(); sequence = 0; entries = []; bytes = 0;
  constructor({ maxBytes = 16 * 1024 * 1024, maxEntries = 512 } = {}) { this.maxBytes = maxBytes; this.maxEntries = maxEntries; }
  append(event) {
    const id = `${this.session}:${++this.sequence}`;
    const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(frame); this.entries.push({ id, frame, bytes, sequence: this.sequence }); this.bytes += bytes;
    while (this.entries.length && (this.bytes > this.maxBytes || this.entries.length > this.maxEntries)) this.bytes -= this.entries.shift().bytes;
    return frame;
  }
  replay(cursor) {
    const match = /^([0-9a-f-]{36}):(\d+)$/.exec(cursor || '');
    if (!match || match[1] !== this.session) return null;
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence > this.sequence || sequence < (this.entries[0]?.sequence ?? this.sequence + 1) - 1) return null;
    return this.entries.filter(e => e.sequence > sequence).map(e => e.frame);
  }
}
