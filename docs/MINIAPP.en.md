# Telegram Mini App

The optional Mini App opens from the bot's Graphical panel button and its Telegram menu button. It uses the same bot process, paired owner, Windows connector and existing local chats.

## Enable

1. Point an HTTPS URL at the bot server. A path on an existing domain works; no BotFather Main Mini App registration is required for the inline launch button.
2. Add to the bot's private `.env`:

```dotenv
MINIAPP_URL=https://example.com/telecodex/
MINIAPP_PORT=27842
```

3. Reverse proxy the path to the loopback listener. Example inside your existing HTTPS Nginx server block:

```nginx
location = /telecodex { return 308 /telecodex/; }
location ^~ /telecodex/ {
    proxy_pass http://127.0.0.1:27842;
    proxy_http_version 1.1;
    proxy_read_timeout 200s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64k;
    access_log off;
}
```

The listener preserves the configured URL prefix, so do not add a trailing slash to proxy_pass that strips it. Verify `nginx -t` before reloading, then restart only the Telegram bot. Keep the Windows connector private; never proxy `/rpc`, `/events`, attachments or its secret to browsers. On Windows-only installations, use your own HTTPS reverse proxy to the same loopback listener.

4. Open `/menu` in the bot and choose Graphical panel. Launch from Telegram, not an ordinary browser tab. Do not publish or paste Telegram initData. The panel expires one hour after opening; close and reopen it to authenticate again.

## Features and limits

- Mobile layout, Persian RTL or fully English LTR edition, dashboard and live state every 3 seconds while visible.
- Search and paginate the real chat catalog; inspect latest messages without changing selection.
- View project folders and create a chat within an existing project.
- Activate a conversation, view its loaded messages, submit a text request through the durable FIFO queue, guide or stop its exact active turn.
- View queue previews and remove waiting or uncertain entries after confirmation. Review uncertain deliveries in Codex before removal.
- View Codex-reported file changes for the latest loaded live turn. This is not a complete Git diff or historical repository browser. The Windows connector must be restarted after installing this version to include fileChange events. Long messages/diffs are explicitly shortened.
- Up to 8 watched conversations, as in the bot. Opening a preview does not activate the desktop chat; activation is explicit. Grouped file forwarding and question replies remain available in the bot conversation.
- The Mini App does not change accounts or consume reset credits. Existing Telegram screens retain these operations and their confirmations.

## Authentication and delivery

The public page contains no workspace data or credentials. API calls verify Telegram's HMAC-signed initData, the paired owner, one-hour freshness, and the configured origin. API responses are not cached. The browser keeps initData in memory and sends it in a header; it is never placed in application URLs or persistent browser storage. Do not enable request-header/body logging at your proxy.

Every mutation receives a unique client action key. Its digest and intent are stored privately in `data/miniapp-actions/` before dispatch. A duplicate completed action returns the saved result; a pending/uncertain action is never replayed, including after restart. Failed preflight actions are conservatively treated as unresolved; inspect the current state before submitting a new action. Keep this journal with runtime backups. Actions from the graphical panel and Telegram use the same selection and queue; if selection changes, a stale send/steer/stop is rejected.

To disable the panel, remove MINIAPP_URL and restart the bot. The Telegram menu returns to commands and the listener is not started. Remove the proxy route if it is no longer needed.

Official reference: [Telegram Mini Apps and initData validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
