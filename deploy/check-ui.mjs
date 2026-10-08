// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { Telegram } from '../src/telegram.mjs';
import { BotUi, UI_REVISION } from '../src/ui.mjs';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const settings = JSON.parse(fs.readFileSync(new URL('../data/settings.json', import.meta.url), 'utf8'));
const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
const commands = await tg.call('getMyCommands', { scope: { type: 'chat', chat_id: settings.ownerId } });
const menu = await tg.call('getChatMenuButton', { chat_id: settings.ownerId });
console.log(JSON.stringify({ revision: settings.uiRevision, expectedRevision: UI_REVISION, commands: commands.length, menu: menu.type }));
if (settings.uiRevision !== UI_REVISION || menu.type !== 'commands' || !commands.some(c => c.command === 'menu')) throw Error('Telegram UI configuration did not match release');
if (process.argv.includes('--publish-guide')) {
  const sent = await BotUi.prototype.help.call({ tg, chatId: settings.ownerId });
  const nativeColor = sent.reply_markup?.inline_keyboard?.flat().some(b => b.style === 'primary');
  console.log(JSON.stringify({ guideDelivered: Boolean(sent.message_id), formattingEntities: sent.entities?.length || 0, nativeColoredButtons: nativeColor }));
  if (!sent.entities?.length || !nativeColor) throw Error('Telegram did not preserve expected formatting/buttons');
}
