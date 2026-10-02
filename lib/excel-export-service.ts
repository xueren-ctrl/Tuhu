/**
 * 导出 Excel（Stage 9.38）
 *
 * 目标（用户 2026-10-02 明确要求）：**导出后跟原 Excel 一模一样，只是数据更新了**。
 *
 * 实现策略 —— 「以原 Excel 为底模，只回填数据」：
 *   1. 用 ExcelJS **重新读原始那份 `途虎HR人员登记.xlsx`**（它就是用户天天在用的那份，
 *      含全部格式：列宽、合并单元格、样式、XLOOKUP 公式一律保留原样）。
 *   2. 按每个 Sheet 的**表头行位置**找到每一列对应的数据库字段。
 *   3. 从数据库取最新数据，只**回填有值的那几格**；软件里没有的列（计算列、快照列、
 *      XLOOKUP 公式列）**原样不动**，让 Excel 自己算。
 *   4. 行数变化时：在原表末尾按同一套样式增删行（新增员工 / 离职人员）。
 *
 * 为什么不用 SheetRow 表当底模：SheetRow 存的是「值」，样式/合并/公式全丢了，
 * 导出后跟原文件对不上。SheetRow 只用来**校验**（导入行数对不对得上）。
 */
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { formatDate } from "./format";
import { setCellValue } from "./excel-export-helpers";
// 统计表的口径**直接复用页面所用的服务**，绝不在导出里另写一套算法
import { getStoreHeadcount } from "./headcount-service";
import { getAttrition, defaultMonth } from "./attrition-service";
import { getDistribution, DISTRIBUTION_GRADES } from "./distribution-service";
import { loadEmployeeSheet } from "./employee-sheet-service";


/** 原始 Excel（只读，永不写） */
const SOURCE_XLSX = "途虎HR人员登记.xlsx";

/** 纯日期字段：库里是 UTC 零点 Date，导出要写回 yyyy-MM-dd 文本 */
const DATE_FIELDS = new Set([
  "hireDate",
  "resignDate",
  "interviewDate",
  "insuredDate",
]);

/** 需要转成「门店名」的字段（库里存 id） */
const STORE_FIELDS = new Set(["storeId"]);

/** 计算列 / 快照列：导出时**不动**，交给 Excel 自己的公式 */
const SKIP_FIELDS = new Set([
  "__seq__",
  "__storeName__",
  "__departmentName__",
  "__positionName__",
  "__age__",
  "__tenure__",
  "__resignedTenure__",
  "__tenureAny__",
  "__work7days__",
  "__work2months__",
  "__status__",
  "__skip__",
]);

/**
 * 每个 Sheet 的**字段名表头**在第几行（实测，别猜）
 *
 * ⚠️ 这些表普遍有 2~3 层表头：
 *   在职/南昌3店  R1 = 大标题「各门店在职人员」（合并单元格）
 *                R2 = 字段名   ← 用这行
 *                R3+ = 数据
 *   数据库        R1 = 一行示例数据（！）
 *                R2 = 字段名   ← 用这行
 *   门店人员编制   R1 = 大标题 / R2 = 分组标题（合并）/ R3 = 字段名 ← 用这行
 */
const HEADER_ROW: Record<string, number> = {
  在职: 2,
  离职: 2,
  南昌3店: 2,
  运营部: 1,
  运营部离职: 1,
  招聘面试登记表: 2,
  薪资表: 1,
  门店人员编制: 3,
  人员流失率: 1,
  门店人员分布明细: 1,
  社保总名单: 1,
  数据库: 2,
};

/** 各 Sheet 对应哪些员工状态（决定取谁的数据） */
const SHEET_STATUS: Record<string, string[]> = {
  在职: ["ACTIVE"],
  南昌3店: ["NC3"],
  离职: ["RESIGNED"],
  运营部: ["OPS"],
  运营部离职: ["OPS_RESIGNED"],
};

