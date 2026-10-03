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

const target = process.argv[2];
const from = Number(process.argv[3] ?? 1);
const to = Number(process.argv[4] ?? 6);
for (const ws of wb.worksheets) {
  if (ws.name !== target) continue;
  console.log("### " + ws.name + " rows=" + ws.rowCount + " cols=" + ws.columnCount);
  for (let r = from; r <= Math.min(to, ws.rowCount); r++) {
    const parts = [];
    for (let c = 1; c <= ws.columnCount; c++) parts.push(c + ":" + txt(ws.getRow(r).getCell(c).value).slice(0, 18));
    console.log(" R" + r + " | " + parts.join(" | "));
  }
}