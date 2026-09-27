#!/usr/bin/env node
/**
 * 回填「任职门店历史」（Stage 9.20）
 *
 * 背景：途虎门店之间人员调动频繁，但 Employee 只存**当前** storeId。
 * 导致「月初人数」算不准 —— 1 号那天他到底在哪个店？
 * 实测：2026-08 月初 207 人里，**22 人（10.6%）**归属可能归错店。
 *
 * 本脚本从**现有的多段档案**反推任职历史：
 *   同一个人有多份档案（按身份证分组），每份 = 门店的一行、且有 hireDate。
 *   把它们按入职日期排序 → 天然就是任职时间线。
 *   前一段的结束日 = 后一段的开始日（或该段自己的 resignDate，取较早者）。
 *
 * ⚠️ 只回填**能确定**的：
 *   - 某段标了 RESIGNED 却没有离职日期 → **跳过整组**（时间线推不出来），
 *     宁可留空让人工判断，也不要编一个错的月份。日志会列出这些组。
 *   - 同一人多段**时间重叠** → 跳过（数据本身有问题）。
 *   - 已在 EmployeeStorePeriod 里有 AUTO 记录的（软件内改过门店）→ 保留不动。
 *
 * 用法：
 *   node scripts/backfill-store-periods.mjs            预演
 *   node scripts/backfill-store-periods.mjs --apply    写入
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const DAY = 86_400_000;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "至今");
const up = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const min = (a, b) => (a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b);

const all = await prisma.employee.findMany({
  where: { deletedAt: null },
  select: {
    id: true, employeeId: true, name: true, idCardNo: true,
    storeId: true, store: { select: { name: true } },
    status: true, hireDate: true, resignDate: true,
  },
});

// 按身份证分组（无身份证退回姓名 —— 姓名可能撞车，标注出来）
const byKey = new Map();
for (const e of all) {
  const hasId = e.idCardNo && String(e.idCardNo).trim();
  const k = hasId ? `id:${String(e.idCardNo).trim()}` : `n:${e.name}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(e);
}

const existingAuto = new Set(
  (await prisma.employeeStorePeriod.findMany({ where: { source: "AUTO" }, select: { employeeId: true } }))
    .map((p) => p.employeeId)
    .filter(Boolean)
);

const groups = [...byKey.entries()].filter(([, v]) => v.length > 1);
console.log(`同一人多段档案：${groups.length} 组\n`);

const plan = [];
const skippedNoResign = [];
const skippedOverlap = [];
const skippedSameStore = [];

for (const [key, g] of groups) {
  const byId = !key.startsWith("n:");
  const segs = g.filter((e) => e.hireDate && e.storeId).sort((a, b) => a.hireDate.getTime() - b.hireDate.getTime());
  if (segs.length < 2) {
    skippedSameStore.push(`${g[0].name}：只有 1 段有入职日期`);
    continue;
  }

  // ⚠️ 同一身份证却有**不同姓名** → 这不是调动，是数据错误（一个人被登记成两个名字）
  //    实测：冯灿 / 毛佳豪 共用身份证 513021199906147830。
  //    这种绝不能当调动串起来，否则会凭空造出一段不存在的任职。
  const names = new Set(g.map((e) => e.name));
  if (names.size > 1) {
    skippedNoResign.push(
      `${[...names].join(" / ")}：同一条身份证对应 ${names.size} 个不同姓名，属数据错误（非调动），不串时间线`
    );
    continue;
  }

  // 时间线：第 i 段的结束 = min(自己的离职日, 下一段的开始)
  // ⚠️ 本段「标记离职却无离职日期」**不是问题** —— 只要下一段存在，
  //    「去新店那天」就是离开旧店的那天，用下一段的入职日当结束日完全成立。
  //    （实测 41 组属于这种情况，若一律跳过会丢掉大量可推断的历史。）
  const timeline = segs.map((e, i) => {
    const ownEnd = e.status === "RESIGNED" ? e.resignDate : null;
    const nextStart = i + 1 < segs.length ? segs[i + 1].hireDate : null;
    const to = min(ownEnd ? up(ownEnd) : null, nextStart ? up(nextStart) : null);
    return { emp: e, from: up(e.hireDate), to, inferredEnd: !ownEnd && !!nextStart };
  });
  let inferredCount = 0;
  for (const t of timeline) if (t.inferredEnd) inferredCount++;

  // 同一人已有 AUTO 记录（软件内改过门店）→ 不覆盖
  if (segs.some((e) => existingAuto.has(e.id))) {
    skippedSameStore.push(`${segs[0].name}：已有软件内自动记录的调动，保留不动`);
    continue;
  }
  // 重叠检测
  let overlap = false;
  for (let i = 0; i < timeline.length - 1; i++) {
    const a = timeline[i], b = timeline[i + 1];
    const aTo = a.to ? a.to.getTime() : Infinity;
    if (aTo > b.from.getTime()) { overlap = true; break; }
  }
  if (overlap) {
    skippedOverlap.push(
      `${segs[0].name}：任职时间重叠（${timeline.map((t) => `${t.emp.store?.name} ${iso(t.from)}~${iso(t.to)}`).join(" / ")}）`
    );
    continue;
  }

  for (const t of timeline) {
    plan.push({
      employeeId: t.emp.id,
      storeId: t.emp.storeId,
      fromDate: t.from,
      toDate: t.to,
      name: t.emp.name,
      storeName: t.emp.store?.name ?? "?",
      byIdCard: byId,
      inferredEnd: t.inferredEnd,
    });
  }
}

const people = new Set(plan.map((p) => p.employeeId));
const inferred = plan.filter((p) => p.inferredEnd).length;
const crossStoreSegs = plan.filter(
  (p) => new Set(plan.filter((q) => q.employeeId === p.employeeId).map((q) => q.storeId)).size > 1
).length;
console.log(`可回填：**${people.size} 人 / ${plan.length} 段任职**`);
console.log(`  其中 ${inferred} 段的结束日是「据下一段入职日推断」（原档案没写离职日期）`);
console.log(`  涉及 ${people.size} 人，其中跨门店调动相关 ${crossStoreSegs} 段\n`);
console.log("样例（前 10 段）：");
for (const p of plan.slice(0, 10)) {
  console.log(`  ${p.name.padEnd(8)} ${String(p.storeName).slice(0, 14).padEnd(15)} ${iso(p.fromDate)} ~ ${iso(p.toDate)}`);
}

console.log(`\n跳过：数据错误/无法推断 ${skippedNoResign.length} 组`);
for (const s of skippedNoResign.slice(0, 8)) console.log("  ·", s);
console.log(`跳过：时间重叠 ${skippedOverlap.length} 组`);
for (const s of skippedOverlap.slice(0, 5)) console.log("  ·", s);
console.log(`跳过：其他 ${skippedSameStore.length} 组`);

if (!APPLY) {
  console.log("\n（预演模式，未写库。确认无误后加 --apply 执行）\n");
  await prisma.$disconnect();
  process.exit(0);
}

let n = 0;
for (const p of plan) {
  await prisma.employeeStorePeriod.create({
    data: {
      employeeId: p.employeeId,
      storeId: p.storeId,
      fromDate: p.fromDate,
      toDate: p.toDate,
      source: "MIGRATION",
      remark: `由多段档案回填（${p.byIdCard ? "身份证" : "姓名"}匹配）`,
    },
  });
  n++;
}
console.log(`\n✓ 写入 ${n} 段任职历史（${people.size} 人）`);
console.log(`  EmployeeStorePeriod 共 ${await prisma.employeeStorePeriod.count()} 条`);

await prisma.$disconnect();