/** 列标题 → 员工字段（显式映射，**唯一口径**，不靠猜） */
const TITLE_TO_FIELD: Record<string, string> = {
  // —— 全表通用 ——
  姓名: "name",
  门店名称: "storeId",
  门店: "storeId",
  序号: "__seq__",
  工号: "employeeId",
  "身份证号": "idCardNo",
  身份证: "idCardNo",
  联系电话: "phone",
  手机号: "phone",
  电话: "phone",
  工作电话: "workPhone",
  性别: "gender",
  年龄: "__age__",
  户籍地址: "householdAddress",
  居住地址: "currentAddress",
  现居住地址: "currentAddress",
  // —— 岗位 ——
  工种级别: "jobGradeRaw",
  职位: "positionId",
  岗位: "positionId",
  职位备注: "positionNote",
  备注等级: "positionNote",
  // —— 入离职 ——
  入职时间: "hireDate",
  入职日期: "hireDate",
  "离职日期": "resignDate",
  "备注（离职日期）": "resignDate",
  离职原因: "resignReason",
  在职年限: "__tenure__",
  在职期限: "__resignedTenure__",
  // —— 联系方式/紧急联系人 ——
  // ⚠️ 归一化后「紧急联系人（电话）」与「紧急联系人1」同名 —— Excel 里
  //    运营部表是「紧急联系人（电话）」两列（一姓名一电话），离职表是「紧急联系人1」。
  //    这里按 Sheet 分别处理，见 SHEET_TITLE_OVERRIDE。
  是否住宿舍: "dormitory",
  "紧急联系人1": "emergencyContact1",
  联系人电话: "emergencyPhone1",
  紧急联系人2: "emergencyContact2",
  紧急联系人: "emergencyContact1",
  // —— 社保/合同 ——
  社保购买: "socialInsurancePurchased",
  是否买社保: "socialInsurancePurchased",
  劳动合同: "laborContract",
  社保协议: "socialInsuranceAgreement",
  消防承诺书: "fireSafetyCommitment",
  宿舍免责协议: "dormitoryWaiver",
  入职体检: "onboardingMedical",
  // —— 薪资/银行卡 ——
  薪资待遇: "salaryTerms",
  首月保障: "firstMonthGuarantee",
  开户行: "bankBranch",
  "工资卡开户银行支行": "bankBranch",
  银行卡账号: "bankAccountNo",
  "备注（薪资）": "salaryTerms",
  // —— 招聘/面试 ——
  招聘人: "recruiterName",
  面试人: "interviewerName",
  面试日期: "interviewDate",
  面试地点: "interviewLocation",
  面试结果: "interviewResult",
  是否入职: "interviewHired",
  简历表: "docResume",
  面试评估表: "docInterviewEvaluation",
  面试评价: "docInterviewEvaluation",
  入职表: "docOnboardingForm",
  测评表: "remark3",
  // —— 其他 ——
  带教人: "mentorName",
  证书等级: "certificateLevel",
  备注: "remark",
  备注3: "remark3",
  未成年备注: "minorNote",
};

/** 列标题 → 社保名单专用字段 */
const SI_TITLE_TO_FIELD: Record<string, string> = {
  姓名: "name",
  门店: "storeId",
  参保日期: "insuredDate",
  缴费基数: "baseAmount",
  备注: "note",
};

/** 表头文本 → 字段（做一次归一，去空格/全半角差异） */
function normTitle(s: string): string {
  return String(s).replace(/[\s　]/g, "").replace(/[（]/g, "(").replace(/[）]/g, ")").trim();
}

function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellToText(o.result);
    if (o.formula !== undefined || o.sharedFormula !== undefined) return ""; // 公式：留空让它自己算
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/**
 * ⚠️ 关键现实（实测）：**「在职」表的绝大多数列本身是 XLOOKUP 公式**
 *   （第 2~25 列里 21 列都是 `{formula: XLOOKUP(...数据库!)}`），
 *   它靠「数据库」Sheet 按姓名+门店取值。所以：
 *   · 「数据库」表**整表回填**（46 列全部写实值）→ 这是数据源头
 *   · 「在职」表**只写姓名列**，其余列让 Excel 自己重算
 *   这样才既保住了「跟原表一模一样」（公式原样在），又能体现最新数据。
 *
 * 「离职」表是**静态值**（无公式），所以能整表回填。
 */
const SHEET_WRITE_MODE: Record<string, "all" | "nameOnly"> = {
  在职: "nameOnly",
  南昌3店: "nameOnly",
  离职: "all",
  运营部: "all",
  运营部离职: "all",
  数据库: "all",
};

/**
 * ⚠️ **行序必须沿用原 Excel**（用户要求「跟原表一模一样」）
 *
 * 原表的人员行是**按门店分组手工排好的**（塘厦一批、南昌一批…），而且：
 *  - 「在职」表的 XLOOKUP 依赖「数据库」表的**行位置**
 *  - 门店列是**合并单元格**（按门店分组），一旦重排会把分组打乱
 *
 * 所以做法是：**先读原表这一行的姓名，按原表顺序回填**，
 * 也就是「以行号为锚」而不是「以库里的顺序为准」。
 * 库里多出来的人（新增员工）排在末尾，库里已少的（原表有、库中无）在末尾标空。
 */
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
 * 按原表顺序排库里的数据；原表有但库里没有的 → 补一条空记录占位（保持行数不变）
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
      aligned.push(null); // 原表有、库中已无（离职归档后）
    }
  }
  // 库里多出来的（新增员工）→ 追加到末尾
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

/**
 * Sheet 级列映射（**按列序号**，比按表头名可靠）
 *
 * 为什么必须用这一套：这份 Excel 的表头名**不可靠**：
 *   - 「在职」表第 5 列表头是**空的**（但那列就是姓名）
 *   - 「在职」表第 13 列和第 15 列**都叫「联系人电话」**（一个是人名电话一个是紧急电话）
 *   - 「运营部」表第 9、10 列**都叫「紧急联系人（电话）」**（一姓名一电话）
 * 按表头名匹配必然出错，所以**人员类表一律按实测的列序号**写死。
 *
 * 依据：原始 Excel 前 5 行实测（R=表头行，序号从 1 开始）。
 */
