# Changelog

## 0.7.0 - 2026-10-09

- Latest loaded message, native project picker, durable new chat/project creation and desktop ownership handoff.
- Live model catalog and supported reasoning controls, guarded by idle state and previous settings, with read-back verification.
- Background local CPU Whisper transcription for voice/audio bundles, preserving original audio and failures.
- Windows Whisper installer with an isolated Python environment and multilingual offline model.
- Installed desktop protocol version inspection, explicit compatibility/audio diagnostics and refusal of incompatible controls.
- SQLite catalog tolerates optional column changes; existing chats are never resumed by the control worker.
- Duplicate-safe creation journals and regression tests for stale controls, uncertainty, confinement and asynchronous audio.

## 0.6.0 — 2026-10-08

- TeleCodex branding using the maintainer-provided logo.
- Separate installable Persian and English editions, each containing the bot and Windows setup scripts.
- English edition translates bot menus, questions, approval/steering messages, attachment bundles and errors; usage uses English numbers and UTC dates.
- Cross-edition links and preserved copyright/attribution terms.

## 0.5.1 — 2026-10-08

- Quote the pinned SSH known-hosts path and normalize Windows separators so checkouts with spaces connect correctly.
- Verified the live private tunnel after Windows connector reload.

## 0.5.0 — 2026-10-08

- Public release of both the Telegram bot and Windows connector/installer.
- Portable server PM2 configuration, documented restricted SSH setup and host-key pinning.
- Windows setup generates separate SSH credentials and shared connector configuration.
- Fresh-install PID locks create their own data directory and prevent duplicate processes.
- SSH startup failures now reconnect without duplicate retry timers.
- Validated connector settings, configurable key/known-host paths and redacted SSH diagnostics.
- English and Persian documentation, maintainer attribution and custom source-available license.
- Cross-platform CI, regression tests and reproducible dependency-free installation.

## 0.4.1 — 2026-10-08

- Fixed desktop steering restore context and text_elements fields.
- Bare `/steer` opens a bound prompt; active question answers use the corrected payload.

## 0.4.0 — 2026-10-08

- Current-account usage, reset times and earned reset credits in Telegram.
- Explicit reset confirmation and durable retry identity for uncertain results.

## 0.3.0

- Native buttons, formatted live responses, question replies and bundled forwarded attachments.
