#requires -Version 7.3
# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
# Isolated setup check: no real SSH network, Telegram, Codex or startup task.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This check exercises Windows ACLs and requires Windows.' }
$installerProject = Split-Path -Parent $PSScriptRoot
$installerFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-installer-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $installerFixtureRoot | Out-Null
$installerOldLocation = Get-Location
try {
    $installerHostKey = Join-Path $installerFixtureRoot 'fixture_host_key'
    $PSNativeCommandArgumentPassing = 'Standard'
    & ssh-keygen -q -t ed25519 -f $installerHostKey -N ''
    if ($LASTEXITCODE -ne 0) { throw 'Fixture key generation failed.' }
    $installerPubKey = (Get-Content -LiteralPath ($installerHostKey + '.pub') -Raw).Trim()
    $installerFingerprint = ((& ssh-keygen -lf ($installerHostKey + '.pub')) -split '\s+')[1]
    $global:InstallerFixtureHostLine = 'server.example.com ' + $installerPubKey
    function global:ssh-keyscan { $global:LASTEXITCODE = 0; return $global:InstallerFixtureHostLine }
    foreach ($installerCase in @('valid', 'mismatch')) {
        $installerCaseRoot = Join-Path $installerFixtureRoot $installerCase
        New-Item -ItemType Directory -Path $installerCaseRoot | Out-Null
        Copy-Item -LiteralPath (Join-Path $installerProject 'setup-connector.ps1') -Destination $installerCaseRoot
        $installerExpected = if ($installerCase -eq 'valid') { $installerFingerprint } else { 'SHA256:not-the-server' }
        if ($installerCase -eq 'mismatch') {
            $installerRejected = $false
            try { & (Join-Path $installerCaseRoot 'setup-connector.ps1') -SshHost server.example.com -HostKeyFingerprint $installerExpected }
            catch { $installerRejected = $_.Exception.Message -like '*fingerprint mismatch*' }
            if (-not $installerRejected -or (Test-Path -LiteralPath (Join-Path $installerCaseRoot '.connector.env'))) { throw 'Unverified host configuration was saved.' }
            continue
        }
        & (Join-Path $installerCaseRoot 'setup-connector.ps1') -SshHost server.example.com -HostKeyFingerprint $installerExpected
        $installerEnvPath = Join-Path $installerCaseRoot '.connector.env'
        $installerOriginalHash = (Get-FileHash -LiteralPath $installerEnvPath).Hash
        & (Join-Path $installerCaseRoot 'setup-connector.ps1') -SshHost ignored.example.com -HostKeyFingerprint 'unused'
        if ((Get-FileHash -LiteralPath $installerEnvPath).Hash -ne $installerOriginalHash) { throw 'Existing configuration changed.' }
        $installerLocalSecret = (Get-Content -LiteralPath $installerEnvPath | Where-Object { $_ -like 'CONNECTOR_SECRET=*' }) -replace '^CONNECTOR_SECRET=', ''
        $installerServerSecret = (Get-Content -LiteralPath (Join-Path $installerCaseRoot 'data/server.env.generated') | Where-Object { $_ -like 'CONNECTOR_SECRET=*' }) -replace '^CONNECTOR_SECRET=', ''
        if ($installerLocalSecret.Length -lt 32 -or $installerLocalSecret -cne $installerServerSecret) { throw 'Generated secrets do not match.' }
        if (-not (Get-Acl -LiteralPath $installerEnvPath).AreAccessRulesProtected) { throw 'Private configuration still inherits permissions.' }
        & ssh-keygen -y -f (Join-Path $installerCaseRoot 'data/connector_ssh_key') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Generated private key is not readable by its owner.' }
    }
    Write-Output 'Windows setup check passed: key generation, host pinning, matching secrets, protected ACLs and existing-config preservation.'
} finally {
    Set-Location -LiteralPath $installerOldLocation.Path
    Remove-Item -LiteralPath 'Function:\ssh-keyscan' -ErrorAction SilentlyContinue
    Remove-Variable -Name InstallerFixtureHostLine -Scope Global -ErrorAction SilentlyContinue
    $installerResolved = [IO.Path]::GetFullPath($installerFixtureRoot)
    $installerTempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($installerResolved.StartsWith($installerTempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $installerResolved -Leaf) -like 'codex-installer-*') {
        Remove-Item -LiteralPath $installerResolved -Recurse -Force
    }
}
