import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("途虎HR人员登记.xlsx");

function txt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.formula !== undefined || o.sharedFormula !== undefined) return "[F]" + String(o.result ?? "");
    if (o.result !== undefined) return txt(o.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v).slice(0, 20);
  }
  return String(v).trim();
}

const HEADER_ROW = {
  在职: 2, 离职: 2, 南昌3店: 2, 运营部: 1, 运营部离职: 1,
  招聘面试登记表: 2, 薪资表: 1, 门店人员编制: 3, 人员流失率: 1,
  门店人员分布明细: 1, 社保总名单: 1, 数据库: 2,
};

for (const ws of wb.worksheets) {
  const hr = HEADER_ROW[ws.name] ?? 1;
  console.log("\n########## " + ws.name + " rows=" + ws.rowCount + " cols=" + ws.columnCount + " headerRow=" + hr);
  for (let r = 1; r <= Math.min(hr, 4); r++) {
    const parts = [];
    for (let c = 1; c <= ws.columnCount; c++) parts.push(c + ":" + txt(ws.getRow(r).getCell(c).value).slice(0, 16));
    console.log(" R" + r + " | " + parts.join(" | "));
  }
  // 合并
  const merges = ws.model.merges ?? [];
  if (merges.length) console.log(" merges(" + merges.length + "): " + merges.slice(0, 60).join(","));
}