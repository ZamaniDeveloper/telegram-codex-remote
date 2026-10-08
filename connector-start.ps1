# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node --env-file=.connector.env src/connector-supervisor.mjs
exit $LASTEXITCODE
