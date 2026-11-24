#!/usr/bin/env python3
"""
定向恢复因导入 bug 丢失的电话（2026-11-24）。

背景：原表「数据库」Sheet 里 38 行是「身份证/电话互换」（身份证列放 11 位
手机号、电话列放 18 位身份证号）。旧版导入只纠了身份证、把手机号丢了，
导致 37 人的库里 phone 为空（第 38 人袁斯荣的电话已由另一行补录，无需恢复）。

用法：
  python3 scripts/restore-phones.py --db <hr.db 路径> [--json test-work/phone-restore.json] [--dry-run]

匹配规则（严格）：
  - 按 idCardNo + 入职日期（hireDate）定位员工（导入的去重键）；
  - 只写 phone 当前为空的员工；已有电话的不动；
  - idCardNo 必须与原表电话列里的 18 位身份证一致（JSON 里已校验）。

注意：这是针对 2026-11-24 导入 bug 的一次性修复脚本。修复后的导入脚本
（parser.ts 场景 A）已能直接恢复互换行的电话，重跑导入同样能修复；
本脚本是独立验证/兜底手段。不要用它「纠正」原表其他手工错误。
"""
import argparse
import json
import sqlite3
import sys

p = argparse.ArgumentParser()
p.add_argument("--db", required=True, help="hr.db 路径")
p.add_argument("--json", default="test-work/phone-restore.json")
p.add_argument("--dry-run", action="store_true")
a = p.parse_args()

with open(a.json, encoding="utf-8") as f:
    lst = json.load(f)
matched = lst.get("matched", [])
print(f"待恢复：{len(matched)} 人（来源 {a.json}）")

con = sqlite3.connect(a.db)
cur = con.cursor()
restored, skipped = 0, 0
names = []
for m in matched:
    row = None
    if m["hire"]:
        row = cur.execute(
            "SELECT id, name, phone FROM Employee WHERE idCardNo=? AND date(hireDate/1000,'unixepoch')=?",
            (m["id"], m["hire"]),
        ).fetchone()
    else:
        # 入职日期为空（原表该格无日期）：按身份证单独匹配，要求库里唯一
        rows = cur.execute(
            "SELECT id, name, phone FROM Employee WHERE idCardNo=?", (m["id"],)
        ).fetchall()
        if len(rows) == 1:
            row = rows[0]
        elif len(rows) > 1:
            print(f"  ✗ 身份证不唯一，无法定位：{m['name']}（{m['id']}，{len(rows)} 条）")
            skipped += 1
            continue
    if not row:
        print(f"  ✗ 未找到：{m['name']}（{m['id']} / {m['hire']}）")
        skipped += 1
        continue
    if row[2]:
        print(f"  - 已有电话，跳过：{m['name']}（库里 {row[2]}）")
        skipped += 1
        continue
    if not a.dry_run:
        cur.execute("UPDATE Employee SET phone=? WHERE id=? AND phone IS NULL", (m["phone"], row[0]))
        if cur.rowcount != 1:
            print(f"  ✗ 更新失败：{m['name']}")
            skipped += 1
            continue
    restored += 1
    names.append(m["name"])
if not a.dry_run:
    con.commit()
con.close()
print(f"\n恢复：{restored} 人；跳过/未找到：{skipped} 人")
print("恢复名单：" + "、".join(names))
if a.dry_run:
    print("（dry-run，未写入）")
sys.exit(0 if skipped == 0 else 1)
