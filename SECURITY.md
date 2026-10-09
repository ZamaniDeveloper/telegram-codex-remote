# Security policy

Supported development line: 0.8.x. The desktop coordination protocol is private
and version-dependent. Verify a desktop update with `npm run doctor` before
allowing control actions.

Never open a public issue containing credentials, chat contents or exploit
payloads that expose a user's machine. Use the repository's private vulnerability
reporting form when enabled. Regular bug reports must use redacted diagnostics.

The connector binds only to 127.0.0.1, requires a shared secret, rejects browser
Origin headers and confines RPC methods. Use a pinned SSH host key and a separate
SSH key restricted to loopback reverse forwarding. Never expose the connector
through a public reverse proxy. The paired Telegram owner can execute actions in
Codex with that account's existing permissions; protect their Telegram account.

Runtime data, attachments, logs, configuration files and private keys are
excluded from Git. Retain only attachments you need: after stopping the connector,
you may delete individual unneeded directories under `data/attachments/`. Deleting
files still referenced by a chat prevents that chat from reopening those files.
Quota resets require explicit confirmation. Unknown control outcomes are not
automatically repeated. The quota-reset journal preserves the original request ID.

Do not deploy this as a public multi-user bot. The current release is designed for
one paired Telegram owner controlling their own Windows desktop.

Account profiles remain in a Windows DPAPI CurrentUser vault. Private operation
backups and authentication caches must stay out of Git and public logs. Switching
requires owner confirmation and an idle desktop. See [account recovery](docs/ACCOUNTS.en.md).
