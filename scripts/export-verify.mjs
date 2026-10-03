/**
 * 导出验收（Stage 9.40）：确认导出文件「0 公式 + 无『没找到』+ 有值」
 *
 * 用法：node scripts/export-verify.mjs "data/export/xxx.xlsx"
 */
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("用法：node scripts/export-verify.mjs <导出的 xlsx 路径>");
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

function isFormula(v) {
  if (!v || typeof v !== "object") return false;
  return v.formula !== undefined || v.sharedFormula !== undefined;
}
function txt(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return txt(v.result);
    return "";
  }
  return String(v).trim();
}

let fail = 0;
const bad = (m) => { console.log("  ❌ " + m); fail++; };

console.log("=== ① 公式残留检查（要求：0 个公式）===");
let totalF = 0;
for (const ws of wb.worksheets) {
  let n = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => { if (isFormula(cell.value)) n++; });
  });
  totalF += n;
  console.log(`  ${ws.name.padEnd(8, "　")} 公式 ${n}`);
}
if (totalF > 0) bad(`仍有 ${totalF} 个公式格`);

console.log("\n=== ② 「没找到」检查（XLOOKUP 匹配失败的痕迹）===");
let notFound = 0;
for (const ws of wb.worksheets) {
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (txt(cell.value) === "没找到") notFound++;
    });
  });
}
if (notFound > 0) bad(`还有 ${notFound} 格是「没找到」`);
else console.log("  ✓ 全表 0 处「没找到」");

console.log("\n=== ③ 各表数据抽样 ===");
const SAMPLE = {
  在职: { r0: 3, cols: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23] },
  离职: { r0: 3, cols: [1, 2, 3, 4, 5, 6, 8, 24, 25] },
  南昌3店: { r0: 3, cols: [1, 2, 3, 5, 6, 8] },
  运营部: { r0: 2, cols: [1, 2, 3, 5, 6, 14, 15] },
  运营部离职: { r0: 2, cols: [1, 2, 5, 17, 18] },
  数据库: { r0: 3, cols: [1, 2, 3, 4, 5, 6, 28, 36, 44, 45] },
  社保总名单: { r0: 2, cols: [1, 2, 3, 4, 5, 6] },
  招聘面试登记表: { r0: 4, cols: [1, 2, 3, 4, 5, 6, 8, 11] },
  薪资表: { r0: 2, cols: [1, 2, 3, 4, 5, 6, 7, 14, 15] },
  门店人员编制: { r0: 4, cols: [1, 2, 3, 4, 7, 8, 10, 13, 15, 18, 19] },
  人员流失率: { r0: 4, cols: [1, 2, 3, 4, 6, 7, 8, 9, 10] },
  门店人员分布明细: { r0: 3, cols: [1, 2, 3, 4, 9, 10] },
};
for (const [name, cfg] of Object.entries(SAMPLE)) {
  const ws = wb.getWorksheet(name);
  if (!ws) { bad(`${name} 不存在`); continue; }
  console.log(`\n--- ${name} ---`);
  for (let k = 0; k < 3; k++) {
    const r = cfg.r0 + k;
    const parts = cfg.cols.map((c) => `${c}:${txt(ws.getRow(r).getCell(c).value).slice(0, 14)}`);
    console.log(`  R${r} | ` + parts.join(" | "));
  }
}

console.log("\n=== ④ 关键统计数字（与软件页面一致性抽检）===");
const hc = wb.getWorksheet("门店人员编制");
const sumRow = 39;
console.log(`  编制表 R${sumRow}: ` + [3, 4, 5, 6, 7, 8, 9, 10].map((c) => txt(hc.getRow(sumRow).getCell(c).value)).join(" / "));
const dist = wb.getWorksheet("门店人员分布明细");
let distTotal = 0;
for (let r = 3; r <= 38; r++) distTotal += Number(txt(dist.getRow(r).getCell(3).value)) || 0;
console.log(`  分布明细 36 家门店人数合计 = ${distTotal}`);
const at = wb.getWorksheet("人员流失率");
console.log(`  流失率标题 = ${txt(at.getRow(1).getCell(1).value)}  月份 = ${txt(at.getRow(1).getCell(10).value)}`);
console.log(`  流失率 R4 = ` + [1, 2, 3, 6, 7, 8, 9, 10].map((c) => txt(at.getRow(4).getCell(c).value)).join(" | "));

console.log(fail === 0 ? "\n✅ 全部通过" : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);