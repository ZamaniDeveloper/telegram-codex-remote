// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { execFileSync } from 'node:child_process';
const names = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!names.length) throw Error('No staged or tracked release files to verify');
const examples = new Set(['.env.example', '.connector.env.example']);
const patterns = [
  /-----BEGIN [\w ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{35,}\b/,
  /TELEGRAM_BOT_TOKEN\s*=\s*\d{5,}:[A-Za-z0-9_-]{30,}/,
];
let failed = false;
for (const file of names) {
  if ((/(^|\/)(data|\.deploy|node_modules|\.diagnostics)(\/|$)/.test(file) || /(^|\/)(?:\.env(?:\..*)?|\.connector\.env.*)$/.test(file)) && !examples.has(file)) {
    console.error(`Runtime path in release: ${file}`); failed = true; continue;
  }
  const content = execFileSync('git', ['show', ':' + file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (patterns.some(pattern => pattern.test(content))) { console.error(`Credential-shaped content in release: ${file}`); failed = true; }
}
if (failed) process.exit(1);
console.log(`Publication scan passed (${names.length} tracked files; no runtime paths or credential-shaped content).`);
