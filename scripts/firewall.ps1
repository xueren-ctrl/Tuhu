# 放行 Windows 防火墙 3000 端口（供手机 / 其他电脑访问本机 HR 系统）
#
# 用法（必须以管理员身份运行 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1
# 或：
#   npm run firewall
#
# 只添加一条入站规则，不做其它任何系统改动。重复执行会先删除旧规则再添加（幂等）。

param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ""
  Write-Host "[x] 需要管理员权限。" -ForegroundColor Red
  Write-Host "    请右键点击「Windows PowerShell」→ 以管理员身份运行，然后执行：" -ForegroundColor Yellow
  Write-Host "    cd D:\Tuhu-HR" -ForegroundColor Yellow
  Write-Host "    npm run firewall" -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

$ruleName = "Tuhu-HR ($Port)"

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Any `
  -Description "途虎加盟店 HR 人事管理系统（本地 Next.js 服务，供局域网内手机/电脑访问）" | Out-Null

Write-Host ""
Write-Host "[v] 已放行 TCP $Port 端口（所有网络类型）。" -ForegroundColor Green
Write-Host "    规则名称：$ruleName"
Write-Host ""
Write-Host "    说明：Windows 把 WiFi 归类为「专用」或「公用」不确定，这里对两种都放行，" -ForegroundColor DarkGray
Write-Host "          保证手机一定能连上。系统本身有登录校验，端口只对本机所在的网络开放。" -ForegroundColor DarkGray
Write-Host "    撤销方法：Remove-NetFirewallRule -DisplayName '$ruleName'" -ForegroundColor DarkGray
Write-Host ""
