/**
 * Stage 9.33 —— 招聘/面试字段的取值归一 + 「面试评估表」重复列合并
 *
 * ⚠️ 本脚本是**纯 JS（.mjs）**，不要写 TS 语法（`as never` / 类型标注会 SyntaxError）。
 *
 * 背景（用户 2026-09-28 要求，全部先只读查证）：
 *   1. 面试地点 interviewLocation → 改用门店搜索下拉
 *   2. 面试结果 interviewResult  → 只允许「通过 / 不通过 / 空」
 *   3. 简历表 docResume、面试评估表 docInterviewEvaluation、入职表 docOnboardingForm
 *      → 只允许「是 / 否 / 空」
 *   4. 招聘面试登记表的「面试评估表」与薪资表的「面试评估表」**合并成一个**
 *
 * 执行前的存量分布（2026-09-28 实测）：
 *   interviewResult          通过 434 / 未通过 1 / 空 1482
 *   docResume                √ 433 / 0 11 / 空 1473
 *   docInterviewEvaluation   √ 425 / 0 16 / 空 1476
 *   docInterviewEvaluation2  √ 257（薪资表重复列）
 *   docOnboardingForm        √ 201
 *   interviewHired           是 287 / 否 28（已规范，不动）
 *   interviewLocation        459 人有值，457 精确匹配门店名，2 人是简称「沙湖大道店」
 *
 * 归一规则（保守、可回退）：
 *   √ / 是 / Y / true / 1 → 是；0 / × / 否 / N / false → 否；
 *   「未通过」→ 不通过；**其他取值一律原样保留**（不做猜测性改写）。
 *
 * 合并规则：
 *   以 `docInterviewEvaluation`（招聘面试登记表 + 在职表在用）为主；
 *   主列为空而 `docInterviewEvaluation2`（薪资表重复列）有值时用后者补上。
 *   **不删除** docInterviewEvaluation2 字段本身（Excel 镜像的一部分），
 *   只在界面上不再作为独立列/独立编辑项出现。
 *
 * 用法：node scripts/normalize-interview-fields.mjs [--apply]   （默认只预览）
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const TO_YES = new Set(["√", "是", "Y", "y", "true", "TRUE", "1"]);
const TO_NO = new Set(["0", "×", "x", "否", "N", "n", "false", "FALSE"]);

function normalize(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (TO_YES.has(s)) return "是";
  if (TO_NO.has(s)) return "否";
  if (s === "通过") return "通过";
  if (s === "不通过" || s === "未通过") return "不通过";
  return s; // 原样保留
}

const FIELDS = ["interviewResult", "docResume", "docInterviewEvaluation", "docOnboardingForm"];

async function dist(field) {
  return prisma.employee.groupBy({
    by: [field],
    where: { deletedAt: null },
    _count: { _all: true },
  });
}

async function main() {
  console.log(`\n${APPLY ? "🔴 执行模式" : "🟡 预览模式（加 --apply 才写库）"}\n`);

  // ---------- ① 取值归一 ----------
  console.log("========== ① 归一 √/0/未通过 → 是/否/不通过 ==========");
  const skipped = [];
  for (const field of FIELDS) {
    const rows = await dist(field);
    const line = [];
    for (const r of rows) {
      const from = r[field];
      const to = normalize(from);
      if (from === to) continue;
      if (from && TO_YES.has(String(from).trim())) line.push(`√→是 ${r._count._all}`);
      else if (from && TO_NO.has(String(from).trim())) line.push(`0→否 ${r._count._all}`);
      else if (from === "未通过") line.push(`未通过→不通过 ${r._count._all}`);
      else skipped.push({ field, value: String(from), count: r._count._all });
    }
    console.log(`  ${field}：${line.join("，") || "无需改动"}`);
    if (APPLY) {
      for (const r of rows) {
        const from = r[field];
        const to = normalize(from);
        if (from === to) continue;
        await prisma.employee.updateMany({ where: { [field]: from }, data: { [field]: to } });
      }
    }
  }
  if (skipped.length) {
    console.log("  ⚠️ 以下取值不识别，原样保留：");
    for (const s of skipped) console.log(`     ${s.field}：「${s.value}」× ${s.count}`);
  }

  // ---------- ② 面试评估表合并 ----------
  console.log("\n========== ② 面试评估表合并（重复列 → 主列） ==========");
  const toMerge = await prisma.employee.findMany({
    where: {
      deletedAt: null,
      docInterviewEvaluation2: { not: null },
      OR: [{ docInterviewEvaluation: null }, { docInterviewEvaluation: "" }],
    },
    select: { id: true, employeeId: true, name: true, docInterviewEvaluation2: true },
  });
  const bothFilled = await prisma.employee.count({
    where: { deletedAt: null, docInterviewEvaluation2: { not: null }, docInterviewEvaluation: { not: null } },
  });
  console.log(
    `  重复列有值 ${toMerge.length + bothFilled} 人；主列为空需合并 ${toMerge.length} 人；两列都有值 ${bothFilled} 人（不覆盖）`
  );
  for (const e of toMerge.slice(0, 5)) {
    console.log(`    ${e.employeeId} ${e.name}：主列空 ← 重复列「${e.docInterviewEvaluation2}」`);
  }
  if (toMerge.length > 5) console.log(`    … 另有 ${toMerge.length - 5} 人`);

  if (APPLY && toMerge.length) {
    let n = 0;
    for (const e of toMerge) {
      const v = normalize(e.docInterviewEvaluation2);
      if (!v) continue;
      await prisma.employee.update({ where: { id: e.id }, data: { docInterviewEvaluation: v } });
      n++;
    }
    console.log(`  ✅ 已合并 ${n} 人到主列 docInterviewEvaluation`);
  } else if (toMerge.length) {
    console.log(`  ⏭ 待执行：合并 ${toMerge.length} 人`);
  }

  // ---------- 复核 ----------
  console.log("\n========== 复核 ==========");
  for (const field of [...FIELDS, "docInterviewEvaluation2"]) {
    const rows = await dist(field);
    const top = rows
      .filter((r) => r[field] !== null && String(r[field]).trim() !== "")
      .slice(0, 6)
      .map((r) => `${r[field]}×${r._count._all}`);
    const empty = rows.find((r) => r[field] === null || String(r[field]).trim() === "")?._count._all ?? 0;
    console.log(`  ${field}：${top.join("，")} / 空 ${empty}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
