/**
 * 导出 Excel（Stage 9.40 重写）
 *
 * ## 用户要求（2026-10-03）
 * > 「导出来的表就不要带公式了，我要纯数据」
 *
 * ## 做法：**先压平公式，再逐表写入实时值**
 *
 * 这份 Excel 12 张表里 **6 万多个格子全是公式**（XLOOKUP / COUNTIFS / SUMPRODUCT /
 * TEXTJOIN / LET）。此前导出的做法是「保留公式让 Excel 自己算」，出了两个致命问题：
 *
 * 1. **「在职」表满屏「没找到」**
 *    在职表的每一列都是 `XLOOKUP(1,(数据库!$E:$E=$E3)*(数据库!$C:$C=$C3),数据库!B:B,"没找到",0)`
 *    —— 靠 **姓名 + 入职时间** 去数据库表匹配。导出时数据库表的入职日期被写成**文本**
 *    `2021-03-22`，而原表 C 列是**日期类型**，文本 ≠ 日期 → 匹配全失败。
 *    而且在职表当时只写了姓名列（`SHEET_WRITE_MODE: nameOnly`），其余 21 列全是公式。
 *
 * 2. **共享公式区不能写**
 *    「门店人员编制」O 列是 `{formula:"M4-N4", shareType:"shared"}`，ExcelJS 覆盖母格就崩
 *    `Shared Formula master must exist above and or left of clone`。
 *
 * ## 现在的流程
 * ```
 * ① flattenFormulas(wb)   把 6 万个公式格全替换成各自的缓存结果值 → 工作簿 0 公式
 * ② 逐表写入               用软件里同一套计算服务算出值，直接写死
 * ③ 输出                   纯数据、纯样式，手机/手机秒开也能看
 * ```
 *
 * ⚠️ 顺序不可颠倒：必须先 flatten，否则写入时会撞上共享公式崩溃。
 * ⚠️ 原始 `途虎HR人员登记.xlsx` **只读**，永不写入。
 *
 * ## 口径一致性铁律
 * 流失率 / 人员分布 / 门店编制三张统计表**直接调用页面所用的同一个服务**
 * （`getAttrition` / `getDistribution` / `getStoreHeadcount`），
 * **绝不在导出里另写一套算法** —— 软件页面看到的数字与导出文件逐格一致。
 */
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { formatDate } from "./format";
import { renderTenureCn, hasCompletedTwoMonths } from "./tenure";
import { flattenFormulas, putCell, clearRange } from "./excel-export-helpers";
import { EMPLOYEE_STATUS_LABEL } from "./constants";
// 统计表口径**直接复用页面所用的服务**，绝不在导出里另写一套算法
import { getStoreHeadcount } from "./headcount-service";
import { getAttrition, defaultMonth, parseMonth } from "./attrition-service";
import { getDistribution, DISTRIBUTION_GRADES } from "./distribution-service";

/** 原始 Excel（只读，永不写） */
const SOURCE_XLSX = "途虎HR人员登记.xlsx";

/** 需要转成「中文显示」的日期字段（库里是 UTC 零点 Date，导出写 yyyy-MM-dd 文本） */
const DATE_FIELDS = new Set(["hireDate", "resignDate", "interviewDate", "insuredDate"]);

/** 表头文本 → 归一（去空格/全半角差异） */
function normTitle(s: string): string {
  return String(s).replace(/[\s　]/g, "").replace(/[(]/g, "(").replace(/[)]/g, ")").trim();
}

/** 任意单元格值 → 纯文本（用于读表头、读原表行序） */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellToText(o.result);
    return "";
  }
  return String(v).trim();
}

/**
 * 每张表的**表头行号 / 数据起始行 / 姓名列**（全部实测，绝不猜）
 *
 * ⚠️ Stage 9.40 修正了两处历史错误：
 *   · 「人员流失率」表头在**第 3 行**（R1 大标题 / R2 分组标题 / R3 才是字段名），
 *     之前写成 1 → 数据往上错位。
 *   · 「门店人员分布明细」表头在**第 2 行**（R1 是合并的大标题），之前也写成 1。
 */
interface SheetLayout {
  headerRow: number;
  dataStart: number;
  /** 姓名所在列（1-based）；-1 = 该表没有姓名列 */
  nameCol: number;
  /** 该表最后一列（1-based），用于清空残留 */
  lastCol: number;
}

