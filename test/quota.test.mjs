// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountRpc, QuotaClient, validateReset } from '../src/quota-client.mjs';
import { QuotaUi, quotaBody, resetCount } from '../src/quota-ui.mjs';
import { createConnector } from '../src/connector-server.mjs';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
import { BotUi, LABELS } from '../src/ui.mjs';
import { Inbox } from '../src/inbox.mjs';

function sample() {
  return { accountId: 'account-A', planType: 'plus', rateLimitsByLimitId: { codex: { primary: { usedPercent: 76, windowDurationMins: 300, resetsAt: 1791464401 }, secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1791959239 } } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'C', status: 'available', title: 'Full reset (Weekly + 5 hr)', expiresAt: 1999999999 }] } };
}
class Tg {
  sent = [];
  async send(chat, value, markup) { this.sent.push({ chat, text: value.text || value, markup }); return { message_id: this.sent.length }; }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-quota-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tg = new Tg(), stateFile = path.join(root, 'quota-reset.json'), api = { data: sample(), calls: [], fail: false, outcome: 'reset', async read() { return structuredClone(this.data); }, async consume(value) { this.calls.push(structuredClone(value)); if (this.fail) throw Error('network'); return { outcome: this.outcome }; } };
  const bridge = { tg, chatId: 123, ipc: {} }, ui = new QuotaUi(bridge, { stateFile, api }); return { root, tg, stateFile, api, bridge, ui };
}
function findButton(tg, command) { return tg.sent.at(-1).markup.inline_keyboard.flat().find(b => b.callback_data.endsWith(':' + command)).callback_data; }
async function confirm(tg, ui) { await ui.show(); await ui.callback(findButton(tg, 'choose')); return findButton(tg, 'confirm'); }

