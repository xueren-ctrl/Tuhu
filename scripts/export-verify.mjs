/**
 * 导出验收（Stage 9.40，2026-11-28 加固）：确认导出文件「0 公式 + 无『没找到』+ 有值」
 *
 * 用法：node scripts/export-verify.mjs <导出的 xlsx 路径> [模板 xlsx 路径]
 *   模板缺省时依次找：$TEMPLATE_XLSX、/root/Tuhu/途虎HR人员登记.xlsx、./途虎HR人员登记.xlsx。
 *   找不到模板时跳过第 ⑤ 节（模板比对），其余检查照常。
 *
 * 第 ⑤ 节（2026-11-28 新增，针对 11 月 27 日招聘表错位 + 镜像丢值 bug）：
 *   对 12 张表逐列比较「导出非空数」与「模板非空数」——导出可以多于模板
 *   （档案回填），但不得少于「模板 - 已知未关联行数」。这是唯一能一次抓住
 *   「整列系统性变空 / 位移」的检查；旧版只抽 3 行、跳过招聘 7/12/13/14 列，
 *   所以错位 bug 能过校验。
 *
 * 注意（模板计数为什么不用 txt()，以及下限的由来）：
 *   模板里招聘/薪资的部分格子是 XLOOKUP 数组公式，ExcelJS 读缓存值时按
 *   <c> 的 t 属性走：缺 t="str" 的文本缓存值会被 parseFloat 成 NaN 再丢掉，
 *   txt() 读出来是空——这正是 import-sheets.mjs 丢值的同一机制（2026-11-28
 *   实测：模板招聘 G 列 openpyxl 读出 574，ExcelJS 只读出 5）。
 *   所以模板基线另设了下限（KNOWN_TEMPLATE_MIN，openpyxl data_only 实测
 *   11.17 源文件）：ExcelJS 读出的模板数低于下限时，基线改用下限。
 *   下限只在「模板内容指纹」吻合时生效——招聘 577 行、薪资 356 行、
 *   数据库 2020 行（序号列，纯值格，ExcelJS 读得准），三者都对上才说明
 *   这份模板就是 11.17 源文件（或内容相同的修复副本）；对不上就不用下限，
 *   基线以 ExcelJS 实测为准，并打印说明。下限只会抬高基线，不会放低。
 */
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("用法：node scripts/export-verify.mjs <导出的 xlsx 路径> [模板 xlsx 路径]");
  process.exit(1);
}

// ---- 模板定位：命令行参数 > 环境变量 > 服务器常规位置 > 当前目录 ----
const TEMPLATE_CANDIDATES = [
  process.argv[3],
  process.env.TEMPLATE_XLSX,
  "/root/Tuhu/途虎HR人员登记.xlsx",
  "./途虎HR人员登记.xlsx",
].filter(Boolean);
const templateFile = TEMPLATE_CANDIDATES.find((p) => existsSync(p));

// ---- 表结构（与 lib/excel-export-service.ts 的 LAYOUT 保持一致）----
// headerRows：表头所在行；招聘表表头跨 2、3 两行（合并单元格），先读 3 行、空了再读 2 行。
const SHEETS = {
  在职: { headerRows: [2], dataStart: 3 },
  离职: { headerRows: [2], dataStart: 3 },
  南昌3店: { headerRows: [2], dataStart: 3 },
  运营部: { headerRows: [1], dataStart: 2 },
  运营部离职: { headerRows: [1], dataStart: 2 },
  招聘面试登记表: { headerRows: [3, 2], dataStart: 4 },
  薪资表: { headerRows: [1], dataStart: 2 },
  数据库: { headerRows: [2], dataStart: 3 },
  社保总名单: { headerRows: [1], dataStart: 2 },
  门店人员编制: { headerRows: [3], dataStart: 4 },
  人员流失率: { headerRows: [3], dataStart: 4 },
  门店人员分布明细: { headerRows: [2], dataStart: 3 },
};

// 已知未关联行数（2026-11-27 link 预演：招聘 13 歧义 + 7 库中无此人 = 20；薪资 4 歧义）。
// 导出某列少于「模板 - 该数」即失败。可用环境变量覆盖。
const UNLINKED_ALLOWANCE = {
  招聘面试登记表: Number(process.env.KNOWN_UNLINKED_RECRUIT ?? 20),
  薪资表: Number(process.env.KNOWN_UNLINKED_SALARY ?? 4),
};