const SHEET_TITLE_OVERRIDE: Record<string, string[]> = {
  // 在职 / 南昌3店：R2 = 字段名，25 列
  在职: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName",
  ],
  // 南昌3店：实测 R2 与「在职」**列序完全一致**（第 20 列都是「入职体检」，
  //   第 21 列才是「工资卡的开户银行支行」）。这里直接复用，不要臆测差异。
  南昌3店: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName",
  ],
  // 运营部：R1 = 字段名，17 列
  运营部: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "positionId", "dormitory",
    "socialInsurancePurchased", "emergencyContact1", "emergencyPhone1", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress",
  ],
  // 运营部离职：R1 = 字段名，18 列
  运营部离职: [
    "__seq__", "storeId", "hireDate", "__resignedTenure__", "name", "positionId", "dormitory",
    "socialInsurancePurchased", "laborContract", "salaryTerms", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress", "resignDate", "resignReason",
  ],
  // 数据库：R2 = 字段名，46 列。R1 是一行示例数据，别当表头
  // ⚠️ 第 41 列也是「面试评估表」——那是薪资表的重复列（Stage 9.36 已合并），
  //    导出时写 docInterviewEvaluation 会造成两列同值。原表既然保留了这一列，就照实留空。
  数据库: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName", "resignReason", "resignDate", "__age__", "interviewDate", "interviewLocation",
    "interviewResult", "interviewerName", "interviewHired", "docResume", "docInterviewEvaluation",
    "__resignedTenure__", "firstMonthGuarantee", "remark", "mentorName", "docOnboardingForm",
    "__skip__", "certificateLevel", "remark3", "__work7days__", "__work2months__", "minorNote",
  ],
};

/** 取某 Sheet 的「列号 → 字段」映射（有覆盖则用覆盖，否则按表头名匹配） */
function columnMapFor(sheet: string, headers: string[], dict: Record<string, string>): Map<number, string> {
  const override = SHEET_TITLE_OVERRIDE[sheet];
  if (override) {
    const m = new Map<number, string>();
    headers.forEach((_, i) => {
      const f = override[i];
      if (f) m.set(i + 1, f);
    });
    return m;
  }
  return headerMap(headers, dict);
}

/** 取某 Sheet 的表头列 → 字段 */
function headerMap(headers: string[], dict: Record<string, string>): Map<number, string> {
  const m = new Map<number, string>();
  headers.forEach((h, i) => {
    const key = normTitle(h);
    const f = dict[key];
    if (f) m.set(i + 1, f); // 1-based 列号
  });
  return m;
}

/** 员工 → 该行的单元格值表 */
function employeeValueMap(
  e: Record<string, unknown>,
  storeNames: Map<number, string>,
  posNames: Map<number, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (DATE_FIELDS.has(k)) {
      out[k] = v ? formatDate(v as Date) : "";
      continue;
    }
    if (k === "storeId") {
      out[k] = v ? (storeNames.get(v as number) ?? "") : "";
      continue;
    }
    if (k === "positionId") {
      // 职位列导出用中文名（与原表一致），不是 id
      out[k] = v ? (posNames.get(v as number) ?? "") : "";
      continue;
    }
    out[k] = v ?? "";
  }
  return out;
}

/** 找出 Sheet 里数据从第几行开始（表头下方第一个有值的行） */
function firstDataRow(ws: ExcelJS.Worksheet, headerRow: number): number {
  for (let r = headerRow + 1; r <= Math.min(ws.rowCount, headerRow + 8); r++) {
    let has = false;
    for (let c = 1; c <= ws.columnCount; c++) {
      if (cellToText(ws.getRow(r).getCell(c).value) !== "") {
        has = true;
        break;
      }
    }
    if (has) return r;
  }
  return headerRow + 1;
}

/** 找「姓名」列（定位数据行的依据） */
function nameColIndex(headers: string[]): number {
  const idx = headers.findIndex((h) => normTitle(h) === "姓名");
  return idx >= 0 ? idx + 1 : -1;
}

/** 把一行员工写进某个 Excel 行的指定列 */
function writeRow(
  ws: ExcelJS.Worksheet,
  excelRow: number,
  colMap: Map<number, string>,
  values: Record<string, unknown>
): number {
  let written = 0;
  for (const [colNo, field] of colMap) {
    if (SKIP_FIELDS.has(field)) continue;
    const v = values[field];
    if (v === undefined || v === null || v === "") continue; // **空的不动**（保留公式/原值）
    const cell = ws.getCell(excelRow, colNo);
    // ⚠️ 公式格一律不写：ExcelJS 的共享公式是「母格 + 克隆格」结构，
    //    覆盖母格（或任何一格导致克隆格失配）后写文件会抛
    //    `Shared Formula master must exist above and or left of clone for cell XX`。
    //    实测「门店人员编制」O 列（=M4-N4 共享公式区）就是这样炸的。
    if (isFormulaCell(cell)) continue;
    cell.value = (v instanceof Date ? cellToText(v) : String(v)) as never;
    written++;
  }
  return written;
}

