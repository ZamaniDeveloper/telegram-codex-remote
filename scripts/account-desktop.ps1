# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
param([ValidateSet('inspect','stop','start')][string]$Operation, [int]$DesktopPid = 0)
$ErrorActionPreference = 'Stop'
try {
    $desktopProcesses = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' })
    $desktopRoots = @($desktopProcesses | Where-Object { $_.ParentProcessId -notin $desktopProcesses.ProcessId })
    if ($Operation -eq 'inspect') {
        if ($desktopRoots.Count -eq 0) { [Console]::Out.Write('null'); exit 0 }
        if ($desktopRoots.Count -ne 1) { throw 'Expected one Codex desktop instance' }
        [Console]::Out.Write(($desktopRoots | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='path';e={$_.ExecutablePath}} | ConvertTo-Json -Compress))
    } elseif ($Operation -eq 'stop') {
        if ($desktopRoots.Count -ne 1 -or $desktopRoots[0].ProcessId -ne $DesktopPid) { throw 'Desktop identity changed' }
        $desktopAllProcesses = @(Get-CimInstance Win32_Process)
        $desktopOwnedIds = @($DesktopPid)
        do {
            $desktopChildren = @($desktopAllProcesses | Where-Object { $_.ParentProcessId -in $desktopOwnedIds -and $_.ProcessId -notin $desktopOwnedIds })
            $desktopOwnedIds += @($desktopChildren.ProcessId)
        } while ($desktopChildren.Count -gt 0)
        $desktopOwnedProcesses = @($desktopAllProcesses | Where-Object { $_.ProcessId -in $desktopOwnedIds -and ($_.ExecutablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or $_.ExecutablePath -match '\\OpenAI\\Codex\\bin\\[^\\]+\\codex\.exe$') })
        # Called only after the connector verifies all latest local turns are idle.
        $desktopMainProcess = Get-Process -Id $DesktopPid
        $desktopGraceful = $desktopMainProcess.CloseMainWindow()
        if ($desktopGraceful) { Start-Sleep -Milliseconds 750 }
        if (Get-Process -Id $DesktopPid -ErrorAction SilentlyContinue) { Stop-Process -Id $DesktopPid -ErrorAction Stop }
        # A crashed Electron root can leave its credential-caching app-server
        # alive. Stop only captured, path-verified descendants of this instance.
        foreach ($desktopOwned in $desktopOwnedProcesses) {
            $desktopActual = Get-CimInstance Win32_Process -Filter "ProcessId=$($desktopOwned.ProcessId)"
            if ($desktopActual -and $desktopActual.CreationDate -eq $desktopOwned.CreationDate -and $desktopActual.ExecutablePath -eq $desktopOwned.ExecutablePath) {
                Stop-Process -Id $desktopOwned.ProcessId -ErrorAction SilentlyContinue
            }
        }
        $desktopDeadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            $desktopStillRunning = @(Get-Process -Id $desktopOwnedProcesses.ProcessId -ErrorAction SilentlyContinue)
            if ($desktopStillRunning.Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $desktopDeadline)
        if ($desktopStillRunning.Count -gt 0) { throw 'Desktop did not stop cleanly' }
        [Console]::Out.Write('true')
    } else {
        if ($desktopRoots.Count -gt 0) { throw 'Desktop is already running' }
        $desktopPackage = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $desktopPackage) { throw 'Codex desktop not installed' }
        Start-Process -FilePath explorer.exe -ArgumentList "shell:AppsFolder\$($desktopPackage.PackageFamilyName)!App" -WindowStyle Hidden
        [Console]::Out.Write('true')
    }
} catch { [Console]::Error.Write('Codex desktop operation failed; check the Windows connector.'); exit 1 }
