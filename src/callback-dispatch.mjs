// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Call only after authenticating the private owner. An expired acknowledgement
// must not discard the action; handlers still enforce their own bound tokens.
export async function dispatchCallback(query, tg, ui, inbox, bridge) {
  try { await tg.call('answerCallbackQuery', { callback_query_id: query.id }); } catch {}
  const data = query.data || '';
  if (data.startsWith('u:')) return ui.callback(data);
  if (data.startsWith('f:')) return ui.features.callback(data);
  if (data.startsWith('r:')) return ui.quota.callback(data);
  if (data.startsWith('b:')) return inbox.callback(data);
  return bridge.callback(data);
}
