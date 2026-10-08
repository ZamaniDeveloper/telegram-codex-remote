# Changelog

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
