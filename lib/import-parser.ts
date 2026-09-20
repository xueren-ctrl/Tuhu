/**
 * Excel 重新导入 —— 解析与 Diff（第四阶段）
 *
 * 与 scripts/import-excel.ts 的关系：
 *   两者共用同一套列定义（COL）与同一张「数据库」Sheet 的表头约定（表头在第 2 行），
 *   但本模块**只解析并比对，不写库** —— 写入必须等人工确认（见 import-preview-service）。
 *
 * 为什么表头要校验：Excel 被人拖动过列顺序是常态，一旦错位就会把身份证号写进银行卡列。
 * 因此预览阶段先校验 6 个关键列的表头文字，不一致就直接拒绝，不生成任何 Diff。
 */
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { EMPLOYEE_FIELDS } from "./constants";
import { maskByField } from "./mask";

export const DB_SHEET = "数据库";
export const HEADER_ROW = 2; // 第 1 行是上一版残留，第 2 行才是表头
export const FIRST_DATA_ROW = 3;

/** 与 scripts/import-excel.ts 保持一致的列定义 */
export const COL = {
  seqNo: 1,
  storeName: 2,
  hireDate: 3,
  tenureText: 4,
  name: 5,
  idCardNo: 6,
  phone: 7,
  jobGrade: 8,
  positionNote: 9,
  dormitory: 10,
  socialInsurancePurchased: 11,
  emergencyContact1: 12,
  emergencyPhone1: 13,
  emergencyContact2: 14,
  emergencyPhone2: 15,
  laborContract: 16,
  socialInsuranceAgreement: 17,
  fireSafetyCommitment: 18,
  dormitoryWaiver: 19,
  onboardingMedical: 20,
  bankBranch: 21,
  bankAccountNo: 22,
  salaryTerms: 23,
  currentAddress: 24,
  recruiterName: 25,
  resignReason: 26,
  resignDateRaw: 27,
  ageRaw: 28,
} as const;

const EXPECTED_HEADER: Array<[number, string]> = [
  [COL.storeName, "门店名称"],
  [COL.hireDate, "入职时间"],
  [COL.name, "姓名"],
  [COL.idCardNo, "身份证号"],
  [COL.phone, "联系电话"],
  [COL.jobGrade, "工种级别"],
];

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim() || null;
    if ("result" in o) {
      const r = o.result;
      if (r === null || r === undefined) return null;
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      return String(r).trim() || null;
    }
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 日期类单元格统一成 YYYY-MM-DD */
function cellDate(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Excel 有时把日期存成数字序列（1900 日期系统），直接取文本会得到 "45879" 这种值
  if (typeof v === "number" && v > 10000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const t = cellText(v);
  if (!t) return null;
  const m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) {
    const mm = m[2].padStart(2, "0");
    const dd = m[3].padStart(2, "0");
    return `${m[1]}-${mm}-${dd}`;
  }
  return t.slice(0, 10);
}

/**
 * 读取名册（「在职」/「离职」Sheet）里的「姓名|入职日期」集合。
 *
 * 为什么要读：导入脚本判定在职/离职时**不只看当前行的离职日期**，
 * 还会交叉比对「离职」名册（见 scripts/import-excel.ts 的 inResignedRoster）。
 * 预览若少了这一步，就会把「在离职名册里、但本行没写离职日期」的人判成在职 ——
 * 确认写入后会把大批离职员工错误改回在职。
 */
/**
 * 合并单元格安全读取。
 *
 * ExcelJS 会把「合并主格」的值回传给整个合并区域内的**每一格**，
 * 于是「南昌3店」「运营部」这类分节标题行（整行合并）会被读成
 * 姓名=门店=身份证=入职日期=「南昌3店」的假员工。
 *
 * 判据与 scripts/import-excel.ts 一致：非主格的合并单元格一律视为空。
 */
function cellMergedAware(ws: ExcelJS.Worksheet, row: number, col: number): ExcelJS.CellValue {
  const c = ws.getCell(row, col);
  try {
    const m = c.master as unknown as { address?: string } | undefined;
    if (c.isMerged && m?.address && m.address !== c.address) return null;
  } catch {
    /* 某些版本没有 master，按普通单元格处理 */
  }
  return c.value;
}

function loadRosterKeys(ws: ExcelJS.Worksheet | undefined): Set<string> {
  const set = new Set<string>();
  if (!ws) return set;
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const name = cellText(cellMergedAware(ws, r, COL.name));
    if (!name || name.startsWith("=")) continue;
    const hire = cellDate(cellMergedAware(ws, r, COL.hireDate));
    set.add(`${name}|${hire ?? ""}`);
  }
  return set;
}

