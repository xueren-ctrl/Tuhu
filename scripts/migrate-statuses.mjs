#!/usr/bin/env node
/**
 * Stage 9：把现有员工迁移到新的 8 状态体系
 *
 * 旧体系只有 3 个值：ACTIVE(在职) / RESIGNED(离职) / CANDIDATE(候选人=只面试未入职)
 * 新体系（用户 2026-09-26 确认，决定出现在哪些表）：
 *   CANDIDATE 候选中 / INTERVIEWED 已面试 / ACTIVE 已入职 / RESIGNED 离职
 *   NC3 南昌3店 / OPS 运营部 / OPS_RESIGNED 运营部离职 / OTHER 其他
 *
 * 迁移依据（按顺序判定，先命中先定）：
 *   1. 旧 CANDIDATE                        → 已面试（旧「候选人」就是只面试没入职）
 *   2. 部门 = 运营部                        → 运营部 / 运营部离职（看是否已离职）
 *   3. 门店 = 其他                          → 其他
 *   4. 门店 ∈ 南昌3店三家门店               → 南昌3店（已离职的记为离职）
 *   5. 其余                                 → 已入职 / 离职
 *
 * 用法：
 *   node scripts/migrate-statuses.mjs            # 只预演，不写库
 *   node scripts/migrate-statuses.mjs --apply    # 真正写库
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const NC3_STORES = ["南昌抚河中路店", "南昌崇仁人民大道店", "抚州乐安新二中店"];
const OPS_DEPT = "运营部";
const OTHER_STORE = "其他";

const NEW_LABEL = {
  CANDIDATE: "候选中",
  INTERVIEWED: "已面试",
  ACTIVE: "已入职",
  RESIGNED: "离职",
  NC3: "南昌3店",
  OPS: "运营部",
  OPS_RESIGNED: "运营部离职",
  OTHER: "其他",
};

function decideStatus(emp, opsDeptId) {
  if (emp.status === "CANDIDATE") return "INTERVIEWED";
  const resigned = emp.status === "RESIGNED";
  if (opsDeptId && emp.departmentId === opsDeptId) return resigned ? "OPS_RESIGNED" : "OPS";
  const store = emp.store?.name ?? emp.storeNameRaw ?? "";
  if (store === OTHER_STORE) return "OTHER";
  if (NC3_STORES.includes(store)) return resigned ? "RESIGNED" : "NC3";
  return resigned ? "RESIGNED" : "ACTIVE";
}

async function main() {
  console.log(`\n======= 员工状态迁移（${APPLY ? "正式写库" : "预演，不写库"}）=======\n`);

  const opsDept = await prisma.department.findFirst({ where: { name: OPS_DEPT } });
  if (!opsDept) console.log("⚠ 未找到部门「运营部」，运营部相关判定会跳过");
  console.log(`运营部 departmentId = ${opsDept?.id ?? "(无)"}`);

  const emps = await prisma.employee.findMany({
    select: {
      id: true,
      employeeId: true,
      status: true,
      departmentId: true,
      storeId: true,
      storeNameRaw: true,
      deletedAt: true,
      store: { select: { name: true } },
    },
  });

  const plan = emps.map((e) => ({ id: e.id, employeeId: e.employeeId, from: e.status, to: decideStatus(e, opsDept?.id) }));

  const matrix = new Map();
  for (const p of plan) {
    const k = `${p.from} → ${p.to}`;
    matrix.set(k, (matrix.get(k) ?? 0) + 1);
  }
  console.log("\n--- 迁移矩阵（旧状态 → 新状态）---");
  [...matrix.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(30)} ${v}`));

  const after = new Map();
  for (const p of plan) after.set(p.to, (after.get(p.to) ?? 0) + 1);
  console.log("\n--- 迁移后各状态人数 ---");
  for (const [k, v] of [...after.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(NEW_LABEL[k] ?? k).padEnd(12)} ${String(v).padStart(5)}`);
  }

  // 迁移后各表预计人数
  const STATUS_SHEETS = {
    CANDIDATE: [],
    INTERVIEWED: ["招聘面试登记表"],
    ACTIVE: ["在职", "招聘面试登记表", "薪资表"],
    RESIGNED: ["离职", "招聘面试登记表", "薪资表"],
    NC3: ["南昌3店", "招聘面试登记表", "薪资表"],
    OPS: ["运营部", "招聘面试登记表", "薪资表"],
    OPS_RESIGNED: ["运营部离职", "招聘面试登记表", "薪资表"],
    OTHER: ["其他"],
  };
  const sheetCount = new Map();
  for (const [st, n] of after) {
    for (const s of STATUS_SHEETS[st] ?? []) sheetCount.set(s, (sheetCount.get(s) ?? 0) + n);
  }
  console.log("\n--- 迁移后各表预计人数（未含软删除过滤）---");
  for (const [k, v] of [...sheetCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}`);
  }
  console.log(`  ${"数据库(全部)".padEnd(14)} ${String(emps.length).padStart(5)}`);

  const changed = plan.filter((p) => p.from !== p.to);
  console.log(`\n需要改动：${changed.length} 条（未改动 ${plan.length - changed.length} 条）`);

  if (!APPLY) {
    console.log("\n（预演结束。确认无误后加 --apply 正式写库）\n");
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (const p of changed) {
    await prisma.employee.update({ where: { id: p.id }, data: { status: p.to } });
    done++;
    if (done % 200 === 0) console.log(`  已更新 ${done}/${changed.length}…`);
  }
  console.log(`\n✓ 已更新 ${done} 条`);

  // 复核
  const verify = await prisma.employee.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("\n--- 写库后复核 ---");
  for (const r of verify.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${(NEW_LABEL[r.status] ?? r.status).padEnd(12)} ${r._count._all}`);
  }
  const total = await prisma.employee.count();
  console.log(`  合计 ${total}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("迁移失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
