// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ControlRpc, DesktopControl, projectFolder } from '../src/desktop-control.mjs';
import { Compatibility, extractVersions } from '../src/compatibility.mjs';
import { Features, latestMessage } from '../src/features.mjs';
import { text as T } from '../src/feature-text.mjs';
import { AttachmentStore } from '../src/attachments.mjs';
import { resolveAudio, Transcriber } from '../src/transcription.mjs';
import { Inbox, bundleInput } from '../src/inbox.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';

async function temporary(t) { const dir = await mkdtemp(path.join(tmpdir(), 'telecodex-feature-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('compatibility detects changed or missing versions and refuses unverified writes', async () => {
  const expected = { 'thread-owner-discovery': 1, 'thread-stream-state-changed': 11, edit: 2 };
  const source = 'var v={"thread-owner-discovery":1,"thread-stream-state-changed":11,"edit":3};';
  const observed = extractVersions(source); assert.equal(observed.edit, 3); assert.equal(extractVersions('missing'), null);
  const c = new Compatibility(expected, async () => ({ version: 'future', versions: observed }));
  assert.deepEqual((await c.read()).incompatible, ['edit']); await assert.rejects(c.assert('edit'), /disabled/);
  await c.assert('thread-owner-discovery');
  const unknown = new Compatibility(expected, async () => { throw Error('missing'); }); await assert.rejects(unknown.assert('edit'), /Cannot verify/);
});
test('control worker forbids resuming threads, inference, account changes and arbitrary methods', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const rpc = new ControlRpc(child, 100);
  for (const method of ['thread/resume', 'turn/start', 'account/login/start', 'project/delete']) await assert.rejects(rpc.request(method, {}), /not allowed/);
  const result = rpc.request('model/list', {});
  const line = Buffer.from('{"id":1,"result":{"data":[{"model":"Test model"}]}}\n'); child.stdout.write(line.subarray(0, 25)); child.stdout.write(line.subarray(25));
  assert.equal((await result).data[0].model, 'Test model'); rpc.close();
});
test('new chat creation is durable, duplicate-safe and does not resume an existing thread', async t => {
  const root = await temporary(t), id = randomUUID(), projectId = randomUUID(), calls = [];
  const c = new DesktopControl({ root, journal: path.join(root, 'journal'), run: async op => op({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'project/create') return { project: { id: projectId, roots: params.roots } };
    if (method === 'thread/start') return { thread: { id } };
    return {};
  } }) });
  const request = { key: randomUUID(), kind: 'project', name: 'Sample project' };
  const result = await c.create(request); assert.equal(result.id, id); assert.deepEqual(await c.create(request), result);
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(calls[1].params.projectId, projectId); assert.equal(calls[1].params.ephemeral, false);
  assert.equal(JSON.parse(await readFile(path.join(root, 'journal', request.key + '.json'))).status, 'complete');
  for (const name of ['../outside', 'a/b', 'CON', 'name.', '']) assert.throws(() => projectFolder(name, root));
});
test('ambiguous creation persists intent and never retries the thread start', async t => {
  const root = await temporary(t), projectId = randomUUID(); let starts = 0;
  const c = new DesktopControl({ journal: root, run: async op => op({ request: async method => {
    if (method === 'project/list') return { data: [{ id: projectId, roots: [{ path: root }] }] };
    if (method === 'thread/start') { starts++; throw Error('connection lost'); }
  } }) });
  const request = { key: randomUUID(), kind: 'chat', name: 'Sample', projectId };
  await assert.rejects(c.create(request)); await assert.rejects(c.create(request), /uncertain/); assert.equal(starts, 1);
});
test('latest message follows canonical loaded history and handles an empty active turn', () => {
  const state = { turnHistory: { kind: 'canonical', history: { entitiesByKey: { T: { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }, { type: 'agentMessage', text: 'reply' }] } }, islands: [{ entries: [{ value: 'T' }, { value: { items: [] } }] }] } } };
  assert.deepEqual(latestMessage(state), { role: 'Codex', text: 'reply' }); assert.equal(latestMessage({ turns: [] }), null);
});
function uiFixture() {
  const sent = [], calls = []; let settings = { model: 'first', reasoningEffort: 'low' };
  const bridge = { selected: { id: 'A', owner: 'desktop' }, readyToSend(id) { if (id && id !== this.selected.id || this.busy) throw Error('wrong chat or busy'); return this.selected; }, ipc: {
    async models() { return [{ model: 'second', displayName: 'Second', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]; },
    async request(method, params) { calls.push({ method, params }); if (method === 'thread-follower-update-thread-settings') settings = { model: params.threadSettings.model, reasoningEffort: params.threadSettings.effort }; return { result: { settings: { ...settings } } }; },
  } };
  const ui = { bridge, inbox: {}, tg: { async send(chat, value, markup) { sent.push({ value, markup }); return { message_id: sent.length }; } }, chatId: 1 };
  return { features: new Features(ui), bridge, calls, sent, change: value => { settings = value; } };
}
test('model and effort buttons update the same idle desktop chat once and verify settings', async () => {
  const f = uiFixture(); await f.features.route('models'); const model = f.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  await f.features.callback(model); const effort = f.sent.at(-1).markup.inline_keyboard[0][0].callback_data;
  await f.features.callback(effort); await assert.rejects(f.features.callback(effort), new RegExp(T.stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const updates = f.calls.filter(c => c.method === 'thread-follower-update-thread-settings'); assert.equal(updates.length, 1); assert.deepEqual(updates[0].params.threadSettings, { model: 'second', effort: 'high' }); assert.equal(updates[0].params.activeTurnId, null);
});
test('model controls reject a different selected chat, a running turn or changed settings', async () => {
  for (const change of [f => { f.bridge.selected.id = 'B'; }, f => { f.bridge.busy = true; }, f => f.change({ model: 'other', reasoningEffort: 'low' })]) {
    const f = uiFixture(); await f.features.route('models'); await f.features.callback(f.sent.at(-1).markup.inline_keyboard[0][0].callback_data);
    const effort = f.sent.at(-1).markup.inline_keyboard[0][0].callback_data; change(f); await assert.rejects(f.features.callback(effort)); assert.equal(f.calls.filter(c => c.method.includes('update')).length, 0);
  }
});
test('replies to creation prompts from before a restart cannot become model input', async () => {
  const f = uiFixture(); await assert.rejects(f.features.message({ text: 'Old title', reply_to_message: { message_id: 42, text: T.newchat + '\nEnter title' } })); assert.equal(f.calls.length, 0);
});
test('local transcription resolves only checksum-verified attachment storage', async t => {
  const root = await temporary(t), bytes = Buffer.from('audio fixture'), meta = { batchId: randomUUID(), id: randomUUID(), name: '../../audio.wav', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const store = new AttachmentStore(root); const file = await store.put(meta, PassThrough.from(bytes));
  assert.equal(await resolveAudio(meta, root), await realpath(file.path)); await assert.rejects(resolveAudio({ ...meta, sha256: '0'.repeat(64) }, root), /checksum/); await assert.rejects(resolveAudio({ ...meta, batchId: '../escape' }, root), /metadata/);
  const model = path.join(root, 'model'); await mkdir(model); await writeFile(path.join(model, 'model.bin'), 'test'); const python = path.join(root, 'python'); await writeFile(python, 'test');
  let called;
  const engine = new Transcriber({ python, modelPath: model, run: async (exe, request) => { called = request; return { text: 'local transcript' }; } });
  assert.equal((await engine.transcribe(meta, root)).text, 'local transcript'); assert.equal(called.audioPath, await realpath(file.path)); assert.equal(called.modelPath, model);
});
test('voice transcription stays asynchronous and is bundled once with the original audio', async t => {
  const root = await temporary(t), bytes = Buffer.from('audio'), sent = [];
  const bridge = { ipc: {}, chatId: 1, selected: { id: 'A', title: 'Sample' }, readyToSend() { return this.selected; }, async sendInput(input) { sent.push(input); }, tg: {
    async send() { return { message_id: 1 }; }, async edit() {}, async downloadFile(id, file) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); return { size: bytes.length, prefix: bytes, sha256: createHash('sha256').update(bytes).digest('hex') }; },
  } };
  const inbox = new Inbox(bridge, { root, transfer: async () => ({ path: 'C:/safe/audio.ogg', image: false }) }); let complete;
  inbox.transcribe = () => new Promise(resolve => { complete = resolve; });
  await inbox.message({ message_id: 1, voice: { file_id: 'voice', file_size: bytes.length } }); const draft = inbox.current;
  await inbox.send(); assert.equal(sent.length, 0); assert.equal(draft.status, 'ready');
  while (!complete) await new Promise(r => setImmediate(r)); complete({ text: '/stop reference text', language: 'en' }); await Promise.all(inbox.transcriptionJobs.values());
  assert.equal(draft.items[0].text, '/stop reference text'); await inbox.send(); assert.equal(sent.length, 1); assert.match(sent[0][0].text, /\/stop reference text/); assert.match(sent[0][0].text, /C:\/safe\/audio.ogg/);
});
test('authenticated connector exposes only scoped catalogs, creation, diagnostics and audio metadata', async t => {
  const root = await temporary(t), secret = 'test-secret-'.repeat(4), ipc = new EventEmitter();
  ipc.close = () => {}; ipc.compatibilityRead = async () => ({ status: 'compatible', version: 'fixture', incompatible: [], verified: true });
  const calls = [];
  const control = { models: async () => [{ model: 'example' }], projects: async () => [{ id: 'project' }], create: async request => { calls.push(request); return { id: 'created' }; } };
  const transcriber = { status: async () => ({ ready: true }), transcribe: async (meta, base) => { assert.equal(base, root); await resolveAudio(meta, base); return { text: 'audio transcript' }; } };
  const server = createConnector({ secret, ipc, control, transcriber, attachments: new AttachmentStore(root) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.shutdown());
  const remote = new RemoteDesktop('http://127.0.0.1:' + server.address().port, secret);
  assert.equal((await remote.models())[0].model, 'example'); assert.equal((await remote.projects())[0].id, 'project');
  assert.equal((await remote.createChat({ kind: 'chat', key: 'fixture' })).id, 'created'); assert.equal(calls.length, 1);
  assert.equal((await remote.compatibilityRead(true)).verified, true); assert.equal((await remote.transcriptionStatus()).ready, true);
  await assert.rejects(remote.transcribeAttachment({ path: '/etc/passwd' }), /metadata/); await assert.rejects(remote.rpc('thread/resume', []), /not allowed/);
});
