// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID, randomBytes } from 'node:crypto';
import { card, concatRich, styled } from './format.mjs';
import { isBusy } from './outbox.mjs';
import { text as T } from './account-text.mjs';
import { Accounts } from './accounts.mjs';
const button = (text, callback_data, style) => ({ text, callback_data, ...(style ? { style } : {}) });
export class AccountUi {
  actions = new Map(); pendingKey = null; notified = null; polling = false; lastPoll = 0;
  constructor(bridge) { this.bridge = bridge; this.tg = bridge.tg; this.chatId = bridge.chatId; }
  action(value) { const key = randomBytes(12).toString('hex'); this.actions.set(key, { ...value, expiresAt: Date.now() + 10 * 60 * 1000 }); if (this.actions.size > 100) this.actions.delete(this.actions.keys().next().value); return `a:${key}`; }
  api(method, value) {
    if (this.bridge.ipc[method]) return this.bridge.ipc[method](value);
    if (process.platform !== 'win32') throw Error(T.unsupported);
    this.local ||= new Accounts({ ipc: this.bridge.ipc });
    return this.local[{ accountsRead: 'read', accountLoginStart: 'start', accountLoginCancel: 'cancel', accountActivate: 'activate' }[method]](value);
  }
  close() { this.local?.pending?.rpc?.close(); return this.local?.close() || Promise.resolve(); }
  async show() {
    const data = await this.api('accountsRead');
    let body = concatRich(styled(T.current + ': '), data.current?.email || T.none, data.current?.planType ? ` · ${data.current.planType}` : '', '\n\n', T.choose);
    const rows = data.accounts.map(account => [button(`${account.key === data.current?.key ? '✅' : '👤'} ${account.email}${account.planType ? ' · ' + account.planType : ''}`.slice(0, 64), this.action({ kind: 'choose', account, expectedCurrentKey: data.current?.key || null }))]);
    rows.push([button(T.add, this.action({ kind: 'add', key: randomUUID() }), 'primary')]);
    if (data.pending?.status === 'waiting') { this.pendingKey = data.pending.key; rows.push([button(T.check, this.action({ kind: 'check', key: data.pending.key })), button(T.cancel, this.action({ kind: 'cancel', key: data.pending.key }))]); }
    rows.push([button(T.refresh, 'u:accounts'), button(T.home, 'u:home')]);
    return this.tg.send(this.chatId, card(T.title, body, T.footer), { inline_keyboard: rows });
  }
  async login(p) {
    if (p.status !== 'waiting') return this.result(p);
    this.pendingKey = p.key;
    return this.tg.send(this.chatId, card(T.loginTitle, concatRich(T.loginBody, '\n\n', styled(p.userCode)), T.loginFooter), { inline_keyboard: [
      [{ text: T.open, url: p.verificationUrl, style: 'primary' }],
      [button(T.check, this.action({ kind: 'check', key: p.key })), button(T.cancel, this.action({ kind: 'cancel', key: p.key }))],
    ] });
  }
  async result(p) {
    if (!p || p.status === 'waiting' || this.notified === `${p.key}:${p.status}`) return;
    this.notified = `${p.key}:${p.status}`; this.pendingKey = null;
    const body = p.status === 'complete' ? p.account?.email : T[{ failed: 'loginFailed', expired: 'loginExpired', cancelled: 'loginCancelled' }[p.status]] || T.loginFailed;
    await this.tg.send(this.chatId, card(p.status === 'complete' ? T.loginComplete : T.loginTitle, body), { inline_keyboard: [[button(T.title, 'u:accounts', 'primary')]] });
  }
  async poll() {
    if (!this.pendingKey || this.polling || Date.now() - this.lastPoll < 10000) return;
    this.polling = true; this.lastPoll = Date.now();
    try { const data = await this.api('accountsRead'); if (data.pending?.key === this.pendingKey) await this.result(data.pending); else await this.result({ key: this.pendingKey, status: 'expired' }); }
    finally { this.polling = false; }
  }
  async callback(data) {
    const token = data.slice(2), action = this.actions.get(token);
    if (!action || action.expiresAt < Date.now()) throw Error(T.stale);
    if (action.kind === 'choose') {
      this.actions.delete(token);
      return this.tg.send(this.chatId, card(T.confirmTitle, concatRich(styled(action.account.email), '\n\n', T.confirmBody)), { inline_keyboard: [[button(T.confirm, this.action({ ...action, kind: 'activate', requestId: randomUUID() }), 'primary')], [button(T.cancel, 'u:accounts')]] });
    }
    if (action.kind === 'add') { this.actions.delete(token); return this.login(await this.api('accountLoginStart', { key: action.key })); }
    if (action.kind === 'cancel') { this.actions.delete(token); return this.result(await this.api('accountLoginCancel', { key: action.key })); }
    if (action.kind === 'check') {
      const status = await this.api('accountsRead'); if (status.pending?.key !== action.key) throw Error(T.stale);
      return status.pending.status === 'waiting' ? this.login(status.pending) : this.result(status.pending);
    }
    if (action.kind === 'activate') {
      if (this.bridge.accountSwitching || this.bridge.outbox?.flushing || this.bridge.outbox?.entries.some(e => ['dispatching', 'awaiting', 'uncertain'].includes(e.status)) || [...this.bridge.watched.values()].some(isBusy)) throw Error(T.inflight);
      this.actions.delete(token); this.bridge.accountSwitching = true;
      try {
        await this.tg.send(this.chatId, T.working);
        const result = await this.api('accountActivate', { key: action.account.key, expectedCurrentKey: action.expectedCurrentKey, requestId: action.requestId });
        await this.tg.send(this.chatId, card(result.outcome === 'unchanged' ? T.unchanged : T.switched, concatRich(styled(result.account.email), '\n\n', T.retained)), { inline_keyboard: [[button(T.usage, 'u:usage'), button(T.home, 'u:home')]] });
        if (result.outcome === 'switched') {
          for (const w of this.bridge.watched.values()) { w.owner = null; w.synced = false; }
          const selected = this.bridge.selected;
          if (selected) await this.bridge.select({ id: selected.id, title: selected.title }, { notify: false }).catch(() => {});
        }
      } catch (e) {
        if (e.message?.includes('Account activation needs recovery')) throw Error(T.recovery);
        if (e.message?.includes('startup deadline')) throw Error(T.startFailedRecovered);
        if (e.message?.includes('uncertain or failed outcome')) throw Error(T.inspectPreviousAttempt);
        throw e;
      } finally { this.bridge.accountSwitching = false; }
      return;
    }
    throw Error(T.stale);
  }
}
