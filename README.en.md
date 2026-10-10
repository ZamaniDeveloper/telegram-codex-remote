<p align="center"><img src="assets/telecodex-logo.jpg" alt="TeleCodex — Telegram + Codex" width="680"></p>

# TeleCodex — Persian edition

**Control existing Windows Codex desktop chats from Telegram.**

[فارسی](README.md) · [Installation](docs/INSTALL.en.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

This repository installs the **Persian bot**. For an English bot, messages,
buttons, installers and documentation, install the separate
[English edition](https://github.com/ZamaniDeveloper/telegram-codex-remote-en).
Each edition includes both the server bot and the Windows connector; use the
same edition at both ends.

![CI](https://github.com/ZamaniDeveloper/telegram-codex-remote/actions/workflows/ci.yml/badge.svg)

Developed by **Mohsen Zamani / [ZamaniDeveloper](https://github.com/ZamaniDeveloper)**.
Both the Telegram server bot and the Windows connector, installer and startup
scripts are included. Production credentials, attachments and private chat history
are excluded.

## Features

- Latest message of each conversation, including closed chats without changing the active selection; native new chat/project creation and verified model/reasoning controls.
- Background local Whisper speech transcription and installed-protocol diagnostics.
- [New controls, audio installation and limits](docs/FEATURES-0.7.en.md).

- Persian-first native menus, formatted live replies, code blocks and links.
- Existing-chat selection/search, history, interrupt and active-turn steering.
- Bound question answers through buttons, free text and Telegram Reply.
- Many forwarded messages, original files, captions and images in one request.
- Current-account quota windows, Tehran reset times and earned reset credits.
- Confirmed credit consumption and a durable request ID for uncertain resets.
- Windows logon startup, supervised reconnection and a pinned reverse SSH tunnel.
- Automatic reopening of closed Codex and restoration of the selected chat, without replaying uncertain requests.
- Local or Linux-server deployment; one paired owner and confined RPC.

The bot delegates work to the existing desktop thread owner. It does not start
an independent agent to resume the chat or modify Codex's local database.

## Quick start: local Windows mode

Requirements: Node.js 24.17.0+, PowerShell 7.3+, and a running, signed-in Windows
Codex desktop. There are no third-party runtime npm dependencies.

```powershell
git clone https://github.com/ZamaniDeveloper/telegram-codex-remote.git
cd telegram-codex-remote
npm ci --ignore-scripts
.\setup.ps1
npm start
```

Create a bot with [BotFather](https://t.me/BotFather), enter its token at the hidden
prompt, and send the displayed `/pair ...` code privately. Pairing expires after
ten minutes. Select a chat using `/chats` and send a message.

## Server bot + Windows connector

Follow [the full installation guide](docs/INSTALL.en.md). On Windows:

```powershell
.\setup-connector.ps1 -SshHost server.example.com -SshUser codexbridge
# Finish server configuration and install the restricted public key, then:
.\install-windows.ps1
```

The bot runs on Linux; the connector runs after Windows logon. Both HTTP endpoints
bind to loopback and communicate through reverse SSH. The PC must stay online.
Do not run a second Telegram poller on Windows in server mode.

| Component | Entrypoint |
|---|---|
| Telegram bot | `src/main.mjs` |
| Supervised connector | `src/connector-supervisor.mjs` |
| Connector setup / installer | `setup-connector.ps1` / `install-windows.ps1` |
| Logon startup / removal | `install-autostart.ps1` / `uninstall-autostart.ps1` |
| Portable server configuration | `deploy/pm2.config.cjs` |

## Commands

`/menu`, `/chats`, `/find text`, `/status`, `/history`, `/steer [text]`, `/stop`,
`/answer text`, `/batch`, `/pending`, `/send [instructions]`, `/cancel`, `/usage`,
`/last`, `/newchat`, `/projects`, `/newproject`, `/models`, `/compat`.
Native buttons cover common flows. Forwarded commands are reference content,
never executed as control commands. Question Replies target their original chat.

Limits: 20 MB per file, 100 messages, 100 MB of attachments and 100,000 text
characters per bundle. Audio/video interpretation requires tools in the chat.
Local Whisper automatically transcribes voice/audio after installation on Windows. See [0.7 controls and setup](docs/FEATURES-0.7.en.md).

## Verification

```sh
npm ci --ignore-scripts
npm run verify
```

CI runs isolated tests on Windows and Linux and parses PowerShell scripts. It does
not sign into Codex, install startup tasks, contact a real bot or consume reset
credits. `npm run doctor` reads a local catalog/snapshot without sending model
input; supply an open thread ID if the newest chat is closed.

The private desktop protocol was inspected against Windows build `26.1002.7124.0`;
verify compatibility after updating Codex. This independent project does not
implement the full official Remote feature set. New project/chat creation, model/reasoning controls and local voice transcription are included. Multiple accounts and cloud Work chats remain outside this release. Protocol inspection detects version mismatches; future schema changes may require an adapter update.

## Copyright and attribution

Copyright © 2026 **Mohsen Zamani / ZamaniDeveloper**. Install and use under the
[custom source-available attribution license](LICENSE). Republishing without the
original developer credit, source URL and full license is prohibited. Credits must
remain in redistributed versions; modified releases must identify their changes
and must not impersonate the original developer.

Public GitHub repositories remain viewable and forkable under
[GitHub's platform terms](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).
This is not an MIT-licensed project. OpenAI and Telegram retain their trademarks;
no endorsement is implied.

[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Design](docs/ARCHITECTURE.md)

### Send queue and Group message sending

Ordinary messages and submitted groups are stored in a durable FIFO queue while their conversation is working. After completion, requests are sent in order; each waits for the preceding request to finish. Switching chats keeps the original destination, and the queue survives bot restart. Use **Send queue** or `/queue` to browse and remove waiting requests. Question answers and `/steer` remain immediate. Forwarded messages and files are collected under **Group message sending**; `/send` submits them together as one request or queued entry.

The queue holds up to 100 requests / 8 MiB of message metadata; original attachments stay on Windows. Ambiguous delivery pauses that conversation without automatic replay: check Codex before removing the uncertain entry. Windows, Codex and the connector must be available to drain the queue.

The main menu (`/menu`, Home and back buttons) attaches all navigation buttons directly to its message. Controls remain accessible when Telegram hides the quick-access reply keyboard. The main-menu Latest message button opens the conversation picker; the active-chat menu button stays bound to that chat.

## Accounts from Telegram (0.8.1)

Use Accounts or `/accounts` to add a ChatGPT login on your phone and manually switch the Windows account while retaining local projects. Update both components. See [account setup and recovery](docs/ACCOUNTS.en.md).

Closed Codex is reopened automatically while the Windows connector is running. Windows must remain awake, online and logged in. See [automatic desktop recovery](docs/INSTALL.en.md#automatic-desktop-recovery-082) for controls and SSH keepalives.

Live progress cards are automatically pinned silently. Updates and the final response edit the same message, so the result remains pinned after completion. Existing unrelated pins are retained. Pin failures do not stop response delivery and are retried with rate-limit-aware delays. History and final-only responses are not auto-pinned.
