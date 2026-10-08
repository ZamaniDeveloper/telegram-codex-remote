#requires -Version 7.3
# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
[CmdletBinding()]
param([string]$PythonPath, [ValidateSet('tiny','base','small','medium')][string]$Model = 'small')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $IsWindows) { throw 'Run the Whisper installer on the Windows connector computer.' }
if (-not $PythonPath) {
    $PythonPath = & py -3.12 -c 'import sys; print(sys.executable)'
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12, or pass -PythonPath with a compatible Python executable.' }
}
& $PythonPath -c 'import sys; assert (3,10) <= sys.version_info[:2] <= (3,13), "Use Python 3.10-3.13"'
if ($LASTEXITCODE -ne 0) { throw 'Unsupported Python version.' }
$whisperEnv = Join-Path $PSScriptRoot 'data/whisper-venv'
$whisperPython = Join-Path $whisperEnv 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $whisperPython)) {
    & $PythonPath -m venv $whisperEnv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Whisper environment.' }
}
& $whisperPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'scripts/whisper-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Whisper package installation failed.' }
$whisperModelPath = Join-Path $PSScriptRoot 'data/whisper-model'
Write-Host 'Downloading the multilingual model once. Audio transcription will run locally afterward.'
$whisperRequest = @{ install = $true; model = $Model; modelPath = $whisperModelPath } | ConvertTo-Json -Compress
$whisperResult = $whisperRequest | & $whisperPython (Join-Path $PSScriptRoot 'scripts/transcribe.py')
if ($LASTEXITCODE -ne 0 -or -not (($whisperResult | ConvertFrom-Json).ready)) { throw 'Whisper model download or verification failed.' }
Write-Host 'Whisper is ready. Restart the Windows connector, then send a voice/audio message and send the bundle.'
Write-Host 'No API key required. Maximum audio duration: 10 minutes. Developed by Mohsen Zamani / ZamaniDeveloper.'
