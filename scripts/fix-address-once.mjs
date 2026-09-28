/**
 * 一次性补正：王思晗 THHR2026001397 的家庭地址补进「现居住地址」
 * （Stage 9.35 遗留：合并脚本执行时该字段已有原值「6214 8333 8525 6006」，
 *  按"不丢数据"原则改为追加，而不是覆盖）
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const ADDRESS = "广东省东莞市黄江镇田心村南门一街48号";

async function main() {
  const e = await prisma.employee.findFirst({
    where: { employeeId: "THHR2026001397" },
    select: { id: true, employeeId: true, name: true, salaryTerms: true, currentAddress: true },
  });
  if (!e) {
    console.log("找不到该员工");
    await prisma.$disconnect();
    return;
  }
  console.log(`\n${APPLY ? "🔴 执行" : "🟡 预览"}`);
  console.log(`  ${e.employeeId} ${e.name}`);
  console.log(`  现居住地址（当前）：「${e.currentAddress ?? "-"}」`);
  console.log(`  目标：追加家庭地址「${ADDRESS}」`);

  if (String(e.currentAddress ?? "").includes("南门一街")) {
    console.log("  ✓ 已含该地址，无需处理");
  } else if (APPLY) {
    const next = e.currentAddress?.trim() ? `${e.currentAddress.trim()}；${ADDRESS}` : ADDRESS;
    await prisma.employee.update({ where: { id: e.id }, data: { currentAddress: next } });
    console.log(`  ✅ 已写入：「${next}」`);
  } else {
    console.log(`  ⏭ 待执行：现居住地址将变成「${e.currentAddress?.trim() ? e.currentAddress.trim() + "；" : ""}${ADDRESS}」`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
