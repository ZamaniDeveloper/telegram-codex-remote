// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { timingSafeEqual } from 'node:crypto';
export function isPrivateOwner(update, ownerId) {
  const source = update.callback_query || update.message;
  const message = update.callback_query?.message || update.message;
  return Boolean(ownerId && source?.from?.id === Number(ownerId) && message?.chat?.type === 'private'
    && message.chat.id === Number(ownerId));
}
export function matchesPairCode(text, code) {
  if (typeof text !== 'string' || !code) return false;
  const actual = Buffer.from(text.trim()); const expected = Buffer.from(`/pair ${code}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
