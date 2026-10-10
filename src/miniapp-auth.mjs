// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { createHmac, timingSafeEqual } from 'node:crypto';
export function validateInitData(value, token, ownerId, now = Date.now()) {
  if (typeof value !== 'string' || !value || value.length > 16384) throw Error('Unauthorized');
  const params = new URLSearchParams(value), keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw Error('Unauthorized');
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw Error('Unauthorized');
  params.delete('hash');
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw Error('Unauthorized');
  const date = Number(params.get('auth_date')), age = now / 1000 - date;
  if (!Number.isSafeInteger(date) || age < -30 || age > 3600) throw Error('Unauthorized');
  let user; try { user = JSON.parse(params.get('user')); } catch { throw Error('Unauthorized'); }
  if (!Number.isSafeInteger(user?.id) || user.id !== Number(ownerId) || user.is_bot || !ownerId) throw Error('Unauthorized');
  return { id: user.id };
}
export function miniappConfig(env = process.env) {
  if (!env.MINIAPP_URL) return null;
  const url = new URL(env.MINIAPP_URL), port = Number(env.MINIAPP_PORT || 27842);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/') || !/^\/(?:[a-z0-9_-]+\/)*$/i.test(url.pathname) || ['localhost','127.0.0.1','::1'].includes(url.hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid Mini App URL or port');
  return { url: url.href, origin: url.origin, base: url.pathname, port };
}
