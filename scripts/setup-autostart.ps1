# Tuhu HR System - Windows startup (auto-run) setup
#
# Purpose: this PC acts as the SERVER, so the app must start by itself after
#          Windows logs in. Nobody should have to type `npm run serve` again.
# How:     drop a VBS launcher into the Startup folder. It runs hidden.
#          (No registry writes, no admin rights needed. To undo: -Uninstall)
#
# WHY THIS FILE IS ASCII-ONLY
#   Windows PowerShell 5.1 mis-parses full-width CJK punctuation inside
#   double-quoted strings (e.g. the full-width colon in "root:"), throwing
#   "The string is missing the terminator". Keep every user-facing string ASCII.
#
# WHY THE VBS HARD-CODES THE NODE PATH
#   node.exe on this machine only lives under the WorkBuddy runtime directory and
#   is NOT on the system PATH, so `shell.Run "node ..."` would silently fail at
#   logon. We resolve the absolute node.exe here (script run time, when the
#   WorkBuddy environment is available) and bake it into the VBS. If node later
#   moves, rerun this script.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1 -Uninstall

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath("Startup")
$vbsPath = Join-Path $startup "TuhuHR-AutoStart.vbs"
$logDir = Join-Path $root "logs"
$logFile = Join-Path $logDir "autostart.log"
$port = 3000

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Tuhu HR System - startup (auto-run) setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ("Project dir : " + $root)
Write-Host ("Startup dir : " + $startup)
Write-Host ""

# ---------- Uninstall ----------
if ($Uninstall) {
  if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host ("[OK] Removed: " + $vbsPath) -ForegroundColor Green
    Write-Host "     Windows will no longer auto-start this app." -ForegroundColor Yellow
  } else {
    Write-Host "[..] No startup entry found. Nothing to do." -ForegroundColor Yellow
  }
  Write-Host ""
  exit 0
}

# ---------- resolve node.exe absolute path ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[FAIL] node command not found." -ForegroundColor Red
  Write-Host "       This app requires Node.js. Install Node.js LTS first." -ForegroundColor Red
  Write-Host ""
  exit 1
}
$nodeExe = $node.Source
if (-not (Test-Path $nodeExe)) {
  Write-Host ("[FAIL] node path does not exist: " + $nodeExe) -Red -ForegroundColor Red
  exit 1
}
Write-Host ("[OK] Node.js : " + $nodeExe) -ForegroundColor Green

# ---------- report port state ----------
$busy = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(800) -and $c.Connected) { $busy = $true }
  $c.Close()
} catch {
  $busy = $false
}
if ($busy) {
  Write-Host ("[..] Port " + $port + " is already in use (service may be running).") -ForegroundColor Yellow
}

# ---------- ensure log dir ----------
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# ---------- write the VBS launcher ----------
# The VBS bakes in the absolute node path so it does not depend on PATH.
$vbs = @"
' Tuhu HR System - auto-start launcher (generated)
' Delete this file to disable auto-start.

Dim shell, fso, logFile, out
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

logFile = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "logs\autostart.log")
Set out = fso.OpenTextFile(logFile, 8, True)
out.WriteLine Now & "  Windows login - auto-start triggered"
out.Close

shell.CurrentDirectory = "$root"

' Fall back to PATH lookup if the hard-coded path no longer exists
If fso.FileExists("$nodeExe") Then
  shell.Run """"$nodeExe"" scripts\autostart.mjs", 0, False
Else
  shell.Run "node scripts\autostart.mjs", 0, False
End If
"@

# UTF-16LE (Unicode) so the VBS is safe regardless of system code page
Set-Content -Path $vbsPath -Value $vbs -Encoding Unicode

Write-Host ("[OK] Created : " + $vbsPath) -ForegroundColor Green
Write-Host ""

# ---------- power settings: never sleep while plugged in ----------
Write-Host "Checking power settings (never sleep on AC)..." -ForegroundColor Cyan
try {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  powercfg /change monitor-timeout-ac 30 | Out-Null
  Write-Host "[OK] AC: never sleep, never hibernate; monitor 30min" -ForegroundColor Green
} catch {
  Write-Host ("[..] Could not change power settings: " + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host "     Set Never manually: Settings > System > Power" -ForegroundColor Yellow
}

try {
  powercfg /h off | Out-Null
  Write-Host "[OK] Hibernation disabled (it breaks network tools after sleep)" -ForegroundColor Green
} catch {
  Write-Host ("[..] Could not disable hibernation: " + $_.Exception.Message) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Setup complete" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "From now on the app starts by itself when Windows logs in." -ForegroundColor Green
Write-Host "The guard also restarts the service if it ever crashes." -ForegroundColor Green
Write-Host ""
Write-Host "Log file  : " + $logFile
Write-Host "View log  : npm run autostart:log"
Write-Host "Stop guard: close the running node process for autostart.mjs"
Write-Host "Undo auto : powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1 -Uninstall"
Write-Host ""
