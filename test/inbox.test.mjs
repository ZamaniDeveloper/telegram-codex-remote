// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Inbox } from '../src/inbox.mjs';
import { Bridge } from '../src/bridge.mjs';
import { AttachmentStore, MAX_FILE_BYTES, safeFilename } from '../src/attachments.mjs';
import { Telegram } from '../src/telegram.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
class FakeTelegram {
  sent = []; edits = [];
  async send(chat, text, markup) { this.sent.push({ chat, text: typeof text === 'string' ? text : text.text, entities: text.entities, markup }); return { message_id: this.sent.length }; }
  async edit(chat, id, text) { this.edits.push({ chat, id, text }); }
  async call(method, params) { this.edits.push({ method, params }); }
  async downloadFile(id, dest) {
    const bytes = id === 'photo' ? png : Buffer.from('متن واقعی فایل\nسلام');
    await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, bytes);
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), prefix: bytes.subarray(0, 16) };
  }
}
class FakeIpc extends EventEmitter {
  calls = []; fail = false;
  async request(method, params) { this.calls.push({ method, params }); if (this.fail) throw Error('Disconnected'); return { result: {} }; }
  follow() {}
  close() {}
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-inbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ipc = new FakeIpc(), tg = new FakeTelegram(), bridge = new Bridge(tg, 123, ipc);
  bridge.selected = { id: 'A', title: 'چت اول', owner: 'owner', synced: true,
    state: { turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } } };
  const transferred = []; const store = new AttachmentStore(path.join(root, 'windows'));
  const transfer = async (meta, source) => { transferred.push(meta); return store.uploadFile(meta, source); };
  const inboxRoot = path.join(root, 'pending'); const inbox = new Inbox(bridge, { root: inboxRoot, transfer, ...options });
  return { root, inboxRoot, inbox, ipc, tg, bridge, transferred, transfer };
}
test('multi-forward text, album images, document and explanation start exactly one turn in order', async t => {
  const { inbox, bridge, ipc, tg, transferred } = await fixture(t);
  const origin = { type: 'hidden_user', sender_user_name: 'فرستنده' };
  await inbox.message({ message_id: 1, text: 'اولین پیام', forward_origin: origin });
  await inbox.message({ message_id: 2, photo: [{ file_id: 'photo', width: 1, height: 1 }], caption: 'کپشن عکس', media_group_id: 'album', forward_origin: origin });
  await inbox.message({ message_id: 3, document: { file_id: 'doc', file_name: '../گزارش.txt' }, caption: 'شرح فایل', forward_origin: origin });
  await inbox.message({ message_id: 4, text: 'توضیح خودم' });
  assert.equal(ipc.calls.length, 0);
  await inbox.message({ message_id: 5, text: '/send این موارد را مقایسه کن' });
  assert.equal(ipc.calls.length, 1); const req = ipc.calls[0].params.turnStart.request;
  assert.equal(req.threadId, bridge.selected.id); assert.equal(req.input.length, 2); assert.equal(req.input[1].type, 'localImage');
  const prompt = req.input[0].text;
  assert.match(prompt, /این موارد را مقایسه کن/); assert.match(prompt, /فرستنده/); assert.match(prompt, /شرح فایل/); assert.match(prompt, /مسیر اصل فایل/);
  assert.ok(prompt.indexOf('اولین پیام') < prompt.indexOf('کپشن عکس') && prompt.indexOf('کپشن عکس') < prompt.indexOf('شرح فایل') && prompt.indexOf('شرح فایل') < prompt.indexOf('توضیح خودم'));
  assert.equal((await readFile(req.input[1].path)).toString('base64'), png.toString('base64'));
  assert.equal(transferred.length, 2); assert.equal(inbox.current, null);
  assert.match(tg.sent.at(-1).text, /۴|4/);
});
test('forwarded slash commands are reference content and cannot run control commands', async t => {
  const { inbox, ipc } = await fixture(t);
  await inbox.message({ message_id: 1, text: '/stop', forward_origin: { type: 'channel', chat: { title: 'کانال' } } });
  await inbox.message({ message_id: 2, text: '/send', forward_origin: { type: 'hidden_user', sender_user_name: 'شخص' } });
  assert.equal(ipc.calls.length, 0); assert.equal(inbox.current.items.length, 2);
  await inbox.send(); assert.equal(ipc.calls.length, 1); assert.equal(ipc.calls[0].method, 'thread-follower-start-turn');
  assert.match(ipc.calls[0].params.turnStart.request.input[0].text, /\/stop/);
});
test('explicit batch collects direct text, survives restart and rejects stale buttons after cancellation', async t => {
  const { inbox, inboxRoot, bridge, transfer, ipc } = await fixture(t);
  await inbox.message({ message_id: 1, text: '/batch' });
  await inbox.message({ message_id: 2, text: 'متن مستقیم' });
  const oldId = inbox.current.id;
  const restored = new Inbox(bridge, { root: inboxRoot, transfer });
  assert.equal(restored.current.items[0].text, 'متن مستقیم'); assert.equal(restored.current.threadId, 'A');
  await restored.cancel(); await restored.message({ message_id: 3, text: '/batch' });
  await assert.rejects(restored.callback(`b:${oldId}:send`), /فعال/); assert.equal(ipc.calls.length, 0);
});
test('changing chat or an active turn preserves the batch and never transfers or sends it', async t => {
  const { inbox, bridge, ipc, transferred } = await fixture(t);
  await inbox.message({ message_id: 1, document: { file_id: 'doc', file_name: 'file.txt' } });
  bridge.selected.id = 'B'; await assert.rejects(inbox.send(), /چت دیگری/);
  bridge.selected.id = 'A'; bridge.selected.state.threadRuntimeStatus.type = 'active';
  await assert.rejects(inbox.send(), /steer/); assert.equal(inbox.current.status, 'ready'); assert.equal(ipc.calls.length, 0); assert.equal(transferred.length, 0);
});
test('transfer failure retains a retryable batch; uncertain control result never automatically repeats', async t => {
  const { inbox, bridge, ipc, inboxRoot, transfer } = await fixture(t);
  await inbox.message({ message_id: 1, document: { file_id: 'doc', file_name: 'file.txt' } });
  const original = inbox.transfer; inbox.transfer = async () => { throw Error('Transfer unavailable'); };
  await assert.rejects(inbox.send(), /Transfer/); assert.equal(inbox.current.status, 'ready'); assert.equal(ipc.calls.length, 0);
  inbox.transfer = original; ipc.fail = true;
  await assert.rejects(inbox.send(), /نامشخص/); assert.equal(inbox.current.status, 'uncertain'); assert.equal(ipc.calls.length, 1);
  const restored = new Inbox(bridge, { root: inboxRoot, transfer });
  await assert.rejects(restored.send(), /نامشخص/); assert.equal(ipc.calls.length, 1);
});
test('crash during preparation is retryable but crash during dispatch is uncertain', async t => {
  const { inbox, bridge, inboxRoot, transfer } = await fixture(t);
  inbox.begin(); inbox.current.status = 'preparing'; inbox.save();
  assert.equal(new Inbox(bridge, { root: inboxRoot, transfer }).current.status, 'ready');
  inbox.current.status = 'sending'; inbox.save();
  assert.equal(new Inbox(bridge, { root: inboxRoot, transfer }).current.status, 'uncertain');
});
test('native attachment storage preserves bytes, verifies hashes, deduplicates and confines hostile names', async t => {
  const { root } = await fixture(t); const store = new AttachmentStore(path.join(root, 'store'));
  const meta = { batchId: randomUUID(), id: randomUUID(), name: '../../CON:.png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  const stream = async function* () { yield png.subarray(0, 1); yield png.subarray(1); };
  const saved = await store.put(meta, stream()); assert.equal(saved.image, true); assert.ok(saved.path.startsWith(store.root + path.sep));
  assert.deepEqual(await readFile(saved.path), png); assert.equal((await store.put(meta, stream())).path, saved.path);
  await assert.rejects(store.put({ ...meta, sha256: '0'.repeat(64) }, stream()), /different content/);
  await assert.rejects(store.put({ ...meta, id: randomUUID(), size: png.length - 1 }, stream()), /size limit/);
  await assert.rejects(store.put({ ...meta, batchId: '../escape' }, stream()), /metadata/);
  assert.equal(safeFilename('..\\secret.txt'), 'secret.txt'); assert.ok(!safeFilename('NUL.txt').startsWith('NUL'));
});
test('Telegram file download streams original bytes and redacts errors containing token URLs', async t => {
  const { root } = await fixture(t); const dest = path.join(root, 'download.png');
  const tg = new Telegram('123:SECRET', async url => {
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file.jpg', file_size: png.length } });
    const body = new ReadableStream({ start(c) { c.enqueue(png.subarray(0, 1)); c.enqueue(png.subarray(1)); c.close(); } });
    return new Response(body);
  });
  const result = await tg.downloadFile('photo', dest); assert.deepEqual(await readFile(dest), png);
  assert.deepEqual(result.prefix, png.subarray(0, 16)); assert.equal(result.size, png.length);
  const failed = new Telegram('123:SECRET', async url => {
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file.jpg' } });
    throw Error(url);
  });
  await assert.rejects(failed.downloadFile('photo', path.join(root, 'failed.png')), e => !e.message.includes('SECRET'));
  await assert.rejects(access(path.join(root, 'failed.png')));
  const oversized = new Telegram('123:SECRET', async () => Response.json({ ok: true, result: { file_path: 'file', file_size: MAX_FILE_BYTES + 1 } }));
  await assert.rejects(oversized.downloadFile('big', dest), /۲۰/);
});
