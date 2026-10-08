# Technical design

Developed by **Mohsen Zamani / ZamaniDeveloper**.

## Process boundaries

The Telegram receiver owns pairing and update offsets. Bridge follows up to eight
desktop-owned chats, applies revisioned snapshots/patches and sends scoped control
requests. BotUi handles menus and bound prompts; QuestionManager handles blocking
and asynchronous questions; Inbox durably collects messages/files.

In server mode RemoteDesktop uses authenticated loopback HTTP/SSE through reverse
SSH. The Windows connector owns DesktopIpc, a read-only SQLite catalog and local
attachment storage. A small explicit RPC allowlist prevents generic proxy access.

QuotaClient starts a short-lived native account-control process with the existing
local ChatGPT login and only official account read/reset RPCs. It requests no model
inference or chat resumption. Account identity is checked before reset consumption.
QuotaUi saves the original request ID and preserves uncertain outcomes on restart.

## Failure semantics

- Telegram offsets are saved before dispatch: at-most-once control, not guaranteed delivery.
- Startup discards Telegram backlog to avoid executing stale commands.
- Desktop revision gaps require a fresh snapshot before further control.
- Chat/turn-bound buttons reject stale actions.
- Bundle preparation failures are retryable; dispatch uncertainty requires inspection.
- Quota retries reuse the original idempotency key; new resets wait for resolution.
- SSH reconnection does not replay model or user actions.

## Runtime data

`data/settings.json` stores owner, selected chat, UI revision and polling offset.
`data/telegram-inbox/` stores bundles and the reset journal. `data/attachments/`
contains original model-input files. `data/connector.pid` and `data/bridge.lock`
are process locks. SSH keys and host pins also live under `data/`.

The entire directory is ignored by Git and excluded from releases. Keep a private
backup; received files can contain confidential project documents.

## Compatibility and verification

Private IPC was inspected against Windows Codex `26.1002.7124.0`: stream version
11; steering requires restoreMessage and text_elements. These are source-inspected
details, not supported public APIs or a compatibility guarantee.

Tests cover transport, Unicode, attachments, owner-only commands, question/turn
binding, steering, quota recovery, configuration and process startup recovery.
CI does not exercise real desktop sessions, Telegram delivery, Windows logon,
SSH authorization or reset-credit consumption.

Private deployment checks previously verified Telegram/menu access, live desktop
snapshots, original attachment hashes, current-account quota and native steering
acceptance. Real reset credits were not consumed for testing. A complete machine
reboot and fresh-host interactive installation remain manual checks.

## Official references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): official account and reset RPCs.
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections): official product context; this project is independent.
- [Telegram Bot API](https://core.telegram.org/bots/api): updates, keyboards and file transport.
- [GitHub licensing](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository): public viewing/forking and repository licenses.

Do not resume a desktop-owned chat on another agent server when compatibility or
ownership checks fail.