/** 与导入脚本同一口径：文本是否表示「已离职」 */
function textMeansResigned(raw: string | null): { yes: boolean; rehire: boolean } {
  if (!raw) return { yes: false, rehire: false };
  const rehire = /重新入职|又入职|回归|再入职/.test(raw);
  if (rehire) return { yes: false, rehire: true };
  if (/离职|辞职|自离|已离|被辞|劝退|开除/.test(raw)) return { yes: true, rehire: false };
  return { yes: false, rehire: false };
}

export interface ParsedRow {
  rowNo: number;
  name: string | null;
  storeName: string | null;
  hireDate: string | null;
  idCardNo: string | null;
  phone: string | null;
  jobGrade: string | null;
  resignDate: string | null;
  resignReason: string | null;
  remark: string | null;
  bankAccountNo: string | null;
  currentAddress: string | null;
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  sheetName: string;
  totalRows: number;
  validRows: number;
  skippedRows: number;
  rows: ParsedRow[];
  /** 「在职」名册的「姓名|入职日期」集合 */
  rosterActive: Set<string>;
  /** 「离职」名册的「姓名|入职日期」集合（判定离职的关键信号之一） */
  rosterResigned: Set<string>;
}

/** 解析「数据库」Sheet（只读，不写库） */
export async function parseDatabaseSheet(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(DB_SHEET);
  if (!ws) {
    return {
      ok: false,
      error: `未找到「${DB_SHEET}」Sheet。现有：${wb.worksheets.map((w) => w.name).join("、")}`,
      sheetName: DB_SHEET,
      totalRows: 0,
      validRows: 0,
      skippedRows: 0,
      rows: [],
      rosterActive: new Set(),
      rosterResigned: new Set(),
    };
  }

  // 表头校验
  for (const [c, label] of EXPECTED_HEADER) {
    const actual = cellText(ws.getCell(HEADER_ROW, c).value);
    if (actual !== label) {
      return {
        ok: false,
        error: `表头校验失败：第 ${c} 列应为「${label}」，实际为「${actual ?? "空"}」。Excel 列顺序可能被改动，为避免错位迁移已终止。`,
        sheetName: DB_SHEET,
        totalRows: 0,
        validRows: 0,
        skippedRows: 0,
        rows: [],
        rosterActive: new Set(),
        rosterResigned: new Set(),
      };
    }
  }

  const rows: ParsedRow[] = [];
  let skippedRows = 0;
  const lastRow = ws.rowCount;
  for (let r = FIRST_DATA_ROW; r <= lastRow; r++) {
    const name = cellText(cellMergedAware(ws, r, COL.name));
    const store = cellText(cellMergedAware(ws, r, COL.storeName));
    const idc = cellText(cellMergedAware(ws, r, COL.idCardNo));
    const hire = cellDate(cellMergedAware(ws, r, COL.hireDate));
    // 与导入脚本同一口径：整行为空 → 跳过；有数据但无姓名 → 也跳过
    // （否则「南昌3店」「运营部」这类分节标题行会被误当成新员工）
    if (!name && !store && !idc && !hire) {
      skippedRows++;
      continue;
    }
    if (!name || name.startsWith("=")) {
      skippedRows++;
      continue;
    }
    rows.push({
      rowNo: r,
      name,
      storeName: store,
      hireDate: hire,
      idCardNo: idc,
      phone: cellText(cellMergedAware(ws, r, COL.phone)),
      jobGrade: cellText(cellMergedAware(ws, r, COL.jobGrade)),
      resignDate: cellDate(cellMergedAware(ws, r, COL.resignDateRaw)),
      resignReason: cellText(cellMergedAware(ws, r, COL.resignReason)),
      remark: cellText(cellMergedAware(ws, r, 38)),
      bankAccountNo: cellText(cellMergedAware(ws, r, COL.bankAccountNo)),
      currentAddress: cellText(cellMergedAware(ws, r, COL.currentAddress)),
    });
  }

  return {
    ok: true,
    sheetName: DB_SHEET,
    totalRows: Math.max(0, lastRow - FIRST_DATA_ROW + 1),
    validRows: rows.length,
    skippedRows,
    rows,
    rosterActive: loadRosterKeys(wb.getWorksheet("在职")),
    rosterResigned: loadRosterKeys(wb.getWorksheet("离职")),
  };
}

// ------------------------------------------------------------
// Diff
// ------------------------------------------------------------

export interface FieldChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface ModifiedEmployee {
  employeeId: number;
  employeeCode: string;
  name: string;
  rowNo: number;
  changes: FieldChange[];
  hasStatusChange: boolean;
  hasStoreChange: boolean;
  hasPositionChange: boolean;
}

export interface NewEmployeeRow {
  rowNo: number;
  name: string | null;
  storeName: string | null;
  hireDate: string | null;
  idCardNo: string | null;
  phone: string | null;
  jobGrade: string | null;
  reason: string;
}

