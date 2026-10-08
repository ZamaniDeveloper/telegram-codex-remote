# Contributing

This is the Persian edition of TeleCodex. Apply shared behavior and security
fixes to the [English edition](https://github.com/ZamaniDeveloper/telegram-codex-remote-en)
as well, and run each edition's tests before releasing matching versions.

Developed by **Mohsen Zamani / ZamaniDeveloper**. Read [LICENSE](LICENSE) before
using or redistributing this code. Contributions are submitted under those terms.

Use Node.js 24.17.0+ and PowerShell 7.3+ for Windows scripts. Run:

```sh
npm ci --ignore-scripts
npm run verify
```

The tests use temporary directories, fake Telegram responses and loopback HTTP
servers. They must not log into OpenAI, consume quota-reset credits, contact a real
Telegram bot or send diagnostic messages to working chats. Never load production
`.env` files in automated tests. Windows installers are syntax-checked in CI;
CI does not install tasks or claim to test the real desktop.

Keep changes focused. Add regression coverage for changed control, transport,
permission and recovery behavior. Document any version-specific desktop protocol
change and verify it against an explicitly authorized disposable chat.

Never commit `.env`, `.connector.env`, `data/`, `.deploy/`, logs, SSH keys or private
chat screenshots. Open issues and pull requests with redacted diagnostics only.