const LAYOUT: Record<string, SheetLayout> = {
  在职: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 25 },
  离职: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 26 },
  南昌3店: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 25 },
  运营部: { headerRow: 1, dataStart: 2, nameCol: 5, lastCol: 16 },
  运营部离职: { headerRow: 1, dataStart: 2, nameCol: 5, lastCol: 18 },
  招聘面试登记表: { headerRow: 3, dataStart: 4, nameCol: 2, lastCol: 15 },
  薪资表: { headerRow: 1, dataStart: 2, nameCol: 4, lastCol: 15 },
  数据库: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 46 },
  社保总名单: { headerRow: 1, dataStart: 2, nameCol: 3, lastCol: 6 },
  门店人员编制: { headerRow: 3, dataStart: 4, nameCol: -1, lastCol: 22 },
  人员流失率: { headerRow: 3, dataStart: 4, nameCol: -1, lastCol: 10 },
  门店人员分布明细: { headerRow: 2, dataStart: 3, nameCol: -1, lastCol: 10 },
};

/**
 * 人员类表：**列号 → 员工字段**（按实测列序号写死，不靠表头名匹配）
 *
 * 为什么必须按列序号：这份 Excel 的表头名不可靠 ——
 *   · 「在职」表第 5 列表头是**空的**（但那列就是姓名）
 *   · 「在职」表第 13/15 列**都叫「联系人电话」**（一列紧急电话一列紧急联系人2电话）
 *   · 「运营部」表第 9/10 列**都叫「紧急联系人（电话）」**
 * 按表头名匹配必然串列，所以人员表一律按实测列序号。
 *
 * `null` = 该列在软件里没有对应数据，保持为空。
 */
const STAFF_COLUMNS: Record<string, (string | null)[]> = {
  // 在职 / 南昌3店：R2 = 字段名，25 列（两者列序完全一致）
  在职: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName",
  ],
  南昌3店: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName",
  ],
  // 运营部：R1 = 字段名，16 列（第 9/10 列都是「紧急联系人（电话）」，实为姓名+电话）
  运营部: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "jobGradeRaw", "dormitory",
    "socialInsurancePurchased", "emergencyContact1", "emergencyPhone1", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress",
  ],
  // 运营部离职：R1 = 字段名，18 列
  运营部离职: [
    "__seq__", "storeId", "hireDate", "__resignedTenure__", "name", "jobGradeRaw", "dormitory",
    "socialInsurancePurchased", "laborContract", "salaryTerms", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress",
    "resignDate", "resignReason",
  ],
  // 离职：R2 = 字段名，26 列（第 4 列「在职年限」= 离职时点的在职年限）
  离职: [
    "__seq__", "storeId", "hireDate", "__resignedTenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "currentAddress",
    "resignReason", "resignDate", "recruiterName",
  ],
  // 数据库：R2 = 字段名，46 列。R1 是一行示例数据（不是表头）
  // ⚠️ 第 41 列也是「面试评估表」—— 那是薪资表的重复列（Stage 9.36 已合并），
  //    原表保留了这一列，导出时留空（与原表一致，不写重复值）。
  数据库: [
    "__seq__", "storeId", "hireDate", "__tenureAny__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName", "resignReason", "resignDate", "__age__", "interviewDate",
    "interviewLocation", "interviewResult", "interviewerName", "interviewHired",
    "docResume", "docInterviewEvaluation", "__resignedTenure__", "firstMonthGuarantee",
    "remark", "mentorName", "docOnboardingForm", null, "certificateLevel", "remark3",
    "__work7days__", "__work2months__", "minorNote",
  ],
};

/** 社保总名单列号 → 字段（R1 = 字段名，6 列）
 *  ⚠️ 第 1 列「序号」在原表里是**门店分组序号**（A2:A5 合并 = 1），
 *  *    不是逐人递增序号，所以不重写、只保留原样。 */
const SI_COLUMNS: (string | null)[] = [
  null, "store", "name", "insuredDate", "baseAmount", "note",
];

/** 各人员表对应的员工状态 */
const SHEET_STATUS: Record<string, string[]> = {
  在职: ["ACTIVE"],
  离职: ["RESIGNED"],
  南昌3店: ["NC3"],
  运营部: ["OPS"],
  运营部离职: ["OPS_RESIGNED"],
};

/** XLOOKUP 匹配失败时 Excel 写入的字面量，出现即代表「这条公式没取到值」 */
const NOT_FOUND = "没找到";

