#!/usr/bin/env node
/**
 * 页面列清单静态断言（只读，不连库、不写库）
 *
 * 针对 2026-11-27/28 的页面列错位 bug（RECRUIT_COLUMNS 多一列 salaryTerms、
 * SALARY_COLUMNS 少一列面试评估表、DATABASE_COLUMNS 44 项对模板 45 列）：
 * export-verify.mjs 只读导出文件，页面侧的列清单一旦又多/少一列，
 * 没有任何脚本能发现——这个检查补的就是这道口子。
 *
 * 用法：npx tsx scripts/check-sheet-columns.mjs（或 npm run check:columns）
 *   建议放进 pre-push 检查：列清单与 FIELD_SPECS 不一致就拒绝推送。
 *
 * 断言：
 *   ① 三张表的列数（减掉末尾系统「状态」列）：数据库 45、招聘 14、薪资 15；
 *   ② 数据库 45 列逐列与 FIELD_SPECS 的 col 对齐（含计算列的显式映射表）；
 *   ③ FIELD_SPECS 本身覆盖且仅覆盖 1..45 列（无缺口、无多余列）。
 */
const { SHEET_COLUMNS, COMPUTED } = await import("../lib/sheet-fields.ts");
const { FIELD_SPECS } = await import("../lib/excel-import/field-mapping.ts");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "❌"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) fail++;
};

/** 数据库页的计算列：第 N 列 → 应取的 COMPUTED 标记（其余列取 FIELD_SPECS 对应字段） */
const COMPUTED_BY_COL = {
  1: COMPUTED.SEQ,
  2: COMPUTED.STORE,
  4: COMPUTED.TENURE_ANY,
  8: COMPUTED.POSITION,
  27: COMPUTED.AGE,
  35: COMPUTED.RESIGNED_TENURE,
  43: COMPUTED.WORK_7DAYS,
  44: COMPUTED.WORK_2MONTHS,
};

console.log("=== ① 三张表列数（减掉末尾系统「状态」列）===");
const EXPECTED_COUNTS = { 数据库: 45, 招聘面试登记表: 14, 薪资表: 15 };
for (const [sheet, n] of Object.entries(EXPECTED_COUNTS)) {
  const cols = SHEET_COLUMNS[sheet];
  if (!cols) { check(`${sheet} 存在`, false); continue; }
  const last = cols[cols.length - 1];
  check(`${sheet} 末尾是系统「状态」列`, last.source === COMPUTED.STATUS, `末尾 source=${last.source}`);
  const dataCols = cols.slice(0, -1);
  check(`${sheet} 列数`, dataCols.length === n, `实际 ${dataCols.length}，期望 ${n}`);
}

console.log("\n=== ② 数据库 45 列逐列与 FIELD_SPECS 对齐 ===");
const fieldsByCol = new Map();
for (const s of FIELD_SPECS) {
  if (s.col <= 0) continue;
  if (!fieldsByCol.has(s.col)) fieldsByCol.set(s.col, new Set());
  fieldsByCol.get(s.col).add(s.field);
}
const dbCols = SHEET_COLUMNS["数据库"].slice(0, -1);
for (let i = 0; i < dbCols.length; i++) {
  const colNo = i + 1;
  const spec = dbCols[i];
  const expectedComputed = COMPUTED_BY_COL[colNo];
  if (expectedComputed !== undefined) {
    check(`数据库第 ${colNo} 列「${spec.label}」`, spec.source === expectedComputed, `source=${spec.source}，期望 ${expectedComputed}`);
  } else {
    const allowed = fieldsByCol.get(colNo);
    check(
      `数据库第 ${colNo} 列「${spec.label}」`,
      allowed !== undefined && allowed.has(spec.source),
      `source=${spec.source}，FIELD_SPECS 第 ${colNo} 列=${allowed ? [...allowed].join("/") : "（无此列）"}`
    );
  }
}

console.log("\n=== ③ FIELD_SPECS 列覆盖 ===");
const covered = [...fieldsByCol.keys()].sort((a, b) => a - b);
const expectedCols = Array.from({ length: 45 }, (_, i) => i + 1);
check(
  "FIELD_SPECS 覆盖且仅覆盖 1..45 列",
  covered.length === 45 && covered.every((c, i) => c === expectedCols[i]),
  `实际 ${covered.length} 列${covered.length ? `（${covered[0]}..${covered[covered.length - 1]}）` : ""}`
);

console.log(fail === 0 ? "\n✅ 列清单全部对齐" : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
