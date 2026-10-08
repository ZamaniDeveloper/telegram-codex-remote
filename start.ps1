# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env'))) { & (Join-Path $PSScriptRoot 'setup.ps1') }
& node --env-file=.env src/main.mjs
exit $LASTEXITCODE
