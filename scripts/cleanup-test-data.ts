/**
 * 清理验收测试产生的临时数据
 * 覆盖第一阶段（acceptance-test.mjs）、第二阶段（stage2-test.mjs）
 * 与第二阶段开发验收（stage2-acceptance.mjs）的测试数据。
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const TEST_EMP_PATTERNS = [
  "验收测试员工",
  "阶段二测试员工",
  "测试员工001",
  "阶段三测试员工",
  "阶段四测试员工",
];
const TEST_STORE_PATTERNS = [
  "验收测试门店",
  "阶段二测试门店",
  "测试门店",
  "阶段三测试门店",
  "阶段四测试门店",
];
const TEST_DEPT_PATTERNS = [
  "阶段二测试部门",
  "测试部门",
  "阶段三测试部门",
  "阶段四测试部门",
];

async function main() {
  // ---- 1. 测试员工（含软删除的）----
  for (const pat of TEST_EMP_PATTERNS) {
    const emps = await prisma.employee.findMany({
      where: { name: { contains: pat } },
      select: { id: true, employeeId: true, name: true },
    });
    for (const e of emps) {
      await prisma.employeeSourceRow.deleteMany({ where: { employeeId: e.id } });
      await prisma.employee.delete({ where: { id: e.id } });
      console.log(`- 已清理测试员工 ${e.name} (${e.employeeId})`);
    }
  }

  // ---- 2. 测试门店 ----
  for (const pat of TEST_STORE_PATTERNS) {
    const stores = await prisma.store.findMany({
      where: { name: { contains: pat }, employees: { none: {} } },
    });
    for (const s of stores) {
      await prisma.store.delete({ where: { id: s.id } });
      console.log(`- 已清理测试门店 ${s.name}`);
    }
  }

  // ---- 3. 测试部门 ----
  for (const pat of TEST_DEPT_PATTERNS) {
    const depts = await prisma.department.findMany({
      where: { name: { contains: pat }, employees: { none: {} } },
    });
    for (const d of depts) {
      await prisma.department.delete({ where: { id: d.id } });
      console.log(`- 已清理测试部门 ${d.name}`);
    }
  }

  // ---- 4. 测试职位 ----
  const poss = await prisma.position.findMany({
    where: { name: { contains: "验收测试职位" }, employees: { none: {} } },
  });
  for (const p of poss) {
    await prisma.position.delete({ where: { id: p.id } });
    console.log(`- 已清理测试职位 ${p.name}`);
  }

  // ---- 5. 测试部门规则（第四阶段）----
  const rules = await prisma.departmentRule.findMany({
    where: {
      OR: [
        { remark: { contains: "验收脚本" } },
        { department: { name: { contains: "阶段四测试部门" } } },
      ],
    },
  });
  for (const r of rules) {
    await prisma.departmentRule.delete({ where: { id: r.id } });
    console.log(`- 已清理测试部门规则 id=${r.id}`);
  }

  // ---- 6. 测试导入预览批次（第四阶段）----
  const previews = await prisma.importPreview.findMany({
    where: { fileName: { contains: "stage4" } },
  });
  for (const v of previews) {
    await prisma.importPreview.delete({ where: { id: v.id } });
    console.log(`- 已清理测试导入预览 ${v.id}`);
  }

  // ---- 7. 测试审计日志 ----
  const logs = await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { summary: { contains: "验收测试" } },
        { summary: { contains: "阶段二测试" } },
      ],
    },
  });
  console.log(`- 已清理测试审计日志 ${logs.count} 条`);

  console.log("");
  console.log(`员工总数 = ${await prisma.employee.count()}`);
  console.log(`门店总数 = ${await prisma.store.count()}`);
  console.log(`部门总数 = ${await prisma.department.count()}`);
  console.log(`职位总数 = ${await prisma.position.count()}`);
  console.log(`溯源映射 = ${await prisma.employeeSourceRow.count()}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
