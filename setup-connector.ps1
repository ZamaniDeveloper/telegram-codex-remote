#requires -Version 7.3
# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
[CmdletBinding()]
param([string]$SshHost, [string]$SshUser = 'codexbridge', [int]$SshPort = 22,
      [int]$LocalPort = 27842, [int]$RemotePort = 27841, [string]$HostKeyFingerprint)
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
Set-Location -LiteralPath $PSScriptRoot
$connectorEnvPath = Join-Path $PSScriptRoot '.connector.env'
if (Test-Path -LiteralPath $connectorEnvPath) {
    Write-Host 'Existing connector configuration preserved. Edit it locally to change settings.'
    return
}
if (-not $SshHost) { $SshHost = Read-Host 'SSH server hostname or IP' }
if ($SshHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$' -or $SshUser -notmatch '^[a-zA-Z_][a-zA-Z0-9_.-]*$') { throw 'Invalid SSH host or user.' }
foreach ($connectorPortValue in @($SshPort, $LocalPort, $RemotePort)) {
    if ($connectorPortValue -lt 1 -or $connectorPortValue -gt 65535) { throw 'Ports must be between 1 and 65535.' }
}
foreach ($connectorTool in @('node', 'ssh', 'ssh-keygen', 'ssh-keyscan')) { Get-Command $connectorTool -ErrorAction Stop | Out-Null }
$connectorData = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $connectorData -Force | Out-Null
$connectorKeyPath = Join-Path $connectorData 'connector_ssh_key'
if (-not (Test-Path -LiteralPath $connectorKeyPath)) {
    & ssh-keygen -q -t ed25519 -f $connectorKeyPath -N '' -C 'telegram-codex-connector'
    if ($LASTEXITCODE -ne 0) { throw 'SSH key generation failed.' }
}
$connectorPinPath = Join-Path $connectorData 'connector_known_hosts'
$connectorPinTemp = Join-Path $connectorData ('hostkey-' + [guid]::NewGuid().ToString() + '.tmp')
try {
    $connectorHostKeys = @(& ssh-keyscan -T 10 -p $SshPort -t ed25519 $SshHost 2>$null) | Where-Object { $_ -match '\s+ssh-ed25519\s+' }
    if (-not $connectorHostKeys.Count) { throw 'No Ed25519 host key received. Verify SSH access on the server.' }
    [IO.File]::WriteAllLines($connectorPinTemp, [string[]]$connectorHostKeys, [Text.UTF8Encoding]::new($false))
    $connectorFingerprintOutput = & ssh-keygen -lf $connectorPinTemp
    if ($LASTEXITCODE -ne 0) { throw 'Host key fingerprint could not be read.' }
    $connectorActualFingerprint = ($connectorFingerprintOutput -split '\s+')[1]
    if (-not $HostKeyFingerprint) {
        Write-Host 'Read the trusted fingerprint in your server console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
        $HostKeyFingerprint = Read-Host 'Paste that trusted SHA256 fingerprint here'
    }
    if ($HostKeyFingerprint.Trim() -cne $connectorActualFingerprint) { throw 'SSH host key fingerprint mismatch; configuration was not saved.' }
    Move-Item -LiteralPath $connectorPinTemp -Destination $connectorPinPath
} finally { Remove-Item -LiteralPath $connectorPinTemp -ErrorAction SilentlyContinue }
$connectorSecretValue = & node --input-type=module -e 'import {randomBytes} from "node:crypto";process.stdout.write(randomBytes(32).toString("base64url"));'
if ($LASTEXITCODE -ne 0 -or $connectorSecretValue.Length -lt 32) { throw 'Secret generation failed.' }
$connectorConfigText = "CONNECTOR_SECRET=$connectorSecretValue`nCONNECTOR_SSH_HOST=$SshHost`nCONNECTOR_SSH_USER=$SshUser`nCONNECTOR_SSH_PORT=$SshPort`nCONNECTOR_PORT=$LocalPort`nCONNECTOR_REMOTE_PORT=$RemotePort`n"
[IO.File]::WriteAllText($connectorEnvPath, $connectorConfigText, [Text.UTF8Encoding]::new($false))
$connectorServerTemplate = Join-Path $connectorData 'server.env.generated'
[IO.File]::WriteAllText($connectorServerTemplate, "TELEGRAM_BOT_TOKEN=`nTELEGRAM_OWNER_ID=`nCONNECTOR_URL=http://127.0.0.1:$RemotePort`nCONNECTOR_SECRET=$connectorSecretValue`n", [Text.UTF8Encoding]::new($false))
$connectorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($connectorPrivatePath in @($connectorKeyPath, $connectorEnvPath, $connectorServerTemplate)) {
    & icacls $connectorPrivatePath '/inheritance:r' '/grant:r' ('*' + $connectorSid + ':F') '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict generated file permissions.' }
}
$connectorSecretValue = $null; $connectorConfigText = $null
Write-Host 'Connector configuration saved. No passwords or secret values were printed.'
Write-Host 'Use data/server.env.generated for the server .env; fill in your BotFather token there.'
Write-Host 'Install the PUBLIC key from data/connector_ssh_key.pub with the restrictions in docs/INSTALL.en.md.'
Write-Host 'After the server is ready, run .\install-windows.ps1.'
