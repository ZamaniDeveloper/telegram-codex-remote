// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { RemoteDesktop } from '../src/remote-desktop.mjs';
const env = parseEnv(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const remote = new RemoteDesktop(env.CONNECTOR_URL, env.CONNECTOR_SECRET);
try {
  const data = await remote.quotaRead();
  const buckets = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? data.rateLimitsByLimitId : { codex: data.rateLimits };
  console.log(JSON.stringify({ readOnly: true, plan: data.planType, resetCredits: data.rateLimitResetCredits?.availableCount ?? null, windows: Object.entries(buckets).map(([id, b]) => ({ id, primaryUsed: b?.primary?.usedPercent ?? null, secondaryUsed: b?.secondary?.usedPercent ?? null })) }));
} finally { remote.close(); }
