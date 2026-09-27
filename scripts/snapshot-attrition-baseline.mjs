/**
 * 自动生成「月初人数」快照 —— Stage 9.22
 *
 * 用法：
 *   node scripts/snapshot-attrition-baseline.mjs --month=2026-10   预演
 *   node scripts/snapshot-attrition-baseline.mjs --month=2026-10 --apply   写入
 *
 * 用途：把「按公式实时算出的月初人数」**固化成快照**。
 *
 * 为什么需要：
 *   流失率的公式会随时间推移失真 —— 员工离职/入职不会补记日期，
 *   下个月再回头算上个月的月初人数时，那些人已经从「在职」变成「离职」了，
 *   算出来的数会跟当初真实的月初人数对不上。
 *   每月 1 号跑一次这个脚本把数字存下来，以后回看历史月份就是准的。
 *
 * ⚠️ 手工导入（`npm run import:attrition-baseline`）优先：
 *    若该月已有快照，本脚本**默认不覆盖**（需显式 --force），
 *    避免把人工核对的权威值冲掉。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const monthArg = argv.find((a) => a.startsWith("--month="))?.slice(8);

const month = monthArg || (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
})();

if (!/^\d{4}-\d{2}$/.test(month)) {
  console.error(`月份格式应为 YYYY-MM，收到：${month}`);
  process.exit(1);
}
const start = new Date(`${month}-01T00:00:00.000Z`);

function full3(h) {
  if (!h) return false;
  const t = new Date(h);
  return (
    new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 3, t.getUTCDate())).getTime() <= start.getTime()
  );
}

const plans = await prisma.attritionIndicator.findMany({
  orderBy: [{ sortOrder: "asc" }, { storeId: "asc" }],
  include: { store: { select: { id: true, name: true } } },
});
const emps = await prisma.employee.findMany({
  where: { deletedAt: null, status: "ACTIVE", storeId: { not: null } },
  select: { storeId: true, hireDate: true },
});
const existing = await prisma.attritionBaseline.findMany({ where: { month: start }, select: { storeId: true } });
const has = new Set(existing.map((e) => e.storeId));

const rows = plans.map((p) => {
  const list = emps.filter((e) => e.storeId === p.storeId);
  const n = list.filter((e) => e.hireDate && e.hireDate.getTime() <= start.getTime() && full3(e.hireDate)).length;
  return { store: p.store, n, exists: has.has(p.storeId) };
});

const total = rows.reduce((s, r) => s + r.n, 0);
const covered = rows.filter((r) => r.exists).length;

console.log(`\n统计月 ${month}（按公式实时计算：1 号在职 + 入职满 3 个月）`);
console.log(`  门店 ${rows.length} 家 · 合计 ${total} 人`);
console.log(`  已有快照的门店 ${covered} 家${covered && !FORCE ? "（默认不覆盖，需 --force 才更新）" : ""}`);

if (covered > 0 && !FORCE && APPLY) {
  console.log("\n⛔ 该月已有快照且未加 --force，已中止。人工核对过的值不会被自动值覆盖。");
  await prisma.$disconnect();
  process.exit(0);
}
if (!APPLY) {
  console.log("\n（预演模式，未写库。加 --apply 执行）");
  await prisma.$disconnect();
  process.exit(0);
}

let n = 0;
for (const r of rows) {
  await prisma.attritionBaseline.upsert({
    where: { storeId_month: { storeId: r.store.id, month: start } },
    create: { storeId: r.store.id, month: start, headcount: r.n, source: "AUTO", remark: "系统按公式自动快照" },
    update: { headcount: r.n, source: "AUTO" },
  });
  n++;
}
console.log(`\n✅ 已写入 ${n} 条自动快照（统计月 ${month}，合计 ${total} 人）`);

await prisma.$disconnect();
