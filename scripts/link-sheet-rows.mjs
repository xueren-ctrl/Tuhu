#!/usr/bin/env node
/**
 * 把「招聘面试登记表」「薪资表」的 Excel 原始行挂到员工档案上（Sheet 9.2）
 *
 * 为什么需要：这两张表以**原始名单**为准（人数与原来完全一致），
 * 但原始行里没有「状态」。不建立关联的话：
 *   ① 表上看不出这个人现在是离职了还是在职；
 *   ② 也没法从表里点进档案去改他的状态。
 *
 * 匹配规则（**只在唯一命中时才建关联，有歧义宁可留空，绝不猜**）：
 *   1. pair      姓名 + 电话 都非空，且在员工表唯一
 *   1b. pairTime 姓名 + 电话命中多人时，再用「面试时间」唯一筛一次（仍唯一才用）
 *   2. phone     电话非空且在员工表唯一
 *   3. nameHire  姓名 + 入职日期 在员工表唯一
 *   4. name      姓名在员工表唯一
 *
 * 用法：
 *   node scripts/link-sheet-rows.mjs            # 预演，只统计不写库
 *   node scripts/link-sheet-rows.mjs --apply    # 写库（先备份旧关联到 /tmp，再在事务里清空重建）
 *
 * 安全措施（2026-11-28 加固，见 OpenCode 核对 §2/§7）：
 *   ① deleteMany 只清 TARGETS 两张表的关联，不动其他表；
 *   ② 删除 + 重建包在一个 $transaction 里，中途失败不留半套；
 *   ③ --apply 前先把旧关联表完整落盘到 /tmp/link-backup-<时间戳>.json；
 *   ④ 写完自检：目标表的关联数必须 == plan.length，否则报错退出。
 *   ⑤ 计划为空时拒绝写库：否则 deleteMany 会把旧关联全清，
 *      而末尾自检 count()===0===plan.length 还会"通过"（OpenCode 2026-11-28 复核 §5.3-1）。
 */
import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// 只处理「以 Excel 原始名单为准」的两张表
const TARGETS = [
  { sheet: "招聘面试登记表", pick: (c) => ({ name: c[1], phone: c[2], hire: "", time: c[5] }) },
  { sheet: "薪资表", pick: (c) => ({ name: c[3], phone: "", hire: c[2], time: "" }) },
];

const emps = await prisma.employee.findMany({
  where: { deletedAt: null },
  select: { id: true, name: true, phone: true, hireDate: true, interviewDate: true },
});
const idx = { pair: new Map(), phone: new Map(), nameHire: new Map(), name: new Map() };
const byId = new Map(emps.map((e) => [e.id, e]));
const add = (m, k, id) => {
  if (!k) return;
  if (!m.has(k)) m.set(k, new Set());
  m.get(k).add(id);
};
for (const e of emps) {
  const nm = (e.name ?? "").trim();
  const ph = (e.phone ?? "").trim();
  const hd = e.hireDate ? e.hireDate.toISOString().slice(0, 10) : "";
  add(idx.pair, nm && ph ? `${nm}|${ph}` : "", e.id);
  add(idx.phone, ph, e.id);
  add(idx.nameHire, nm && hd ? `${nm}|${hd}` : "", e.id);
  add(idx.name, nm, e.id);
}
const uniq = (m, k) => {
  const s = k ? m.get(k) : undefined;
  return s && s.size === 1 ? [...s][0] : null;
};
/** 多人时用「面试时间」再筛一次（仅当筛完仍唯一才采信） */
const narrowByTime = (ids, timeText) => {
  const t = (timeText ?? "").trim();
  if (!t) return null;
  const ym = t.slice(0, 7);
  const hit = ids.filter((id) => {
    const d = byId.get(id)?.interviewDate;
    return d && d.toISOString().slice(0, 7) === ym;
  });
  return hit.length === 1 ? hit[0] : null;
};

console.log(`\n======= 原始名单行 → 员工档案 关联（${APPLY ? "写库" : "预演"}）=======\n`);

