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
    return db.prepare(`SELECT id, COALESCE(name, title) AS title, cwd, model, updated_at
      FROM threads WHERE archived = 0 AND agent_path IS NULL AND source NOT LIKE '{%'
      AND (COALESCE(name,title) LIKE ? OR cwd LIKE ?)
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(`%${search}%`, `%${search}%`, limit, offset);
  } finally { db.close(); }
}
