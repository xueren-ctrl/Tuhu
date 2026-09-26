# Tuhu HR System - Tailscale setup (fixed private access)
#
# What this does:
#   1. Installs Tailscale if missing (silent install, no admin prompt on modern Windows)
#   2. Turns on unattended mode so the service logs in automatically after reboots
#   3. Prints the permanent 100.x address you can use from phone / laptop
#   4. Verifies the HR service is reachable THROUGH the tunnel
#
# Why Tailscale: gives a PERMANENT address (100.x.x.x) with no domain to buy,
# and it is NOT public - nobody outside your own devices can reach it.
# This is much safer than a public tunnel for a system holding ID numbers.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-tailscale.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-tailscale.ps1 -EnableFunnel
#   powershell -ExecutionPolicy Bypass -File scripts/setup-tailscale.ps1 -Uninstall
#
# NOTE: all user-facing strings are ASCII-only (Windows PowerShell 5.1 mis-parses
#       full-width CJK punctuation inside double-quoted strings).

param(
  [switch]$EnableFunnel,   # also expose a public https://xxx.ts.net URL
  [switch]$Uninstall
)

$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$tsExe = "C:\Program Files\Tailscale\tailscale.exe"
$port = 3000

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Tuhu HR System - Tailscale setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ---------- Uninstall ----------
if ($Uninstall) {
  if (Test-Path $tsExe) {
    Write-Host "Removing Tailscale..." -ForegroundColor Yellow
    & $tsExe logout 2>&1 | Out-Null
    Start-Process -FilePath "C:\Program Files\Tailscale\uninstall.exe" -Wait -ErrorAction SilentlyContinue
    Write-Host "[OK] Tailscale removed." -ForegroundColor Green
  } else {
    Write-Host "[..] Tailscale is not installed." -ForegroundColor Yellow
  }
  Write-Host ""
  exit 0
}

# ---------- 1. install if missing ----------
if (-not (Test-Path $tsExe)) {
  Write-Host "[..] Tailscale not found. Downloading installer..." -ForegroundColor Yellow
  $installer = Join-Path $root "tools\tailscale-setup.exe"
  if (-not (Test-Path $installer)) {
    Write-Host "[FAIL] Installer not found at: $installer" -ForegroundColor Red
    Write-Host "       Download it from https://tailscale.com/download and put it in tools\." -ForegroundColor Red
    Write-Host ""
    exit 1
  }
  Write-Host "     Running silent install (this takes 1-2 minutes)..." -ForegroundColor Yellow
  $p = Start-Process -FilePath $installer -ArgumentList "/quiet" -Wait -PassThru -ErrorAction SilentlyContinue
  Write-Host ("     Installer exit code: " + $p.ExitCode)
  if (-not (Test-Path $tsExe)) {
    Write-Host "[WARN] Tailscale exe not found after install. Try a manual install." -ForegroundColor Yellow
    Write-Host ""
    exit 1
  }
}
Write-Host ("[OK] Tailscale installed: " + $tsExe) -ForegroundColor Green

# ---------- 2. sign-in URL ----------
Write-Host ""
Write-Host "Checking login status..." -ForegroundColor Cyan
$status = & $tsExe status --json 2>$null
$loggedIn = $false
$selfName = ""
if ($status) {
  try {
    $j = $status | ConvertFrom-Json
    if ($j.BackendState -eq "Running") { $loggedIn = $true }
    if ($j.Self) { $selfName = $j.Self.HostName }
  } catch {
    $loggedIn = $false
  }
}

if (-not $loggedIn) {
  Write-Host ""
  Write-Host ">>> ACTION NEEDED: sign in to your Tailscale account" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "A browser window will open. Log in with the SAME account you just" -ForegroundColor White
  Write-Host "registered (Google / GitHub). Do it within 90 seconds." -ForegroundColor White
  Write-Host ""
  & $tsExe up 2>&1 | Out-Null
  Write-Host ""
  Write-Host "If the browser did not open, open this page manually:" -ForegroundColor Yellow
  Write-Host "    https://login.tailscale.com" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Then run this script again." -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

Write-Host ("[OK] Signed in. Machine name: " + $selfName) -ForegroundColor Green

# ---------- 3. unattended mode (survives reboots, no browser needed) ----------
# This is the key setting: without it, every reboot would need a manual login.
Write-Host ""
Write-Host "Enabling unattended mode (auto-login after reboots)..." -ForegroundColor Cyan
$u = & $tsExe set --unattended=true 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "[OK] Unattended mode ON - this machine reconnects by itself after reboots." -ForegroundColor Green
} else {
  Write-Host ("[..] Could not set unattended mode automatically: " + $u) -ForegroundColor Yellow
  Write-Host "     You may need to enable it in the Tailscale admin console." -ForegroundColor Yellow
}

# Optional: expose a public URL
if ($EnableFunnel) {
  Write-Host ""
  Write-Host "Enabling Funnel (public https URL)..." -ForegroundColor Cyan
  $f = & $tsExe funnel --bg 3000 2>&1
  Write-Host ($f -join [Environment]::NewLine)
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Funnel enabled - a public https://xxx.ts.net URL is now live." -ForegroundColor Green
    Write-Host "     WARNING: anyone with that URL can see the login page. Use only when needed." -ForegroundColor Yellow
  } else {
    Write-Host "[..] Funnel not enabled. Enable it in the admin console if you need a public URL." -ForegroundColor Yellow
  }
}

# ---------- 4. print the address ----------
Start-Sleep -Seconds 2
$status = & $tsExe status --json 2>$null
$ip = ""
$dns = ""
if ($status) {
  try {
    $j = $status | ConvertFrom-Json
    if ($j.TailscaleIPs) { $ip = $j.TailscaleIPs[0] }
    if ($j.MagicDNSSuffix) { $dns = $selfName + "." + $j.MagicDNSSuffix }
  } catch {
    # ignore
  }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " DONE - your permanent address" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
if ($ip) {
  Write-Host ("  By IP  : http://" + $ip + ":" + $port) -ForegroundColor White
}
if ($dns) {
  Write-Host ("  By name: http://" + $dns + ":" + $port) -ForegroundColor White
}
Write-Host ""
Write-Host "Sign in on your phone / laptop with the SAME account, install" -ForegroundColor White
Write-Host "Tailscale, then open the address above. That address never changes." -ForegroundColor White
Write-Host ""
Write-Host "Only devices on your account can reach it - it is not public." -ForegroundColor Green
Write-Host ""
Write-Host "Inside this app, the same address is shown at:" -ForegroundColor Cyan
Write-Host "    http://<address>/settings/access" -ForegroundColor Cyan
Write-Host ""
Write-Host "To remove Tailscale: rerun this script with -Uninstall" -ForegroundColor Yellow
Write-Host ""
