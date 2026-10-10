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

## Controls and local speech (0.7)

DesktopControl uses a separate strict allowlist for model/project catalogs and new durable threads. It never resumes existing chats or starts a turn. It persists creation intent before mutation, stores the new thread identity and closes its worker before desktop adoption. Existing model changes use the desktop follower settings adapter with a comparison condition and read-back validation.

Compatibility reads the installed package and ASAR metadata directly, inspecting only bounded build files for the numeric message-version manifest. It never executes extracted code or modifies the app. The adapter keeps its known schemas; changed versions are refused rather than blindly substituted. Unknown installations block private writes. The local catalog inspects optional SQL columns before preparing its read-only query.

Whisper runs in an isolated Python environment on Windows with offline local model loading. Incoming audio is transferred to checksum-verified attachment storage; the RPC takes validated attachment metadata, never an arbitrary local file path. Realpath confinement, file size/duration limits, a bounded serial queue and worker deadline restrict processing. Background jobs append transcripts to their original durable bundle. Failure retains the original audio; sending an unfinished bundle does not dispatch a model request.

Runtime additions: data/creation-journal/, data/whisper-venv/ and data/whisper-model/. These directories and Python bytecode are excluded from Git and releases. See FEATURES-0.7.en.md for setup and limits.

## Conversation latest messages (0.7.1)

The authenticated latestMessage RPC accepts one UUID and exposes only the newest user/agent message. The control worker allowlist includes read-only thread/items/list with descending pagination; it never resumes or takes ownership of an existing conversation. Menus bind actions to the catalog row and reading does not select/open/watch a chat. Navigation retires the current creation/search/steering prompt; reply-keyboard routes run before ordinary input consumers. Callback acknowledgement failures are isolated from action dispatch and never trigger automatic action replay.

## Compact live streams (0.7.2)

The Windows connector keeps a bounded full-state mirror for at most 16 conversations and applies original desktop revision patches there. It emits compact coherent snapshots containing all user/assistant messages, questions, pending requests, approval-related items and the context needed for controls. Old tool outputs and unrelated desktop fields stay on Windows. Raw private patches never run against projected state. Mirror gaps invalidate remote sync and cause a fresh subscription. A successful existing snapshot is reused when the owner is unchanged. Concurrent selections maintain separate snapshot waiters; only the newest successful selection is persisted. Full persisted history remains available through the read-only latest-message API.

## Durable outgoing queue (0.7.4)

Outbox stores up to 100 requests / 8 MiB in data/outbox.json using atomic replacement before RPC dispatch. Every entry keeps the original conversation UUID, input (including Windows attachment paths), client submission UUID and delivery phase. One accepted request per conversation blocks its successors until a synchronized desktop turn with the matching user-message client ID reaches a known terminal status and the runtime is idle. An unrelated turn or the old idle snapshot cannot release that barrier. Ordinary messages and explicit group submission use the queue; steering, answers, stop and navigation do not. Queue watchers restore without changing the selected chat and are protected from capacity eviction. Queued requests survive restart; dispatching entries become uncertain on recovery and are never replayed automatically. Uncertain entries pause only their own conversation and may be removed after manual desktop inspection. UI pages show five entries at a time; waiting/uncertain entries have removal controls. Attachments transfer to Windows before queue acceptance and local draft cleanup; pre-dispatch failures preserve a retryable draft. The desktop and connector must remain available for automatic draining.

## Inline main menu (0.7.5)

Home responses carry the complete inline menu, independent of reply-keyboard visibility. UI upgrade installs the quick-access keyboard in a separate message. Read-only feature navigation uses stateless u: routes; creation and model writes retain their existing scoped prompts and guarded one-shot actions. Main-menu latest-message navigation opens the picker while conversation menus retain UUID-bound latest buttons.

## Accounts (0.8.0)

An isolated authentication worker performs device-code login. Profiles remain in a Windows DPAPI vault. Activation is bound to an expected current profile and request UUID, pauses queue delivery, checks local activity, restarts the installed desktop and verifies retained local identities. No auth worker resumes an existing chat. See [account storage and recovery](ACCOUNTS.en.md).

## Desktop recovery (0.8.2)

A single-flight Windows watchdog checks the real desktop IPC connection every five seconds and launches only an absent installed desktop. The connector waits for an in-flight recovery before account activation and blocks watchdog attempts during activation. Recovery restores observation of the selected existing chat through a throttled registered URI, without issuing model turns. SSH transport remains authenticated and loopback-only; retries use bounded backoff and server ClientAlive keepalives prevent dead sessions from retaining the forwarded port.
