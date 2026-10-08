// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { createConnector } from './connector-server.mjs';
import { AttachmentStore } from './attachments.mjs';
import { tunnelOptions } from './config.mjs';
import { acquirePidLock } from './pid-lock.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function startConnector({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env = process.env, spawnSsh = spawn, retryMs = 5000 } = {}) {
  const options = tunnelOptions(env, root);
  const cleanup = acquirePidLock(path.join(root, 'data', 'connector.pid'), 'Windows connector');
  let server;
  try { server = createConnector({ secret: options.secret, attachments: new AttachmentStore(path.join(root, 'data', 'attachments')) }); }
  catch (e) { cleanup(); throw e; }
  let stopped = false, ssh = null, timer = null;
  function tunnel() {
    if (stopped) return;
    let settled = false;
    const schedule = () => {
      if (settled) return; settled = true;
      if (!stopped) { console.log('SSH reconnect scheduled'); timer = setTimeout(tunnel, retryMs); }
    };
    try {
      ssh = spawnSsh(options.sshBin, ['-N', '-T', '-p', String(options.sshPort), '-i', options.keyFile,
        '-o', `UserKnownHostsFile=${options.knownHostsFile}`,
        '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-R', `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`, `${options.user}@${options.host}`],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      ssh.stderr?.on('data', () => console.error('SSH tunnel unavailable; check pinned host key, key permissions and SSH access.'));
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