export interface DiffResult {
  summary: {
    totalRows: number;
    validRows: number;
    skippedRows: number;
    matched: number;
    unchanged: number;
    modified: number;
    newCount: number;
    statusChanges: number;
    storeChanges: number;
    positionChanges: number;
  };
  modified: ModifiedEmployee[];
  created: NewEmployeeRow[];
}

const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYEE_FIELDS.map((f) => [f.key, f.label])
);

function norm(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function digits(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\D/g, "");
  return t === "" ? null : t;
}

/**
 * 推导状态 —— 与 scripts/import-excel.ts 完全同一口径：
 *   离职信号 = 在「离职」名册 / 有离职日期 / 有离职原因 / 备注文本含离职字样
 *   （「重新入职 / 又入职 / 回归 / 再入职」不算离职）
 * 有任一信号即为 RESIGNED，否则 ACTIVE。
 */
function deriveStatus(
  row: ParsedRow,
  rosterResigned: Set<string>
): { status: "ACTIVE" | "RESIGNED"; signals: string[] } {
  const rosterKey = `${row.name ?? ""}|${row.hireDate ?? ""}`;
  const inResignedRoster = rosterResigned.has(rosterKey);
  const resignText = textMeansResigned(norm(row.resignReason) ?? row.resignDate);

  const signals: string[] = [];
  if (inResignedRoster) signals.push("离职名册");
  if (row.resignDate) signals.push("离职日期");
  if (norm(row.resignReason)) signals.push("离职原因");
  if (resignText.yes) signals.push("备注文本含离职");

  return { status: signals.length > 0 ? "RESIGNED" : "ACTIVE", signals };
}

/** 比较用的归一化：避免「大小写 / 分隔符」造成的假差异 */
function normalizeForCompare(field: string, v: string | null | undefined): string | null {
  const t = norm(v);
  if (t === null) return null;
  if (field === "idCardNo") return t.replace(/\s/g, "").toUpperCase();
  if (field === "phone") return t.replace(/\D/g, "") || null;
  if (field === "bankAccountNo") return t.replace(/\D/g, "") || null;
  return t;
}

/**
 * 计算 Diff（只读，不写库）
 */
