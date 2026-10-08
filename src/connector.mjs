// Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
import { createConnector } from './connector-server.mjs';
import { connectorOptions } from './config.mjs';
const { secret, localPort: port } = connectorOptions();
const server = createConnector({ secret });
server.listen(port, '127.0.0.1', () => console.log(`Codex connector listening on localhost:${port}`));
server.on('error', () => { console.error('Connector port unavailable'); process.exitCode = 1; });
process.on('SIGINT', () => { server.shutdown().finally(() => process.exit()); });
process.on('SIGTERM', () => { server.shutdown().finally(() => process.exit()); });
