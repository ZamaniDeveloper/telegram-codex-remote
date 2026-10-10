// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { createConnector } from './connector-server.mjs';
import { AttachmentStore } from './attachments.mjs';
import { tunnelOptions } from './config.mjs';
import { acquirePidLock } from './pid-lock.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function startConnector({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env = process.env, spawnSsh = spawn, retryMs = 5000, desktopRecovery = process.platform === 'win32' && env.CONNECTOR_AUTO_START_CODEX !== '0' } = {}) {
  const options = tunnelOptions(env, root);
  const cleanup = acquirePidLock(path.join(root, 'data', 'connector.pid'), 'Windows connector');
  let server;
  try { server = createConnector({ secret: options.secret, attachments: new AttachmentStore(path.join(root, 'data', 'attachments')), desktopRecovery }); }
  catch (e) { cleanup(); throw e; }
  let stopped = false, ssh = null, timer = null, failures = 0;
  function tunnel() {
    if (stopped) return;
    let settled = false, reported = false;
    const startedAt = Date.now();
    const schedule = () => {
      if (settled) return; settled = true;
      if (Date.now() - startedAt >= 30000) failures = 0;
      if (!stopped) {
        const delay = Math.min(60000, retryMs * 2 ** Math.min(failures++, 5));
        console.log('SSH reconnect scheduled in', delay, 'ms'); timer = setTimeout(tunnel, delay);
      }
    };
    try {
      ssh = spawnSsh(options.sshBin, ['-N', '-T', '-p', String(options.sshPort), '-i', options.keyFile,
        '-o', `UserKnownHostsFile="${options.knownHostsFile.replaceAll('\\', '/').replaceAll('"', '\\"')}"`,
        '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=10', '-o', 'TCPKeepAlive=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-R', `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`, `${options.user}@${options.host}`],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      ssh.stderr?.on('data', chunk => {
        if (reported) return; reported = true;
        const text = String(chunk);
        const reason = /remote port forwarding failed/i.test(text) ? 'remote port already occupied or forwarding denied'
          : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text) ? 'pinned host key verification failed'
          : /Permission denied/i.test(text) ? 'SSH key authentication denied'
          : 'network or SSH access unavailable';
        console.error('SSH tunnel unavailable:', reason);
      });
      ssh.once('error', () => { console.error('SSH tunnel process unavailable'); schedule(); });
      ssh.once('exit', schedule); ssh.once('close', schedule);
    } catch { console.error('SSH tunnel process unavailable'); schedule(); }
  }
  const stop = async () => {
    if (stopped) return; stopped = true; clearTimeout(timer); ssh?.kill();
    try { await server.shutdown(); } finally { cleanup(); }
  };
  server.once('error', () => { console.error('Windows connector port unavailable'); stop().catch(() => {}); });
  server.listen(options.localPort, '127.0.0.1', () => { console.log('Windows connector ready; opening SSH tunnel'); tunnel(); });
  return { server, stop, cleanup };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const instance = startConnector();
    process.on('SIGINT', () => instance.stop().finally(() => process.exit()));
    process.on('SIGTERM', () => instance.stop().finally(() => process.exit()));
    process.on('exit', instance.cleanup);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
