import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("途虎HR人员登记.xlsx");

for (const ws of wb.worksheets) {
  let normal = 0, sharedMaster = 0, sharedClone = 0;
  const cols = new Map();
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (!v || typeof v !== "object") continue;
      const o = v;
      let kind = null;
      if (o.formula !== undefined && o.shareType === "shared") { kind = "M"; sharedMaster++; }
      else if (o.sharedFormula !== undefined) { kind = "C"; sharedClone++; }
      else if (o.formula !== undefined) { kind = "F"; normal++; }
      if (!kind) continue;
      const k = cols.get(c) ?? { F: 0, M: 0, C: 0, sample: "" };
      k[kind]++;
      if (!k.sample) k.sample = String(o.formula ?? "").slice(0, 80);
      cols.set(c, k);
    }
  }
  if (normal + sharedMaster + sharedClone === 0) {
    console.log("\n=== " + ws.name + " : 无公式");
    continue;
  }
  console.log("\n=== " + ws.name + " rows=" + ws.rowCount + " cols=" + ws.columnCount +
    " 普通=" + normal + " 共享母=" + sharedMaster + " 共享克隆=" + sharedClone);
  for (const [c, k] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    const h = ws.getRow(1).getCell(c).value;
    console.log("  列" + c + " 表头1=[" + String(h ?? "").slice(0, 14) + "] F" + k.F + "/M" + k.M + "/C" + k.C + "  例: " + k.sample);
  }
}