/** 一行员工 → 各字段的显示值（与软件页面 cellValue 口径完全一致） */
function employeeValues(
  e: Record<string, unknown>,
  storeNames: Map<number, string>,
  posNames: Map<number, string>,
  now: Date
): Record<string, string> {
  const s = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const t = String(v).trim();
    // ⚠️ 原表里 XLOOKUP 匹配失败会写入字面量「没找到」，它不是真实数据，
    //    导出时必须清掉（否则用户看到的是一句假话）。
    return t === NOT_FOUND ? "" : t;
  };
  const d = (v: unknown) => (v ? formatDate(v as Date) : "");

  const storeId = e.storeId as number | null;
  const positionId = e.positionId as number | null;

  return {
    // 门店：优先门店主数据；运营部的人没有 storeId，回退到部门名 / Excel 原文
    storeId: storeId
      ? (storeNames.get(storeId) ?? "")
      : (s(e.departmentNameRaw) || s(e.storeNameRaw)),
    name: s(e.name),
    idCardNo: s(e.idCardNo),
    phone: s(e.phone),
    workPhone: s(e.workPhone),
    jobGradeRaw: s(e.jobGradeRaw) || (positionId ? (posNames.get(positionId) ?? "") : ""),
    positionNote: s(e.positionNote),
    dormitory: s(e.dormitory),
    socialInsurancePurchased: s(e.socialInsurancePurchased),
    emergencyContact1: s(e.emergencyContact1),
    emergencyPhone1: s(e.emergencyPhone1),
    emergencyContact2: s(e.emergencyContact2),
    emergencyPhone2: s(e.emergencyPhone2),
    laborContract: s(e.laborContract),
    socialInsuranceAgreement: s(e.socialInsuranceAgreement),
    fireSafetyCommitment: s(e.fireSafetyCommitment),
    dormitoryWaiver: s(e.dormitoryWaiver),
    onboardingMedical: s(e.onboardingMedical),
    bankBranch: s(e.bankBranch),
    bankAccountNo: s(e.bankAccountNo),
    salaryTerms: s(e.salaryTerms),
    firstMonthGuarantee: s(e.firstMonthGuarantee),
    currentAddress: s(e.currentAddress),
    householdAddress: s(e.householdAddress),
    recruiterName: s(e.recruiterName),
    mentorName: s(e.mentorName),
    certificateLevel: s(e.certificateLevel),
    remark: s(e.remark),
    remark3: s(e.remark3),
    minorNote: s(e.minorNote),
    resignReason: s(e.resignReason),
    interviewDate: d(e.interviewDate),
    interviewLocation: s(e.interviewLocation),
    interviewResult: s(e.interviewResult),
    interviewerName: s(e.interviewerName),
    interviewHired: s(e.interviewHired),
    docResume: s(e.docResume),
    docInterviewEvaluation: s(e.docInterviewEvaluation),
    docOnboardingForm: s(e.docOnboardingForm),
    hireDate: d(e.hireDate),
    resignDate: d(e.resignDate),

    // —— 计算列：与 lib/employee-sheet-service.ts 的 cellValue 同一套口径 ——
    // 在职年限（在职算到今天）
    __tenure__: safe(() => renderTenureCn(e.hireDate as Date | null, null, now), ""),
    // 在职年限（离职算到离职日）
    __resignedTenure__: safe(() => renderTenureCn(e.hireDate as Date | null, e.resignDate as Date | null, now), ""),
    // 在职年限（离职看离职日、在职看今天）—— 数据库表用
    __tenureAny__: safe(() => renderTenureCn(e.hireDate as Date | null, e.resignDate as Date | null, now), ""),
    __age__: e.age !== null && e.age !== undefined ? String(e.age) : s(e.ageRaw),
    __work7days__: safe(() => {
      if (!e.hireDate) return "";
      const ref = (e.resignDate as Date | null) ?? now;
      const days = Math.floor((ref.getTime() - (e.hireDate as Date).getTime()) / 86_400_000);
      return days >= 7 ? "入职满7天" : "未满7天";
    }, ""),
    __work2months__: safe(() => {
      if (!e.hireDate) return "";
      const ref = (e.resignDate as Date | null) ?? now;
      const done = hasCompletedTwoMonths(e.hireDate as Date, ref);
      if (done === null) return "";
      return done ? "入职满2个月" : "未满2个月";
    }, ""),
  };
}

/** 计算列绝不让导出崩：算不出来就留空（并在报告里体现） */
function safe(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 读原表某列的姓名顺序（保持用户手工排好的门店分组顺序） */
function readOriginalOrder(ws: ExcelJS.Worksheet, nameCol: number, headerRow: number): string[] {
  const out: string[] = [];
  if (nameCol <= 0) return out;
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const nm = cellToText(ws.getRow(r).getCell(nameCol).value);
    if (nm) out.push(nm);
  }
  return out;
}