/** 该格是否含公式（含共享公式的克隆格） */
function isFormulaCell(cell: ExcelJS.Cell): boolean {
  const v = cell.value as unknown;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.formula !== undefined || o.sharedFormula !== undefined;
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  stats: { sheet: string; rows: number; written: number; note: string }[];
}

/**
 * 导出 Excel —— 以原始文件为底模，回填数据库最新数据
 */
export async function exportExcel(): Promise<ExportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE_XLSX);

  // —— 预取参照数据 ——
  const [stores, positions, employees, siEntries] = await Promise.all([
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { deletedAt: null } }),
    prisma.socialInsuranceEntry.findMany({ orderBy: { sourceRowNo: "asc" } }),
  ]);
  const storeNames = new Map(stores.map((s) => [s.id, s.name]));
  const posNames = new Map(positions.map((p) => [p.id, p.name]));
  const byStatus = new Map<string, Record<string, unknown>[]>();
  for (const e of employees as unknown as Record<string, unknown>[]) {
    const st = String(e.status);
    if (!byStatus.has(st)) byStatus.set(st, []);
    byStatus.get(st)!.push(e);
  }

  const stats: ExportResult["stats"] = [];

  // ---------- ① 人员类 Sheet：在原表基础上回填 + 增删行 ----------
  for (const [sheet, statuses] of Object.entries(SHEET_STATUS)) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }
    const hRow = HEADER_ROW[sheet] ?? 1;
    const headers: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) headers.push(cellToText(ws.getRow(hRow).getCell(c).value));
    const colMap = columnMapFor(sheet, headers, TITLE_TO_FIELD);
    const nCol = nameColIndex(headers);
    const dataStart = firstDataRow(ws, hRow);

    const rows = statuses.flatMap((st) => byStatus.get(st) ?? []);
    // ⚠️ **按原表顺序对齐，不排序**（原表按门店分组手工排的，见 alignToOriginalOrder 注释）
    const originalNames = readOriginalOrder(ws, nCol, hRow);
    const aligned = alignToOriginalOrder(originalNames, rows);

    let written = 0;
    const mode = SHEET_WRITE_MODE[sheet] ?? "all";
    if (nCol > 0) {
      // ① 按原表行序逐行回填（aligned 里 null = 库中已无此人，原样留空）
      for (let i = 0; i < aligned.length; i++) {
        const target = dataStart + i;
        const rec = aligned[i];
        const nm = ws.getCell(target, nCol);
        if (rec) {
          if (!isFormulaCell(nm)) nm.value = String(rec.name ?? "");
          if (mode === "all") {
            written += writeRow(ws, target, colMap, employeeValueMap(rec, storeNames, posNames));
          }
        } else if (originalNames.length) {
          // 库中已无此人（多半是离职归档后不在该状态表里）→ 只清姓名，其余格不动
          nm.value = null;
        }
      }
    }

    stats.push({
      sheet,
      rows: aligned.length,
      written,
      note:
        mode === "nameOnly"
          ? `表头第 ${hRow} 行；原表数据列是 XLOOKUP 公式，只写姓名列，其余由 Excel 从「数据库」表自动取值`
          : `表头第 ${hRow} 行，映射 ${colMap.size}/${headers.length} 列，数据自第 ${dataStart} 行起`,
    });
  }

  // ---------- ② 社保总名单 ----------
  {
    const sheet = "社保总名单";
    const ws = wb.getWorksheet(sheet);
    if (ws) {
      const hRow = HEADER_ROW[sheet] ?? 1;
      const headers: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) headers.push(cellToText(ws.getRow(hRow).getCell(c).value));
      const colMap = columnMapFor(sheet, headers, SI_TITLE_TO_FIELD);
      const nCol = nameColIndex(headers);
      const dataStart = firstDataRow(ws, hRow);
      let written = 0;
      if (nCol > 0) {
        const vals = (r: (typeof siEntries)[number]): Record<string, unknown> => ({
          name: r.name,
          storeId: r.storeId ? (storeNames.get(r.storeId) ?? r.storeNameRaw ?? "") : (r.storeNameRaw ?? ""),
          insuredDate: r.insuredDate ? formatDate(r.insuredDate) : "",
          baseAmount: r.baseAmount ?? "",
          note: r.note ?? "",
        });
        const aligned = alignToOriginalOrder(readOriginalOrder(ws, nCol, hRow), siEntries as unknown as Record<string, unknown>[]);
        for (let i = 0; i < aligned.length; i++) {
          const target = dataStart + i;
          const rec = aligned[i] as (typeof siEntries)[number] | null;
          const nm = ws.getCell(target, nCol);
          if (rec) {
            nm.value = rec.name;
            written += writeRow(ws, target, colMap, vals(rec));
          } else {
            nm.value = null;
          }
        }
      }
      stats.push({ sheet, rows: siEntries.length, written, note: `映射 ${colMap.size}/${headers.length} 列` });
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ③ 「数据库」Sheet：全量档案（46 列） ----------
  {
    const sheet = "数据库";
    const ws = wb.getWorksheet(sheet);
    if (ws) {
      const hRow = HEADER_ROW[sheet] ?? 1;
      const headers: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) headers.push(cellToText(ws.getRow(hRow).getCell(c).value));
      const colMap = columnMapFor(sheet, headers, TITLE_TO_FIELD);
      const nCol = nameColIndex(headers);
      const dataStart = firstDataRow(ws, hRow);
      const rows = employees as unknown as Record<string, unknown>[];
      // ⚠️ 同样按原表顺序对齐（数据库表是所有 XLOOKUP 的数据源，行序乱了公式会指错）
      const aligned = alignToOriginalOrder(readOriginalOrder(ws, nCol, hRow), rows);
      let written = 0;
      if (nCol > 0) {
        for (let i = 0; i < aligned.length; i++) {
          const target = dataStart + i;
          const rec = aligned[i];
          const nm = ws.getCell(target, nCol);
          if (rec) {
            if (!isFormulaCell(nm)) nm.value = String(rec.name ?? "");
            written += writeRow(ws, target, colMap, employeeValueMap(rec, storeNames, posNames));
          } else {
            nm.value = null;
          }
        }
      }
      stats.push({
        sheet,
        rows: rows.length,
        written,
        note: `表头第 ${hRow} 行，映射 ${colMap.size}/${headers.length} 列`,
      });
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ④ 统计类 Sheet（编制/流失率/分布）：实时计算后整表重写 ----------
  stats.push(...(await writeStatSheets(wb)));

  // ---------- ⑤ 招聘面试登记表 / 薪资表：Excel 名单口径 + 回填最新档案数据 ----------
  stats.push(...(await writeRecruitAndSalarySheets(wb)));

  const out = await wb.xlsx.writeBuffer();
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    buffer: Buffer.from(out),
    filename: `途虎HR人员登记（导出于${stamp}）.xlsx`,
    stats,
  };
}


