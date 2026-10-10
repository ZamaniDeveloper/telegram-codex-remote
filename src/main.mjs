// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telegram } from './telegram.mjs';
import { Bridge } from './bridge.mjs';
import { isPrivateOwner, matchesPairCode } from './auth.mjs';
import { RemoteDesktop } from './remote-desktop.mjs';
import { Inbox } from './inbox.mjs';
import { BotUi, UI_REVISION, UI_EDITION } from './ui.mjs';
import { acquirePidLock } from './pid-lock.mjs';
import { dispatchCallback } from './callback-dispatch.mjs';
import { Outbox } from './outbox.mjs';
import { DesktopRecovery } from './desktop-recovery.mjs';
import { Premium } from './premium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data'); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const stateFile = path.join(dataDir, 'settings.json'); const lockFile = path.join(dataDir, 'bridge.lock');
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token || !/^\d+:[\w-]+$/.test(token)) throw Error('توکن ربات را با setup.ps1 در فایل محلی .env تنظیم کن.');
let settings = {};
try { settings = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('Local settings are invalid; inspect data/settings.json'); }
if (process.env.TELEGRAM_OWNER_ID) {
  if (!/^\d+$/.test(process.env.TELEGRAM_OWNER_ID)) throw Error('TELEGRAM_OWNER_ID must be a numeric user ID');
  settings.ownerId = Number(process.env.TELEGRAM_OWNER_ID);
}
const releaseLock = acquirePidLock(lockFile, 'Telegram bot');
function save() { writeFileSync(stateFile + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 }); renameSync(stateFile + '.tmp', stateFile); }
const tg = new Telegram(token); let running = true, bridge = null, inbox = null, ui = null, flushTimer, restoreSelection = null, lastRestore = 0;
function stop() {
  running = false; clearInterval(flushTimer);
  void bridge?.desktopRecovery?.stop();
  ui?.accounts.close().catch(() => {});
  try { bridge?.close(); } catch {}
  releaseLock();
}
process.on('SIGINT', () => { stop(); process.exit(); });
process.on('SIGTERM', () => { stop(); process.exit(); });
process.on('exit', stop);
const pairCode = randomBytes(6).toString('hex'); const pairExpires = Date.now() + 10 * 60 * 1000;
function attachOwner() {
  if (process.env.CONNECTOR_URL) {
    const remote = new RemoteDesktop(process.env.CONNECTOR_URL, process.env.CONNECTOR_SECRET);
    bridge = new Bridge(tg, settings.ownerId, remote, (...args) => remote.listThreads(...args));
  } else bridge = new Bridge(tg, settings.ownerId);
  bridge.premium = new Premium(tg, settings.ownerId, { state: settings.telegramPremium, save: state => { settings.telegramPremium = state; save(); } });
  tg.premium = bridge.premium;
  bridge.outbox = new Outbox(path.join(dataDir, 'outbox.json'));
  restoreSelection = settings.selectedThread || null;
  bridge.onSelected = row => { settings.selectedThread = { id: row.id, title: row.title }; restoreSelection = null; save(); };
  inbox = new Inbox(bridge); ui = new BotUi(bridge, inbox);
  if (!process.env.CONNECTOR_URL && process.platform === 'win32' && process.env.CONNECTOR_AUTO_START_CODEX !== '0') {
    bridge.desktopRecovery = new DesktopRecovery(bridge.ipc, { blocked: () => bridge.accountSwitching || ui.accounts.local?.busy, report: status => console.log('Codex desktop recovery:', status) });
    bridge.desktopRecovery.start();
  }
  bridge.onSteerPrompt = context => ui.prompt('steer', context);
  inbox.onInstruction = batchId => ui.prompt('instruction', { batchId });
}
async function setupUi() {
  await bridge.premium.refresh();
  const commands = [ ['menu', 'منوی اصلی'], ['chats', 'انتخاب چت'], ['usage', 'سهمیه و اعتبار ریست'], ['status', 'وضعیت Codex'], ['history', 'پاسخ‌های اخیر'], ['batch', 'بسته جدید'], ['pending', 'ارسال‌گروهی‌پیام‌ها'], ['queue', 'صف ارسال'], ['send', 'ارسال بسته'], ['answer', 'پاسخ به سؤال'], ['stop', 'توقف کار'], ['help', 'راهنما'] ].map(([command, description]) => ({ command, description }));
  commands.push(...[['last', 'آخرین پیام هر گفتگو'], ['newchat', 'چت جدید'], ['projects', 'پروژه‌ها'], ['newproject', 'پروژه جدید'], ['models', 'انتخاب مدل و استدلال'], ['compat', 'سازگاری و Whisper']].map(([command, description]) => ({ command, description })));
  commands.push({ command: 'accounts', description: 'حساب‌های Codex و تعویض حساب' });
  commands.push({ command: 'premium', description: 'تلگرام پرمیوم و ظاهر ویژه' });
  await tg.call('setMyCommands', { scope: { type: 'chat', chat_id: settings.ownerId }, commands });
  await tg.call('setChatMenuButton', { chat_id: settings.ownerId, menu_button: { type: 'commands' } });
  if (settings.uiRevision !== UI_REVISION || settings.uiEdition !== UI_EDITION) {
    await ui.home(true); settings.uiRevision = UI_REVISION; settings.uiEdition = UI_EDITION; save(); console.log('Telegram UI revision installed:', UI_REVISION, UI_EDITION);
    try { const panel = await ui.quota.show(); console.log('Quota screen delivered:', Boolean(panel?.message_id)); }
    catch { console.log('Quota screen unavailable at startup; use the usage button after reconnecting.'); }
  }
}
try {
  const bot = await tg.call('getMe');
  const webhook = await tg.call('getWebhookInfo');
  if (webhook.url) throw Error('این ربات webhook فعال دارد؛ از BotFather یک ربات جدید برای این اتصال بساز.');
  const backlog = await tg.call('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  if (backlog.length) settings.offset = backlog.at(-1).update_id + 1;
  save(); console.log(`Telegram bot: @${bot.username}`);
  if (settings.ownerId) { attachOwner(); await setupUi(); }
  else console.log(`برای اتصال حساب خودت، در چت خصوصی ربات بفرست: /pair ${pairCode}\nاین کد ده دقیقه اعتبار دارد.`);
  let flushing = false;
  flushTimer = setInterval(async () => {
    if (!bridge || flushing) return; flushing = true;
    try {
      await inbox.flush(); await bridge.reconnect();
      if (restoreSelection && Date.now() - lastRestore > 30000) {
        lastRestore = Date.now(); await bridge.select(restoreSelection, { notify: false });
      }
      await bridge.flush();
      await bridge.outbox.follow(bridge); await bridge.outbox.flush(bridge);
      await ui.accounts.poll();
    }
    catch { /* Retry connection/stream sync, never resend a user action. */ }
    finally { flushing = false; }
  }, 2500);
  while (running) {
    let updates;
    try { updates = await tg.call('getUpdates', { offset: settings.offset || 0, timeout: 25, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { console.error('Telegram polling unavailable; retrying.'); await new Promise(r => setTimeout(r, Math.min(60000, (e.retryAfter || 5) * 1000))); continue; }
    for (const update of updates) {
      // At-most-once control actions: persist before dispatch. Ambiguous commands are never retried.
      settings.offset = update.update_id + 1; save();
      const message = update.message;
      if (!settings.ownerId && Date.now() < pairExpires && message?.chat?.type === 'private'
        && message.chat.id === message.from?.id && matchesPairCode(message.text, pairCode)) {
        settings.ownerId = message.from.id; save(); attachOwner();
        await setupUi();
        console.log('Owner paired.'); continue;
      }
      if (!isPrivateOwner(update, settings.ownerId)) continue;
      try {
        bridge.premium.observe(update); await bridge.premium.prepare();
        if (update.callback_query) {
          await dispatchCallback(update.callback_query, tg, ui, inbox, bridge);
        } else if (message) await ui.message(message);
      } catch (e) { try { await tg.send(settings.ownerId, e.message); } catch {} }
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { stop(); }
