// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { applyPatches, turnsOf, pendingRequests } from './state.mjs';

export function compactState(state) {
  const result = {};
  for (const key of ['id', 'cwd', 'latestModel', 'latestReasoningEffort', 'threadRuntimeStatus', 'requests']) if (Object.hasOwn(state, key)) result[key] = state[key];
  const approvalItems = new Set(pendingRequests(state).map(r => r.params?.itemId).filter(Boolean));
  result.turns = turnsOf(state).map(turn => {
    const value = {};
    for (const key of ['id', 'turnId', 'status', 'error', 'durationMs', 'startedAt', 'completedAt']) if (Object.hasOwn(turn, key)) value[key] = turn[key];
    value.items = (turn.items || []).filter(item => ['agentMessage', 'userMessage', 'steeringUserMessage'].includes(item.type) || approvalItems.has(item.id));
    return value;
  });
  return result;
}

// Apply desktop patches to the full local mirror, then transmit coherent compact
// snapshots. Raw patch paths must never be applied to filtered history.
export class LiveStream {
  states = new Map();
  forget(id) { this.states.delete(id); }
  clear() { this.states.clear(); }
  project(message) {
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11 || message.params?.hostId !== 'local') return message;
    const { conversationId: id, change } = message.params;
    let current = this.states.get(id);
    if (change?.type === 'snapshot' && change.conversationState) {
      current = { owner: message.sourceClientId, revision: change.revision, state: structuredClone(change.conversationState) };
      this.states.delete(id); this.states.set(id, current);
      if (this.states.size > 16) this.states.delete(this.states.keys().next().value);
    } else if (change?.type === 'patches') {
      if (!current || current.owner !== message.sourceClientId || current.revision !== change.baseRevision) return this.gap(message);
      try { current.state = applyPatches(current.state, change.patches); current.revision = change.revision; }
      catch { this.forget(id); return this.gap(message); }
    } else return message;
    try { return { ...message, params: { ...message.params, change: { type: 'snapshot', revision: current.revision, conversationState: compactState(current.state) } } }; }
    catch { this.forget(id); return this.gap(message); }
  }
  gap(message) { return { ...message, params: { ...message.params, change: { type: 'patches', baseRevision: null, revision: message.params.change.revision, patches: [] } } }; }
}
