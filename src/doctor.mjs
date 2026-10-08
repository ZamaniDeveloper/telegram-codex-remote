// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { DesktopIpc } from './ipc.mjs';
import { listThreads } from './catalog.mjs';
import { lastTurn, pendingRequests } from './state.mjs';

const ipc = new DesktopIpc();
let threadId, owner;
try {
  const threads = listThreads(); console.log('Local catalog:', threads.length, 'recent chats found');
  threadId = process.argv[2] || threads[0]?.id;
  if (!threadId) throw Error('No local chat found');
  owner = await ipc.owner(threadId);
  console.log('Connected to running desktop; thread owner found.');
  const snapshot = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No desktop snapshot received')), 10000);
    ipc.on('broadcast', m => {
      if (m.method === 'thread-stream-state-changed' && m.params.conversationId === threadId && m.params.change.type === 'snapshot') {
        clearTimeout(timer); resolve(m.params.change.conversationState);
      }
    });
  });
  ipc.follow(threadId, owner);
  const state = await snapshot;
  const turn = lastTurn(state);
  console.log('Live snapshot OK. History mode:', state.historyMode, 'Runtime:', state.threadRuntimeStatus?.type);
  console.log('Turn fields:', Object.keys(turn || {}));
  console.log('Item fields:', (turn?.items || []).slice(-3).map(i => ({ type: i.type, keys: Object.keys(i) })));
  console.log('History fields:', Object.keys(state.turnHistory?.history || {}));
  console.log('Approval/input fields:', pendingRequests(state).map(r => ({ keys: Object.keys(r), method: r.method })));
  console.log('No Telegram request, user message, or model inference was sent.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { if (owner) ipc.follow(threadId, owner, false); ipc.close(); }
