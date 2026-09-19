/**
 * ============================================================
 * 第二阶段数据迁移：把「部门」从「门店」中独立出来
 * scripts/migrate-departments.ts
 *
 * 背景
 * ────────────────────────────────────────────────────────────
 * Excel 里 `运营部`、`运营部离职` 这两个 Sheet 的业务含义是**部门**，
 * 不是门店。第一阶段把「门店名称」列的值不加区分地都建成了 Store，
 * 导致 `运营部` 这个非门店主体混在门店列表里（18 人）。
 *
 * 本脚本做三件事（可重复执行、幂等）：
 *   1. 为 Excel 中代表部门的 Sheet 建立 Department 记录
 *   2. 把这些员工从 Store 迁到 Department：
 *        departmentId      = 对应部门
 *        departmentNameRaw = Excel 原始值（保留留痕）
 *        storeId           = null（他们不属于任何门店）
 *   3. 清理掉迁移后已无任何员工关联的、由 Excel 派生的门店记录
 *
 * 不做的事（重要）
 * ────────────────────────────────────────────────────────────
 * - 不为门店员工虚构部门归属。Excel 未提供该信息，
 *   departmentId 保持 null，由 HR 后续在界面上维护。
 * - 不修改任何员工的其他字段，不删除任何员工记录。
 * - 不触碰原始 Excel。
 *
 * 用法
 * ────────────────────────────────────────────────────────────
 *   npx tsx scripts/migrate-departments.ts --dry-run   # 只看会改什么
 *   npx tsx scripts/migrate-departments.ts             # 实际执行
 * ============================================================
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Excel 中代表「部门」的 Sheet → 归并后的部门名。
 * 依据是 Sheet 名称本身（业务含义），不是猜测。
 * 「运营部离职」与「运营部」是同一部门的两份名单。
 */
const DEPARTMENT_SHEETS: { sheet: string; department: string; remark: string }[] = [
  { sheet: "运营部", department: "运营部", remark: "来自 Excel Sheet「运营部」" },
  { sheet: "运营部离职", department: "运营部", remark: "来自 Excel Sheet「运营部离职」" },
];

