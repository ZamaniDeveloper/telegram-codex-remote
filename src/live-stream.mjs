// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { applyPatches, turnsOf, pendingRequests } from './state.mjs';

export function compactState(state) {
  const result = {};
  for (const key of ['id', 'cwd', 'latestModel', 'latestReasoningEffort', 'threadRuntimeStatus', 'requests']) if (Object.hasOwn(state, key)) result[key] = state[key];
  const approvalItems = new Set(pendingRequests(state).map(r => r.params?.itemId).filter(Boolean));
  result.turns = turnsOf(state).map(turn => {
    const value = {};
    for (const key of ['id', 'turnId', 'status', 'error', 'durationMs', 'startedAt', 'completedAt']) if (Object.hasOwn(turn, key)) value[key] = turn[key];
    // A cancelled start can have no userMessage item. Preserve only its request
    // identity, never the full request params, to reconcile the durable queue.
    if (typeof turn.params?.clientUserMessageId === 'string') value.clientUserMessageId = turn.params.clientUserMessageId;
    else if (typeof turn.clientUserMessageId === 'string') value.clientUserMessageId = turn.clientUserMessageId;
    value.items = (turn.items || []).filter(item => ['agentMessage', 'userMessage', 'steeringUserMessage', 'fileChange'].includes(item.type) || approvalItems.has(item.id));
    return value;
  });
  return result;
}

// Apply desktop patches to the full local mirror, then transmit coherent compact
// snapshots. Raw patch paths must never be applied to filtered history.
export class LiveStream {
  states = new Map();
  constructor({ delta = false } = {}) { this.delta = delta; }
  forget(id) { this.states.delete(id); }
  clear() { this.states.clear(); }
  snapshot(id, owner) {
    const current = this.states.get(id);
    if (!current || current.owner !== owner) return null;
    return { owner, revision: current.revision, state: structuredClone(compactState(current.state)) };
  }
  project(message) {
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11 || message.params?.hostId !== 'local') return message;
    const { conversationId: id, change } = message.params;
    let current = this.states.get(id);
    const previous = current?.compact;
    const baseRevision = current?.revision;
    if (change?.type === 'snapshot' && change.conversationState) {
      current = { owner: message.sourceClientId, revision: change.revision, state: structuredClone(change.conversationState) };
      this.states.delete(id); this.states.set(id, current);
      if (this.states.size > 16) this.states.delete(this.states.keys().next().value);
    } else if (change?.type === 'patches') {
      if (!current || current.owner !== message.sourceClientId || current.revision !== change.baseRevision) { this.forget(id); return this.gap(message); }
      try { current.state = applyPatches(current.state, change.patches); current.revision = change.revision; }
      catch { this.forget(id); return this.gap(message); }
    } else return message;
    try {
      const compact = compactState(current.state);
      let output = { type: 'snapshot', revision: current.revision, conversationState: compact };
      if (this.delta && previous && change.type === 'patches') {
        const patches = compactDiff(previous, compact);
        const delta = { type: 'patches', baseRevision, revision: current.revision, patches };
        if (patches.length <= 256 && Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(output))) output = delta;
      }
      // Compact items reference the mutable desktop mirror; retain an isolated
      // baseline so subsequent raw patches cannot mutate both sides of the diff.
      if (this.delta) current.compact = structuredClone(compact);
      return { ...message, params: { ...message.params, change: output } };
    }
    catch { this.forget(id); return this.gap(message); }
  }
  gap(message) { return { ...message, params: { ...message.params, change: { type: 'patches', baseRevision: null, revision: message.params.change.revision, patches: [] } } }; }
}

export function compactDiff(before, after, path = [], patches = []) {
  if (Object.is(before, after)) return patches;
  if (before && after && typeof before === 'object' && typeof after === 'object'
      && Array.isArray(before) === Array.isArray(after)
      && (!Array.isArray(before) || before.length === after.length)) {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patches.push({ op: 'remove', path: [...path, key] });
    for (const key of Object.keys(after)) {
      const segment = Array.isArray(after) ? Number(key) : key;
      if (!Object.hasOwn(before, key)) patches.push({ op: 'add', path: [...path, segment], value: after[key] });
      else compactDiff(before[key], after[key], [...path, segment], patches);
    }
  } else patches.push({ op: 'replace', path, value: after });
  return patches;
}
