#requires -Version 7.3
# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
$connectorTaskName = 'Telegram Codex Connector'
$connectorScriptFile = Join-Path $PSScriptRoot 'connector-auto.ps1'
$connectorGuardProcesses = @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($connectorScriptFile, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
$connectorGuardPids = @($connectorGuardProcesses | ForEach-Object { $_.ProcessId })
$connectorTask = Get-ScheduledTask -TaskName $connectorTaskName -ErrorAction SilentlyContinue
if ($connectorTask -and @($connectorTask.Actions | Where-Object { $_.Arguments -and $_.Arguments.IndexOf($connectorScriptFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count) {
    Stop-ScheduledTask -TaskName $connectorTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $connectorTaskName -Confirm:$false
}
$connectorRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$connectorRunValue = (Get-ItemProperty -LiteralPath $connectorRunKey -Name $connectorTaskName -ErrorAction SilentlyContinue).$connectorTaskName
if ($connectorRunValue -and $connectorRunValue.IndexOf($connectorScriptFile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Remove-ItemProperty -LiteralPath $connectorRunKey -Name $connectorTaskName
}
$connectorGuardProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
$connectorPidPath = Join-Path $PSScriptRoot 'data\connector.pid'
if (Test-Path -LiteralPath $connectorPidPath) {
    $connectorStoredPid = [int](Get-Content -LiteralPath $connectorPidPath -Raw)
    $connectorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$connectorStoredPid"
    $connectorOwnedProcess = $connectorGuardPids -contains $connectorProcess.ParentProcessId -or ($connectorProcess.CommandLine -and $connectorProcess.CommandLine.IndexOf($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($connectorProcess.Name -eq 'node.exe' -and $connectorOwnedProcess -and $connectorProcess.CommandLine -like '*src/connector-supervisor.mjs*') {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$connectorStoredPid" | Where-Object { $_.Name -eq 'ssh.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
        Stop-Process -Id $connectorStoredPid -ErrorAction SilentlyContinue
    }
}
Write-Host 'Autostart removed. Configuration, keys, attachments and Codex remain available.'