export async function computeDiff(parsed: ParseResult): Promise<DiffResult> {
  const [employees, stores, aliases, positions, sourceRows] = await Promise.all([
    prisma.employee.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        name: true,
        idCardNo: true,
        phone: true,
        hireDate: true,
        status: true,
        storeId: true,
        storeNameRaw: true,
        positionId: true,
        jobGradeRaw: true,
        resignDate: true,
        resignReason: true,
        remark: true,
        bankAccountNo: true,
        currentAddress: true,
        store: { select: { name: true } },
        position: { select: { name: true } },
      },
    }),
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.storeAlias.findMany({ select: { storeId: true, alias: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employeeSourceRow.findMany({
      where: { sheet: DB_SHEET },
      select: { employeeId: true, rowNo: true },
    }),
  ]);

  const storeByName = new Map<string, number>();
  for (const s of stores) storeByName.set(s.name.trim(), s.id);
  for (const a of aliases) if (!storeByName.has(a.alias.trim())) storeByName.set(a.alias.trim(), a.storeId);
  const positionByName = new Map(positions.map((p) => [p.name.trim(), p.id]));

  // 索引：与导入脚本同一套去重级联
  const byIdHire = new Map<string, number>();
  const byId = new Map<string, number[]>();
  const byNameHire = new Map<string, number>();
  const byNamePhone = new Map<string, number>();
  const bySourceRow = new Map<number, number>();
  const byIdEmp = new Map<number, (typeof employees)[number]>();

  for (const e of employees) {
    byIdEmp.set(e.id, e);
    const hireIso = e.hireDate ? e.hireDate.toISOString().slice(0, 10) : null;
    const idc = norm(e.idCardNo);
    if (idc && hireIso) byIdHire.set(`${idc}|${hireIso}`, e.id);
    if (idc) {
      const arr = byId.get(idc) ?? [];
      arr.push(e.id);
      byId.set(idc, arr);
    }
    if (hireIso) byNameHire.set(`${e.name}|${hireIso}`, e.id);
    if (digits(e.phone)) byNamePhone.set(`${e.name}|${digits(e.phone)}`, e.id);
  }
  for (const s of sourceRows) bySourceRow.set(s.rowNo, s.employeeId);

  const modified: ModifiedEmployee[] = [];
  const created: NewEmployeeRow[] = [];

  for (const row of parsed.rows) {
    // ---- 匹配（级联，与导入脚本一致）----
    let empId: number | null = null;
    const idc = norm(row.idCardNo);
    if (idc && row.hireDate) empId = byIdHire.get(`${idc}|${row.hireDate}`) ?? null;
    if (empId === null && idc) {
      const arr = byId.get(idc) ?? [];
      if (arr.length === 1 && !row.hireDate) empId = arr[0];
    }
    if (empId === null && row.name && row.hireDate) {
      empId = byNameHire.get(`${row.name}|${row.hireDate}`) ?? null;
    }
    if (empId === null && row.name && digits(row.phone)) {
      empId = byNamePhone.get(`${row.name}|${digits(row.phone)}`) ?? null;
    }
    if (empId === null) empId = bySourceRow.get(row.rowNo) ?? null;

    if (empId === null) {
      created.push({
        rowNo: row.rowNo,
        name: row.name,
        storeName: row.storeName,
        hireDate: row.hireDate,
        idCardNo: row.idCardNo,
        phone: row.phone,
        jobGrade: row.jobGrade,
        reason: row.idCardNo ? "库中没有匹配的身份证号 + 入职日期" : "无任何可用去重键，无法匹配",
      });
      continue;
    }

    const e = byIdEmp.get(empId);
    if (!e) continue;

    const changes: FieldChange[] = [];
    const push = (field: string, oldV: string | null, newV: string | null) => {
      const a = normalizeForCompare(field, oldV);
      const b = normalizeForCompare(field, newV);
      if (a === b) return;
      // 敏感字段只展示脱敏值
      const mask = (v: string | null) =>
        v === null ? null : String(maskByField(field, v) ?? v);
      changes.push({
        field,
        label: FIELD_LABELS[field] ?? field,
        oldValue: mask(a),
        newValue: mask(b),
      });
    };

    push(
      "name",
      e.name,
      row.name
    );
    push("phone", e.phone, row.phone);
    push("idCardNo", e.idCardNo, row.idCardNo);
    push("jobGradeRaw", e.jobGradeRaw, row.jobGrade);
    push("resignReason", e.resignReason, row.resignReason);
    push("remark", e.remark, row.remark);
    push("bankAccountNo", e.bankAccountNo, row.bankAccountNo);
    push("currentAddress", e.currentAddress, row.currentAddress);

    // 入职日期
    const oldHire = e.hireDate ? e.hireDate.toISOString().slice(0, 10) : null;
    push("hireDate", oldHire, row.hireDate);

    // 离职日期
    const oldResign = e.resignDate ? e.resignDate.toISOString().slice(0, 10) : null;
    push("resignDate", oldResign, row.resignDate);

    // 状态（含「离职」名册交叉比对，口径与导入脚本一致）
    const { status: newStatus } = deriveStatus(row, parsed.rosterResigned);
    push("status", e.status, newStatus);

    // 门店（按标准名或别名解析；展示用名称而不是 id）
    const newStoreId = row.storeName ? (storeByName.get(row.storeName.trim()) ?? null) : null;
    const oldStoreName = e.store?.name ?? e.storeNameRaw ?? null;
    if ((newStoreId ?? null) !== (e.storeId ?? null)) {
      const newName =
        newStoreId !== null ? (stores.find((s) => s.id === newStoreId)?.name ?? row.storeName) : null;
      changes.push({
        field: "storeId",
        label: "门店",
        oldValue: oldStoreName,
        newValue: newName,
      });
    }

    // 岗位
    const newPositionId = row.jobGrade ? (positionByName.get(row.jobGrade.trim()) ?? null) : null;
    if ((newPositionId ?? null) !== (e.positionId ?? null)) {
      changes.push({
        field: "positionId",
        label: "岗位",
        oldValue: e.position?.name ?? e.jobGradeRaw ?? null,
        newValue: row.jobGrade ?? null,
      });
    }

    if (!changes.length) continue;

    modified.push({
      employeeId: e.id,
      employeeCode: e.employeeId,
      name: e.name,
      rowNo: row.rowNo,
      changes,
      hasStatusChange: changes.some((c) => c.field === "status"),
      hasStoreChange: changes.some((c) => c.field === "storeId"),
      hasPositionChange: changes.some((c) => c.field === "positionId"),
    });
  }

  const summary = {
    totalRows: parsed.totalRows,
    validRows: parsed.validRows,
    skippedRows: parsed.skippedRows,
    matched: parsed.validRows - created.length,
    unchanged: Math.max(0, parsed.validRows - created.length - modified.length),
    modified: modified.length,
    newCount: created.length,
    statusChanges: modified.filter((m) => m.hasStatusChange).length,
    storeChanges: modified.filter((m) => m.hasStoreChange).length,
    positionChanges: modified.filter((m) => m.hasPositionChange).length,
  };

  return { summary, modified, created };
}
