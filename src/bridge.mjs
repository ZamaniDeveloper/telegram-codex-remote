// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DesktopIpc } from './ipc.mjs';
import { listThreads } from './catalog.mjs';
import { applyPatches, lastTurn, assistantText, pendingRequests, turnId, turnsOf } from './state.mjs';
import { card, concatRich, styled, splitRich, turnCard } from './format.mjs';
import { chatKeyboard, navKeyboard, button } from './ui.mjs';
import { QuestionManager } from './questions.mjs';

const HELP = `ریموت Codex دسکتاپ\n\n/chats — انتخاب چت فعلی\n/find عبارت — جستجو در چت‌ها و مسیر پروژه\n/status — وضعیت و مدل\n/history — پاسخ‌های اخیر\n/stop — توقف کار همین چت\n/steer متن — اصلاح مسیر حین اجرا\n/answer متن — پاسخ به سؤال باز\n/batch — جمع کردن چند پیام در یک بسته\n/pending — نمایش بسته و پیوست‌ها\n/send توضیح دلخواه — ارسال کل بسته به صورت یک پیام\n/cancel — حذف بستهٔ ارسال‌نشده\n/help — راهنما\n\nپیام فورواردی، فایل و تصویر در بسته جمع می‌شوند. متن معمولی هنگام باز بودن بسته به آن اضافه می‌شود. ارسال نهایی با /send است. تصویرها همراه فایل اصلی به Codex می‌رسند. حداکثر هر فایل ۲۰ مگابایت است.\n\nبعد از انتخاب چت، پیام معمولی بدون بسته به همان چت فرستاده می‌شود. اگر کار در حال اجرا باشد، از /steer استفاده کن. چت‌های بسته هنگام انتخاب در Codex باز می‌شوند.`;
// Desktop 26.1002 reads restoreMessage.cwd/context before dispatching turn/steer.
// Match its plain-text follow-up shape, including the shared message identity.
export function steeringParams(w, input) {
  input = input.map(i => i.type === 'text' ? { ...i, text_elements: i.text_elements ?? [] } : i);
  const id = randomUUID(), text = input.filter(i => i.type === 'text').map(i => i.text).join('\n');
  const cwd = w.state?.cwd || null;
  return { conversationId: w.id, input, clientUserMessageId: id, attachments: [],
    restoreMessage: { id, text, cwd, createdAt: Date.now(), context: {
      prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [],
      commentAttachments: [], ideContext: null, workspaceRoots: cwd ? [cwd] : [],
    } } };
}
export class Bridge {
  watched = new Map(); actions = new Map(); selected = null; selectionEpoch = 0;
  constructor(telegram, chatId, ipc = new DesktopIpc(), catalog = listThreads, { snapshotTimeoutMs = 30000 } = {}) {
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.tg = telegram; this.chatId = chatId; this.ipc = ipc; this.catalog = catalog; this.questions = new QuestionManager(this);
    ipc.on('broadcast', m => this.onBroadcast(m));
    ipc.on('disconnected', () => { for (const w of this.watched.values()) { w.owner = null; w.synced = false; } });
  }
  async reconnect() {
    await this.ipc.connect();
    for (const w of this.watched.values()) if (!w.owner) {
      try { w.owner = await this.ipc.owner(w.id); this.ipc.follow(w.id, w.owner); }
      catch { /* Only the desktop can own the thread. Never resume on a second server. */ }
    }
  }
  action(value) {
    const id = randomBytes(12).toString('hex');
    this.actions.set(id, { ...value, expires: Date.now() + 15 * 60 * 1000 });
    if (this.actions.size > 500) this.actions.delete(this.actions.keys().next().value);
    return id;
  }
  async chats(search = '', offset = 0) {
    const rows = await this.catalog(search, 10, offset);
    const keyboard = rows.map(row => [{ text: (row.title || row.cwd || row.id).slice(0, 64),
      callback_data: `c:${this.action({ type: 'chat', row })}` }, ...(this.latestButton ? [this.latestButton(row)] : [])]);
    if (rows.length === 10) keyboard.push([{ text: 'چت‌های بعدی',
      callback_data: `p:${this.action({ type: 'page', search, offset: offset + 10 })}` }]);
    keyboard.push([button('🔎 جستجو', 'u:search'), button('🏠 منوی اصلی', 'u:home')]);
    await this.tg.send(this.chatId, card('💬 چت‌های Codex', rows.length ? 'چت موردنظر را انتخاب کن:' : 'چتی با این عبارت پیدا نشد.'), { inline_keyboard: keyboard });
  }
  async select(row, { notify = true } = {}) {
    const epoch = ++this.selectionEpoch;
    let owner;
    try { owner = await this.ipc.owner(row.id); }
    catch {
      if (!/^[\da-f-]{36}$/i.test(row.id)) throw Error('این چت را ابتدا در Codex دسکتاپ باز کن.');
      if (this.ipc.openThread) await this.ipc.openThread(row.id);
      else {
      if (process.platform !== 'win32') throw Error('این چت را ابتدا در Codex دسکتاپ باز کن.');
      // Open an existing chat via the app's registered URI; no restart or file edit.
      await new Promise((resolve, reject) => {
        const child = spawn('explorer.exe', [`codex://threads/${row.id}`], { windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', resolve);
      });
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, 700));
        try { owner = await this.ipc.owner(row.id); break; } catch {}
      }
      if (!owner) throw Error('چت در برنامه مالک فعال ندارد؛ آن را در Codex باز کن و دوباره انتخاب کن.');
    }
    if (epoch !== this.selectionEpoch) return;
    if (!this.watched.has(row.id) && this.watched.size >= 8) {
      const candidate = [...this.watched.values()].find(w => lastTurn(w.state)?.status !== 'inProgress');
      if (!candidate) throw Error('هشت چت در حال پیگیری هستند؛ ابتدا یکی را به پایان برسان.');
      if (candidate.owner) this.ipc.follow(candidate.id, candidate.owner, false);
      this.watched.delete(candidate.id);
    }
    let w = this.watched.get(row.id);
    if (!w) { w = { id: row.id, title: row.title, owner, synced: false, revision: null, state: null,
      messages: new Map(), sentRequests: new Set(), seenTurns: new Set() }; this.watched.set(row.id, w); }
    if (w.owner !== owner) { w.synced = false; w.state = null; w.revision = null; }
    w.owner = owner;
    if (!w.synced) {
      const ready = this.waitSnapshot(w);
      this.ipc.follow(row.id, owner); await ready;
    }
    if (epoch !== this.selectionEpoch) return;
    if (row.title) w.title = row.title;
    this.selected = w;
    this.onSelected?.(row);
    if (notify) await this.tg.send(this.chatId, card('✅ چت انتخاب شد', concatRich(styled(row.title || 'Codex'), '\n\n📁 پروژه: ', w.state.cwd || 'بدون پروژه', '\n🧠 مدل: ', w.state.latestModel || 'پیش‌فرض'), 'پیام بعدی به همین چت می‌رود.'), chatKeyboard(w.id));
  }
  waitSnapshot(w) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); w.snapshotWaiters.delete(finish);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(Error('دریافت وضعیت زنده طول کشید؛ اتصال رابط ویندوز را بررسی کن.')), this.snapshotTimeoutMs);
      (w.snapshotWaiters ||= new Set()).add(finish);
    });
  }
  resync(w) {
    w.synced = false;
    if (w.resyncing) return;
    w.resyncing = (async () => { await this.ipc.follow(w.id, w.owner, false); await this.ipc.follow(w.id, w.owner); })().catch(() => {}).finally(() => { w.resyncing = null; });
  }
  onBroadcast(m) {
    if (m.params?.hostId !== 'local') return;
    const w = this.watched.get(m.params.conversationId); if (!w || m.sourceClientId !== w.owner) return;
    if (m.method === 'thread-stream-following-status-requested') { this.ipc.follow(w.id, w.owner); return; }
    if (m.method !== 'thread-stream-state-changed') return;
    if (m.version !== 11) { w.synced = false; return; }
    const change = m.params.change;
    if (change.type === 'snapshot') {
      w.state = change.conversationState; w.revision = change.revision; w.synced = true;
      if (!w.initialized) {
        w.initialized = true;
        for (const turn of turnsOf(w.state)) if (turn.status !== 'inProgress') w.seenTurns.add(turnId(turn));
      }
      for (const finish of [...(w.snapshotWaiters || [])]) finish();
    } else if (change.type === 'patches') {
      if (!w.synced || change.baseRevision !== w.revision) { this.resync(w); return; }
      try { w.state = applyPatches(w.state, change.patches); w.revision = change.revision; }
      catch { this.resync(w); }
    }
  }
  requireSelected() {
    if (!this.selected?.owner || !this.selected.synced) throw Error('ابتدا /chats را بزن و چتی با وضعیت زنده انتخاب کن.');
    return this.selected;
  }
  async text(text) {
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (match) {
      const [, command, arg = ''] = match;
      if (['start', 'help'].includes(command)) return this.tg.send(this.chatId, HELP);
      if (command === 'chats') return this.chats();
      if (command === 'find') return this.chats(arg);
      const w = this.requireSelected(); const turn = lastTurn(w.state);
      if (command === 'status') return this.tg.send(this.chatId, card('📊 وضعیت Codex', concatRich(styled(w.title || 'چت'), '\n\n',
        '⚡ وضعیت: ', turn?.status === 'inProgress' ? 'در حال کار' : 'آماده', '\n🧠 مدل: ', w.state.latestModel || 'پیش‌فرض', '\n📁 پروژه: ', w.state.cwd || 'بدون پروژه',
        '\n❓ سؤال‌های باز: ', String(this.questions.eligible().filter(s => s.threadId === w.id).length), '\n🔐 درخواست‌های تأیید: ', String(pendingRequests(w.state).filter(r => r.method.endsWith('requestApproval')).length))), chatKeyboard(w.id));
      if (command === 'history') {
        const turns = turnsOf(w.state).slice(-3).filter(t => assistantText(t));
        if (!turns.length) return this.tg.send(this.chatId, card('🗂 پاسخ‌های اخیر', 'پاسخی در بخش بارگذاری‌شدهٔ تاریخچه نیست.'), navKeyboard());
        for (const t of turns) await this.tg.send(this.chatId, turnCard(w.title, assistantText(t), t.status, t.error?.message), navKeyboard());
        return;
      }
      if (command === 'stop') return this.stopTurn(w.id, turnId(turn));
      if (command === 'steer') return this.steer(arg, w.id, turnId(turn));
      if (command === 'answer') return this.answer(arg);
      throw Error('دستور شناخته نشد. /help');
    }
    await this.sendInput([{ type: 'text', text }]);
    return this.tg.send(this.chatId, card('📨 پیام ارسال شد', `Codex در چت «${this.selected.title || 'چت'}» درخواستت را دریافت کرد.`), chatKeyboard(this.selected.id));
  }
  readyToSend(expectedThreadId) {
    const w = this.requireSelected();
    if (expectedThreadId && w.id !== expectedThreadId) throw Error('بسته متعلق به چت دیگری است؛ همان چت را دوباره انتخاب کن یا با /cancel بسته را حذف کن.');
    if (lastTurn(w.state)?.status === 'inProgress' || w.state.threadRuntimeStatus?.type === 'active') throw Error('Codex در حال کار است؛ برای راهنمایی حین اجرا از /steer متن استفاده کن.');
    return w;
  }
  async sendInput(input, expectedThreadId, clientUserMessageId = randomUUID()) {
    const w = this.readyToSend(expectedThreadId);
    const request = { threadId: w.id, input, clientUserMessageId };
    await this.ipc.request('thread-follower-start-turn', { conversationId: w.id, turnStart: { request, context: { inheritThreadSettings: true } } }, w.owner, 60000);
    return w;
  }
  activeTurn(threadId, expectedTurnId) {
    const w = this.watched.get(threadId), turn = lastTurn(w?.state);
    if (!w?.synced || !w.owner || turn?.status !== 'inProgress' || !expectedTurnId || turnId(turn) !== expectedTurnId) throw Error('این کار دیگر فعال نیست؛ وضعیت چت را دوباره باز کن.');
    return w;
  }
  async stopTurn(threadId, expectedTurnId) {
    const w = this.activeTurn(threadId, expectedTurnId);
    await this.ipc.request('thread-follower-interrupt-turn', { conversationId: w.id, mode: 'user-stop', expectedTurnId }, w.owner);
    return this.tg.send(this.chatId, card('⏹ درخواست توقف ارسال شد', w.title || 'چت'));
  }
  async steer(text, threadId, expectedTurnId) {
    if (!text.trim()) throw Error('متن راهنمایی را بنویس.');
    const w = this.activeTurn(threadId, expectedTurnId);
    await this.ipc.request('thread-follower-steer-turn', steeringParams(w, [{ type: 'text', text }]), w.owner);
    return this.tg.send(this.chatId, card('✍️ راهنمایی ارسال شد', `به کار در حال اجرای چت «${w.title || 'Codex'}» اضافه شد.`));
  }
  controls(w, turn, final) {
    if (final) return { inline_keyboard: [[button('💬 چت‌ها', 'u:chats'), button('🏠 منوی اصلی', 'u:home')]] };
    const token = this.action({ type: 'turn', threadId: w.id, turnId: turnId(turn) });
    return { inline_keyboard: [[button('✍️ راهنمایی حین کار', `t:${token}:steer`, 'primary'), button('⏹ توقف', `t:${token}:stop`, 'danger')], [button('❓ سؤال‌های Codex', 'u:questions')]] };
  }
  async callback(data) {
    const [kind, id, option] = data.split(':'); const a = this.actions.get(id);
    if (!a || a.expires < Date.now()) throw Error('این دکمه منقضی شده؛ دوباره درخواست را باز کن.');
    if (kind === 'c' && a.type === 'chat') return this.select(a.row);
    if (kind === 'p' && a.type === 'page') return this.chats(a.search, a.offset);
    if (kind === 'q' && a.type === 'question') return this.questions.callback(a, option);
    if (kind === 't' && a.type === 'turn') {
      this.activeTurn(a.threadId, a.turnId);
      if (option === 'stop') { this.actions.delete(id); return this.stopTurn(a.threadId, a.turnId); }
      if (option === 'steer') return this.onSteerPrompt?.({ threadId: a.threadId, turnId: a.turnId });
      throw Error('دکمه معتبر نیست.');
    }
    if (kind !== 'a' || a.type !== 'approval' || !['accept', 'decline'].includes(option)) throw Error('تصمیم معتبر نیست.');
    const w = this.watched.get(a.threadId);
    const req = w?.synced && pendingRequests(w.state).find(r => String(r.id) === String(a.requestId));
    if (!req || req.method !== a.method || req.params?.turnId !== a.turnId) throw Error('این درخواست قبلاً پاسخ داده شده یا دیگر فعال نیست.');
    this.actions.delete(id);
    const method = req.method === 'item/commandExecution/requestApproval' ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision';
    await this.ipc.request(method, { conversationId: w.id, requestId: req.id, decision: option }, w.owner);
    await this.tg.send(this.chatId, card(option === 'accept' ? '✅ تأیید ارسال شد' : '⛔ درخواست رد شد', w.title || 'چت'));
  }
  askQuestion(...args) { return this.questions.ask(...args); }
  answer(text) { return this.questions.answer(text); }
  async flush() {
    for (const w of this.watched.values()) {
      if (!w.synced) continue;
      await this.questions.sync(w);
      for (const req of pendingRequests(w.state)) {
        if (w.sentRequests.has(req.id)) continue;
        if (req.method === 'item/tool/requestUserInput') { w.sentRequests.add(req.id); continue; }
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(req.method)) {
          await this.tg.send(this.chatId, `${w.title}\nدرخواست ${req.method} نیاز به پاسخ در برنامهٔ دسکتاپ دارد.`); w.sentRequests.add(req.id); continue;
        }
        const token = this.action({ type: 'approval', threadId: w.id, requestId: req.id, turnId: req.params.turnId, method: req.method });
        const item = lastTurn(w.state)?.items?.find(i => i.id === req.params.itemId);
        const detail = req.params.command || item?.command || item?.changes?.map(c => `${c.path}\n${c.diff || ''}`).join('\n') || req.params.reason || 'تغییر فایل';
        await this.tg.send(this.chatId, card('🔐 اجازهٔ Codex', concatRich(styled(w.title || 'چت', 'italic'), '\n\n', styled(detail, 'pre'), '\n\n📁 مسیر: ', req.params.cwd || w.state.cwd || 'بدون پروژه')), { inline_keyboard: [[
          { text: '✅ تأیید همین درخواست', callback_data: `a:${token}:accept`, style: 'success' }, { text: '⛔ رد', callback_data: `a:${token}:decline`, style: 'danger' } ]] });
        w.sentRequests.add(req.id);
      }
      const turn = lastTurn(w.state); const id = turnId(turn); if (!id || w.seenTurns.has(id)) continue;
      const text = assistantText(turn), final = turn.status !== 'inProgress';
      if (!text.trim() && !final) continue;
      const parts = splitRich(turnCard(w.title, text, turn.status, turn.error?.message, turn.durationMs));
      const preview = parts[0], signature = JSON.stringify(preview), previous = w.messages.get(id);
      if (previous?.signature === signature && !final) continue;
      const existingToken = previous?.markup?.inline_keyboard?.[0]?.[0]?.callback_data?.split(':')[1];
      const validControls = this.actions.get(existingToken)?.expires > Date.now() + 60000;
      const markup = previous?.markup && validControls && !final ? previous.markup : this.controls(w, turn, final);
      if (previous) await this.tg.edit(this.chatId, previous.id, preview, markup);
      else { const sent = await this.tg.send(this.chatId, preview, markup); w.messages.set(id, { id: sent.message_id }); }
      const record = w.messages.get(id); record.signature = signature; record.markup = markup;
      if (final) {
        for (let i = record.finalIndex || 1; i < parts.length; i++) {
          await this.tg.send(this.chatId, parts[i], i === parts.length - 1 ? markup : undefined); record.finalIndex = i + 1;
        }
        w.seenTurns.add(id);
      }
    }
  }
  close() { for (const w of this.watched.values()) if (w.owner) this.ipc.follow(w.id, w.owner, false); this.ipc.close(); }
}