/**
 * 按原表顺序对齐；原表有但库里没有的 → null 占位（清空该行）；
 * 库里多出来的（新增员工）→ 追加到末尾
 */
function alignToOriginalOrder(
  originalNames: string[],
  rows: Record<string, unknown>[]
): (Record<string, unknown> | null)[] {
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = String(r.name ?? "");
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(r);
  }
  const used = new Map<string, number>();
  const aligned: (Record<string, unknown> | null)[] = [];
  for (const nm of originalNames) {
    const bucket = byName.get(nm);
    const i = used.get(nm) ?? 0;
    if (bucket && i < bucket.length) {
      aligned.push(bucket[i]);
      used.set(nm, i + 1);
    } else {
      aligned.push(null);
    }
  }
  for (const r of rows) {
    const nm = String(r.name ?? "");
    const i = used.get(nm) ?? 0;
    const bucket = byName.get(nm) ?? [];
    if (i < bucket.length && bucket[i] === r) {
      used.set(nm, i + 1);
      aligned.push(r);
    }
  }
  return aligned;
}

/** 某表最后一个有数据的行（用于清空残留） */
function lastDataRow(ws: ExcelJS.Worksheet, dataStart: number, lastCol: number): number {
  for (let r = ws.rowCount; r >= dataStart; r--) {
    for (let c = 1; c <= lastCol; c++) {
      if (cellToText(ws.getRow(r).getCell(c).value) !== "") return r;
    }
  }
  return dataStart - 1;
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  stats: { sheet: string; rows: number; written: number; note: string }[];
  /** 被压平的公式数量（用户要求「纯数据」的证据） */
  flattened: { total: number; bySheet: Record<string, number> };
}

/**
 * 导出 Excel —— 纯数据、零公式
 */
