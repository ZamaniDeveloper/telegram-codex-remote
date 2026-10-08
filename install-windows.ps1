#requires -Version 7.3
# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
[CmdletBinding()]
param([string]$SshHost, [string]$SshUser = 'codexbridge', [int]$SshPort = 22, [string]$HostKeyFingerprint)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $IsWindows) { throw 'The desktop connector installer requires Windows.' }
$connectorNodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$connectorNodeVersion -lt [version]'24.17.0') { throw 'Install Node.js 24.17.0 or newer before continuing.' }
Get-Command ssh.exe -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.connector.env'))) {
    & (Join-Path $PSScriptRoot 'setup-connector.ps1') -SshHost $SshHost -SshUser $SshUser -SshPort $SshPort -HostKeyFingerprint $HostKeyFingerprint
    Write-Host 'Finish the server setup described in docs/INSTALL.en.md, then run this installer again.'
    return
}
& node --env-file=.connector.env --input-type=module -e 'import {tunnelOptions} from "./src/config.mjs";tunnelOptions(process.env,process.cwd());'
if ($LASTEXITCODE -ne 0) { throw 'Connector configuration is invalid.' }
& (Join-Path $PSScriptRoot 'install-autostart.ps1')
Write-Host 'Installed. Codex and the connector run after you log in to Windows.'
Write-Host 'Developed by Mohsen Zamani / ZamaniDeveloper'
