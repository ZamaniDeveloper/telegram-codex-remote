# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
$ErrorActionPreference = 'Stop'
$taskEnvPath = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $taskEnvPath) {
    Write-Host 'The local .env file already exists. Edit it locally if needed.'
    exit 0
}
$taskSecureToken = Read-Host 'Telegram bot token from BotFather (hidden)' -AsSecureString
$taskTokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureToken)
try {
    $taskBotToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskTokenPtr)
    if ($taskBotToken -notmatch '^\d+:[\w-]+$') { throw 'Invalid Telegram token format.' }
    $taskConfigText = "TELEGRAM_BOT_TOKEN=$taskBotToken`nTELEGRAM_OWNER_ID=`n"
    [IO.File]::WriteAllText($taskEnvPath, $taskConfigText, [Text.UTF8Encoding]::new($false))
    $taskConfigText = $null
    $taskBotToken = $null
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskTokenPtr) }
Write-Host 'Saved locally. Keep Codex open, then run: npm start'
