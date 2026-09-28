/**
 * Stage 9.35 —— 薪资表「第一列备注」并入「薪资待遇」
 *
 * 用户 2026-09-28 明确：
 *   「薪资表里有 2 列备注，**第一列备注就是"薪资待遇"**，可与『⑤ 银行卡与薪资』中的薪资待遇合并」
 *
 * 只处理**第一列**（`remark`）。第二列（`remark3`，内容是「已劝退」「重新入职的」共 6 人）
 * 用户决定**暂时不管**，本脚本不碰、界面也不显示。
 *
 * 合并规则（用户逐条确认过）：
 *   ① 只有备注、薪资待遇为空（12 人，均为离职员工）→ 直接把备注搬进薪资待遇
 *   ② 两边都有且**完全相同**（254 人）→ 不动
 *   ③ 两边都有但**写法不同**（59 人）→ **两段都保留**：
 *        薪资待遇 = 原值 + 「（原备注：xxx）」
 *   ④ 异常：王思晗 THHR2026001397 的 salaryTerms 里存的是**家庭地址**
 *      「广东省东莞市黄江镇田心村南门一街48号」，真薪资在备注里。
 *      用户指示「把家庭地址更正到正确的列去」→ 地址搬到 `currentAddress`（现居住地址，Excel X 列），
 *      salaryTerms 换成备注里的真薪资。
 *
 * 默认只预览，`--apply` 才写库。写前打印明细，写后复核。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

/** 地址类特征：出现路/街/号/村/镇/栋/室 且不含薪资特征 */
const ADDRESS_RE = /(省|市|区|镇|村|路|街|号|栋|幢|室|楼|巷)/;
const SALARY_RE = /(薪资|底薪|保底|保障|提成|工资|元|月薪|薪)/;
const ADDRESS_EMPLOYEE = "THHR2026001397"; // 王思晗

async function main() {
  console.log(`\n${APPLY ? "🔴 执行模式" : "🟡 预览模式（加 --apply 才写库）"}\n`);

  const rows = await prisma.employee.findMany({
    where: { deletedAt: null, remark: { not: null } },
    select: {
      id: true,
      employeeId: true,
      name: true,
      salaryTerms: true,
      remark: true,
      currentAddress: true,
    },
  });

  const fill = []; // ① 补空
  const dup = []; // ② 相同（不动）
  const both = []; // ③ 两段保留
  const addr = []; // ④ 地址更正

  for (const e of rows) {
    const s = (e.salaryTerms ?? "").trim();
    const r = (e.remark ?? "").trim();
    if (!r) continue;
    if (!s) {
      fill.push(e);
      continue;
    }
    if (s === r) {
      dup.push(e);
      continue;
    }
    // 薪资待遇里塞的是地址 → 走「更正」分支
    if (e.employeeId === ADDRESS_EMPLOYEE || (ADDRESS_RE.test(s) && !SALARY_RE.test(s))) {
      addr.push(e);
      continue;
    }
    both.push(e);
  }

  console.log("========== 分类结果 ==========");
  console.log(`  ① 薪资待遇为空 → 用备注补上：${fill.length} 人`);
  console.log(`  ② 两边完全相同 → 不动：${dup.length} 人`);
  console.log(`  ③ 两边写法不同 → 两段都保留：${both.length} 人`);
  console.log(`  ④ 薪资待遇里是地址 → 搬到现居住地址：${addr.length} 人`);

  console.log(`\n  ① 样例：`);
  for (const e of fill.slice(0, 3)) {
    console.log(`    ${e.employeeId} ${e.name}：备注=「${e.remark}」`);
  }
  console.log(`\n  ③ 样例（合并后长这样）：`);
  for (const e of both.slice(0, 3)) {
    console.log(`    ${e.employeeId} ${e.name}：原「${e.salaryTerms}」→「${e.salaryTerms}（原备注：${e.remark}）」`);
  }
  console.log(`\n  ④ 样例：`);
  for (const e of addr) {
    console.log(`    ${e.employeeId} ${e.name}：地址「${e.salaryTerms}」→ 现居住地址；薪资待遇 ← 备注「${e.remark}」`);
  }

  if (APPLY) {
    for (const e of fill) {
      await prisma.employee.update({ where: { id: e.id }, data: { salaryTerms: e.remark } });
    }
    for (const e of both) {
      const merged = `${(e.salaryTerms ?? "").trim()}（原备注：${(e.remark ?? "").trim()}）`;
      await prisma.employee.update({ where: { id: e.id }, data: { salaryTerms: merged } });
    }
    for (const e of addr) {
      // ⚠️ 该员工的「现居住地址」原本就有个值（"6214 8333 8525 6006"，属那批非地址数据），
      //    按「不丢数据」原则**追加**而不是覆盖；若原本为空则直接写入。
      const prev = (e.currentAddress ?? "").trim();
      await prisma.employee.update({
        where: { id: e.id },
        data: {
          currentAddress: prev ? `${prev}；${(e.salaryTerms ?? "").trim()}` : (e.salaryTerms ?? "").trim(),
          salaryTerms: (e.remark ?? "").trim(),
        },
      });
    }
    console.log(`\n  ✅ 已写入：补空 ${fill.length} / 两段保留 ${both.length} / 地址更正 ${addr.length}`);
  } else {
    console.log(`\n  ⏭ 待执行（加 --apply 写入）`);
  }

  console.log(`\n========== 复核 ==========`);
  const after = await prisma.employee.groupBy({
    by: ["salaryTerms"],
    where: { deletedAt: null, salaryTerms: { not: null } },
    _count: { _all: true },
  });
  const withParen = after.filter((r) => r.salaryTerms.includes("（原备注："));
  console.log(`  薪资待遇非空合计 = ${after.reduce((s, r) => s + r._count._all, 0)} 人（含两段保留 ${withParen.reduce((s, r) => s + r._count._all, 0)} 人）`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
