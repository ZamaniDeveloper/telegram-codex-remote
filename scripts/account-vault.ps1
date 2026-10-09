# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$vaultRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vaultEntropy = [Text.Encoding]::UTF8.GetBytes('TeleCodex account vault v1')
try {
    if ($vaultRequest.op -eq 'secure') {
        $vaultDirectory = [IO.Path]::GetFullPath([string]$vaultRequest.path)
        New-Item -ItemType Directory -Path $vaultDirectory -Force | Out-Null
        $vaultSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls.exe $vaultDirectory /inheritance:r /grant:r "*${vaultSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'ACL setup failed' }
        [Console]::Out.Write('true')
    } else {
        $vaultBytes = [Convert]::FromBase64String([string]$vaultRequest.value)
        if ($vaultRequest.op -eq 'protect') {
            $vaultResult = [Security.Cryptography.ProtectedData]::Protect($vaultBytes, $vaultEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        } elseif ($vaultRequest.op -eq 'unprotect') {
            $vaultResult = [Security.Cryptography.ProtectedData]::Unprotect($vaultBytes, $vaultEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        } else { throw 'Invalid vault operation' }
        [Console]::Out.Write([Convert]::ToBase64String($vaultResult))
    }
} catch { [Console]::Error.Write('Windows account vault operation failed.'); exit 1 }
