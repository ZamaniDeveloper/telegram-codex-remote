# Changelog

## 0.8.1 - 2026-10-09

- Wait up to a minute for desktop IPC readiness after switching, including immediate named-pipe failures during slow startup.
- Reconnect to an already launched desktop without launching a second instance.
- Allow the remote activation request to finish startup and verified rollback; preserve one-shot request journals.
- Verify the restored account identity and record safe failure phases/codes without credential payloads.
- Localize recovery guidance and cover slow startup, bounded failure and recovery diagnostics.

## 0.8.0 - 2026-10-09

- Add Accounts and `/accounts` for phone device-code login and confirmed manual switching.
- Store profiles with Windows DPAPI and isolate login from active project state.
- Guard local active turns and competing connector operations; pause queue dispatch.
- Restart Codex on the same home, verify project/chat identities and retain private backups.
- Journal activation, attempt rollback on startup failure and never replay ambiguous switches.
- Cover login cancellation, Windows file locks, encryption, authenticated RPC, stale/busy guards and rollback.

## 0.7.5 - 2026-10-09

- Attach the full main menu directly to the /menu and Home message, so controls remain visible when Telegram hides the reply keyboard.
- Add durable inline navigation to chats, search, latest-message picker, creation, projects, models, compatibility, history, groups, questions, queue, usage and help.
- Keep quick-access reply buttons installed separately on UI upgrade; preserve chat selection and collected messages during navigation.
- Cover each main-menu action, hidden-keyboard entry points, expired acknowledgements and cancelled prompts with regression tests.

## 0.7.4 - 2026-10-09

- Persist ordinary messages and submitted groups in a per-conversation FIFO send queue while Codex is working; dispatch the next request only after its predecessor is observed complete.
- Preserve the destination through chat switches and restarts, deduplicate submission IDs, and pause ambiguous deliveries without automatic replay.
- Add queue browsing, pagination and removal controls; questions and steering remain immediate.
- Rename the grouping entry to Group message sending; preserve old keyboard shortcuts.
- Include the conversation-bound Latest message button introduced in 0.7.3.

## 0.7.3 - 2026-10-09

- Add a Latest message button to the active chat menu, selection confirmation, status and message-delivery screens.
- Bind the button to the original conversation so an older menu still reads the correct chat after switching.

## 0.7.2 - 2026-10-09

- Compact live snapshots retain messages, questions, active approval details and control context while keeping old tool output on Windows.
- Desktop patches are applied to a full local mirror before projecting coherent snapshots for the remote bot.
- Already synced chats can be selected without waiting for a duplicate snapshot; overlapping selections use independent waiters and respect selection order.
- A failed selection preserves the previous ready chat; timeouts clean up their waiters and revision gaps resubscribe safely.
- Regression tests include a 20 MB history, live patch updates, canonical history, approvals and selection races.

## 0.7.1 - 2026-10-09

- Read the latest user or Codex message from any conversation through a paginated picker and per-chat clock buttons, without changing the selected chat.
- Read-only descending history pagination also works for closed conversations and skips tool events.
- Main menu navigation takes precedence over chat/project creation prompts and retires cancelled inputs.
- Expired callback acknowledgements no longer discard menu actions.
- Regression coverage for both keyboard types, closed-chat history, paging, authentication and unchanged active selection.

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
