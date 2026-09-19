/** 清理验收测试产生的临时数据（测试员工 / 测试门店 / 测试职位） */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const emps = await prisma.employee.findMany({
    where: { name: { contains: "验收测试员工" } },
    select: { id: true, employeeId: true, name: true },
  });
  for (const e of emps) {
    await prisma.employeeSourceRow.deleteMany({ where: { employeeId: e.id } });
    await prisma.employee.delete({ where: { id: e.id } });
    console.log(`- 已清理测试员工 ${e.name} (${e.employeeId})`);
  }

  const stores = await prisma.store.findMany({
    where: { name: { contains: "验收测试门店" }, employees: { none: {} } },
  });
  for (const s of stores) {
    await prisma.store.delete({ where: { id: s.id } });
    console.log(`- 已清理测试门店 ${s.name}`);
  }

  const poss = await prisma.position.findMany({
    where: { name: { contains: "验收测试职位" }, employees: { none: {} } },
  });
  for (const p of poss) {
    await prisma.position.delete({ where: { id: p.id } });
    console.log(`- 已清理测试职位 ${p.name}`);
  }

  // 清理验收过程中产生的审计日志
  const logs = await prisma.auditLog.deleteMany({
    where: { summary: { contains: "验收测试" } },
  });
  console.log(`- 已清理测试审计日志 ${logs.count} 条`);

  console.log("");
  console.log(`员工总数 = ${await prisma.employee.count()}`);
  console.log(`门店总数 = ${await prisma.store.count()}`);
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