const plan = [];
for (const { sheet, pick } of TARGETS) {
  const rows = await prisma.sheetRow.findMany({ where: { sheet }, orderBy: { rowNo: "asc" } });
  const stat = { pair: 0, pairTime: 0, phone: 0, nameHire: 0, name: 0, ambiguous: 0, taken: 0, unmatched: 0 };
  const missed = [];
  const used = new Set();
  for (const r of rows) {
    const c = JSON.parse(r.cellsJson);
    const { name, phone, hire, time } = pick(c);
    const nm = (name ?? "").trim();
    const ph = (phone ?? "").trim();
    const hd = (hire ?? "").trim();

    let employeeId = uniq(idx.pair, nm && ph ? `${nm}|${ph}` : "");
    let method = "pair";
    let taken = false; // 命中了员工，但该员工已被别行占用（去重时被拒）
    if (!employeeId && nm && ph && idx.pair.has(`${nm}|${ph}`)) {
      employeeId = narrowByTime([...idx.pair.get(`${nm}|${ph}`)], time);
      method = "pairTime";
    }
    if (!employeeId) { employeeId = uniq(idx.phone, ph); method = "phone"; }
    if (!employeeId) { employeeId = uniq(idx.nameHire, nm && hd ? `${nm}|${hd}` : ""); method = "nameHire"; }
    if (!employeeId) { employeeId = uniq(idx.name, nm); method = "name"; }

    if (employeeId && used.has(employeeId)) {
      // 同一员工被两行认到（例如重新入职）：保留第一次，后面这行留空
      taken = true;
      employeeId = null;
    }
    if (employeeId) {
      used.add(employeeId);
      stat[method]++;
      plan.push({ sheet, rowNo: r.rowNo, employeeId, method });
    } else {
      // 判断是「有歧义」「已被别行占用」还是「库里根本没这个人」（三者分开计数）
      const amb =
        (nm && ph && idx.pair.has(`${nm}|${ph}`)) ||
        (ph && idx.phone.has(ph)) ||
        (nm && hd && idx.nameHire.has(`${nm}|${hd}`)) ||
        (nm && idx.name.has(nm));
      if (taken) stat.taken++;
      else if (amb) stat.ambiguous++;
      else stat.unmatched++;
      if (missed.length < 6) missed.push({ rowNo: r.rowNo, 姓名: nm, 原因: taken ? "已被别行占用" : amb ? "有歧义" : "员工库中没有这个人" });
    }
  }
  console.log(`--- ${sheet}（${rows.length} 行）---`);
  console.log(`  姓名+电话 ${stat.pair} · 姓名+电话+面试时间消歧 ${stat.pairTime} · 电话唯一 ${stat.phone} · 姓名+入职日期 ${stat.nameHire} · 姓名唯一 ${stat.name}`);
  console.log(`  关联成功 ${rows.length - stat.ambiguous - stat.taken - stat.unmatched} 行；有歧义未关联 ${stat.ambiguous} 行；已被别行占用 ${stat.taken} 行；库中无此人 ${stat.unmatched} 行`);
  if (missed.length) console.log("  未关联样例:", JSON.stringify(missed));
}

console.log(`\n合计待写入关联 ${plan.length} 条`);
if (!APPLY) {
  console.log("（预演结束。确认后加 --apply 写库）\n");
  await prisma.$disconnect();
} else {
  const TARGET_SHEETS = TARGETS.map((t) => t.sheet);
  // ③ 写库前先把旧关联表完整落盘（回滚用），再动手
  const oldLinks = await prisma.sheetRowEmployeeLink.findMany({ orderBy: [{ sheet: "asc" }, { rowNo: "asc" }] });
  const backupPath = `/tmp/link-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(backupPath, JSON.stringify(oldLinks, null, 2));
  console.log(`  已备份旧关联 ${oldLinks.length} 条 → ${backupPath}`);
  // ⑤ 计划为空时拒绝写库：否则 deleteMany 会把旧关联全清，
  //    而末尾自检 count()===0===plan.length 还会"通过"（OpenCode 2026-11-28 复核 §5.3-1）
  if (plan.length === 0) {
    console.error("❌ 计划为 0（镜像为空或员工库无匹配），拒绝写库，旧关联未动");
    await prisma.$disconnect();
    process.exit(1);
  }
  // ①② 只清这两张表的旧关联，且删除 + 重建包在一个事务里（中途失败不留半套）
  await prisma.$transaction([
    prisma.sheetRowEmployeeLink.deleteMany({ where: { sheet: { in: TARGET_SHEETS } } }),
    // SQLite 不支持 createMany 的 skipDuplicates，这里逐条写入
    ...plan.map((row) => prisma.sheetRowEmployeeLink.create({ data: row })),
  ]);
  // ④ 自检：目标两张表的关联数必须等于计划数
  const n = await prisma.sheetRowEmployeeLink.count({ where: { sheet: { in: TARGET_SHEETS } } });
  console.log(`✓ 已写入 ${n} 条关联`);
  if (n !== plan.length) {
    console.error(`❌ 自检失败：目标表关联数 ${n} ≠ 计划 ${plan.length}，请用备份 ${backupPath} 核对后处理`);
    process.exitCode = 1;
  }
  const byMethod = await prisma.sheetRowEmployeeLink.groupBy({ by: ["method"], _count: { _all: true } });
  for (const m of byMethod) console.log(`  ${m.method.padEnd(10)} ${m._count._all}`);
  await prisma.$disconnect();
}
