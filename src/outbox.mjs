// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lastTurn, turnId, turnsOf } from './state.mjs';
import { card } from './format.mjs';
import { text as T } from './outbox-text.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function acceptedTurnId(response) {
  if (response?.resultType && response.resultType !== 'success') return null;
  const id = response?.result?.result?.turn?.id ?? response?.result?.turn?.id ?? response?.turn?.id;
  return ID.test(id || '') ? id : null;
}
export const isBusy = w => lastTurn(w?.state)?.status === 'inProgress' || w?.state?.threadRuntimeStatus?.type === 'active';
export class Outbox {
  entries = []; flushing = false;
  constructor(file) {
    this.file = path.resolve(file); mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 100 || saved.entries.some(e => !ID.test(e.id) || !ID.test(e.threadId) || !ID.test(e.clientId) || !['queued', 'dispatching', 'awaiting', 'uncertain'].includes(e.status) || !Array.isArray(e.input))) throw Error('Invalid outbox');
      this.entries = saved.entries;
      for (const entry of this.entries) if (entry.status === 'dispatching') entry.status = 'uncertain';
      this.save();
    } catch (e) { if (e.code !== 'ENOENT') throw Error('Saved outbox is invalid; inspect data/outbox.json'); }
  }
  save() { writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries: this.entries }), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
  has(id) { return this.entries.some(e => e.threadId === id); }
  count(threadId) { return this.entries.filter(e => e.status === 'queued' && (!threadId || e.threadId === threadId)).length; }
  countsText(threadId) { return `${T.chatCount}: ${this.count(threadId)}\n${T.totalCount}: ${this.count()}`; }
  enqueue(w, input, clientId) {
    const existing = this.entries.find(e => e.clientId === clientId);
    if (existing) { if (existing.threadId !== w.id) throw Error('Outbox message belongs to another conversation'); return existing; }
    if (!ID.test(w.id) || !ID.test(clientId) || !Array.isArray(input) || !input.length) throw Error('Invalid queued message');
    const entry = { id: randomUUID(), threadId: w.id, title: w.title, input: structuredClone(input), clientId, status: 'queued', createdAt: Date.now() };
    if (this.entries.length >= 100 || Buffer.byteLength(JSON.stringify([...this.entries, entry])) > 8 * 1024 * 1024) throw Error(T.limit);
    this.entries.push(entry);
    try { this.save(); } catch (error) { this.entries.pop(); throw error; }
    return entry;
  }
  observe(entry, w) {
    if (!['awaiting', 'uncertain'].includes(entry.status) || !w?.synced) return false;
    const turns = turnsOf(w.state);
    const match = turns.find(t => t.clientUserMessageId === entry.clientId || t.params?.clientUserMessageId === entry.clientId
      || (t.items || []).some(i => i.type === 'userMessage' && [i.clientId, i.clientUserMessageId, i.id].includes(entry.clientId)));
    const receipt = ID.test(entry.turnId || '') && turns.find(t => turnId(t) === entry.turnId);
    if (match && receipt && turnId(match) !== turnId(receipt)) return false;
    if (receipt && [receipt.clientUserMessageId, receipt.params?.clientUserMessageId].some(id => id && id !== entry.clientId)) return false;
    const actual = match || receipt;
    if (!actual || !turnId(actual)) return false;
    if (entry.turnId !== turnId(actual)) { entry.turnId = turnId(actual); this.save(); }
    if (entry.status === 'uncertain') { entry.status = 'awaiting'; this.save(); }
    return ['completed', 'failed', 'interrupted'].includes(actual.status);
  }
  async follow(bridge) {
    for (const entry of this.entries) if (!bridge.watched.has(entry.threadId)) {
      try { await bridge.watchQueued({ id: entry.threadId, title: entry.title }); } catch { /* Keep the original chat binding until its desktop owner is available. */ }
    }
  }
  async flush(bridge, onlyThread) {
    if (this.flushing || bridge.accountSwitching) return;
    this.flushing = true;
    try {
      const ids = [...new Set(this.entries.map(e => e.threadId))].filter(id => !onlyThread || onlyThread === id);
      for (const id of ids) {
        if (bridge.accountSwitching) break;
        let entry = this.entries.find(e => e.threadId === id);
        const w = bridge.watched.get(id);
        if (!w?.synced || !w.owner) continue;
        if (entry?.status === 'uncertain' && bridge.ipc.startReceipt && Date.now() - (entry.lastReceiptCheck || 0) >= 15000) {
          entry.lastReceiptCheck = Date.now();
          try {
            const receipt = await bridge.ipc.startReceipt(id, entry.clientId);
            const accepted = acceptedTurnId(receipt);
            if (accepted) { entry.turnId = accepted; entry.status = 'awaiting'; this.save(); }
          } catch { /* Read-only receipt recovery; never resend the original request. */ }
        }
        if (['awaiting', 'uncertain'].includes(entry?.status) && this.observe(entry, w)) {
          this.entries = this.entries.filter(e => e !== entry); this.save();
          entry = this.entries.find(e => e.threadId === id);
        }
        if (!entry || entry.status !== 'queued' || isBusy(w)) continue;
        entry.status = 'dispatching'; entry.baseTurnId = turnId(lastTurn(w.state)) || null; this.save();
        try {
          const response = await bridge.ipc.request('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input: entry.input, clientUserMessageId: entry.clientId }, context: { inheritThreadSettings: true } } }, w.owner, 60000);
          const accepted = acceptedTurnId(response); if (accepted) entry.turnId = accepted;
          entry.status = 'awaiting'; this.save();
          if (entry.notifyOnDispatch) {
            entry.notifyOnDispatch = false; this.save();
            await bridge.tg.send(bridge.chatId, card(T.sent, entry.title || id), { inline_keyboard: [[{ text: T.title, callback_data: 'u:queue' }]] }).catch(() => {});
          }
        } catch {
          entry.status = 'uncertain'; this.save();
          await bridge.tg.send(bridge.chatId, card(T.title, `${entry.title || id}\n\n${T.uncertain}`), this.markup(entry)).catch(() => {});
        }
      }
    } finally { this.flushing = false; }
  }
  markup(entry) { return { inline_keyboard: [[{ text: entry.status === 'uncertain' ? T.removeUncertain : T.cancel, callback_data: `o:${entry.id}:cancel` }], [{ text: T.title, callback_data: 'u:queue' }]] }; }
  async notice(bridge, entry) { return bridge.tg.send(bridge.chatId, card(T.queued, `${entry.title || entry.threadId}\n\n${this.countsText(entry.threadId)}\n\n${T.waiting}`), this.markup(entry)); }
  async show(bridge, offset = 0) {
    if (!this.entries.length) return bridge.tg.send(bridge.chatId, card(T.title, T.empty));
    offset = Math.max(0, Math.min(offset, Math.floor((this.entries.length - 1) / 5) * 5));
    for (const entry of this.entries.slice(offset, offset + 5)) {
      const preview = entry.input.filter(i => i.type === 'text').map(i => i.text).join('\n').slice(0, 200);
      const w = bridge.watched.get(entry.threadId);
      const recovery = entry.status === 'awaiting' && w?.synced && !isBusy(w);
      const markup = recovery ? { inline_keyboard: [[{text:T.confirmFinished,callback_data:`o:${entry.id}:review`}]] } : ['queued', 'uncertain'].includes(entry.status) ? this.markup(entry) : undefined;
      await bridge.tg.send(bridge.chatId, card(T.title, `${entry.title || entry.threadId}\n${T[entry.status + 'Status']}\n\n${preview}${recovery?'\n\n'+T.needsReview:''}`), markup);
    }
    const navigation = [];
    if (offset) navigation.push({ text: T.previous, callback_data: `o:page:${offset - 5}` });
    if (offset + 5 < this.entries.length) navigation.push({ text: T.next, callback_data: `o:page:${offset + 5}` });
    await bridge.tg.send(bridge.chatId, `${offset + 1}–${Math.min(offset + 5, this.entries.length)} / ${this.entries.length}`, { inline_keyboard: [...(navigation.length ? [navigation] : []), [{text:T.refresh,callback_data:'o:refresh'}], [{ text: T.home, callback_data: 'u:home' }]] });
  }
  async callback(data, bridge) {
    if (data === 'o:refresh') {
      await this.follow(bridge);
      for (const id of new Set(this.entries.map(e=>e.threadId))) await bridge.refreshQueued(id);
      await this.flush(bridge); return this.show(bridge);
    }
    const recover = /^o:([0-9a-f-]{36}):review$/i.exec(data);
    if (recover) {
      const entry = this.entries.find(e=>e.id===recover[1]);
      if (!entry || entry.status !== 'awaiting' || this.flushing || bridge.accountSwitching) throw Error(T.stale);
      await bridge.refreshQueued(entry.threadId);
      const w=bridge.watched.get(entry.threadId);
      if (!w?.synced || !w.owner || isBusy(w)) throw Error(T.busyRecovery);
      const token=randomUUID();
      (this.reviews ||= new Map()).set(token,{entryId:entry.id,threadId:entry.threadId,expires:Date.now()+120000});
      return bridge.tg.send(bridge.chatId,card(T.title,`${entry.title || entry.threadId}\n\n${T.confirmReview}`),{inline_keyboard:[[{text:T.confirmFinished,callback_data:`o:confirm:${token}`}],[{text:T.title,callback_data:'u:queue'}]]});
    }
    const confirmation=/^o:confirm:([0-9a-f-]{36})$/i.exec(data);
    if (confirmation) {
      const review=this.reviews?.get(confirmation[1]);this.reviews?.delete(confirmation[1]);
      const entry=review && this.entries.find(e=>e.id===review.entryId && e.threadId===review.threadId);
      if (!entry || review.expires < Date.now() || entry.status !== 'awaiting' || this.flushing || bridge.accountSwitching) throw Error(T.stale);
      await bridge.refreshQueued(entry.threadId);
      const w=bridge.watched.get(entry.threadId);
      if (!w?.synced || !w.owner || isBusy(w) || this.flushing || bridge.accountSwitching || !this.entries.includes(entry)) throw Error(T.busyRecovery);
      this.entries=this.entries.filter(e=>e!==entry);this.save();
      await bridge.tg.send(bridge.chatId,T.recovered);
      await this.flush(bridge,entry.threadId);return this.show(bridge);
    }
    const page = /^o:page:(\d{1,3})$/.exec(data);
    if (page) return this.show(bridge, Number(page[1]));
    const match = /^o:([0-9a-f-]{36}):cancel$/i.exec(data), entry = match && this.entries.find(e => e.id === match[1]);
    if (!entry) throw Error(T.stale);
    if (!['queued', 'uncertain'].includes(entry.status)) throw Error(T.busyCancel);
    this.entries = this.entries.filter(e => e !== entry); this.save();
    return bridge.tg.send(bridge.chatId, T.cancelled);
  }
}
