// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function listThreads(search = '', limit = 20, offset = 0) {
  const root = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const file = readdirSync(root).filter(x => /^state_\d+\.sqlite$/.test(x))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!file) throw Error('Codex local thread catalog was not found');
  const db = new DatabaseSync(path.join(root, file), { readOnly: true });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
    if (!['id', 'cwd', 'updated_at'].every(c => columns.has(c))) throw Error('Codex catalog schema changed; update TeleCodex');
    const title = columns.has('name') && columns.has('title') ? 'COALESCE(name,title)' : columns.has('name') ? 'name' : columns.has('title') ? 'title' : 'id';
    const filters = [columns.has('archived') ? 'archived = 0' : '1', columns.has('agent_path') ? 'agent_path IS NULL' : '1', columns.has('source') ? "source NOT LIKE '{%'" : '1'];
    return db.prepare(`SELECT id, ${title} AS title, cwd, ${columns.has('model') ? 'model' : 'NULL AS model'}, updated_at
      FROM threads WHERE ${filters.join(' AND ')} AND (${title} LIKE ? OR cwd LIKE ?)
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(`%${search}%`, `%${search}%`, limit, offset);
  } finally { db.close(); }
}
