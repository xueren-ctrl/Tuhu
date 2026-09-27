rem ============================================================
rem 每月 1 号 01:10 自动生成「月初人数」快照（Stage 9.22）
rem
rem 为什么需要：流失率的分母是「月初人数」，而公式是按「1 号在职」算的。
rem 若不固化，之后回看历史月份时，员工已离职/入职，算出来的数会跟当初的真实值对不上。
rem 每月 1 号跑一次就能锁住那一刻的真实人数。
rem
rem 人工导入的快照（source=MANUAL）优先级更高，本脚本默认不覆盖（无 --force）。
rem ============================================================
Set-Location "D:\Tuhu-HR"

$log = "D:\Tuhu-HR\logs\snapshot-baseline.log"
New-Item -ItemType Directory -Force -Path "D:\Tuhu-HR\logs" | Out-Null

Write-Output "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 开始生成月初人数快照 ===" 2>&1 | Out-File -FilePath $log -Append -Encoding utf8

# 只在 1~3 号跑（错过的机器开机后仍能补上，避免完全错过）
$day = (Get-Date).Day
if ($day -le 3) {
    node "D:\Tuhu-HR\scripts\snapshot-attrition-baseline.mjs" --apply 2>&1 |
        Out-File -FilePath $log -Append -Encoding utf8
    Write-Output "快照生成完成" 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
} else {
    Write-Output "今天是 $day 号，非 1~3 号，跳过（如需补跑请手动执行）" 2>&1 |
        Out-File -FilePath $log -Append -Encoding utf8
}
