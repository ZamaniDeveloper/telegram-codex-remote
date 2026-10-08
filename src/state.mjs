// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Immer patch paths contain segments, not JSON Pointer strings.
export function applyPatches(value, patches) {
  for (const { op, path, value: next } of patches) {
    if (path.some(x => ['__proto__', 'prototype', 'constructor'].includes(String(x)))) throw Error('Unsafe patch path');
    if (!path.length) { if (op === 'remove') throw Error('Invalid root removal'); value = structuredClone(next); continue; }
    let parent = value;
    for (const key of path.slice(0, -1)) {
      if (parent == null || !Object.hasOwn(parent, key)) throw Error('Patch path is missing');
      parent = parent[key];
    }
    const key = path.at(-1);
    if (op === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key];
    else if (op === 'add' && Array.isArray(parent)) parent.splice(Number(key), 0, structuredClone(next));
    else if (op === 'add' || op === 'replace') parent[key] = structuredClone(next);
    else throw Error('Unknown patch operation');
  }
  return value;
}
export function turnsOf(state) {
  if (state?.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    return (history?.islands || []).flatMap(i => (i.entries || []).map(e =>
      typeof e.value === 'string' ? history.entitiesByKey?.[e.value] : e.value)).filter(Boolean);
  }
  return state?.turns || [];
}
export function lastTurn(state) { return turnsOf(state).at(-1); }
export function turnId(turn) { return turn?.turnId ?? turn?.id; }
export function assistantText(turn) {
  return (turn?.items || []).filter(i => i.type === 'agentMessage')
    .map(i => i.text ?? '').filter(Boolean).join('\n\n');
}
export function pendingRequests(state) {
  return (state?.requests || []).filter(r => r.completedAtMs == null && r.completed !== true);
}
export function splitText(text, size = 3800) {
  const chunks = []; let rest = String(text);
  while (rest.length) {
    let cut = Math.min(size, rest.length);
    if (cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  return chunks.length ? chunks : ['…'];
}
