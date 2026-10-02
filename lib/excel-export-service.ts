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

  // ---------- ④ 统计类 Sheet（编制/流失率/分布）：库里有专门表，直接整表重写 ----------
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
  };
}


/** 统计类 Sheet：门店人员编制（实时计算视图「人员流失率/人员分布明细」不落库，导出保留原样） */
async function writeStatSheets(wb: ExcelJS.Workbook): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];
  const headcounts = await prisma.storeHeadcount.findMany({
    include: { store: { select: { name: true } } },
    orderBy: { sortOrder: "asc" },
  });

  // —— 门店人员编制：R3 = 字段名，22 列 ——
  // ⚠️ 只有「满编」相关的 6 列是**人工设置值**（StoreHeadcount），
  //    其余「现有人数」列是**实时算出来的**（按在职表 COUNT），
  //    而且原表那些格大多是公式 —— 所以只回填满编，其余保留公式让它自己算。
  {
    const sheet = "门店人员编制";
    const ws = wb.getWorksheet(sheet);
    if (ws && headcounts.length) {
      const hRow = HEADER_ROW[sheet] ?? 3;
      const colMap = HC_COLUMN_MAP; // 按实测列序号
      const dataStart = firstDataRow(ws, hRow);
      // 找出原表最后一行有门店名的行，好知道该写到哪
      let lastData = dataStart - 1;
      for (let r = dataStart; r <= ws.rowCount; r++) {
        if (cellToText(ws.getRow(r).getCell(2).value) !== "") lastData = r;
      }
      let written = 0;
      for (let i = 0; i < headcounts.length; i++) {
        const h = headcounts[i];
        const target = dataStart + i;
        const vals: Record<string, unknown> = {
          storeName: h.store.name,
          sortOrder: i + 1,
          serviceManagerFull: h.serviceManagerFull,
          mechanicFull: h.mechanicFull,
          beautyFull: h.beautyFull,
          beautyMasterFull: h.beautyMasterFull,
          beautyJuniorFull: h.beautyJuniorFull,
        };
        for (const [colNo, field] of colMap) {
          const v = vals[field];
          if (v === undefined || v === null || v === "") continue;
          ws.getCell(target, colNo).value = v as never;
          written++;
        }
      }
      void lastData;
      out.push({
        sheet,
        rows: headcounts.length,
        written,
        note: "仅回填满编（人工设置值）；现有人数是公式，保留原样自动重算",
      });
    } else {
      out.push({ sheet, rows: headcounts.length, written: 0, note: ws ? "无编制数据" : "Excel 里没有这个 Sheet" });
    }
  }

  // —— 人员流失率 / 人员分布明细：这两个是**实时计算视图**，数据库里不落库 ——
  for (const s of ["人员流失率", "门店人员分布明细"]) {
    const ws = wb.getWorksheet(s);
    out.push({
      sheet: s,
      rows: 0,
      written: 0,
      note: ws
        ? "⚠️ 实时计算的统计视图（库里不落库），导出文件保留原表原样未回填；请在软件里查看"
        : "Excel 里没有这个 Sheet",
    });
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

export { HEADER_ROW, TITLE_TO_FIELD, normTitle, cellToText };