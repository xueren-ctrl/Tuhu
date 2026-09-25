// Stage 7.3.10：把 Excel 各 Sheet 原样镜像入库（SheetRow）
// 规则：值与用户在 Excel 里看到的完全一致 —— 公式取缓存结果，日期格式化为 YYYY-MM-DD。
import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const XLSX = "C:/Users/Administrator/Desktop/人事z资料9.19.xlsx";
const SHA = crypto.createHash("sha256").update(readFileSync(XLSX)).digest("hex");

/** 取单元格显示值：公式取缓存结果；日期取 YYYY-MM-DD；其它转字符串 */
function txt(cell) {
  const v = cell.value;
  if (v == null) return "";
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : "";
  if (typeof v === "object") {
    if ("error" in v) return "";
    if ("result" in v && v.result != null) {
      const r = v.result;
      if (r instanceof Date) return Number.isFinite(r.getTime()) ? r.toISOString().slice(0, 10) : "";
      if (typeof r === "object" && r !== null && "error" in r) return "";
      return String(r).trim();
    }
    if ("text" in v) return String(v.text).trim();
    if ("richText" in v) return v.richText.map((x) => x.text).join("").trim();
    if ("hyperlink" in v) return String(v.text ?? v.hyperlink ?? "").trim();
    return "";
  }
  return String(v).trim();
}

// 各 Sheet 的表头行与数据起始行（实测）
const SPEC = {
  在职: { headerRow: 2, dataStart: 3 },
  离职: { headerRow: 2, dataStart: 3 },
  南昌3店: { headerRow: 2, dataStart: 3 },
  运营部: { headerRow: 1, dataStart: 2 },
  招聘面试登记表: { headerRow: 3, dataStart: 4 },  // R2 是分组名，R3 才是真表头
  运营部离职: { headerRow: 1, dataStart: 2 },
  薪资表: { headerRow: 1, dataStart: 2 },
  数据库: { headerRow: 2, dataStart: 3 },
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX);

const prisma = new PrismaClient();
console.log("Excel SHA256:", SHA.slice(0, 24) + "...");
console.log("");

let grandTotal = 0;
for (const [sheetName, spec] of Object.entries(SPEC)) {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) { console.log(`❌ 缺少 Sheet「${sheetName}」`); continue; }

  // 1) 找最大有效列：扫描表头行与所有数据行
  let maxCol = 1;
  for (let r = spec.headerRow; r <= ws.rowCount; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      if (txt(cell) !== "") maxCol = Math.max(maxCol, cell.col);
    });
  }

  // 2) 表头
  const headers = [];
  for (let c = 1; c <= maxCol; c++) headers.push(txt(ws.getRow(spec.headerRow).getCell(c)));

  // 3) 数据行：整行为空则跳过
  const rows = [];
  for (let r = spec.dataStart; r <= ws.rowCount; r++) {
    const cells = [];
    let hasValue = false;
    for (let c = 1; c <= maxCol; c++) {
      const v = txt(ws.getRow(r).getCell(c));
      if (v !== "") hasValue = true;
      cells.push(v);
    }
    if (!hasValue) continue;
    rows.push({ rowNo: r, cells });
  }

  // 4) 覆盖式写入（幂等：先删本 sheet 旧数据）
  await prisma.$transaction(async (tx) => {
    await tx.sheetRow.deleteMany({ where: { sheet: sheetName } });
    // createMany 分批，避免参数过多
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.sheetRow.createMany({
        data: rows.slice(i, i + BATCH).map((r) => ({
          sheet: sheetName,
          rowNo: r.rowNo,
          cellsJson: JSON.stringify(r.cells),
          headersJson: JSON.stringify(headers),
          sourceSha: SHA,
        })),
      });
    }
  });

  grandTotal += rows.length;
  console.log(`✅ ${sheetName.padEnd(8)} ${String(rows.length).padStart(4)} 行 × ${String(maxCol).padStart(2)} 列`);
}

console.log(`\n合计导入 ${grandTotal} 行`);
console.log("SheetRow 总数:", await prisma.sheetRow.count());
await prisma.$disconnect();
