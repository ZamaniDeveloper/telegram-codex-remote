// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { Telegram } from '../src/telegram.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
const bot = await tg.call('getMe'); const webhook = await tg.call('getWebhookInfo');
console.log(JSON.stringify({ telegram: 'connected', bot: bot.username, webhookConfigured: Boolean(webhook.url) }));
const remote = new RemoteDesktop(env.CONNECTOR_URL, env.CONNECTOR_SECRET);
try {
  const threads = await remote.listThreads('', 10, 0);
  console.log(JSON.stringify({ windowsCatalog: 'connected', chats: threads.length }));
  if (process.argv[2]) {
    const id = process.argv[2]; const owner = await remote.owner(id);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Snapshot timed out')), 15000);
      remote.on('broadcast', m => { if (m.params?.conversationId === id && m.params?.change?.type === 'snapshot') {
        clearTimeout(timer); resolve({ liveSnapshot: true, runtime: m.params.change.conversationState.threadRuntimeStatus?.type });
      } });
    });
    remote.follow(id, owner); console.log(JSON.stringify(await result)); remote.follow(id, owner, false);
  }
} finally { remote.close(); }
