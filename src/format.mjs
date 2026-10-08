// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
// Telegram entities use UTF-16 offsets, matching JavaScript string indices.
export function rich(text, entities = []) { return { text: String(text), entities }; }
export function asRich(value) { return typeof value === 'string' ? rich(value) : rich(value?.text || '', value?.entities || []); }
export function concatRich(...values) {
  const result = rich('');
  for (const value of values) {
    const part = asRich(value), offset = result.text.length;
    result.text += part.text; result.entities.push(...part.entities.map(e => ({ ...e, offset: e.offset + offset })));
  }
  return result;
}
export function styled(text, type = 'bold', extra = {}) { return rich(text, text.length ? [{ type, offset: 0, length: text.length, ...extra }] : []); }
function addEmphasis(entities, offset, length, type) {
  // Telegram forbids bold/italic entities inside code or preformatted entities.
  let cursor = offset;
  for (const code of entities.filter(e => ['code', 'pre'].includes(e.type) && e.offset < offset + length && e.offset + e.length > offset).sort((a, b) => a.offset - b.offset)) {
    if (cursor < code.offset) entities.push({ type, offset: cursor, length: code.offset - cursor });
    cursor = Math.max(cursor, code.offset + code.length);
  }
  if (cursor < offset + length) entities.push({ type, offset: cursor, length: offset + length - cursor });
}
function inline(source, depth = 0) {
  const out = rich('');
  const tokens = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|~~([^\n]+?)~~|\[([^\]\n]+)\]\(([^\n]+?)\)/g;
  let cursor = 0, match;
  while ((match = tokens.exec(source))) {
    out.text += source.slice(cursor, match.index); const offset = out.text.length;
    if (match[1] !== undefined) {
      out.text += match[1]; out.entities.push({ type: 'code', offset, length: match[1].length });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      const raw = match[2] ?? match[3]; const inner = depth < 2 ? inline(raw, depth + 1) : rich(raw);
      out.text += inner.text; out.entities.push(...inner.entities.map(e => ({ ...e, offset: e.offset + offset })));
      addEmphasis(out.entities, offset, inner.text.length, match[2] !== undefined ? 'bold' : 'strikethrough');
    } else {
      const label = match[4], target = match[5].replace(/^<|>$/g, ''); let allowed = false;
      try { allowed = ['https:', 'http:', 'tg:'].includes(new URL(target).protocol); } catch {}
      out.text += allowed ? label : `${label} (${target})`;
      if (allowed) out.entities.push({ type: 'text_link', offset, length: label.length, url: target });
    }
    cursor = match.index + match[0].length;
  }
  out.text += source.slice(cursor); return out;
}
export function markdown(source) {
  const lines = String(source).replaceAll('\r\n', '\n').split('\n'); let out = rich('');
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s{0,3}(`{3,}|~{3,})([\w+.-]*)\s*$/.exec(lines[i]);
    if (fence) {
      const code = [], delimiter = fence[1][0]; let closed = false;
      for (i++; i < lines.length; i++) {
        if (new RegExp(`^\\s{0,3}${delimiter}{${fence[1].length},}\\s*$`).test(lines[i])) { closed = true; break; }
        code.push(lines[i]);
      }
      const text = code.join('\n');
      out = concatRich(out, styled(text, 'pre', fence[2] ? { language: fence[2].slice(0, 30) } : {}));
      if (closed && i < lines.length - 1) out = concatRich(out, '\n');
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(lines[i]);
    const quote = /^>\s?(.*)$/.exec(lines[i]);
    const sourceLine = heading?.[1] || quote?.[1] || lines[i].replace(/^\s*[-*]\s+/, '• ');
    const part = inline(sourceLine);
    if (heading) addEmphasis(part.entities, 0, part.text.length, 'bold');
    if (quote && part.text.length) {
      if (part.entities.some(e => ['code', 'pre', 'text_link'].includes(e.type))) addEmphasis(part.entities, 0, part.text.length, 'italic');
      else part.entities.push({ type: 'blockquote', offset: 0, length: part.text.length });
    }
    out = concatRich(out, part, i < lines.length - 1 ? '\n' : '');
  }
  // Deterministic order is helpful for Telegram, streaming diffs and tests.
  out.entities = [...new Map(out.entities.map(e => [JSON.stringify(e), e])).values()];
  out.entities.sort((a, b) => a.offset - b.offset || b.length - a.length); return out;
}
export function sliceRich(value, start, end) {
  const data = asRich(value); end = Math.min(data.text.length, end);
  return rich(data.text.slice(start, end), data.entities.flatMap(e => {
    const from = Math.max(start, e.offset), to = Math.min(end, e.offset + e.length);
    return from < to ? [{ ...e, offset: from - start, length: to - from }] : [];
  }));
}
export function splitRich(value, size = 3800) {
  const data = asRich(value), parts = []; let offset = 0;
  while (offset < data.text.length) {
    let end = Math.min(offset + size, data.text.length);
    if (end < data.text.length) {
      const newline = data.text.lastIndexOf('\n', end - 1);
      if (newline > offset + size * 0.6) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(data.text[end - 1])) end--;
    }
    parts.push(sliceRich(data, offset, end)); offset = end;
  }
  return parts.length ? parts : [rich('…')];
}
export function card(title, body, footer = '') {
  return concatRich(styled(title), '\n\n', typeof body === 'string' ? rich(body) : body, footer ? concatRich('\n\n', styled(footer, 'italic')) : '');
}
export function turnCard(title, source, status, error = '', durationMs) {
  const live = status === 'inProgress'; let body = markdown(source || (live ? 'در حال آماده‌کردن پاسخ…' : ''));
  if (live && body.text.length > 3200) {
    let start = body.text.length - 3200; if (/[\uDC00-\uDFFF]/.test(body.text[start])) start++;
    body = concatRich('… ادامهٔ پاسخ\n\n', sliceRich(body, start, body.text.length));
  }
  const footer = live ? '⏳ در حال کار؛ پاسخ خودکار به‌روز می‌شود.' : status === 'completed' ? '✅ انجام شد' : status === 'interrupted' ? '⏹ متوقف شد' : '❌ اجرا ناموفق بود';
  const time = !live && durationMs > 0 ? ` · ⏱ ${Math.round(durationMs / 1000)} ثانیه` : '';
  return concatRich(styled(live ? '⚡ Codex · پاسخ زنده' : '🤖 Codex · پاسخ'), '\n', styled(String(title || 'چت').slice(0, 250), 'italic'), '\n\n', body,
    '\n\n', styled(footer + time), error ? concatRich('\n', rich(error)) : '');
}
