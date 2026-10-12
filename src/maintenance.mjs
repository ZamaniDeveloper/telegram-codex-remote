// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Telegram output failures must not prevent read-only reconciliation or queue work.
export async function maintainBridge({bridge,inbox,ui,restore}) {
  for (const operation of [()=>inbox.flush(),()=>bridge.reconnect(),restore,
    ()=>bridge.flush(),()=>bridge.outbox.follow(bridge),()=>bridge.outbox.flush(bridge),
    ()=>ui.accounts.poll()]) {
    if (operation) try {await operation();} catch { /* No control action is replayed. */ }
  }
}

// Each lane has its own lock. A hanging Telegram request cannot block desktop
// reconciliation, and an unavailable desktop cannot stop Telegram updates.
export function maintenanceScheduler({ bridge, inbox, ui, restore }) {
  const active = new Map(); let stopped = false;
  const safe = async operation => { try { await operation?.(); } catch { /* No action replay. */ } };
  const lanes = {
    desktop: async () => { await safe(() => bridge.reconnect()); await safe(restore); await safe(() => bridge.outbox.follow(bridge)); await safe(() => bridge.outbox.flush(bridge)); },
    delivery: async () => { await safe(() => inbox.flush()); await safe(() => bridge.flush()); },
    accounts: () => safe(() => ui.accounts.poll()),
  };
  return {
    tick() {
      if (stopped) return;
      for (const [name, operation] of Object.entries(lanes)) if (!active.has(name)) {
        const promise = Promise.resolve().then(operation).finally(() => active.delete(name));
        active.set(name, promise);
      }
    },
    async idle() { await Promise.all([...active.values()]); },
    stop() { stopped = true; },
  };
}
