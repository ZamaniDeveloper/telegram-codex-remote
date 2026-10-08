// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import path from 'node:path';
import { isIP } from 'node:net';

export function port(value, fallback, name) {
  const raw = value == null || value === '' ? String(fallback) : String(value);
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw Error(`${name} must be an integer between 1 and 65535`);
  return Number(raw);
}
export function connectorOptions(env = process.env) {
  const secret = env.CONNECTOR_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || /\s/.test(secret)) throw Error('CONNECTOR_SECRET must contain at least 32 non-whitespace characters');
  return { secret, localPort: port(env.CONNECTOR_PORT, 27842, 'CONNECTOR_PORT') };
}
export function tunnelOptions(env = process.env, root = process.cwd()) {
  const options = connectorOptions(env), host = env.CONNECTOR_SSH_HOST, user = env.CONNECTOR_SSH_USER;
  if (!host || !(isIP(host) || /^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host))) throw Error('CONNECTOR_SSH_HOST must be a hostname or IP address');
  if (!user || !/^[a-z_][a-z\d_.-]*$/i.test(user)) throw Error('CONNECTOR_SSH_USER must be an SSH username');
  return { ...options, host, user, sshPort: port(env.CONNECTOR_SSH_PORT, 22, 'CONNECTOR_SSH_PORT'),
    remotePort: port(env.CONNECTOR_REMOTE_PORT, 27841, 'CONNECTOR_REMOTE_PORT'),
    sshBin: env.CONNECTOR_SSH_BIN || (process.platform === 'win32' ? 'ssh.exe' : 'ssh'),
    keyFile: path.resolve(root, env.CONNECTOR_SSH_KEY || 'data/connector_ssh_key'),
    knownHostsFile: path.resolve(root, env.CONNECTOR_KNOWN_HOSTS || 'data/connector_known_hosts'),
  };
}