// 已核对的模板关键列非空数下限（openpyxl data_only 实测 11.17 源文件，2026-11-28）。
// 仅当模板内容指纹吻合时生效（见下文 TEMPLATE_FINGERPRINT）。
const KNOWN_TEMPLATE_MIN = {
  招聘面试登记表: { 7: 574, 12: 548, 13: 542, 14: 577 },
  薪资表: { 10: 263, 11: 265 },
};
// 模板内容指纹：三张表序号列（纯值格）的非空数，11.17 源文件实测值。
const TEMPLATE_FINGERPRINT = {
  招聘面试登记表: { col: 1, count: 577 },
  薪资表: { col: 1, count: 356 },
  数据库: { col: 1, count: 2020 },
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

function isFormula(v) {
  if (!v || typeof v !== "object") return false;
  return v.formula !== undefined || v.sharedFormula !== undefined;
}
function txt(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return txt(v.result);
    return "";
  }
  return String(v).trim();
}
/**
 * 模板计数专用：txt() 读不到的 XLOOKUP 缓存值，在 ExcelJS 里常以
 * Invalid Date 的形式残留（文本缓存值被 parseFloat 成 NaN 后又按日期
 * 格式转了一道）——值读不出来，但格子确实有值，计数时要算进去。
 * （导出文件是纯值、无公式，不会产生 Invalid Date，两边用同一口径无妨。）
 */
