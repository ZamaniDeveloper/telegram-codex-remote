// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = {
  apps: [{
    name: 'telegram-codex-remote',
    cwd: root,
    script: process.execPath,
    args: ['--env-file=' + path.join(root, '.env'), path.join(root, 'src', 'main.mjs')],
    interpreter: 'none',
    autorestart: true,
    restart_delay: 5000,
    max_memory_restart: '512M',
    time: true,
  }],
};
