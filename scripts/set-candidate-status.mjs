/**
 * 一次性数据裁定：把指定员工的状态改为「候选中」（不出现在任何表，只保留在数据库）
 * 用法：node scripts/set-candidate-status.mjs <姓名>
 * 幂等：已是候选中则不做任何事。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const name = process.argv[2];
if (!name) {
  console.error("用法：node scripts/set-candidate-status.mjs <姓名>");
  process.exit(1);
}

const list = await prisma.employee.findMany({
  where: { name },
  select: { id: true, employeeId: true, name: true, status: true, deletedAt: true },
});
if (list.length === 0) {
  console.error(`未找到员工：${name}`);
  process.exit(1);
}

for (const e of list) {
  if (e.status === "CANDIDATE") {
    console.log(`${e.employeeId} ${e.name} 已经是「候选中」，跳过`);
    continue;
  }
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: e.id }, data: { status: "CANDIDATE" } });
    await tx.employeeHistory.create({
      data: {
        employeeId: e.id,
        employeeCode: e.employeeId,
        source: "UPDATE",
        fieldName: "status",
        fieldLabel: "状态",
        oldValue: e.status,
        newValue: "CANDIDATE",
        operator: "人工裁定（未面试未入职，保留在数据库）",
      },
    });
    await tx.auditLog.create({
      data: {
        actor: "人工裁定",
        action: "STATUS_CHANGE",
        entity: "Employee",
        entityId: String(e.id),
        summary: `更正状态：${e.status} → CANDIDATE（未面试未入职）`,
        detail: JSON.stringify({ employeeCode: e.employeeId, from: e.status, to: "CANDIDATE" }),
      },
    });
  });
  console.log(`${e.employeeId} ${e.name}：${e.status} → CANDIDATE（候选中）`);
}

const counts = await prisma.employee.groupBy({
  by: ["status"],
  where: { deletedAt: null },
  _count: { _all: true },
});
console.log("\n改完后各状态人数：");
for (const r of counts.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${r.status.padEnd(14)} ${r._count._all}`);
}
await prisma.$disconnect();
