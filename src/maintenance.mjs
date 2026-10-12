// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Telegram output failures must not prevent read-only reconciliation or queue work.
export async function maintainBridge({bridge,inbox,ui,restore}) {
  for (const operation of [()=>inbox.flush(),()=>bridge.reconnect(),restore,
    ()=>bridge.flush(),()=>bridge.outbox.follow(bridge),()=>bridge.outbox.flush(bridge),
    ()=>ui.accounts.poll()]) {
    if (operation) try {await operation();} catch { /* No control action is replayed. */ }
  }
}
