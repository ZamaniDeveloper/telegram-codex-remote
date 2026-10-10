# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$connectorNodePath = (Get-Command node.exe).Source
$connectorPidFile = Join-Path $PSScriptRoot 'data\connector.pid'
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
# The connector continuously reopens an absent desktop in this interactive session.
while ($true) {
    $connectorActive = $false
    try {
        $connectorPid = [int](Get-Content -LiteralPath $connectorPidFile -Raw)
        $connectorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$connectorPid"
        $connectorActive = $connectorProcess.Name -eq 'node.exe' -and $connectorProcess.CommandLine -like '*src/connector-supervisor.mjs*'
        if (-not $connectorActive) { Remove-Item -LiteralPath $connectorPidFile -ErrorAction SilentlyContinue }
    } catch {}
    if (-not $connectorActive) {
        $connectorProcess = Start-Process -FilePath $connectorNodePath -ArgumentList @('--env-file=.connector.env', 'src/connector-supervisor.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\connector-out.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\connector-error.log') -PassThru
        $connectorProcess.WaitForExit()
    }
    Start-Sleep -Seconds 15
}
