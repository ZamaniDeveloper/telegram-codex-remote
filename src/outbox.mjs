// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lastTurn, turnId, turnsOf } from './state.mjs';
import { card } from './format.mjs';
import { text as T } from './outbox-text.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    if (entry.status !== 'awaiting' || !w?.synced) return false;
    const turns = turnsOf(w.state);
    const match = turns.find(t => (t.items || []).some(i => i.type === 'userMessage' && [i.clientId, i.clientUserMessageId, i.id].includes(entry.clientId)));
    const actual = match;
    if (!actual || !turnId(actual)) return false;
    if (entry.turnId !== turnId(actual)) { entry.turnId = turnId(actual); this.save(); }
    return ['completed', 'failed', 'interrupted'].includes(actual.status) && !isBusy(w);
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
        if (entry?.status === 'awaiting' && this.observe(entry, w)) {
          this.entries = this.entries.filter(e => e !== entry); this.save();
          entry = this.entries.find(e => e.threadId === id);
        }
        if (!entry || entry.status !== 'queued' || isBusy(w)) continue;
        entry.status = 'dispatching'; entry.baseTurnId = turnId(lastTurn(w.state)) || null; this.save();
        try {
          await bridge.ipc.request('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input: entry.input, clientUserMessageId: entry.clientId }, context: { inheritThreadSettings: true } } }, w.owner, 60000);
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
  async notice(bridge, entry) { return bridge.tg.send(bridge.chatId, card(T.queued, `${entry.title || entry.threadId}\n\n${T.waiting}`), this.markup(entry)); }
  async show(bridge, offset = 0) {
    if (!this.entries.length) return bridge.tg.send(bridge.chatId, card(T.title, T.empty));
    offset = Math.max(0, Math.min(offset, Math.floor((this.entries.length - 1) / 5) * 5));
    for (const entry of this.entries.slice(offset, offset + 5)) {
      const preview = entry.input.filter(i => i.type === 'text').map(i => i.text).join('\n').slice(0, 200);
      await bridge.tg.send(bridge.chatId, card(T.title, `${entry.title || entry.threadId}\n${T[entry.status + 'Status']}\n\n${preview}`), ['queued', 'uncertain'].includes(entry.status) ? this.markup(entry) : undefined);
    }
    const navigation = [];
    if (offset) navigation.push({ text: T.previous, callback_data: `o:page:${offset - 5}` });
    if (offset + 5 < this.entries.length) navigation.push({ text: T.next, callback_data: `o:page:${offset + 5}` });
    await bridge.tg.send(bridge.chatId, `${offset + 1}–${Math.min(offset + 5, this.entries.length)} / ${this.entries.length}`, { inline_keyboard: [...(navigation.length ? [navigation] : []), [{ text: T.home, callback_data: 'u:home' }]] });
  }
  async callback(data, bridge) {
    const page = /^o:page:(\d{1,3})$/.exec(data);
    if (page) return this.show(bridge, Number(page[1]));
    const match = /^o:([0-9a-f-]{36}):cancel$/i.exec(data), entry = match && this.entries.find(e => e.id === match[1]);
    if (!entry) throw Error(T.stale);
    if (!['queued', 'uncertain'].includes(entry.status)) throw Error(T.busyCancel);
    this.entries = this.entries.filter(e => e !== entry); this.save();
    return bridge.tg.send(bridge.chatId, T.cancelled);
  }
}