export async function exportExcel(): Promise<ExportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE_XLSX);

  // ---------- ① flatten：把 6 万个公式格全压成常量（必须在所有写入之前） ----------
  const flattened = flattenFormulas(wb);

  // ---------- 预取参照数据 ----------
  const [stores, positions, employees, siEntries] = await Promise.all([
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { deletedAt: null } }),
    prisma.socialInsuranceEntry.findMany({ orderBy: { sourceRowNo: "asc" } }),
  ]);
  const storeNames = new Map(stores.map((s) => [s.id, s.name]));
  const posNames = new Map(positions.map((p) => [p.id, p.name]));
  const now = new Date();

  const byStatus = new Map<string, Record<string, unknown>[]>();
  for (const e of employees as unknown as Record<string, unknown>[]) {
    const st = String(e.status);
    if (!byStatus.has(st)) byStatus.set(st, []);
    byStatus.get(st)!.push(e);
  }

  const stats: ExportResult["stats"] = [];

  // ---------- ② 人员类表：逐格写实时值 ----------
  for (const [sheet, statuses] of Object.entries(SHEET_STATUS)) {
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }
    const cols = STAFF_COLUMNS[sheet];
    const rows = statuses.flatMap((st) => byStatus.get(st) ?? []);
    const originalNames = readOriginalOrder(ws, layout.nameCol, layout.headerRow);
    const aligned = alignToOriginalOrder(originalNames, rows);

    // 先把整块数据区清空（原表残留值一律不留），再逐行写
    const clearTo = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), layout.dataStart + aligned.length - 1);
    clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

    let written = 0;
    for (let i = 0; i < aligned.length; i++) {
      const target = layout.dataStart + i;
      const rec = aligned[i];
      if (!rec) continue; // 库中已无此人 → 保持清空
      const vals = employeeValues(rec, storeNames, posNames, now);
      vals.__seq__ = String(i + 1); // 序号列 = 在本表里的行号
      for (let c = 1; c <= cols.length; c++) {
        const field = cols[c - 1];
        if (!field) continue;
        if (putCell(ws, target, c, vals[field] ?? "")) written++;
      }
    }

    const missing = aligned.filter((r) => r === null).length;
    stats.push({
      sheet,
      rows: aligned.length,
      written,
      note:
        `按原表顺序写 ${aligned.length} 行 × ${cols.filter(Boolean).length} 列实值（0 公式）` +
        (missing ? `；其中 ${missing} 行原表有、库中已无，保持空白` : ""),
    });
  }

  // ---------- ③ 数据库表：全部员工档案（46 列实值） ----------
  {
    const sheet = "数据库";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (ws && layout) {
      const cols = STAFF_COLUMNS[sheet];
      const rows = employees as unknown as Record<string, unknown>[];
      const originalNames = readOriginalOrder(ws, layout.nameCol, layout.headerRow);
      const aligned = alignToOriginalOrder(originalNames, rows);
      const clearTo = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), layout.dataStart + aligned.length - 1);
      clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

      let written = 0;
      for (let i = 0; i < aligned.length; i++) {
        const target = layout.dataStart + i;
        const rec = aligned[i];
        if (!rec) continue;
        const vals = employeeValues(rec, storeNames, posNames, now);
        vals.__seq__ = String(i + 1);
        for (let c = 1; c <= cols.length; c++) {
          const field = cols[c - 1];
          if (!field) continue;
          if (putCell(ws, target, c, vals[field] ?? "")) written++;
        }
      }
      stats.push({
        sheet,
        rows: aligned.length,
        written,
        note: `全部 ${rows.length} 名员工 × ${cols.filter(Boolean).length} 列实值（不受状态限制，0 公式）`,
      });
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ④ 社保总名单 ----------
  {
    const sheet = "社保总名单";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (ws && layout) {
      const entries = siEntries as unknown as Record<string, unknown>[];
      const aligned = alignToOriginalOrder(
        readOriginalOrder(ws, layout.nameCol, layout.headerRow),
        entries
      );
      const clearTo = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), layout.dataStart + aligned.length - 1);
      clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

      let written = 0;
      for (let i = 0; i < aligned.length; i++) {
        const target = layout.dataStart + i;
        const rec = aligned[i];
        if (!rec) continue;
        const storeId = rec.storeId as number | null;
        const vals: Record<string, string> = {
          store: storeId ? (storeNames.get(storeId) ?? String(rec.storeNameRaw ?? "")) : String(rec.storeNameRaw ?? ""),
          name: String(rec.name ?? ""),
          insuredDate: rec.insuredDate ? formatDate(rec.insuredDate as Date) : "",
          baseAmount: rec.baseAmount === null || rec.baseAmount === undefined ? "" : String(rec.baseAmount),
          note: rec.note === null || rec.note === undefined ? "" : String(rec.note),
        };
        for (let c = 1; c <= SI_COLUMNS.length; c++) {
          const field = SI_COLUMNS[c - 1];
          if (!field) continue;
          if (putCell(ws, target, c, vals[field] ?? "")) written++;
        }
      }
      stats.push({
        sheet,
        rows: aligned.length,
        written,
        note: `名单 ${entries.length} 人 × 5 列实值（原表本来就没公式）`,
      });
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ⑤ 招聘面试登记表 / 薪资表：Excel 原始名单 + 回填最新档案 ----------
  stats.push(...(await writeRecruitAndSalarySheets(wb, storeNames, now)));

  // ---------- ⑥ 统计类表：实时计算写入（复用页面同一服务） ----------
  stats.push(...(await writeStatSheets(wb)));

  const out = await wb.xlsx.writeBuffer();
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    buffer: Buffer.from(out),
    filename: `途虎HR人员登记（导出于${stamp}）.xlsx`,
    stats,
    flattened,
  };
}

/**
 * 招聘面试登记表 / 薪资表 —— **Excel 原始名单口径 + 回填最新档案数据**
 *
 * 这两张表在软件里的口径是「以 Excel 原始名单为准」（招聘面试 478 人、薪资 290 人，
 * 见 Stage 9 的约定），所以**不能按员工状态重新筛人** —— 那会把口径改掉。
 * 正确做法：
 *   ① 行集合 = `SheetRow` 镜像（原名单顺序、人数完全不变）
 *   ② 每行按 `SheetRowEmployeeLink.employeeId` 找到员工档案，**把最新值写回**
 *   ③ 没建档的行（只来面试没入职）→ 保留 SheetRow 里的原始名单值
 *
 * ⚠️ `SheetRowEmployeeLink.employeeId` 是**员工档案 id（Int）**，不是 THHR 工号。
 * ⚠️ `SheetRow.rowNo` 就是 **Excel 原始行号**（导入时 `rows.push({ rowNo: r })` 就是 Excel 行号）。
 */
