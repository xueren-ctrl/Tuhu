rem ============================================================
rem 每天自动执行到期的调店单（Stage 9.28）
rem
rem 为什么需要：调店单登记时会填「生效日期」（= 实际到岗日），
rem 到期由系统自动改门店，语义是「到岗即生效」（与主流 HR 系统一致）。
rem 若店长临时改口，在到期前到「调店记录」页点「作废」，档案不会被动过。
rem
rem 幂等：只处理 status=PENDING 且到期日<=今天 的单，执行后立刻置为已生效，
rem       重复运行不会重复改门店。
rem ============================================================
Set-Location "D:\Tuhu-HR"

$log = "D:\Tuhu-HR\logs\transfers.log"
New-Item -ItemType Directory -Force -Path "D:\Tuhu-HR\logs" | Out-Null

Write-Output "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 执行到期调店单 ===" 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8

npx tsx "D:\Tuhu-HR\scripts\run-due-transfers.mjs" --apply 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8
