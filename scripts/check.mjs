// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let files = 0;
for (const directory of ['src', 'test', 'deploy', 'scripts']) {
  for (const entry of await readdir(path.join(root, directory))) {
    if (!/\.(mjs|cjs)$/.test(entry)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, entry)], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); } files++;
  }
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.license !== 'SEE LICENSE IN LICENSE') throw Error('Unexpected release license');
for (const file of ['.env.example', '.connector.env.example', 'LICENSE', 'README.md', 'README.en.md']) {
  if (!(await readFile(path.join(root, file), 'utf8')).trim()) throw Error(`Missing release file: ${file}`);
}
console.log(`Syntax and release files verified (${files} JavaScript files).`);