function cellHasValue(v) {
  if (v === null || v === undefined) return false;
  if (v instanceof Date) return true; // 含 Invalid Date：ExcelJS 误读的缓存值
  return txt(v) !== "";
}
/** 合计行不参与逐列计数（模板与导出各有一行，口径不同会误报 ±1） */
function isSummaryRow(row) {
  return txt(row.getCell(1).value).includes("合计") || txt(row.getCell(2).value).includes("合计");
}
function lastDataRow(ws) {
  for (let r = ws.rowCount; r >= 1; r--) {
    const row = ws.getRow(r);
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell) => { if (txt(cell.value) !== "") any = true; });
    if (any) return r;
  }
  return 0;
}
function effectiveHeader(ws, headerRows, col) {
  for (const hr of headerRows) {
    const t = txt(ws.getRow(hr).getCell(col).value);
    if (t !== "") return t;
  }
  return "";
}
function headerCount(ws, headerRows) {
  let n = 0;
  for (let c = 1; c <= ws.columnCount; c++) if (effectiveHeader(ws, headerRows, c) !== "") n++;
  return n;
}
function colCounts(ws, dataStart) {
  const counts = {};
  const last = lastDataRow(ws);
  for (let r = dataStart; r <= last; r++) {
    const row = ws.getRow(r);
    if (isSummaryRow(row)) continue;
    for (let c = 1; c <= ws.columnCount; c++) {
      if (cellHasValue(row.getCell(c).value)) counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  return counts;
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

console.log("\n=== ③ 各表数据抽样（每列一个非空值 + 首末行，全列覆盖）===");
for (const [name, cfg] of Object.entries(SHEETS)) {
  const ws = wb.getWorksheet(name);
  if (!ws) { bad(`${name} 不存在`); continue; }
  const last = lastDataRow(ws);
  const showRow = (r) => {
    const parts = [];
    for (let c = 1; c <= ws.columnCount; c++) parts.push(`${c}:${txt(ws.getRow(r).getCell(c).value).slice(0, 14)}`);
    return parts.join(" | ");
  };
  console.log(`\n--- ${name}（数据行 ${cfg.dataStart}..${last}）---`);
  console.log(`  首行 R${cfg.dataStart} | ` + showRow(cfg.dataStart));
  if (last > cfg.dataStart) console.log(`  末行 R${last} | ` + showRow(last));
  // 每列第一个非空值：任何一列整列变空都会在这里露出来
  const firstVals = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    let v = "";
    for (let r = cfg.dataStart; r <= last; r++) {
      const t = txt(ws.getRow(r).getCell(c).value);
      if (t !== "") { v = t; break; }
    }
    firstVals.push(`${c}:${v === "" ? "(空)" : v.slice(0, 14)}`);
  }
  console.log(`  每列首值 | ` + firstVals.join(" | "));
}

console.log("\n=== ④ 关键统计数字（与软件页面一致性抽检，行号运行时探测）===");
const hc = wb.getWorksheet("门店人员编制");
if (hc) {
  let sumRow = 0;
  for (let r = 1; r <= hc.rowCount; r++) {
    if (txt(hc.getRow(r).getCell(1).value).includes("合计")) { sumRow = r; break; }
  }
  if (sumRow) console.log(`  编制表合计行 R${sumRow}: ` + [3, 4, 5, 6, 7, 8, 9, 10].map((c) => txt(hc.getRow(sumRow).getCell(c).value)).join(" / "));
  else console.log("  编制表：未找到合计行");
}
const dist = wb.getWorksheet("门店人员分布明细");
if (dist) {
  let distTotal = 0;
  let storeRows = 0;
  const cfg = SHEETS["门店人员分布明细"];
  for (let r = cfg.dataStart; r <= lastDataRow(dist); r++) {
    const row = dist.getRow(r);
    if (isSummaryRow(row)) continue;
    if (txt(row.getCell(2).value) === "") continue;
    storeRows++;
    distTotal += Number(txt(row.getCell(3).value)) || 0;
  }
  console.log(`  分布明细 ${storeRows} 家门店人数合计 = ${distTotal}`);
}
const at = wb.getWorksheet("人员流失率");
if (at) {
  console.log(`  流失率标题 = ${txt(at.getRow(1).getCell(1).value)}  月份 = ${txt(at.getRow(1).getCell(10).value)}`);
  console.log(`  流失率 R4 = ` + [1, 2, 3, 6, 7, 8, 9, 10].map((c) => txt(at.getRow(4).getCell(c).value)).join(" | "));
}

console.log("\n=== ⑤ 逐列非空数 vs 模板（导出可多于模板，不得少于模板 - 已知未关联）===");
if (!templateFile) {
  console.log("  ⚠️ 未找到模板文件（可传第 2 个参数或设 $TEMPLATE_XLSX），本节跳过");
} else {
  const twb = new ExcelJS.Workbook();
  await twb.xlsx.readFile(templateFile);
  console.log(`  模板：${templateFile}`);
  // 先算出全部模板逐列数（后面比对直接复用），再核对内容指纹
  const tplCounts = {};
  for (const [name, cfg] of Object.entries(SHEETS)) {
    const tws = twb.getWorksheet(name);
    if (tws) tplCounts[name] = colCounts(tws, cfg.dataStart);
  }
  const fpHit = Object.entries(TEMPLATE_FINGERPRINT).every(([name, fp]) => tplCounts[name]?.[fp.col] === fp.count);
  const floorsApply = fpHit;
  if (floorsApply) console.log("  （模板内容指纹吻合 11.17 源文件，关键列下限生效）");
  else console.log("  （模板内容指纹与 11.17 源文件不符，已核对的关键列下限不适用，基线以 ExcelJS 实测为准）");
  for (const [name, cfg] of Object.entries(SHEETS)) {
    const ews = wb.getWorksheet(name);
    const tws = twb.getWorksheet(name);
    if (!ews) { bad(`${name} 在导出中不存在`); continue; }
    if (!tws) { console.log(`  ${name}：模板中没有此表，跳过`); continue; }
    // 表头逐列比对 + 列数断言
    const eCols = headerCount(ews, cfg.headerRows);
    const tCols = headerCount(tws, cfg.headerRows);
    if (eCols !== tCols) {
      bad(`${name} 列数不一致：导出 ${eCols} 列，模板 ${tCols} 列`);
    } else {
      let headerDiff = "";
      for (let c = 1; c <= tCols; c++) {
        const e = effectiveHeader(ews, cfg.headerRows, c);
        const t = effectiveHeader(tws, cfg.headerRows, c);
        if (e !== t) { headerDiff += ` 第${c}列导出「${e}」≠模板「${t}」；`; }
      }
      if (headerDiff) bad(`${name} 表头不一致：${headerDiff}`);
      else console.log(`  ${name}：表头 ${tCols} 列一致 ✓`);
    }
    // 逐列非空数比对（模板数已在节首预先算好）
    const eCounts = colCounts(ews, cfg.dataStart);
    const tCounts = tplCounts[name] ?? {};
    const allowance = UNLINKED_ALLOWANCE[name] ?? 0;
    const floors = floorsApply ? (KNOWN_TEMPLATE_MIN[name] ?? {}) : {};
    const maxCol = Math.max(...Object.keys(tCounts).map(Number), ...Object.keys(eCounts).map(Number), 0);
    for (let c = 1; c <= maxCol; c++) {
      let t = tCounts[c] ?? 0;
      if (floors[c] !== undefined && t < floors[c]) {
        console.log(`    ${name} 第${c}列：ExcelJS 只读出模板 ${t} 个，低于已核对下限 ${floors[c]}，基线改用下限`);
        t = floors[c];
      }
      const e = eCounts[c] ?? 0;
      const min = t - allowance;
      const mark = e < min ? "❌" : (e < t ? "△" : "✓");
      if (e < min) bad(`${name} 第${c}列「${effectiveHeader(tws, cfg.headerRows, c)}」导出 ${e} < 模板 ${t} - 已知未关联 ${allowance}（下限 ${min}）`);
      else console.log(`    ${mark} ${name} 第${c}列「${effectiveHeader(tws, cfg.headerRows, c)}」：导出 ${e} / 模板 ${t}`);
    }
  }
}

console.log(fail === 0 ? "\n✅ 全部通过" : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
