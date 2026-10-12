// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { CommandReceipts } from './reliability.mjs';
import { fileURLToPath } from 'node:url';
import { createConnector } from './connector-server.mjs';
import { connectorOptions } from './config.mjs';
const { secret, localPort: port } = connectorOptions();
const server = createConnector({ secret, receipts: new CommandReceipts(fileURLToPath(new URL('../data/connector-receipts.sqlite', import.meta.url))) });
server.listen(port, '127.0.0.1', () => console.log(`Codex connector listening on localhost:${port}`));
server.on('error', () => { console.error('Connector port unavailable'); process.exitCode = 1; });
process.on('SIGINT', () => { server.shutdown().finally(() => process.exit()); });
process.on('SIGTERM', () => { server.shutdown().finally(() => process.exit()); });
