// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { randomUUID, randomBytes } from 'node:crypto';
import { DesktopControl } from './desktop-control.mjs';
import { Transcriber } from './transcription.mjs';
import { turnsOf } from './state.mjs';
import { card, splitRich, markdown } from './format.mjs';
import { text as T } from './feature-text.mjs';
import { messageFromItem } from './latest-message.mjs';

const ROUTES = ['last', 'newchat', 'projects', 'newproject', 'models', 'compat'];
const b = (text, callback_data) => ({ text, callback_data });
export const featureRows = () => [[T.last, T.newchat], [T.projects, T.newproject], [T.models, T.compat]];
export function latestMessage(state) {
  for (const turn of [...turnsOf(state)].reverse()) for (const item of [...(turn.items || [])].reverse()) {
    const message = messageFromItem(item); if (message) return message;
  }
  return null;
}
export function responseSettings(response) { return response?.result?.result?.settings || response?.result?.settings || response?.settings; }
export class Features {
  actions = new Map(); replies = new Map(); input = null;
  constructor(ui, { control = new DesktopControl(), transcriber = new Transcriber() } = {}) {
    this.ui = ui; this.bridge = ui.bridge; this.tg = ui.tg; this.chatId = ui.chatId; this.control = control; this.transcriber = transcriber;
  }
  rpc(method, ...args) { return this.bridge.ipc[method] ? this.bridge.ipc[method](...args) : this.control[method === 'createChat' ? 'create' : method](...args); }
  action(value) {
    const token = randomBytes(12).toString('hex'); this.actions.set(token, { ...value, expires: Date.now() + 15 * 60000 });
    if (this.actions.size > 300) this.actions.delete(this.actions.keys().next().value); return 'f:' + token;
  }
  send(title, body, rows = []) { return this.tg.send(this.chatId, card(title, body), { inline_keyboard: [...rows, [b(T.back, 'u:home')]] }); }
  cancelInput() { if (this.input) this.input.used = true; this.input = null; }
  async prompt(kind, context = {}) {
    this.cancelInput(); this.ui.cancelInput?.();
    const sent = await this.tg.send(this.chatId, card(kind === 'project' ? T.newproject : T.newchat, kind === 'project' ? T.projectName : T.title), { force_reply: true });
    this.input = { kind, ...context, key: randomUUID(), expires: Date.now() + 15 * 60000 };
    this.replies.set(sent.message_id, this.input); if (this.replies.size > 100) this.replies.delete(this.replies.keys().next().value);
  }
  async route(route) {
    this.cancelInput(); this.ui.cancelInput?.();
    if (route === 'last') return this.lastPage(0);
    if (route === 'newproject') { if (this.ui.inbox.current) throw Error(T.busy); return this.prompt('project'); }
    if (route === 'newchat' || route === 'projects') {
      if (this.ui.inbox.current) throw Error(T.busy);
      const projects = await this.rpc('projects'); return this.projectPage(projects, 0);
    }
    if (route === 'models') {
      const w = this.bridge.readyToSend(); const settings = responseSettings(await this.bridge.ipc.request('thread-follower-read-model-settings', { conversationId: w.id }, w.owner));
      if (!settings || !settings.model) throw Error(T.modelFailed);
      const models = await this.rpc('models'); return this.modelPage(models, 0, { threadId: w.id, settings });
    }
    if (route === 'compat') {
      const report = await this.bridge.ipc.compatibilityRead(true);
      const voice = this.bridge.ipc.transcriptionStatus ? await this.bridge.ipc.transcriptionStatus() : await this.transcriber.status();
      return this.send(T.compat, `${T[report.status] || T.unknown}\nCodex: ${report.version || '?'}\n${report.incompatible.join('\n')}\n\n${voice.ready ? T.whisperReady : T.whisperMissing}\n\n${T.boundary}`, [[b(T.refresh, this.action({ kind: 'refresh' }))]]);
    }
  }
  async lastPage(offset = 0) {
    const rows = await this.bridge.catalog('', 9, offset);
    const buttons = rows.slice(0, 8).map(row => [b((row.title || row.cwd || row.id).slice(0, 64), this.action({ kind: 'last', row, offset }))]);
    const pages = [];
    if (offset) pages.push(b(T.previous, this.action({ kind: 'lastPage', offset: Math.max(0, offset - 8) })));
    if (rows.length > 8) pages.push(b(T.next, this.action({ kind: 'lastPage', offset: offset + 8 })));
    if (pages.length) buttons.push(pages);
    return this.send(T.last, rows.length ? T.chooseLast : T.noChats, buttons);
  }
  async showLast(row, offset = 0) {
    const last = await this.rpc('latestMessage', row.id);
    const rows = [[b(T.refresh, this.action({ kind: 'last', row, offset }))], [b(T.allChats, this.action({ kind: 'lastPage', offset }))], [b(T.back, 'u:home')]];
    const chunks = splitRich(card(T.last + ' · ' + (row.title || row.id), last ? markdown(last.role + '\n\n' + last.text) : T.noMessage));
    for (let i = 0; i < chunks.length; i++) await this.tg.send(this.chatId, chunks[i], i === chunks.length - 1 ? { inline_keyboard: rows } : undefined);
  }
  projectPage(rows, offset) {
    const buttons = rows.slice(offset, offset + 8).map(p => [b((p.name || p.id).slice(0, 64), this.action({ kind: 'project', projectId: p.id }))]);
    if (offset) buttons.push([b(T.previous, this.action({ kind: 'projectsPage', rows, offset: offset - 8 }))]);
    if (rows.length > offset + 8) buttons.push([b(T.next, this.action({ kind: 'projectsPage', rows, offset: offset + 8 }))]);
    buttons.push([b(T.createProject, this.action({ kind: 'newproject' }))]); return this.send(T.projects, T.chooseProject, buttons);
  }
  modelPage(rows, offset, context) {
    const buttons = rows.slice(offset, offset + 8).map(model => [b((model.displayName || model.model).slice(0, 64), this.action({ kind: 'model', model, ...context }))]);
    if (offset) buttons.push([b(T.previous, this.action({ kind: 'modelsPage', rows, offset: offset - 8, ...context }))]);
    if (rows.length > offset + 8) buttons.push([b(T.next, this.action({ kind: 'modelsPage', rows, offset: offset + 8, ...context }))]);
    return this.send(T.models, T.chooseModel, buttons);
  }
  async callback(data) {
    this.cancelInput(); this.ui.cancelInput?.();
    const token = data.slice(2), a = this.actions.get(token); if (!a || a.expires < Date.now() || a.used) throw Error(T.stale); a.used = true;
    if (a.kind === 'refresh') return this.route('compat');
    if (a.kind === 'last') return this.showLast(a.row, a.offset);
    if (a.kind === 'lastPage') return this.lastPage(a.offset);
    if (a.kind === 'newproject') return this.route('newproject');
    if (a.kind === 'projectsPage') return this.projectPage(a.rows, a.offset);
    if (a.kind === 'modelsPage') return this.modelPage(a.rows, a.offset, a);
    if (a.kind === 'project') { if (this.ui.inbox.current) throw Error(T.busy); return this.prompt('chat', { projectId: a.projectId }); }
    if (a.kind === 'select') return this.bridge.select(a.row);
    if (a.kind === 'model') {
      this.bridge.readyToSend(a.threadId);
      const rows = (a.model.supportedReasoningEfforts || []).map(e => [b(e.reasoningEffort, this.action({ ...a, used: false, kind: 'effort', effort: e.reasoningEffort }))]);
      return this.send(T.models, T.chooseEffort, rows.length ? rows : [[b('Default', this.action({ ...a, used: false, kind: 'effort', effort: a.model.defaultReasoningEffort }))]]);
    }
    if (a.kind === 'effort') {
      const w = this.bridge.readyToSend(a.threadId), current = responseSettings(await this.bridge.ipc.request('thread-follower-read-model-settings', { conversationId: w.id }, w.owner));
      if (!current || current.model !== a.settings.model || current.reasoningEffort !== a.settings.reasoningEffort) throw Error(T.busy);
      const model = (await this.rpc('models')).find(m => m.model === a.model.model);
      if (!model || !model.supportedReasoningEfforts?.some(e => e.reasoningEffort === a.effort)) throw Error(T.stale);
      this.bridge.readyToSend(a.threadId);
      await this.bridge.ipc.request('thread-follower-update-thread-settings', { conversationId: w.id, activeTurnId: null, threadSettings: { model: model.model, effort: a.effort }, condition: { ifModelEquals: current.model, ifEffortEquals: current.reasoningEffort } }, w.owner);
      const after = responseSettings(await this.bridge.ipc.request('thread-follower-read-model-settings', { conversationId: w.id }, w.owner));
      if (after?.model !== model.model || after.reasoningEffort !== a.effort) throw Error(T.modelFailed);
      return this.send(T.models, `${T.modelUpdated}\n${model.model} · ${a.effort}`);
    }
    throw Error(T.stale);
  }
  async message(message) {
    const value = message.text?.trim(), replyId = message.reply_to_message?.message_id;
    const route = ROUTES.find(r => value === T[r] || new RegExp('^/' + r + '(?:@\\w+)?$').test(value || ''));
    if (route) { await this.route(route); return true; }
    if (replyId && !this.replies.has(replyId) && [T.newchat, T.newproject].some(title => message.reply_to_message.text?.startsWith(title))) throw Error(T.stale);
    const input = (replyId && this.replies.get(replyId)) || (!replyId && !value?.startsWith('/') && this.input);
    if (!input) { if (value?.startsWith('/') || this.ui.input) this.input = null; return false; }
    if (input.used || input.expires < Date.now()) throw Error(T.stale);
    if (!value || value.length > (input.kind === 'project' ? 80 : 120) || this.ui.inbox.current) throw Error(T.busy);
    input.used = true; this.input = null;
    const row = await this.rpc('createChat', { kind: input.kind, name: value, key: input.key, projectId: input.projectId });
    await this.send(T.newchat, T.created);
    try { await this.bridge.select(row); }
    catch { await this.send(T.newchat, `${T.selectCreated}\n${row.id}`, [[b(T.select, this.action({ kind: 'select', row }))]]); }
    return true;
  }
}