async function main() {
  console.log("═".repeat(72));
  console.log("第二阶段数据迁移：部门 与 门店 分离" + (DRY_RUN ? "  【DRY RUN 只读】" : ""));
  console.log("═".repeat(72));
  console.log("");

  // ---- 1. 建立 Department ----
  const deptNames = Array.from(new Set(DEPARTMENT_SHEETS.map((d) => d.department)));
  const deptIdByName = new Map<string, number>();

  for (const [i, name] of deptNames.entries()) {
    const source = DEPARTMENT_SHEETS.filter((d) => d.department === name)
      .map((d) => `「${d.sheet}」`)
      .join(" + ");

    const existing = await prisma.department.findUnique({ where: { name } });
    if (existing) {
      deptIdByName.set(name, existing.id);
      console.log(`  · 部门已存在：${name}（id=${existing.id}）`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  + [DRY] 将新建部门：${name}  来源 ${source}`);
      deptIdByName.set(name, -1);
      continue;
    }
    const created = await prisma.department.create({
      data: {
        name,
        sortOrder: i,
        status: "ACTIVE",
        remark: `数据来源：Excel ${source}`,
      },
    });
    deptIdByName.set(name, created.id);
    console.log(`  + 已新建部门：${name}（id=${created.id}）  来源 ${source}`);
  }
  console.log("");

  // ---- 2. 把员工从 Store 迁到 Department ----
  let moved = 0;
  const touchedStoreIds = new Set<number>();
  /** 各门店将被迁出的人数（用于 DRY RUN 时准确预估清理结果） */
  const movingOutByStore = new Map<number, number>();

  for (const name of deptNames) {
    const rows = await prisma.employee.findMany({
      where: { storeNameRaw: name, deletedAt: null },
      select: { id: true, employeeId: true, name: true, storeId: true, departmentId: true },
      orderBy: { sourceRowNo: "asc" },
    });

    console.log(`── 处理部门「${name}」：匹配到 ${rows.length} 名员工 ──`);
    for (const e of rows) {
      const alreadyDone = e.departmentId === deptIdByName.get(name) && e.storeId === null;
      if (alreadyDone) continue;

      if (e.storeId) {
        touchedStoreIds.add(e.storeId);
        movingOutByStore.set(e.storeId, (movingOutByStore.get(e.storeId) ?? 0) + 1);
      }
      if (DRY_RUN) {
        console.log(`   [DRY] ${e.employeeId} ${e.name}  storeId ${e.storeId} -> null，departmentId -> ${name}`);
        moved++;
        continue;
      }
      await prisma.employee.update({
        where: { id: e.id },
        data: {
          departmentId: deptIdByName.get(name) ?? null,
          departmentNameRaw: name, // 保留 Excel 原文
          storeId: null, // 不再属于任何门店
        },
      });
      moved++;
    }
    if (moved === 0) console.log("   （无需变更，已是目标状态）");
  }
  console.log("");
  console.log(`  ${DRY_RUN ? "[DRY] 将迁移" : "已迁移"}员工：${moved} 人`);
  console.log("");

  // ---- 3. 清理迁移后空了的名店记录 ----
  console.log("── 清理已无员工关联的派生门店记录 ──");
  let removedStores = 0;
  for (const sid of touchedStoreIds) {
    const store = await prisma.store.findUnique({
      where: { id: sid },
      select: { id: true, name: true, _count: { select: { employees: true } } },
    });
    if (!store) continue;
    // DRY RUN 下员工尚未真正迁出，需扣除「将要迁出」的人数才是真实结果
    const willMoveOut = DRY_RUN ? (movingOutByStore.get(sid) ?? 0) : 0;
    const remain = store._count.employees - willMoveOut;
    if (remain > 0) {
      console.log(
        `   · 保留门店「${store.name}」（迁出后仍有 ${remain} 名员工）`
      );
      continue;
    }
    if (DRY_RUN) {
      console.log(`   - [DRY] 将删除空门店「${store.name}」（id=${store.id}）`);
      removedStores++;
      continue;
    }
    await prisma.store.delete({ where: { id: sid } });
    console.log(`   - 已删除空门店「${store.name}」（id=${sid}）——它是非门店主体，已转为部门`);
    removedStores++;
  }
  if (removedStores === 0) console.log("   （无可清理项）");
  console.log("");

  // ---- 4. 结果核对 ----
  const [empTotal, storeCount, deptCount, posCount] = await Promise.all([
    prisma.employee.count({ where: { deletedAt: null } }),
    prisma.store.count(),
    prisma.department.count(),
    prisma.position.count(),
  ]);

  console.log("── 迁移后数据库现状 ──");
  console.log(`   员工总数   : ${empTotal}`);
  console.log(`   门店数量   : ${storeCount}`);
  console.log(`   部门数量   : ${deptCount}`);
  console.log(`   岗位数量   : ${posCount}`);

  for (const name of deptNames) {
    const [total, active, resigned] = await Promise.all([
      prisma.employee.count({ where: { departmentNameRaw: name, deletedAt: null } }),
      prisma.employee.count({ where: { departmentNameRaw: name, status: "ACTIVE", deletedAt: null } }),
      prisma.employee.count({ where: { departmentNameRaw: name, status: "RESIGNED", deletedAt: null } }),
    ]);
    console.log(`   部门「${name}」: 共 ${total} 人（在职 ${active} / 离职 ${resigned}）`);
  }

  const noDept = await prisma.employee.count({ where: { departmentId: null, deletedAt: null } });
  console.log(`   未分配部门的员工: ${noDept} 人（Excel 未提供门店员工的部门归属，留待 HR 维护）`);
  console.log("");
  console.log("✓ 迁移完成" + (DRY_RUN ? "（DRY RUN，未写入任何变更）" : ""));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("✗ 迁移失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
