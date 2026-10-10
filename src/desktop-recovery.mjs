// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { WindowsAccountRuntime } from './account-runtime.mjs';

// Reopen an absent desktop and reconnect only. Never restart an existing
// process, touch credentials, or repeat a user/model request.
export class DesktopRecovery {
  pending = null; timer = null; stopped = false; lastFailure = false;
  constructor(ipc, { runtime = new WindowsAccountRuntime(null, ipc), blocked = () => false, intervalMs = 5000, report = () => {} } = {}) {
    this.ipc = ipc; this.runtime = runtime; this.blocked = blocked; this.intervalMs = intervalMs; this.report = report;
  }
  ensure() {
    if (this.stopped || this.blocked()) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.ipc.socket && this.ipc.clientId) return Promise.resolve();
    this.pending = (async () => {
      const desktop = await this.runtime.inspect();
      if (this.stopped || this.blocked()) return;
      if (!desktop) { this.report('opening'); await this.runtime.start(); }
      else await this.ipc.connect();
      if (this.lastFailure) this.report('ready');
      this.lastFailure = false;
    })().catch(() => {
      if (!this.stopped && !this.lastFailure) this.report('unavailable');
      this.lastFailure = true;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  start() {
    if (this.timer || this.stopped) return;
    void this.ensure();
    this.timer = setInterval(() => void this.ensure(), this.intervalMs); this.timer.unref?.();
  }
  drain() { return this.pending || Promise.resolve(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; return this.drain(); }
}