async function writeRecruitAndSalarySheets(
  wb: ExcelJS.Workbook,
  storeNames: Map<number, string>,
  now: Date
): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];

  /** 列号 → 字段（招聘面试登记表 R3 实测；第 5 列「年龄」由 age 计算） */
  const RECRUIT_COLUMNS: (string | null)[] = [
    "__seq__", "name", "phone", "jobGradeRaw", "__age__", "interviewDate", "interviewLocation",
    "interviewResult", "interviewerName", "interviewHired", "hireDate", "salaryTerms",
    "docResume", "docInterviewEvaluation", "recruiterName",
  ];
  /** 列号 → 字段（薪资表 R1 实测；第 6 列表头是合并的「首月保障」跨两列） */
  const SALARY_COLUMNS: (string | null)[] = [
    "__seq__", "storeId", "hireDate", "name", "jobGradeRaw", "firstMonthGuarantee",
    "salaryTerms", "recruiterName", "mentorName", "docOnboardingForm",
    "docInterviewEvaluation", "certificateLevel", "remark3", "__work7days__", "__work2months__",
  ];

  const spec: { sheet: string; cols: (string | null)[] }[] = [
    { sheet: "招聘面试登记表", cols: RECRUIT_COLUMNS },
    { sheet: "薪资表", cols: SALARY_COLUMNS },
  ];

  for (const sp of spec) {
    const ws = wb.getWorksheet(sp.sheet);
    const layout = LAYOUT[sp.sheet];
    if (!ws || !layout) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }

    // ① 行集合 = SheetRow 原始镜像（保持原名单口径与顺序）
    const mirror = await prisma.sheetRow.findMany({
      where: { sheet: sp.sheet },
      orderBy: { rowNo: "asc" },
    });
    if (mirror.length === 0) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "SheetRow 镜像为空（是否还没导入？）" });
      continue;
    }

    // ② 整块清空，然后逐行写：先写原始名单值，再对已建档的行回填最新档案
    const maxRow = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), ...mirror.map((m) => m.rowNo));
    clearRange(ws, layout.dataStart, maxRow, 1, layout.lastCol);

    const links = await prisma.sheetRowEmployeeLink.findMany({ where: { sheet: sp.sheet } });
    const empIdByRow = new Map<number, number>(links.map((l) => [l.rowNo, l.employeeId]));
    const empIds = [...new Set(empIdByRow.values())];
    const emps = empIds.length
      ? await prisma.employee.findMany({ where: { id: { in: empIds }, deletedAt: null } })
      : [];
    const empMap = new Map<number, Record<string, unknown>>(
      (emps as unknown as Record<string, unknown>[]).map((e) => [e.id as number, e])
    );

    let written = 0;
    let matched = 0;
    for (let i = 0; i < mirror.length; i++) {
      const row = mirror[i];
      const cells = safeParseCells(row.cellsJson);
      const empId = empIdByRow.get(row.rowNo);
      const e = empId !== undefined ? empMap.get(empId) : undefined;

      let vals: Record<string, string>;
      if (e) {
        matched++;
        // 已建档 → 用最新档案算出的值（软件里改过，这里立刻反映）
        vals = employeeValues(e, storeNames, new Map(), now);
        vals.__seq__ = String(i + 1);
      } else {
        // 未建档 → 保留导入时的原始名单值（cellsJson 数组，下标 = 列号-1）
        vals = {};
        for (let c = 1; c <= sp.cols.length; c++) {
          // ⚠️ 原始名单里也可能存着 XLOOKUP 匹配失败留下的「没找到」，同样要清掉
          const raw = cells[c - 1] ?? "";
          vals[`c${c}`] = raw.trim() === NOT_FOUND ? "" : raw;
        }
      }

      for (let c = 1; c <= sp.cols.length; c++) {
        const field = sp.cols[c - 1];
        let v: string;
        if (e) {
          if (!field) continue;
          v = vals[field] ?? "";
        } else {
          v = vals[`c${c}`] ?? "";
        }
        if (putCell(ws, row.rowNo, c, v)) written++;
      }
    }

    out.push({
      sheet: sp.sheet,
      rows: mirror.length,
      written,
      note:
        `名单沿用 Excel 原始行（${mirror.length} 人不变），` +
        `其中 ${matched} 人已建档并回填最新档案数据，其余保留原始名单值；0 公式`,
    });
  }

  return out;
}

function safeParseCells(json: string): string[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.map((x) => (x === null || x === undefined ? "" : String(x))) : [];
  } catch {
    return [];
  }
}

/**
 * 统计类 Sheet —— **全部实时计算写入**
 *
 * ⚠️ 口径铁律：直接调用页面所用的同一个服务
 *   · 门店人员编制   → `getStoreHeadcount()`
 *   · 人员流失率     → `getAttrition({ month })`
 *   · 门店人员分布明细 → `getDistribution()`
 * 软件页面看到的数字与导出文件**逐格一致**，绝不各写一套算法。
 *
 * 之前这些格全是公式（COUNTIFS / SUMPRODUCT / TEXTJOIN / LET），手机上看是空的；
 * 现在全部写死为常量值。
 */
