/**
 * 执行到期的调店单（Stage 9.28）
 *
 * 用法：
 *   node scripts/run-due-transfers.mjs        预演（只打印将执行什么）
 *   node scripts/run-due-transfers.mjs --apply  真正执行
 *
 * 由 Windows 计划任务每天调用（`scripts/schedule-transfers.ps1`）。
 *
 * ── 为什么需要自动生效 ────────────────────────────────────
 * 登记调店单时会填「生效日期」= 实际到岗日。
 * 到期自动改门店，语义就是「到岗即生效」，与用友人力云等系统的做法一致。
 * 若店长临时改口，在**到期前**到调店记录页点「作废」即可，档案不会被动过。
 *
 * ── 幂等 ──────────────────────────────────────────────────
 * 只处理 `status=PENDING 且 effectiveDate<=今天` 的单；
 * 执行成功后立刻置为 EFFECTED，重复跑不会重复改门店。
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const today = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
})();

const due = await prisma.transferOrder.findMany({
  where: { status: "PENDING", effectiveDate: { lte: today } },
  orderBy: { effectiveDate: "asc" },
  include: {
    employee: { select: { id: true, name: true, storeId: true } },
    toStore: { select: { id: true, name: true } },
    fromStore: { select: { id: true, name: true } },
  },
});

const pendingAll = await prisma.transferOrder.count({ where: { status: "PENDING" } });
console.log(`待生效单据共 ${pendingAll} 张，其中今天到期或已过期 ${due.length} 张`);

if (due.length === 0) {
  console.log("没有需要执行的单据。");
  await prisma.$disconnect();
  process.exit(0);
}

for (const o of due) {
  console.log(
    `  #${o.id}  ${o.employee.name}：${o.fromStore.name} → ${o.toStore.name}` +
      `（生效日 ${o.effectiveDate.toISOString().slice(0, 10)}）` +
      `${o.reason ? "  原因：" + o.reason : ""}`
  );
}

if (!APPLY) {
  console.log("\n（预演模式，未执行。加 --apply 真正生效）");
  await prisma.$disconnect();
  process.exit(0);
}

// 复用服务层逻辑，保证与页面「立即生效」产生完全一致的副作用
const { runDueTransfers } = await import("../lib/transfer-order-service.ts");
const r = await runDueTransfers("system:auto-transfer");
console.log(`\n执行完成：生效 ${r.effected} 张，跳过 ${r.skipped} 张，失败 ${r.failed.length} 张`);
for (const f of r.failed) console.log(`  ✗ 单 #${f.orderId}：${f.error}`);

await prisma.$disconnect();
process.exit(r.failed.length > 0 ? 1 : 0);