/**
 * 统计类 Sheet —— **全部实时计算写入**（Stage 9.39）
 *
 * 用户 2026-10-03 明确要求：
 * > 「我手动导出要是最新的，现在所有表都要跟软件里实时更新」
 *
 * 这三张表在软件里都是**实时算出来的**（数据库不落库），原 Excel 里则是**公式**：
 *   · 人员流失率       每行 5 个公式（SUMPRODUCT 统计离职/入职、算流失率、邀约数）
 *   · 门店人员分布明细  每行 8 个公式（按工种 XLOOKUP 拼人名）
 *   · 门店人员编制     现有人数 / 缺编 / 各类派生列
 *
 * 所以导出时：**调用与页面完全相同的计算服务**，把算出来的值替换掉公式。
 * 已实测：单独把普通公式格（`SUMPRODUCT(...)`）换成常量，写文件**不会崩**
 * （只有破坏 sharedFormula 母格才会崩，见 `setCellValue` 的注释）。
 */
async function writeStatSheets(wb: ExcelJS.Workbook): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];

  const [headcounts, dist, attrition] = await Promise.all([
    prisma.storeHeadcount.findMany({
      include: { store: { select: { name: true } } },
      orderBy: { sortOrder: "asc" },
    }),
    getDistribution(),
    getAttrition({ month: defaultMonth() }),
  ]);

  // 现有人数 + 缺编明细 —— **直接复用「门店人员编制」页的同一服务**，
  // 口径绝不各写一份（导出与页面看到的数字必须一致）
  const hc = await getStoreHeadcount();
  const hcByStore = new Map(hc.rows.map((r) => [r.storeName, r]));

  // ---------- ① 门店人员编制 ----------
  // 实测列序：1 序号 / 2 名称 / 3 店长 / 4 技术店长 / 5 副店长 / 6 客服经理 /
  //          7 机修现有 / 8 美容现有 / 9 后勤 / 10 当前合计人数 /
  //          11 客服经理满编 / 12 机修满编 / 13 美容满编 / 14 美容师傅满编 / 15 美容中小工满编
  {
    const sheet = "门店人员编制";
    const ws = wb.getWorksheet(sheet);
    if (ws && headcounts.length) {
      const hRow = HEADER_ROW[sheet] ?? 3;
      const dataStart = firstDataRow(ws, hRow);
      // ⚠️ 第 15 列（美容中小工满编）是共享公式区 O4:O15 —— **整列不能写**
      const SKIP = new Set([15]);
      let written = 0;
      for (let i = 0; i < headcounts.length; i++) {
        const h = headcounts[i];
        const target = dataStart + i;
        if (setCellValue(ws, target, 1, i + 1, SKIP)) written++;
        if (setCellValue(ws, target, 2, h.store.name, SKIP)) written++;

        // 现有人数（3~10 列）—— 实时 COUNT
        const st = hcByStore.get(h.store.name);
        if (st) {
          const c = st.current;
          const live: (number | null)[] = [
            c.manager,
            c.techManager,
            c.deputyManager,
            c.serviceManager,
            c.mechanic,
            c.beauty,
            c.logistics,
            c.total,
          ];
          for (let k = 0; k < live.length; k++) {
            if (setCellValue(ws, target, 3 + k, live[k], SKIP)) written++;
          }
        }

        // 满编（11~14 列，人工设置值）
        const full: (number | null | undefined)[] = [
          h.serviceManagerFull,
          h.mechanicFull,
          h.beautyFull,
          h.beautyMasterFull,
        ];
        for (let k = 0; k < full.length; k++) {
          const v = full[k];
          if (v === null || v === undefined) continue;
          if (setCellValue(ws, target, 11 + k, v, SKIP)) written++;
        }
        // ⚠️ 第 15 列（美容中小工满编）**整列都不能写**：
        //    实测它是 `{formula:"M4-N4", ref:"O4:O15", shareType:"shared"}` 的**共享公式区**，
        //    第 4 行是母格、第 5~15 行是克隆格。写母格会让所有克隆格失配 →
        //    `writeBuffer()` 抛 `Shared Formula master must exist above and or left of clone`。
        //    所以这列保留公式，让 Excel 自己算（= 美容满编 − 美容师傅满编，结果是对的）。
        // 16 现有美容师傅 / 17 现有美容中小工 / 18 缺编汇总 / 19 机修缺编 / 20 美容缺编 /
        // 21 客服经理缺编 / 22 具体缺编明细 —— 全部实时算（负数=超编，原样显示）
        if (st) {
          const gap: (number | string)[] = [
            st.current.beautyMaster,
            st.current.beautyJunior,
            st.gap.total,
            st.gap.mechanic,
            st.gap.beauty,
            st.gap.serviceManager,
            st.gap.detail,
          ];
          for (let k = 0; k < gap.length; k++) {
            if (setCellValue(ws, target, 16 + k, gap[k], SKIP)) written++;
          }
        }
      }
      out.push({
        sheet,
        rows: headcounts.length,
        written,
        note: "实时计算：现有人数按在职表实时 COUNT，满编取人工设置值",
      });
    } else {
      out.push({ sheet, rows: headcounts.length, written: 0, note: ws ? "无编制数据" : "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ② 门店人员分布明细 ----------
  // 实测列序（R2）：1 序号 / 2 门店 / 3 门店人数 / 4 店长 / 5 副店长 /
  //                6 技术店长 / 7 客服经理 / 8 后勤 / 9 机修 / 10 美容
  {
    const sheet = "门店人员分布明细";
    const ws = wb.getWorksheet(sheet);
    if (ws) {
      const hRow = HEADER_ROW[sheet] ?? 2;
      const dataStart = firstDataRow(ws, hRow);
      let written = 0;
      for (let i = 0; i < dist.rows.length; i++) {
        const r = dist.rows[i];
        const target = dataStart + i;
        if (setCellValue(ws, target, 1, i + 1)) written++;
        if (setCellValue(ws, target, 2, r.storeName)) written++;
        if (setCellValue(ws, target, 3, r.headcount)) written++;
        for (let k = 0; k < DISTRIBUTION_GRADES.length; k++) {
          const g = DISTRIBUTION_GRADES[k];
          const names = r.people[g.key] ?? [];
          if (setCellValue(ws, target, 4 + k, names.join("、"))) written++;
        }
      }
      out.push({
        sheet,
        rows: dist.rows.length,
        written,
        note: "实时计算：按在职表 + 职位/工种口径聚合（与软件「人员分布明细」页同一服务）",
      });
    } else {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ③ 人员流失率 ----------
  // 实测列序（R3）：1 序号 / 2 门店名称 / 3 店长 / 4 技术店长 / 5 副店长 /
  //                6 实时人数 / 7 当月离职 / 8 当月入职 / 9 流失率 / 10 邀约数量
  // ⚠️ 原表**一家门店占 1~2 行**（有副店长就多一行副店长行），A/B 列是合并单元格。
  //    这里按软件的行结构逐行写值，合并结构保持原样（不动 merges，避免破坏样式）。
  {
    const sheet = "人员流失率";
    const ws = wb.getWorksheet(sheet);
    if (ws) {
      const hRow = HEADER_ROW[sheet] ?? 3;
      const dataStart = firstDataRow(ws, hRow);
      let written = 0;
      let rowNo = 0;
      for (const r of attrition.rows) {
        const target = dataStart + rowNo;
        if (setCellValue(ws, target, 2, r.storeName)) written++;
        if (r.role === "STORE_MANAGER") {
          if (setCellValue(ws, target, 1, r.sortOrder)) written++;
          if (setCellValue(ws, target, 3, r.managers.storeManager ?? "")) written++;
          if (setCellValue(ws, target, 4, r.managers.techManager ?? "")) written++;
        } else {
          if (setCellValue(ws, target, 5, r.managers.deputyManager ?? "")) written++;
        }
        const vals: (number | string | null)[] = [
          r.monthStartHeadcount,
          r.monthResigned,
          r.monthHired,
          r.rate === null ? null : Number((r.rate * 100).toFixed(2)),
          r.invites,
        ];
        for (let k = 0; k < vals.length; k++) {
          if (setCellValue(ws, target, 6 + k, vals[k])) written++;
        }
        rowNo++;
      }
      out.push({
        sheet,
        rows: attrition.rows.length,
        written,
        note: `实时计算：默认月份 ${defaultMonth()}，月初人数/当月离职/当月入职/流失率/邀约数量全部按当前数据重算`,
      });
    } else {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  return out;
}

/**
 * 门店人员编制：按实测列序号（不是表头名）
 *
 * 依据实测 R3（字段名）/ R4~R5（真实值类型）：
 *   第 3~10 列  = **公式**（店长/技术店长/副店长/客服经理/机修现有/美容现有/后勤/当前合计，实时算）
 *   第 11 列 客服经理满编   = **常量** ✅ 人工填的，回填
 *   第 12 列 机修满编       = **常量** ✅ 回填
 *   第 13 列 美容满编       = **常量** ✅ 回填
 *   第 14 列 美容师傅满编   = **常量** ✅ 回填
 *   第 15 列 美容中小工满编 = **公式 `M4-N4`**，且它是 O4:O15 的**共享公式母格**
 *                              ⚠️ 覆盖它会让 O5~O39 的克隆格找不到母格，
 *                              写文件时直接抛 `Shared Formula master must exist...`
 *                              —— 所以**坚决不写**，让 Excel 自己算。
 *   第 16~22 列 = 公式（现有人数/缺编/明细），保留原样自动重算
 */
const HC_COLUMN_MAP = new Map<number, string>([
  [1, "sortOrder"],
  [2, "storeName"],
  [11, "serviceManagerFull"],
  [12, "mechanicFull"],
  [13, "beautyFull"],
  [14, "beautyMasterFull"],
]);

/**
 * 招聘面试登记表 / 薪资表 —— **Excel 原始名单口径 + 回填最新档案数据**（Stage 9.39）
 *
 * 这两张表在软件里的口径是「**以 Excel 原始名单为准**」（招聘面试 478 人、薪资 290 人，
 * 见 Stage 9 的约定），所以**不能按员工状态重新筛人** —— 那会把口径改掉。
 * 正确做法：
 *   ① 行集合 = `SheetRow` 镜像（原名单顺序、人数完全不变）
 *   ② 每行按 `SheetRowEmployeeLink.employeeId` 找到员工档案，**把最新值写回**
 *
 * 原表这两张表有大量 XLOOKUP 公式（去「数据库」表按姓名+日期/门店取值），
 * 导出时直接替换成算好的值 —— 这样即使在手机上看（无 Excel 公式引擎）也是最新的。
 */

/** 招聘面试登记表列序（实测 R3） */
const RECRUIT_COLUMNS: { col: number; field: string }[] = [
  { col: 2, field: "name" },
  { col: 3, field: "phone" },
  { col: 4, field: "jobGradeRaw" },
  { col: 6, field: "interviewDate" },
  { col: 7, field: "interviewLocation" },
  { col: 8, field: "interviewResult" },
  { col: 9, field: "interviewerName" },
  { col: 10, field: "interviewHired" },
  { col: 11, field: "hireDate" },
  { col: 12, field: "salaryTerms" },
  { col: 13, field: "docResume" },
  { col: 14, field: "docInterviewEvaluation" },
  { col: 15, field: "recruiterName" },
];

/** 薪资表列序（实测 R1）：第 6 列表头是合并单元格（「首月保障」跨两列），按位置取 */
const SALARY_COLUMNS: { col: number; field: string }[] = [
  { col: 2, field: "storeId" },
  { col: 3, field: "hireDate" },
  { col: 4, field: "name" },
  { col: 5, field: "jobGradeRaw" },
  { col: 6, field: "firstMonthGuarantee" },
  { col: 7, field: "salaryTerms" },
  { col: 8, field: "recruiterName" },
  { col: 9, field: "mentorName" },
  { col: 10, field: "docOnboardingForm" },
  { col: 11, field: "docInterviewEvaluation" },
  { col: 12, field: "certificateLevel" },
  { col: 13, field: "remark3" },
];

async function writeRecruitAndSalarySheets(wb: ExcelJS.Workbook): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];

  const spec: {
    sheet: string;
    headerRow: number;
    nameCol: number;
    cols: { col: number; field: string }[];
  }[] = [
    { sheet: "招聘面试登记表", headerRow: 3, nameCol: 2, cols: RECRUIT_COLUMNS },
    { sheet: "薪资表", headerRow: 1, nameCol: 4, cols: SALARY_COLUMNS },
  ];

  for (const sp of spec) {
    const ws = wb.getWorksheet(sp.sheet);
    if (!ws) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }
    try {
    try {
      // ① 行集合 = **SheetRow 原始镜像**（保持原名单口径与顺序）
      //    ⚠️ 不能用 loadEmployeeSheet()：它的 rowNo 是「员工 id / NEW_ROW_BASE」
      //       （供前端跳转与 React key 用，见 employee-sheet-service.ts 注释），
      //       **不是 Excel 行号** —— 拿它写 Excel 会写到完全无关的行上（踩过）。
      const mirror = await prisma.sheetRow.findMany({
        where: { sheet: sp.sheet },
        orderBy: { rowNo: "asc" },
      });
      if (mirror.length === 0) {
        out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "SheetRow 镜像为空（是否还没导入？）" });
        continue;
      }
      // ② 行 → 员工档案（SheetRowEmployeeLink，只在唯一命中时才建立）
      const links = await prisma.sheetRowEmployeeLink.findMany({ where: { sheet: sp.sheet } });
      // ⚠️ SheetRowEmployeeLink.employeeId 是**员工档案 id（Int）**，不是 THHR 工号
      const empIdByRow = new Map<number, number>(links.map((l) => [l.rowNo, l.employeeId]));
      const empIds: number[] = [...new Set(empIdByRow.values())];
      const emps = empIds.length
        ? await prisma.employee.findMany({
            where: { id: { in: empIds }, deletedAt: null },
            select: {
              id: true, employeeId: true, name: true, phone: true, jobGradeRaw: true,
              interviewDate: true, interviewLocation: true, interviewResult: true,
              interviewerName: true, interviewHired: true, hireDate: true,
              salaryTerms: true, firstMonthGuarantee: true, docResume: true,
              docInterviewEvaluation: true, docOnboardingForm: true, recruiterName: true,
              mentorName: true, certificateLevel: true, remark3: true, storeId: true,
            },
          })
        : [];
      const empMap = new Map<number, (typeof emps)[number]>(emps.map((e) => [e.id, e]));
      const storeNames = new Map(
        (await prisma.store.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name])
      );

      // ③ 逐行回填（**Excel 行号 = SheetRow.rowNo**，与原表严格一致）
      let written = 0;
      let matched = 0;
      for (const row of mirror) {
        const employeeId = empIdByRow.get(row.rowNo);
        if (!employeeId) continue; // 只来面试没入职的，没有档案可更新
        const e = empMap.get(employeeId);
        if (!e) continue;
        matched++;
        const vals: Record<string, unknown> = { ...e };
        if (e.storeId) vals.storeId = storeNames.get(e.storeId) ?? "";
        for (const c of sp.cols) {
          let v = vals[c.field];
          if (v === undefined || v === null || v === "") continue;
          if (c.field === "hireDate" || c.field === "interviewDate") {
            v = formatDate(v as Date);
          }
          if (setCellValue(ws, row.rowNo, c.col, v)) written++;
        }
      }
      out.push({
        sheet: sp.sheet,
        rows: mirror.length,
        written,
        note: `名单沿用 Excel 原始行（${mirror.length} 人不变），其中 ${matched} 人已建档并回填最新档案数据`,
      });
    } catch (e) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: `回填失败：${(e as Error).message.slice(0, 60)}` });
    }
      const loaded = await loadEmployeeSheet(sp.sheet);
      if (!loaded) {
        out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "未取到名单数据" });
        continue;
      }
      // ② 这些行对应的员工档案（一次性取全，避��� N+1）
      const empIds = loaded.rows.map((r) => r.employeeRef).filter((x): x is number => typeof x === "number");
      const emps = empIds.length
        ? await prisma.employee.findMany({
            where: { id: { in: empIds }, deletedAt: null },
            select: {
              id: true,
              name: true,
              phone: true,
              jobGradeRaw: true,
              interviewDate: true,
              interviewLocation: true,
              interviewResult: true,
              interviewerName: true,
              interviewHired: true,
              hireDate: true,
              salaryTerms: true,
              firstMonthGuarantee: true,
              docResume: true,
              docInterviewEvaluation: true,
              docOnboardingForm: true,
              recruiterName: true,
              mentorName: true,
              certificateLevel: true,
              remark3: true,
              storeId: true,
            },
          })
        : [];
      const empMap = new Map(emps.map((e) => [e.id, e]));
      const storeNames = new Map((await prisma.store.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));

      // ③ 逐行回填（Excel 行号 = SheetRow.rowNo，与原表一致）
      let written = 0;
      let matched = 0;
      for (const row of loaded.rows) {
        if (row.employeeRef === null) continue; // 只来面试没入职的，没有档案可更新
        const e = empMap.get(row.employeeRef);
        if (!e) continue;
        matched++;
        const vals: Record<string, unknown> = { ...e };
        if (e.storeId) vals.storeId = storeNames.get(e.storeId) ?? "";
        for (const c of sp.cols) {
          let v = vals[c.field];
          if (v === undefined || v === null || v === "") continue;
          if (c.field === "hireDate" || c.field === "interviewDate") {
            v = formatDate(v as Date);
          }
          if (setCellValue(ws, row.rowNo, c.col, v)) written++;
        }
      }
      out.push({
        sheet: sp.sheet,
        rows: loaded.rows.length,
        written,
        note: `名单沿用 Excel 原始行（${loaded.rows.length} 人不变），其中 ${matched} 人已建档并回填最新档案数据`,
      });
    } catch (e) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: `回填失败：${(e as Error).message.slice(0, 60)}` });
    }
  }

  return out;
}

export { HEADER_ROW, TITLE_TO_FIELD, normTitle, cellToText };