# Accounts from Telegram (0.8.0)

TeleCodex adds and manually switches managed ChatGPT accounts on the Windows computer while keeping the same local Codex home, project folders and local chat databases. Cloud projects and account entitlements stay account-specific. Continuing every existing conversation under a second real account has not yet been verified.

## Use the controls

1. Update both the bot and Windows connector. Open **Accounts** or send `/accounts`.
2. Choose **Add account**. Open the official OpenAI link on your phone, sign in to the destination account and enter the one-time code.
3. Enable device-code login in that account's ChatGPT security settings if required. Organization restrictions still apply.
4. The bot reports completion and saves the new profile. Adding an account does not activate it. Pending login can be checked or cancelled; connector restart cancels a pending flow.
5. Select the destination and explicitly confirm switching. Finish all active Codex chats and resolve accepted, dispatching or uncertain queued requests first.
6. Codex closes and reopens under the same Windows user and `CODEX_HOME`. Project/root/chat identities are checked after restart. Use **Usage** for the active account's current quota; saved plan labels are cached metadata.

Local Windows bot mode and a Linux bot using the Windows SSH connector are supported. The PC must stay online and the Windows user must be logged in. Waiting requests stay bound to their original chats and can continue under the selected account after reconnection. Automatic rotation is not implemented.

## Storage and recovery

Passwords are entered only on the official OpenAI website. Access and refresh tokens never cross connector RPC, appear in Telegram, or enter diagnostic logs. Saved caches are encrypted with Windows DPAPI CurrentUser in ignored `data/account-vault/`; the directory ACL permits the Windows user and SYSTEM. This vault is not portable to another Windows user or computer. Up to 30 user/workspace profiles are supported.

Authentication-only workers use isolated temporary homes. Codes expire locally after 15 minutes; OpenAI can expire them earlier. Cancellation waits for the worker to exit before cleaning Windows database files.

The destination login is refreshed separately before activation. The previous profile is saved. Local state/configuration/global state are backed up privately before changing the authentication cache and the root `cli_auth_credentials_store = "file"` setting. Existing keyring entries are left intact, while the restarted desktop uses the file cache. No existing chat is resumed by an authentication worker.

The connector checks latest local turn activity, blocks competing requests, and pauses queue dispatch during switching. Do not start another desktop/CLI task during activation. Only the installed Codex desktop and its path-verified executable descendants are closed.

Activation uses a durable one-shot journal. A completed duplicate returns its saved result. An ambiguous request is never replayed automatically. Startup failure attempts to restore the previous account/configuration and reopen Codex. If recovery cannot be verified, preserve the private operation backup and inspect Windows before trying again. Actual account switching and conversation resumption require the owner's first sign-in to a second account and subsequent live verification.

References: [OpenAI app-server authentication](https://learn.chatgpt.com/docs/app-server), [device-code login and credential storage](https://learn.chatgpt.com/docs/auth).