test('quota shows remaining percentage, both windows, Tehran reset times and credit count', () => {
  const body = quotaBody(sample()).text;
  assert.match(body, /۲۴٪ باقی‌مانده/); assert.match(body, /۷۵٪ باقی‌مانده/); assert.match(body, /۵ ساعته/); assert.match(body, /هفتگی/); assert.match(body, /Full reset/); assert.match(body, /انقضا/);
  assert.ok(!body.includes('account-A')); assert.equal(resetCount({ rateLimitResetCredits: null }), null);
  const unavailable = quotaBody({ rateLimits: { primary: { usedPercent: null } }, rateLimitResetCredits: null }).text;
  assert.match(unavailable, /مصرف نامشخص/); assert.ok(!unavailable.includes('۱۰۰٪')); assert.match(unavailable, /اطلاعات موجود نیست/);
});
test('native account worker handles fragmented Persian JSON, sanitizes errors and prohibits inference methods', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; const writes = [];
  child.stdin = new Writable({ write(chunk, _, done) { writes.push(JSON.parse(chunk)); done(); } });
  const rpc = new AccountRpc(child, 1000);
  try {
    const read = rpc.request('account/rateLimits/read', {}); const response = Buffer.from(JSON.stringify({ id: writes[0].id, result: { text: 'سلام 👋' } }) + '\n');
    for (const byte of response) child.stdout.write(Buffer.from([byte])); assert.equal((await read).text, 'سلام 👋');
    const failed = rpc.request('account/read', {}); child.stdout.write(JSON.stringify({ id: writes.at(-1).id, error: { code: 1, message: 'SECRET_TOKEN' } }) + '\n'); await assert.rejects(failed, e => !e.message.includes('SECRET_TOKEN'));
    await assert.rejects(rpc.request('turn/start', {}), /not allowed/); assert.equal(writes.length, 2);
  } finally { rpc.close(); }
});
test('QuotaClient reads current ChatGPT identity and enforces same account before reset', async () => {
  const calls = [], data = sample(); const rpc = { async request(method, params) { calls.push({ method, params }); return method === 'account/read' ? { account: { type: 'chatgpt', planType: 'plus' } } : method === 'account/rateLimits/read' ? data : { outcome: 'reset' }; } };
  const client = new QuotaClient(fn => fn(rpc)); await client.read(); const intent = { expectedAccountId: 'account-A', idempotencyKey: randomUUID(), creditId: 'C' };
  await client.consume(intent); const consume = calls.find(c => c.method === 'account/rateLimitResetCredit/consume'); assert.deepEqual(consume.params, { idempotencyKey: intent.idempotencyKey, creditId: 'C' });
  data.accountId = 'account-B'; assert.equal((await client.consume(intent)).outcome, 'accountChanged'); assert.equal(calls.filter(c => c.method.endsWith('/consume')).length, 1);
  assert.ok(calls.every(c => c.method.startsWith('account/'))); assert.throws(() => validateReset({ ...intent, idempotencyKey: '' }));
});
test('checking usage, choosing reset and cancellation never consume credit', async t => {
  const { ui, tg, api } = await fixture(t); await ui.show(); const choose = findButton(tg, 'choose'); await ui.callback(choose);
  assert.match(tg.sent.at(-1).text, /یک اعتبار/); assert.equal(api.calls.length, 0);
  const cancel = findButton(tg, 'cancel'), old = findButton(tg, 'confirm'); await ui.callback(cancel); await assert.rejects(ui.callback(old)); assert.equal(api.calls.length, 0);
});
test('only available credits display reset controls; unavailable data never means zero usage', async t => {
  const { ui, api, tg } = await fixture(t); api.data.rateLimitResetCredits.availableCount = 0; await ui.show(); assert.ok(!tg.sent.at(-1).markup.inline_keyboard.flat().some(b => b.callback_data.startsWith('r:')));
  api.data.rateLimitResetCredits = null; await ui.show(); assert.match(tg.sent.at(-1).text, /اطلاعات موجود نیست/); assert.equal(api.calls.length, 0);
});
test('count-only reset credits use service selection and require explicit confirmation', async t => {
  const { ui, tg, api } = await fixture(t); api.data.rateLimitResetCredits.credits = null; const button = await confirm(tg, ui); await ui.callback(button);
  assert.equal(api.calls.length, 1); assert.equal(api.calls[0].creditId, undefined); assert.equal(ui.current, null); await assert.rejects(ui.callback(button));
});
test('confirmation dispatches exactly once and persists intent before sending', async t => {
  const { ui, tg, api, stateFile } = await fixture(t); const button = await confirm(tg, ui);
  api.consume = async value => { api.calls.push(value); const state = JSON.parse(await readFile(stateFile)); assert.equal(state.intent.idempotencyKey, value.idempotencyKey); assert.equal(state.status, 'sending'); return { outcome: 'reset' }; };
  await ui.callback(button); assert.equal(api.calls.length, 1); assert.equal(ui.current, null); assert.match(tg.sent.at(-2).text, /ریست شد/);
  await assert.rejects(ui.callback(button)); assert.equal(api.calls.length, 1);
});
test('expired credits and a changed account invalidate old reset selection', async t => {
  const { ui, tg, api } = await fixture(t); await ui.show(); const choose = findButton(tg, 'choose'); api.data.accountId = 'account-B'; await assert.rejects(ui.callback(choose), /حساب/);
  api.data.accountId = 'account-A'; api.data.rateLimitResetCredits.credits[0].expiresAt = 1; await assert.rejects(ui.callback(choose), /اعتبار/); assert.equal(api.calls.length, 0);
});
test('uncertain reset survives restart and retries use the exact original idempotency key', async t => {
  const { ui, tg, api, stateFile, bridge } = await fixture(t); const button = await confirm(tg, ui); api.fail = true; await ui.callback(button);
  const first = structuredClone(api.calls[0]); assert.equal(ui.current.status, 'uncertain');
  const restored = new QuotaUi(bridge, { stateFile, api }); api.fail = false; api.outcome = 'alreadyRedeemed'; api.data.rateLimitResetCredits.availableCount = 0;
  await restored.show(); assert.ok(!tg.sent.at(-1).markup.inline_keyboard.flat().some(b => b.callback_data.endsWith(':choose')));
  await restored.callback(findButton(tg, 'retry')); assert.deepEqual(api.calls[1], first); assert.equal(restored.current, null); assert.match(tg.sent.at(-2).text, /اعتبار دیگری مصرف نشد/);
});
test('account changes during uncertain retry retain the original unresolved intent', async t => {
  const { ui, tg, api } = await fixture(t); const button = await confirm(tg, ui); api.fail = true; await ui.callback(button); const key = ui.current.intent.idempotencyKey;
  const retry = findButton(tg, 'retry'); api.fail = false; api.outcome = 'accountChanged'; await ui.callback(retry);
  assert.equal(ui.current.intent.idempotencyKey, key); assert.equal(ui.current.status, 'uncertain'); assert.match(tg.sent.at(-1).text, /حساب اصلی/);
});
test('noCredit and nothingToReset are definitive outcomes without fabricated success', async t => {
  const { ui, tg, api } = await fixture(t);
  for (const outcome of ['noCredit', 'nothingToReset']) { api.outcome = outcome; const button = await confirm(tg, ui); await ui.callback(button); assert.equal(ui.current, null); assert.ok(!tg.sent.at(-2).text.includes('✅')); }
});
test('authenticated remote quota RPC confines methods and rejects malformed reset parameters', async () => {
  const ipc = new EventEmitter(); ipc.close = () => {}; const data = sample(), calls = [], quota = { async read() { return data; }, async consume(value) { calls.push(value); return { outcome: 'reset' }; } };
  const secret = 'test_secret_'.repeat(5); const server = createConnector({ secret, ipc, quota }); await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}`, remote = new RemoteDesktop(url, secret);
  try {
    assert.equal((await remote.quotaRead()).accountId, 'account-A'); await assert.rejects(remote.quotaReset({ idempotencyKey: 'bad' })); assert.equal(calls.length, 0);
    const intent = { idempotencyKey: randomUUID(), expectedAccountId: 'account-A' }; assert.equal((await remote.quotaReset(intent)).outcome, 'reset'); assert.deepEqual(calls[0], intent);
    assert.equal((await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ method: 'quotaReset', args: [intent] }) })).status, 403);
    await assert.rejects(remote.rpc('request', ['account/rateLimitResetCredit/consume', intent]), /not allowed/);
  } finally { await server.shutdown(); }
});
test('usage button and slash command bypass bundles and questions without starting a turn', async t => {
  const { root, api, tg } = await fixture(t); const bridge = { tg, chatId: 123, ipc: { quotaRead: () => api.read(), quotaReset: value => api.consume(value) }, selected: null, text() { throw Error('must not send a model message'); } };
  const inbox = new Inbox(bridge, { root }), ui = new BotUi(bridge, inbox); inbox.begin();
  await ui.message({ text: LABELS.usage }); await ui.message({ text: '/usage' }); assert.equal(api.calls.length, 0); assert.equal(inbox.current.items.length, 0); assert.match(tg.sent.at(-1).text, /سهمیه/);
});