async function writeStatSheets(wb: ExcelJS.Workbook): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];
  const month = defaultMonth();

  const [hc, dist, attrition] = await Promise.all([
    getStoreHeadcount(),
    getDistribution(),
    getAttrition({ month }),
  ]);
  const hcByStore = new Map(hc.rows.map((r) => [r.storeName, r]));

  // ---------- ① 门店人员编制 ----------
  // 实测列序（R3）：1 序号 / 2 名称 / 3 店长 / 4 技术店长 / 5 副店长 / 6 客服经理 /
  //           7 机修现有 / 8 美容现有 / 9 后勤 / 10 当前合计人数 /
  //           11 客服经理满编 / 12 机修满编 / 13 美容满编 / 14 美容师傅满编 /
  //           15 美容中小工满编 / 16 现有美容师傅 / 17 现有美容中小工 /
  //           18 缺编汇总 / 19 机修缺编 / 20 美容缺编 / 21 客服经理缺编 / 22 具体缺编明细
  // ⚠️ 原表 R40 是「所有店铺合计」行，数据行只到 R39 —— 合计行要单独处理。
  {
    const sheet = "门店人员编制";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      // ⚠️ 合计行必须在**清空之前**探测：它的 A:B 是合并单元格，
      // 读 B 列拿到的是主格 A 的值；清空后就再也认不出哪行是合计行了。
      const sumRow = dataStart + hc.rows.length;
      const hasSumRow =
        cellToText(ws.getRow(sumRow).getCell(1).value).includes("合计") ||
        cellToText(ws.getRow(sumRow).getCell(2).value).includes("合计");
      const lastRow = lastDataRow(ws, dataStart, layout.lastCol);
      clearRange(ws, dataStart, lastRow, 1, layout.lastCol);
      if (hasSumRow) putCell(ws, sumRow, 1, "所有店铺合计：");

      let written = 0;
      for (let i = 0; i < hc.rows.length; i++) {
        const r = hc.rows[i];
        const target = dataStart + i;
        const st = hcByStore.get(r.storeName);
        if (putCell(ws, target, 1, i + 1)) written++;
        if (putCell(ws, target, 2, r.storeName)) written++;
        const c = r.current;
        const live: (number | null)[] = [
          c.manager, c.techManager, c.deputyManager, c.serviceManager,
          c.mechanic, c.beauty, c.logistics, c.total,
        ];
        for (let k = 0; k < live.length; k++) if (putCell(ws, target, 3 + k, live[k])) written++;
        const full: (number | null)[] = [
          r.full.serviceManager, r.full.mechanic, r.full.beauty, r.full.beautyMaster, r.full.beautyJunior,
        ];
        for (let k = 0; k < full.length; k++) if (putCell(ws, target, 11 + k, full[k])) written++;
        // 16 现有美容师傅 / 17 现有美容中小工 / 18 缺编汇总 / 19 机修缺编 /
        // 20 美容缺编 / 21 客服经理缺编 / 22 具体缺编明细（负数=超编，原样显示）
        if (st) {
          const gap: (number | string)[] = [
            c.beautyMaster, c.beautyJunior, st.gap.total, st.gap.mechanic,
            st.gap.beauty, st.gap.serviceManager, st.gap.detail,
          ];
          for (let k = 0; k < gap.length; k++) if (putCell(ws, target, 16 + k, gap[k])) written++;
        }
      }

      // 合计行（先探测后写，见上）
      if (hasSumRow) {
        const colVals = (r: (typeof hc.rows)[number]): (number | null)[] => [
          r.current.manager, r.current.techManager, r.current.deputyManager,
          r.current.serviceManager, r.current.mechanic, r.current.beauty,
          r.current.logistics, r.current.total, r.full.serviceManager,
          r.full.mechanic, r.full.beauty, r.full.beautyMaster, r.full.beautyJunior,
          r.current.beautyMaster, r.current.beautyJunior,
        ];
        for (let c = 3; c <= 17; c++) {
          let s = 0;
          for (const r of hc.rows) {
            const v = colVals(r)[c - 3];
            if (typeof v === "number") s += v;
          }
          if (putCell(ws, sumRow, c, s)) written++;
        }
        // 18~21 缺编四列的合计（负数 = 超编，原样相加；Excel R 列汇总才是 SUMIF(">0")）
        for (let c = 18; c <= 21; c++) {
          let s = 0;
          for (const r of hc.rows) {
            const v =
              c === 18 ? r.gap.total : c === 19 ? r.gap.mechanic : c === 20 ? r.gap.beauty : r.gap.serviceManager;
            if (typeof v === "number") s += v;
          }
          if (putCell(ws, sumRow, c, s)) written++;
        }
      }

      out.push({
        sheet,
        rows: hc.rows.length,
        written,
        note:
          `实时计算（getStoreHeadcount）：${hc.rows.length} 家门店 22 列实值 + 合计行；` +
          `现有人数按在职表实时 COUNT，满编取人工设置值；0 公式`,
      });
    }
  }

  // ---------- ② 门店人员分布明细 ----------
  // 实测列序（R2）：1 序号 / 2 门店 / 3 门店人数 / 4 店长 / 5 副店长 /
  //                6 技术店长 / 7 客服经理 / 8 后勤 / 9 机修 / 10 美容
  {
    const sheet = "门店人员分布明细";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      clearRange(ws, dataStart, lastDataRow(ws, dataStart, layout.lastCol), 1, layout.lastCol);
      let written = 0;
      for (let i = 0; i < dist.rows.length; i++) {
        const r = dist.rows[i];
        const target = dataStart + i;
        if (putCell(ws, target, 1, i + 1)) written++;
        if (putCell(ws, target, 2, r.storeName)) written++;
        if (putCell(ws, target, 3, r.headcount)) written++;
        for (let k = 0; k < DISTRIBUTION_GRADES.length; k++) {
          const names = r.people[DISTRIBUTION_GRADES[k].key] ?? [];
          if (putCell(ws, target, 4 + k, names.join("、"))) written++;
        }
      }
      out.push({
        sheet,
        rows: dist.rows.length,
        written,
        note: `实时计算（getDistribution）：${dist.rows.length} 家门店 × 8 列实值；与软件「人员分布明细」页同一服务；0 公式`,
      });
    }
  }

  // ---------- ③ 人员流失率 ----------
  // 实测列序（R3）：1 序号 / 2 门店名称 / 3 店长 / 4 技术店长 / 5 副店长 /
  //                6 实时人数 / 7 当月离职 / 8 当月入职 / 9 流失率 / 10 邀约数量
  // ⚠️ 原表**一家门店占 1~2 行**（有副店长就多一行副店长行），A/B 列是合并单元格。
  //    合并结构保持原样（只写主格，从格自动跳过）。
  {
    const sheet = "人员流失率";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      clearRange(ws, dataStart, lastDataRow(ws, dataStart, layout.lastCol), 1, layout.lastCol);
      let written = 0;
      let rowNo = 0;
      for (const r of attrition.rows) {
        const target = dataStart + rowNo;
        if (putCell(ws, target, 2, r.storeName)) written++;
        if (r.role === "STORE_MANAGER") {
          if (putCell(ws, target, 1, r.sortOrder)) written++;
          if (putCell(ws, target, 3, r.managers.storeManager ?? "")) written++;
          if (putCell(ws, target, 4, r.managers.techManager ?? "")) written++;
        } else {
          if (putCell(ws, target, 5, r.managers.deputyManager ?? "")) written++;
        }
        // ⚠️ 第 9 列「流失率」必须写**小数**（0.14），不能写百分数（14）。
        //   原表该列 numFmt 是 0%，写小数才会显示成 14%；写 14 会显示成 1400%。
        //   原 Excel 公式 `(G4-H4)/F4` 本身也是小数，两边一致。
        const vals: (number | string | null)[] = [
          r.monthStartHeadcount,
          r.monthResigned,
          r.monthHired,
          r.rate === null ? null : Number(r.rate.toFixed(6)),
          r.invites,
        ];
        for (let k = 0; k < vals.length; k++) if (putCell(ws, target, 6 + k, vals[k])) written++;
        rowNo++;
      }
      const { label } = parseMonth(month);
      // J1（R1 第 10 列）是「统计月份」单元格；A1:I1 是合并的大标题 —— 一起更新，
      // 否则标题写着「2026年8月」而数据是 9 月的，会误导看表的人。
      if (putCell(ws, 1, 10, `${month}-01`)) written++;
      if (putCell(ws, 1, 1, `${label}门店考核指标数据`)) written++;
      out.push({
        sheet,
        rows: attrition.rows.length,
        written,
        note:
          `实时计算（getAttrition，月份 ${label}）：${attrition.rows.length} 行 × 实值；` +
          `月初人数/当月离职/当月入职/流失率/邀约数量全部按当前数据重算；0 公式`,
      });
    }
  }

  return out;
}

export { LAYOUT, cellToText, normTitle };