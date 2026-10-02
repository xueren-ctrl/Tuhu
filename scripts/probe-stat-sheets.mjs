/** 探查 Excel 里「人员流失率」「门店人员分布明细」两张表的列结构与表头 */
import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("途虎HR人员登记.xlsx");

function txt(row, c) {
  let v = row.getCell(c).value;
  if (v && typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.formula !== undefined || v.sharedFormula !== undefined) return "[公式]";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "[obj]";
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v === null || v === undefined ? "" : String(v).trim();
}

for (const name of ["人员流失率", "门店人员分布明细", "招聘面试登记表", "薪资表"]) {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    console.log(`\n### ${name}：不存在`);
    continue;
  }
  console.log(`\n========== ${name}（${ws.rowCount} 行 × ${ws.columnCount} 列）==========`);
  // 找字段名行（前 4 行里非空最多且不含"公式"最多的那行）
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
    const cells = [];
    let formulas = 0;
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (v && typeof v === "object" && (v.formula !== undefined || v.sharedFormula !== undefined)) formulas++;
      cells.push(txt(ws.getRow(r), c));
    }
    console.log(`R${r}（公式${formulas}格）: ${cells.map((x, i) => `${i + 1}.${x.slice(0, 12)}`).join(" | ")}`);
  }
  // 合并单元格
  const merges = ws.model?.merges ?? [];
  console.log(`合并单元格 ${merges.length} 个: ${merges.slice(0, 8).join(", ")}`);
}