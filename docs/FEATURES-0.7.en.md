# TeleCodex 0.7 controls and local speech

Developed by **Mohsen Zamani / ZamaniDeveloper**. See [LICENSE](../LICENSE).

- **Latest message** (`/last`) opens a paginated conversation picker. Choose any conversation to read its newest user or Codex message, including closed conversations, without changing the active chat. Clock buttons beside chat titles provide the same action. History is read through descending persisted item pages, preserving code formatting; tool events are skipped. Reading scans at most 2,500 recent items within the worker deadline and reports a limit or protocol error instead of returning an older message as latest.
- **New chat / Projects** (`/newchat`, `/projects`) reads the native project list, asks for a project and title, creates a durable empty chat, then opens and selects it in the desktop app.
- **New project** (`/newproject`) asks for a folder name. It creates a new directory under `%USERPROFILE%/Documents/TeleCodex Projects`, registers the project and creates its first chat. Existing directories are never overwritten. Set `TELECODEX_PROJECT_ROOT` on the Windows connector to choose a different parent directory.
- **Change model** (`/models`) fetches the installed Codex model catalog, then offers the supported reasoning efforts. Controls bind to the idle selected chat, compare the previous settings and verify the resulting settings. They do not change an active turn or grant account access to unavailable models.
- **Compatibility and audio** (`/compat`) inspects the installed Windows package and private IPC message version manifest. An unchanged supported manifest remains usable after an app update; changed methods or stream versions disable affected actions. Unknown inspection results block writes. Future schema changes with unchanged version numbers still require testing and an adapter update.

## Install local Whisper on Windows

Install Python 3.12, then run in the connector checkout:

```powershell
.\install-whisper.ps1
# Or use your own compatible Python 3.10-3.13 executable:
.\install-whisper.ps1 -PythonPath C:/Python312/python.exe
# Optional smaller multilingual model:
.\install-whisper.ps1 -Model base
```

The installer creates `data/whisper-venv`, installs the pinned faster-whisper package and downloads a multilingual `small` model into `data/whisper-model`. It verifies CPU int8 loading. No separate FFmpeg installation is needed: PyAV supplies the decoder. Installing dependencies and the model requires internet; runtime transcription uses local files and offline model loading. Audio travels from Telegram through your existing private connector to your Windows computer. The transcript and original audio are included in the request you explicitly send to Codex.

Send or forward voice/audio messages to the bot. They join the current bundle. Transcription runs in the background; the bundle preview shows the transcript or error. **Send bundle** sends the transcript and original files together. If transcription is still running, wait for the preview to update and press Send again. Failed audio is preserved; fix Whisper and press Send to retry. Use Discard to remove an unsent bundle. A transcript that resembles a slash command is reference text, never a bot command.

Limits: 20 MB per audio file, 10 minutes of audio, 4 queued CPU jobs, 100,000 characters per bundle. Silence, invalid media or missing models produce a visible error. Quality depends on the recording and model; review the preview. Optional connector settings: `WHISPER_PYTHON`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE` (blank means automatic language detection). The English edition can transcribe any supported language; its controls and scripts remain English.

New chats/projects use a separate short-lived official app-server **only for catalog reads and new chat/project creation**, without starting model work or resuming existing chats. The process closes before the desktop takes ownership. Existing chat model changes continue through the desktop owner. Creation intents are stored under `data/creation-journal`; a lost response never triggers an automatic duplicate. If a newly created chat takes time to open, use its Select created chat button.

Both bot and connector must be updated together. Preserve `.env`, `.connector.env`, keys and all `data/` when updating. Restart the bot and connector, keep Codex open, then use `/compat`.

## Dependency notices

TeleCodex's custom license applies to this repository's original code. It does not replace the independent licenses of downloaded packages and models. [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and [OpenAI Whisper](https://github.com/openai/whisper) use MIT licenses; retain their notices when redistributing those components. See the package/model licenses for other dependencies. Models, virtual environments, credentials and received files are excluded from TeleCodex source releases.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server). Project methods are experimental and private desktop IPC remains version dependent.

### Send queue and Group message sending

Ordinary messages and submitted groups are stored in a durable FIFO queue while their conversation is working. After completion, requests are sent in order; each waits for the preceding request to finish. Switching chats keeps the original destination, and the queue survives bot restart. Use **Send queue** or `/queue` to browse and remove waiting requests. Question answers and `/steer` remain immediate. Forwarded messages and files are collected under **Group message sending**; `/send` submits them together as one request or queued entry.

The queue holds up to 100 requests / 8 MiB of message metadata; original attachments stay on Windows. Ambiguous delivery pauses that conversation without automatic replay: check Codex before removing the uncertain entry. Windows, Codex and the connector must be available to drain the queue.

The main menu (`/menu`, Home and back buttons) attaches all navigation buttons directly to its message. Controls remain accessible when Telegram hides the quick-access reply keyboard. The main-menu Latest message button opens the conversation picker; the active-chat menu button stays bound to that chat.
