# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
$connectorTaskName = 'Telegram Codex Connector'
$connectorShellPath = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $connectorShellPath)) { $connectorShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$connectorScriptPath = Join-Path $PSScriptRoot 'connector-auto.ps1'
$connectorArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $connectorScriptPath + '"'
$connectorRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$connectorTaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
    $existingConnectorTask = Get-ScheduledTask -TaskName $connectorTaskName -ErrorAction SilentlyContinue
    if ($existingConnectorTask) {
        New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '.deploy') -Force | Out-Null
        Export-ScheduledTask -TaskName $connectorTaskName | Set-Content -LiteralPath (Join-Path $PSScriptRoot '.deploy\autostart-task-backup.xml') -Encoding utf8
    }
    $connectorAction = New-ScheduledTaskAction -Execute $connectorShellPath -Argument $connectorArguments -WorkingDirectory $PSScriptRoot
    $connectorTrigger = New-ScheduledTaskTrigger -AtLogOn -User $connectorTaskUser
    $connectorPrincipal = New-ScheduledTaskPrincipal -UserId $connectorTaskUser -LogonType Interactive -RunLevel Limited
    $connectorSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $connectorTaskName -Action $connectorAction -Trigger $connectorTrigger -Principal $connectorPrincipal -Settings $connectorSettings -Description 'Start Codex and maintain the private Telegram connector at user logon.' -Force | Out-Null
    Remove-ItemProperty -LiteralPath $connectorRunKey -Name $connectorTaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $connectorTaskName
    Write-Output 'Installed and started the per-user logon task: Telegram Codex Connector'
} catch {
    # HKCU startup is available even when the task scheduler requires elevation.
    New-Item -Path $connectorRunKey -Force | Out-Null
    New-ItemProperty -LiteralPath $connectorRunKey -Name $connectorTaskName -Value ('"' + $connectorShellPath + '" ' + $connectorArguments) -PropertyType String -Force | Out-Null
    Start-Process -FilePath $connectorShellPath -ArgumentList $connectorArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    Write-Output 'Installed and started per-user logon startup: Telegram Codex Connector (HKCU Run)'
}
