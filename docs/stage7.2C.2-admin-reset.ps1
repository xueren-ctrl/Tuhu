# Stage 7.2C.2 - production admin password reset (operator runs locally)
# This script contains NO password. The password is typed by the operator at the
# hidden prompt; it is never echoed, never written to any file, never printed.
#
# NOTE: Read-Host's FIRST argument is the prompt TEXT and is displayed verbatim.
# Never put the password itself in the prompt text.

$ErrorActionPreference = 'Stop'
Set-Location 'D:\Tuhu-HR'

$nodeRoot = 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3'
$nodeExe  = Join-Path $nodeRoot 'node.exe'
$npmCmd   = Join-Path $nodeRoot 'npm.cmd'

# npm.cmd 内部会调用 `node`，而本机 node 未注册到系统 PATH，
# 所以必须把 node 目录临时加入**当前进程**的 PATH，否则报
# '"node" 不是内部或外部命令'。此设置只影响本脚本进程。
$env:PATH = $nodeRoot + ';' + $env:PATH

$nodeVer = & $nodeExe --version
$npmVer  = & $npmCmd --version
Write-Host ('node = ' + $nodeVer)
Write-Host ('npm  = ' + $npmVer)
Write-Host ''

# ---- hidden password input (prompt text must NOT contain the password) ----
$sec = Read-Host 'Enter the new admin password (at least 8 chars, input not echoed)' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $sec).Password

if ($plain.Length -lt 8) {
    Write-Host 'Password too short (<8 chars). Aborted, nothing was modified.' -ForegroundColor Red
    $plain = $null
    $sec = $null
    exit 1
}

# ---- password lives only in this process env, never in a file ----
$env:SEED_ADMIN_PASSWORD = $plain
$code = 1

try {
    Write-Host ''
    Write-Host 'Resetting admin password only (hr is not touched)...' -ForegroundColor Cyan
    # 直接用 node 跑 tsx CLI，绕开 npm.cmd 的 PATH 依赖（更稳）
    $tsxCli = Join-Path (Get-Location) 'node_modules\tsx\dist\cli.mjs'
    & $nodeExe $tsxCli 'scripts/seed-users.ts' '--reset-password' '--only=admin'
    $code = $LASTEXITCODE
}
finally {
    Remove-Item Env:SEED_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    $plain = $null
    $sec = $null
    [System.GC]::Collect()
}

Write-Host ''
if ($code -eq 0) {
    Write-Host 'Done. Paste the seed-users output above back to me (it contains no password).' -ForegroundColor Green
}
else {
    $msg = 'Reset FAILED (exit code ' + $code + '). Production password unchanged.'
    Write-Host $msg -ForegroundColor Red
}
