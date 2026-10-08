# Installation and operations

Developed by **Mohsen Zamani / ZamaniDeveloper**. Preserve attribution and
[LICENSE](../LICENSE) when redistributing. [راهنمای فارسی](INSTALL.fa.md).

## Requirements and topology

- Windows with signed-in Codex, PowerShell 7.3+, Node.js 24.17.0+ and Git.
- Server mode: persistent Linux host, Node.js 24.17.0+, OpenSSH and PM2.
- Windows OpenSSH client tools: `ssh`, `ssh-keygen`, `ssh-keyscan`.
- One BotFather bot and one paired Telegram owner.

Local mode runs the Telegram receiver on Windows. Server mode runs it on Linux
and uses the Windows connector. Never run both receivers. Ports 27842 (Windows)
and 27841 (server tunnel) bind to 127.0.0.1; open only your chosen SSH port.

## 1. Get the source on Windows

```powershell
git clone https://github.com/ZamaniDeveloper/telegram-codex-remote.git
cd telegram-codex-remote
npm ci --ignore-scripts
npm run verify
```

For local mode run `.\setup.ps1`, then `npm start`. Enter the hidden BotFather
token, pair privately and select a chat. Skip the SSH steps below. Proxy variables
are available in `.env.example` when Telegram is inaccessible from Windows.

## 2. Prepare dedicated server accounts

These examples target Ubuntu and must be run by the administrator. Adapt paths
and ports to your deployment; keep the bot and tunnel identities separate.

```sh
sudo useradd --create-home --shell /usr/sbin/nologin codexbot
sudo useradd --create-home --shell /bin/bash codexbridge
sudo install -d -m 750 -o codexbot -g codexbot /opt/telegram-codex-remote
sudo git clone https://github.com/ZamaniDeveloper/telegram-codex-remote.git /opt/telegram-codex-remote
sudo chown -R codexbot:codexbot /opt/telegram-codex-remote
cd /opt/telegram-codex-remote
sudo -u codexbot -H npm ci --ignore-scripts
sudo -u codexbot -H npm run verify
```

Install PM2 with your Node installation's administrative method (e.g.
`npm install --global pm2`). Check `node --version` and `pm2 --version` are
available to `codexbot`. The supplied PM2 file resolves its checkout and Node
executable automatically.

Read the trusted host-key fingerprint **in the existing server console**:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

## 3. Generate Windows connector configuration

```powershell
.\setup-connector.ps1 -SshHost server.example.com -SshUser codexbridge -SshPort 22
```

Paste the trusted `SHA256:...` fingerprint from step 2. Scanning alone is not
verification; a mismatch is rejected. The script generates:

- `.connector.env`: local settings and random shared secret.
- `data/connector_ssh_key`: private key; never upload it.
- `data/connector_ssh_key.pub`: public key for the server.
- `data/connector_known_hosts`: pinned server key.
- `data/server.env.generated`: private server template with the same secret.

Private files have per-user Windows ACLs. Existing configuration is preserved.
Edit it locally to change an existing setup and update both ends together.

## 4. Restrict the SSH tunnel key

Put the public key in `/home/codexbridge/.ssh/authorized_keys`, prefixed exactly
as below on a single line:

```text
restrict,port-forwarding,permitlisten="127.0.0.1:27841",command="/bin/false" ssh-ed25519 PUBLIC_KEY_HERE telegram-codex-connector
```

Set `.ssh` to 700, `authorized_keys` to 600 and ownership to `codexbridge`. Also
restrict the account in the server's OpenSSH configuration:

```text
Match User codexbridge
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:27841
    GatewayPorts no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /bin/false
Match all
```

Validate with `sudo sshd -t` before reloading the Ubuntu `ssh` service. Keep the
existing admin session open. The account must allow public-key authentication
under your server's account/PAM policy. `ssh -N -T` does not request a shell.

## 5. Configure and start the bot service

Transfer `data/server.env.generated` through the administrator's secure connection.
Save it as `/opt/telegram-codex-remote/.env`, fill in the BotFather token and
optionally your numeric `TELEGRAM_OWNER_ID`. Never commit it.

```sh
sudo chown codexbot:codexbot /opt/telegram-codex-remote/.env
sudo chmod 600 /opt/telegram-codex-remote/.env
sudo -u codexbot -H pm2 start /opt/telegram-codex-remote/deploy/pm2.config.cjs --only telegram-codex-remote
sudo -u codexbot -H pm2 save
```

Set up boot integration with `pm2 startup systemd -u codexbot --hp /home/codexbot`
and execute the exact administrative command PM2 prints for your Node installation.
Check the generated service is enabled and active; `pm2 save` alone does not
install boot integration. Use only the bot's process/user for these operations.

## 6. Install Windows logon startup and pair

After the server and key are ready:

```powershell
.\install-windows.ps1
```

A per-user task maintains Codex and the connector after Windows logon. If task
registration is unavailable, the installer uses the current user's Run key. No
Windows password is stored. Keep the PC online and its user logged in.

```sh
sudo -u codexbot -H pm2 logs telegram-codex-remote --lines 20 --nostream
```

Send the displayed temporary `/pair ...` code privately. It expires after ten
minutes. Select a chat and send a small request. Read-only server checks:

```sh
sudo -u codexbot -H node deploy/check-server.mjs
sudo -u codexbot -H node deploy/check-ui.mjs
sudo -u codexbot -H node deploy/check-quota.mjs
```

`check-ui --publish-guide` sends help. `check-upload.mjs` writes test attachments
to Windows. Neither consumes reset credits. CI does not run these commands.

## Updates and troubleshooting

Back up private configuration, keys, settings and attachments before updating.
Review [CHANGELOG](../CHANGELOG.md). Stop only this bot, update and verify:

```sh
sudo -u codexbot -H pm2 stop telegram-codex-remote
sudo -u codexbot -H git -C /opt/telegram-codex-remote pull --ff-only
sudo -u codexbot -H sh -c 'cd /opt/telegram-codex-remote && npm ci --ignore-scripts && npm run verify'
sudo -u codexbot -H pm2 restart telegram-codex-remote --update-env
sudo -u codexbot -H pm2 save
```

On Windows:

```powershell
.\uninstall-autostart.ps1
git pull --ff-only
npm ci --ignore-scripts
npm run verify
.\install-windows.ps1
```

Keep existing `.connector.env` and keys. This removes only this checkout's startup
processes and keeps local data. Do not restart Codex during an active task.

| Symptom | Check |
|---|---|
| Telegram conflict | Use exactly one local/server poller. |
| Connector unavailable | PC online, user logged in, task running, pinned key and SSH permissions. |
| Port in use | One connector per port; inspect `data/connector.pid`. |
| Expired button / guide | Reopen the menu/question or press the steering button again. |
| Desktop protocol changed | Run `npm run doctor` with an open thread ID. |
| Reset result uncertain | Use the same-request check button; keep the reset journal. |
| No reset credit | Refreshing does not create an eligible earned credit. |

Do not upload raw logs or configurations. Runtime `data/` can contain private
project documents and is intentionally ignored by Git.
