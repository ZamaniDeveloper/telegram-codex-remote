// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

// Persist only Telegram delivery checkpoints; the live desktop remains the
// authority for execution state. Never hydrate owner/synced flags from disk.
export class DeliveryState {
  closed = false;
  constructor(file) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery (thread TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL)');
  }
  read(id) {
    const row = this.db.prepare('SELECT state FROM delivery WHERE thread=?').get(id);
    return row ? JSON.parse(row.state) : null;
  }
  save(w) {
    const state = { seenTurns: [...w.seenTurns].slice(-4096), messages: [...w.messages].slice(-64) };
    this.db.prepare('INSERT INTO delivery VALUES (?,?,?) ON CONFLICT(thread) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(w.id, JSON.stringify(state), Date.now());
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
