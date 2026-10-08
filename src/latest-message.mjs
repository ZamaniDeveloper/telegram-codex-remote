// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
export function messageFromItem(item) {
  if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) return { role: 'Codex', text: item.text };
  if (!['userMessage', 'steeringUserMessage'].includes(item?.type) || item.status === 'rejected') return null;
  const content = item.content || item.input || [];
  const text = item.text || (typeof content === 'string' ? content : Array.isArray(content) ? content.map(i => {
    if (['text', 'inputText', 'input_text'].includes(i.type)) return i.text;
    if (['image', 'localImage'].includes(i.type)) return '[Image]';
    return '';
  }).filter(Boolean).join('\n') : '');
  return typeof text === 'string' && text.trim() ? { role: 'User', text } : null;
}

export async function readLatestMessage(rpc, threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw Error('Invalid thread ID');
  let cursor; const seen = new Set();
  // Small pages avoid transporting many large tool outputs just to find a message.
  for (let page = 0; page < 500; page++) {
    const result = await rpc.request('thread/items/list', { threadId, sortDirection: 'desc', limit: 5, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.some(entry => typeof entry?.item?.type !== 'string') || (result.nextCursor != null && typeof result.nextCursor !== 'string')) throw Error('Codex history schema changed; update TeleCodex');
    for (const entry of result.data) {
      const message = messageFromItem(entry.item);
      if (message) return message;
    }
    cursor = result.nextCursor;
    if (!cursor) return null;
    if (seen.has(cursor)) throw Error('Codex history cursor repeated');
    seen.add(cursor);
  }
  throw Error('Recent history exceeds the supported scan limit; open this conversation in Codex');
}
