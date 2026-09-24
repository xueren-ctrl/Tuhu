/**
 * ============================================================
 * 途虎加盟店 HR —— Excel 数据库迁移脚本
 * scripts/import-excel.ts
 *
 * 读取：途虎HR人员登记.xlsx 中的「数据库」Sheet
 * 流程：Excel → 数据清洗 → 字段映射 → Employee → SQLite
 *
 * 安全与保真原则（务必遵守）：
 *  1. 原始 Excel 只读，绝不写入 / 覆盖（脚本前后校验 SHA256）。
 *  2. 身份证号 / 银行卡号 / 手机号一律按【字符串】处理，
 *     禁止转数字，禁止丢前导零，禁止科学计数法，禁止截断。
 *  3. 空值统一转 null，不做猜测性填充。
 *  4. 可重复执行：以身份证号优先匹配已有员工，不会无限重复创建。
 *  5. 所有异常记录到 ImportIssue 表并写入 docs/import-report.md，不静默处理。
 * ============================================================
 */

import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

// ---- 共享解析底座（第五阶段）：解析/归一化/状态判定只有这一份实现 ----
import type { EmployeeRecord, EmployeeStatus, ParseIssue } from "../lib/excel-import/types";
import { parseWorkbook } from "../lib/excel-import/parser";
import { dateFromIso } from "../lib/excel-import/normalization";
import { SPEC_BY_FIELD, STORED_SPECS } from "../lib/excel-import/field-mapping";
// Stage 7.1.5（P0）：门店解析统一入口（ACTIVE 门店 > 指向 ACTIVE 门店的别名 > null）
import { resolveStoreNamesBatch } from "../lib/store-service";
type Issue = ParseIssue;

// ------------------------------------------------------------
// 配置
// ------------------------------------------------------------
const ROOT = process.cwd();
const EXCEL_PATH =
  process.env.EXCEL_SOURCE_PATH?.trim() ||
  path.join(ROOT, "途虎HR人员登记.xlsx");
const DB_SHEET = "数据库";
const ROSTER_ACTIVE_SHEET = "在职";
const ROSTER_RESIGNED_SHEET = "离职";
const HEADER_ROW = 2; // 「数据库」Sheet 第 1 行是上一版本残留，第 2 行才是表头
const DATA_START_ROW = 3;
const EMPLOYEE_ID_PREFIX = process.env.EMPLOYEE_ID_PREFIX?.trim() || "THHR";

const prisma = new PrismaClient();

// ------------------------------------------------------------
// ------------------------------------------------------------
// 解析：统一走共享底座 lib/excel-import（第五阶段）
//
// 正式导入与导入预览严禁各自实现一套解析 —— 曾经的两套实现导致预览
// 漏掉「离职名册交叉比对」与「合并单元格防护」，差点把 171 名离职员工改回在职。
// 本脚本只保留「写入数据库」这半段；列映射、归一化、状态判定、异常收集
// 全部来自 lib/excel-import。
// ------------------------------------------------------------

/** 把日期格式化为 yyyy-MM-dd（统一 UTC 取值，避免时区串日） */
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const RE_ID18 = /^\d{17}[\dX]$/;

/** 写入阶段使用的行结构（由共享解析结果转换而来） */
interface ParsedRow {
  row: number;
  seqNo: number | null;
  name: string | null;
  /** 18 位规范身份证（可用于去重） */
  idCardKey: string | null;
  /** 原始身份证值（可能是 15/16/17 位等不完整值） */
  idCardRaw: string | null;
  phone: string | null;
  storeNameRaw: string | null;
  jobGradeRaw: string | null;
  hireDate: Date | null;
  status: EmployeeStatus;
  resignDate: Date | null;
  resignDateRaw: string | null;
  resignReason: string | null;
  dataFlags: string[];
  fields: Record<string, string | number | Date | null>;
}

/**
 * 共享解析结果 → 写入结构。
 * 只有在这里才把日期转成 Date（写库需要）；其余值与预览看到的完全一致。
 */
function toParsedRow(r: EmployeeRecord): ParsedRow {
  const fields: Record<string, string | number | Date | null> = {};
  for (const [k, v] of Object.entries(r.values)) {
    // hireDate / resignDate 由写入逻辑显式设置，不重复放 fields
    if (k === "hireDate" || k === "resignDate") continue;
    const kind = SPEC_BY_FIELD.get(k)?.kind;
    fields[k] = kind === "date" ? dateFromIso(v as string | null) : v;
  }
  return {
    row: r.rowNo,
    seqNo: r.seqNo,
    name: r.name,
    idCardKey: r.idCardKey,
    idCardRaw: (r.values.idCardNo as string | null) ?? null,
    phone: r.phone,
    storeNameRaw: r.storeNameRaw,
    jobGradeRaw: r.jobGradeRaw,
    hireDate: dateFromIso(r.hireDate),
    status: r.status,
    resignDate: dateFromIso(r.resignDate),
    resignDateRaw: (r.values.resignDateRaw as string | null) ?? null,
    resignReason: (r.values.resignReason as string | null) ?? null,
    dataFlags: r.dataFlags,
    fields,
  };
}


// ------------------------------------------------------------
// 「未变化」判定（第五阶段 · 需求 7）
//
// 幂等重跑时，绝大多数行会匹配到已有员工但字段完全一致 —— 这类行不应计为
// 「更新」（否则每次重跑都产生 1920 条无意义的写库）。这里一次性加载全量员工
// 快照到内存，逐行比对，命中则计为「未变化」并跳过写入，不增加任何额外的
// 逐行数据库查询。
// ------------------------------------------------------------

/** 写库比对所用字段快照（一次性全量加载，内存比对） */
const SNAP_SELECT: Record<string, boolean> = (() => {
  const s: Record<string, boolean> = {
    name: true,
    idCardNo: true,
    phone: true,
    storeId: true,
    positionId: true,
    hireDate: true,
    sourceRowNo: true,
    sourceSheet: true,
    dataFlags: true,
  };
  for (const sp of STORED_SPECS) s[sp.field] = true;
  return s;
})();

/** findUnique 后用于补齐检索索引的最小字段集 */
const AFTER_SELECT = {
  id: true,
  name: true,
  idCardNo: true,
  phone: true,
  hireDate: true,
  sourceRowNo: true,
  sourceSheet: true,
} as const;

/** 归一化用于比对：null/undefined → ""，Date → yyyy-MM-dd，其余去空格 */
function cmpVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/**
 * 判断「写入数据 data」与「库内快照 snap」是否完全一致。
 * 只比内容字段（STORED_SPECS + 两个外键），不比 importBatch / deletedAt 等
 * 运行期字段 —— 否则每次重跑都会因批次号不同而被误判为「已更新」。
 */
function dataIsUnchanged(data: Record<string, unknown>, snap: Record<string, unknown>): boolean {
  for (const sp of STORED_SPECS) {
    if (cmpVal(data[sp.field]) !== cmpVal(snap[sp.field])) return false;
  }
  for (const fk of ["storeId", "positionId"]) {
    if (cmpVal(data[fk]) !== cmpVal(snap[fk])) return false;
  }
  return true;
}

// ------------------------------------------------------------
// employee_id 分配器（脚本内批量分配，性能可控且不撞号）
// ------------------------------------------------------------
async function createIdAllocator(year: number) {
  const prefix = `${EMPLOYEE_ID_PREFIX}${year}`;
  const existing = await prisma.employee.findMany({
    where: { employeeId: { startsWith: prefix } },
    select: { employeeId: true },
  });
  let maxSeq = 0;
  for (const e of existing) {
    const m = /^([A-Z]+)(\d{4})(\d{6})$/.exec(e.employeeId);
    if (m && Number(m[2]) === year) maxSeq = Math.max(maxSeq, Number(m[3]));
  }
  const counter = await prisma.employeeIdCounter.findUnique({ where: { year } });
  let next = Math.max(maxSeq, counter?.lastValue ?? 0);

  return {
    alloc(): string {
      next += 1;
      return `${prefix}${String(next).padStart(6, "0")}`;
    },
    async persist() {
      await prisma.employeeIdCounter.upsert({
        where: { year },
        create: { year, lastValue: next },
        update: { lastValue: next },
      });
    },
    current: () => next,
  };
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  const batchId = `IMP-${startedAt
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;

  console.log("═".repeat(72));
  console.log("途虎加盟店 HR —— Excel 数据库迁移");
  console.log("═".repeat(72));
  console.log(`源文件   : ${EXCEL_PATH}`);
  console.log(`目标     : SQLite (${process.env.DATABASE_URL ?? "未设置"})`);
  console.log(`批次号   : ${batchId}`);

  // ---- 0. 校验源文件存在 + 记录 SHA256（前后对比，证明未被修改） ----
  let shaBefore = "";
  try {
    const buf = await readFile(EXCEL_PATH);
    shaBefore = createHash("sha256").update(buf).digest("hex");
  } catch {
    console.error(`✗ 找不到原始 Excel：${EXCEL_PATH}`);
    console.error("  请确认路径，或在 .env 中设置 EXCEL_SOURCE_PATH");
    process.exit(1);
  }
  console.log(`SHA256   : ${shaBefore}`);
  console.log("");

  const issues: Issue[] = [];
  const addIssue = (i: Issue) => issues.push(i);

  // ---- 可选：--reset 先清空历史导入数据（仅用于重新建立基线） ----
  //  会删除：全部员工记录、导入批次、导入异常、员工编号计数器，
  //          以及【没有任何员工关联】的门店/职位主数据。
  //  不会删除：有员工关联的门店/职位、字典、审计日志。
  const RESET = process.argv.includes("--reset");
  if (RESET) {
    const before = await prisma.employee.count();
    const orphanStores = await prisma.store.findMany({
      where: { employees: { none: {} } },
      select: { name: true },
    });
    const orphanPositions = await prisma.position.findMany({
      where: { employees: { none: {} } },
      select: { name: true },
    });
    console.log("");
    console.log("⚠ --reset 已启用：将清空全部员工记录与导入历史，重新建立迁移基线");
    await prisma.importIssue.deleteMany({});
    await prisma.importBatch.deleteMany({});
    await prisma.employeeSourceRow.deleteMany({});
    await prisma.employee.deleteMany({});
    await prisma.employeeIdCounter.deleteMany({});
    await prisma.store.deleteMany({ where: { employees: { none: {} } } });
    await prisma.position.deleteMany({ where: { employees: { none: {} } } });
    console.log(`  已删除员工 ${before} 人，导入批次与异常明细已清空，编号计数器已归零`);
    console.log(
      `  已清理无员工关联的门店 ${orphanStores.length} 个、职位 ${orphanPositions.length} 个`
    );
    if (orphanStores.length) {
      console.log(`    （这些是 Excel 表尾说明行误产生的垃圾主数据，已逐项列出）`);
      console.log(`    门店：${orphanStores.map((s) => s.name).join(" · ")}`);
    }
    if (orphanPositions.length) {
      console.log(`    职位：${orphanPositions.map((p) => p.name).join(" · ")}`);
    }
    console.log("");
  }

  // ---- 1. 读取 Excel（只读）+ 共享解析 ----
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);

  // 表头校验、名册读取、逐行解析、异常收集全部在共享底座内完成，
  // 与「导入预览」是同一份代码 —— 不存在两套口径。
  const parseResult = parseWorkbook(wb);
  if (!parseResult.ok) {
    console.error(`✗ ${parseResult.error ?? "解析失败"}`);
    process.exit(1);
  }
  console.log(
    `✓ 已读取「${DB_SHEET}」Sheet：数据区 ${parseResult.totalRows} 行 × 46 列（表头校验已通过）`
  );

  const rosterActive = parseResult.rosterActive;
  const rosterResigned = parseResult.rosterResigned;
  console.log(
    `✓ 名册读取：「在职」${rosterActive.size} 人 · 「离职」${rosterResigned.size} 人（仅用于辅助判定状态，数据仍以「数据库」Sheet 为准）`
  );
  console.log("");

  // ---- 2. 解析结果 → 写入结构 ----
  const parsed: ParsedRow[] = parseResult.rows.map(toParsedRow);
  const rowsSkipped: { row: number; reason: string }[] = parseResult.skipped;
  // 解析期异常（列错位 / 身份证异常 / 日期无法解析 / 源数据未提供 等）全部并入报告
  issues.push(...parseResult.issues);

  console.log(`✓ 解析完成：有效行 ${parsed.length}，跳过 ${rowsSkipped.length} 行`);
  console.log("");
  console.log("");

  // ---- 5. 建立门店 / 职位 主数据（保留 Excel 历史取值） ----
  const storeNames = Array.from(
    new Set(parsed.map((p) => p.storeNameRaw).filter((v): v is string => !!v))
  ).sort();
  const jobGrades = Array.from(
    new Set(parsed.map((p) => p.jobGradeRaw).filter((v): v is string => !!v))
  ).sort();

  // Stage 7.1.5（P0）：门店归属统一走 resolveStoreNamesBatch，**绝不 upsert 复活 INACTIVE 门店**。
  //   优先级（与预览 / diff.ts 完全一致）：
  //     ① ACTIVE 同名门店 → 用其 storeId
  //     ② 指向 ACTIVE 门店的别名 → 用别名的 storeId
  //   其余一律 storeId = null 并分流：
  //     - not-found：库里既无同名门店也无别名 → 按既有导入规则新建 ACTIVE Store（保留 Excel 历史取值）
  //     - inactive-no-alias：存在已停用同名门店但无有效别名 → 不重绑、不复活，记 STORE_UNRESOLVED 交人工
  const storeResolutions = await resolveStoreNamesBatch(storeNames);
  const storeIdByName = new Map<string, number | null>();
  let createdStores = 0;
  let unresolvedStores = 0;
  for (const nm of storeNames) {
    const res = storeResolutions.get(nm) ?? { storeId: null, matchedBy: "not-found" as const };
    if (res.matchedBy === "name" || res.matchedBy === "alias") {
      // ①/② 有效归属目标（ACTIVE 门店 / 指向 ACTIVE 门店的别名）
      storeIdByName.set(nm, res.storeId);
    } else if (res.matchedBy === "not-found") {
      // 库里既无同名门店也无别名 → 新建 ACTIVE Store（既有行为）
      const s = await prisma.store.create({ data: { name: nm, status: "ACTIVE" } });
      storeIdByName.set(nm, s.id);
      createdStores++;
    } else {
      // inactive-no-alias：存在已停用同名门店、无有效别名。
      // 严禁把已合并停用的旧门店重新当导入目标 / 重新激活：storeId 置空并记明确异常。
      storeIdByName.set(nm, null);
      unresolvedStores++;
      addIssue({
        row: null,
        name: null,
        field: "门店",
        rawValue: nm,
        type: "STORE_UNRESOLVED",
        severity: "WARN",
        message:
          `门店原文「${nm}」对应一家已停用（INACTIVE）的门店，且没有指向有效门店的别名；` +
          `为避免把员工错误挂回已停用门店，本次导入已将 storeId 置空，请在「门店管理」中处理后再重新导入`,
      });
    }
  }
  const positionIdByName = new Map<string, number>();
  for (const [i, nm] of jobGrades.entries()) {
    const p = await prisma.position.upsert({
      where: { name: nm },
      create: { name: nm, sortOrder: i, status: "ACTIVE" },
      update: {},
      select: { id: true },
    });
    positionIdByName.set(nm, p.id);
  }
  console.log(
    `✓ 基础数据：门店 ${storeNames.length} 个（新建 ${createdStores} · 需人工处理 ${unresolvedStores}） · 职位/工种 ${jobGrades.length} 个`
  );
  if (unresolvedStores > 0) {
    console.log(
      `  ⚠ ${unresolvedStores} 个门店原文对应已停用门店且无有效别名，已置空 storeId 并记 STORE_UNRESOLVED（不自动复活/重绑）`
    );
  }
  console.log("");

  // ---- 6. 幂等导入 ----
  const importYear = new Date().getFullYear();
  const alloc = await createIdAllocator(importYear);

  // 现有员工索引（用于去重）
  const existing = await prisma.employee.findMany({
    select: {
      id: true,
      employeeId: true,
      name: true,
      idCardNo: true,
      phone: true,
      hireDate: true,
      sourceRowNo: true,
      sourceSheet: true,
    },
  });
  // ── 去重索引 ────────────────────────────────────────────────
  // 设计要点：身份证号【不能单独】作为唯一键。
  // 实测「数据库」Sheet 中有 118 个身份证号对应 2~3 条记录，其中绝大多数
  // 入职日期不同 —— 这些是「重新入职」，是真实的多次任职记录，
  // 若按身份证号合并就会丢失历史任职，违反「原 Excel 数据必须保留完整」。
  // 因此主键为「身份证号 + 入职日期」。
  const byIdHire = new Map<string, number>(); // idCard|hireISO -> empId
  const byNameHire = new Map<string, number>(); // name|hireISO -> empId
  const byNamePhone = new Map<string, number>(); // name|phone   -> empId
  const idToIds = new Map<string, Set<number>>(); // idCard -> 全部 empId
  const idSingle = new Map<string, number>(); // idCard -> empId（仅当唯一）
  const idCardsWithHire = new Set<string>(); // 有入职日期的身份证号
  const hireByEmpId = new Map<number, string | null>(); // empId -> 当前入职日期
  // 溯源键：来源 Sheet + 原始行号，持久化在 EmployeeSourceRow 表。
  // 这是「没有任何业务去重键」的行的最后兜底，也是重复执行导入幂等性的保证。
  const bySourceRow = new Map<string, number>();
  // 本次运行需要写入的溯源映射（行号 -> empId），最后批量落库
  const sourceRowWrites = new Map<string, { employeeId: number; rowNo: number }>();

  /** 登记一个已有 / 刚创建的员工，维护全部索引 */
  const registerEmployee = (e: {
    id: number;
    name: string;
    idCardNo: string | null;
    phone: string | null;
    hireDate: Date | null;
    sourceRowNo?: number | null;
    sourceSheet?: string | null;
  }) => {
    const hireIso = e.hireDate ? isoDate(e.hireDate) : null;
    const idKey =
      e.idCardNo && RE_ID18.test(e.idCardNo) ? e.idCardNo : null;

    if (e.sourceRowNo != null) {
      bySourceRow.set(`${e.sourceSheet ?? DB_SHEET}|${e.sourceRowNo}`, e.id);
    }
    if (idKey) {
      if (hireIso) byIdHire.set(`${idKey}|${hireIso}`, e.id);
      const set = idToIds.get(idKey) ?? new Set<number>();
      set.add(e.id);
      idToIds.set(idKey, set);
      if (set.size === 1) idSingle.set(idKey, e.id);
      else idSingle.delete(idKey); // 出现多条 → 不再视为唯一
      if (hireIso) idCardsWithHire.add(idKey);
    }
    if (hireIso) byNameHire.set(`${e.name}|${hireIso}`, e.id);
    if (e.phone) byNamePhone.set(`${e.name}|${e.phone}`, e.id);
    hireByEmpId.set(e.id, hireIso);
  };

  for (const e of existing) registerEmployee(e);

  // 一次性加载全量员工快照（仅用于「未变化」比对，避免逐行查询）
  const snapshotById = new Map<number, any>();
  {
    const all = await prisma.employee.findMany({
      where: { deletedAt: null },
      select: SNAP_SELECT,
    });
    for (const e of all as any[]) {
      snapshotById.set(e.id as number, e);
    }
  }

  // 从 EmployeeSourceRow 表恢复「Excel 行号 → 员工」的完整映射，
  // 这是保证重复执行导入幂等的关键：一行 Excel 一旦有归属，下次必定还能找到。
  const existingSourceRows = await prisma.employeeSourceRow.findMany({
    where: { sheet: DB_SHEET },
    select: { rowNo: true, employeeId: true },
  });
  for (const s of existingSourceRows) {
    bySourceRow.set(`${DB_SHEET}|${s.rowNo}`, s.employeeId);
  }

  // 身份证号重复情况的摸底（导入前，仅用于控制台提示）
  const dupIdCardsInDb = Array.from(idToIds.entries()).filter(
    ([, s]) => s.size > 1
  ).length;

  console.log(
    `✓ 现有员工 ${existing.length} 人（去重索引：身份证+入职 ${byIdHire.size} · 姓名+入职 ${byNameHire.size} · 姓名+电话 ${byNamePhone.size} · 溯源行 ${bySourceRow.size}）`
  );
  if (dupIdCardsInDb > 0) {
    console.log(
      `  ℹ 库中已有 ${dupIdCardsInDb} 个身份证号对应多条任职记录（重新入职），按「身份证+入职日期」区分保留`
    );
  }
  console.log("");

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let duplicated = 0;
  let failed = 0;
  let matchByIdCardHire = 0;
  let matchByIdCardOnly = 0;
  let matchByNameHire = 0;
  let matchByNamePhone = 0;
  let matchBySourceRow = 0;
  let noKeyCount = 0;
  const statusStat = { ACTIVE: 0, RESIGNED: 0, CANDIDATE: 0 };
  /** 本次运行已“落地”过的员工 id，用于识别运行内重复行 */
  const touchedThisRun = new Map<number, number>(); // empId -> 首次出现的 Excel 行号
  /** 库中已有员工却仍然新建的行（用于审计重复风险） */
  const newOnRerun: {
    row: number;
    name: string;
    hasId: boolean;
    hasHire: boolean;
    hasPhone: boolean;
  }[] = [];

  for (const p of parsed) {
    statusStat[p.status] += 1;

    const hireIso = p.hireDate ? isoDate(p.hireDate) : null;
    const hireKey = `${p.name}|${hireIso ?? ""}`;
    const phoneKey = p.phone ? `${p.name}|${p.phone}` : null;

    let targetId: number | null = null;
    let matchedBy:
      | "idCardHire"
      | "idCardOnly"
      | "nameHire"
      | "namePhone"
      | "sourceRow"
      | null = null;

    // ① 身份证号 + 入职日期 —— 最可靠，可区分同一人的多次入职
    if (p.idCardKey && hireIso) {
      const v = byIdHire.get(`${p.idCardKey}|${hireIso}`);
      if (v !== undefined) {
        targetId = v;
        matchedBy = "idCardHire";
        matchByIdCardHire++;
      }
    }

    // ② 身份证号（唯一记录）—— 仅当该身份证在库中只对应 1 条记录、
    //    且该记录缺少入职日期（或本行缺少入职日期）时使用，避免错误合并
    if (targetId === null && p.idCardKey && idSingle.has(p.idCardKey)) {
      const single = idSingle.get(p.idCardKey)!;
      if (!hireIso) {
        targetId = single;
        matchedBy = "idCardOnly";
        matchByIdCardOnly++;
        addIssue({
          row: p.row,
          name: p.name,
          field: "入职时间",
          rawValue: null,
          type: "FALLBACK_MATCH",
          severity: "WARN",
          message: "本行入职日期缺失，已按「身份证号（库中唯一）」匹配到已有员工（谨慎策略）",
        });
      } else if (!idCardsWithHire.has(p.idCardKey)) {
        // 唯一记录没有入职日期 → 安全补录
        targetId = single;
        matchedBy = "idCardOnly";
        matchByIdCardOnly++;
        addIssue({
          row: p.row,
          name: p.name,
          field: "入职时间",
          rawValue: null,
          type: "FALLBACK_MATCH",
          severity: "WARN",
          message: "库中该身份证记录缺少入职日期，已按「身份证号（库中唯一）」匹配并补录入职日期",
        });
      }
      // 否则：该身份证已有带入职日期的记录但日期不一致 → 视为「重新入职」，新建记录
    }

    // ③ 姓名 + 入职日期
    if (targetId === null && hireIso) {
      const v = byNameHire.get(hireKey);
      if (v !== undefined) {
        targetId = v;
        matchedBy = "nameHire";
        matchByNameHire++;
        addIssue({
          row: p.row,
          name: p.name,
          field: "身份证号",
          rawValue: null,
          type: "FALLBACK_MATCH",
          severity: "WARN",
          message: "身份证号缺失，已回退用「姓名+入职日期」匹配到已有员工（谨慎策略）",
        });
      }
    }

    // ④ 姓名 + 电话 —— 严格限制：仅当候选记录的入职日期未知(null)时才匹配。
    //    若候选记录已有入职日期且与本行不同，那是另一段任职（重新入职），
    //    必须新建记录而不能合并，否则会丢失历史任职数据。
    if (targetId === null && phoneKey) {
      const v = byNamePhone.get(phoneKey);
      if (v !== undefined && hireByEmpId.get(v) === null) {
        targetId = v;
        matchedBy = "namePhone";
        matchByNamePhone++;
        addIssue({
          row: p.row,
          name: p.name,
          field: "身份证号",
          rawValue: null,
          type: "FALLBACK_MATCH",
          severity: "WARN",
          message:
            "身份证号与入职日期均不足，已回退用「姓名+电话」匹配到一条入职日期为空的已有员工（谨慎策略）",
        });
      }
    }

    // ⑤ 溯源键兜底：来源 Sheet + 原始行号
    //    用于「没有任何业务去重键」的行，保证重复执行导入不会重复创建员工。
    //    注意：若有人手工在 Excel 中插入/删除行，行号会整体位移，
    //    此时该兜底可能失效 —— 因此仍强烈建议尽快补录身份证号。
    if (targetId === null) {
      const v = bySourceRow.get(`${DB_SHEET}|${p.row}`);
      if (v !== undefined) {
        targetId = v;
        matchedBy = "sourceRow";
        matchBySourceRow++;
        addIssue({
          row: p.row,
          name: p.name,
          field: null,
          rawValue: `来源行 ${p.row}`,
          type: "OTHER",
          severity: "WARN",
          message:
            "无身份证号/入职日期/电话等业务去重键，已按「来源 Sheet + 原始行号」溯源键匹配到同一条记录（保证重复执行导入幂等）",
        });
      }
    }

    // 记录：本次运行内是否已经落地过这条记录（真正的重复行）
    let inRunDup = false;
    if (targetId !== null && touchedThisRun.has(targetId)) {
      inRunDup = true;
      duplicated++;
      addIssue({
        row: p.row,
        name: p.name,
        field: null,
        // 不写姓名，避免敏感信息进入异常表
        rawValue: p.idCardKey ? "身份证+入职日期" : "姓名+入职日期",
        type: "DUPLICATE_KEY",
        severity: "WARN",
        message: `与本次导入的第 ${touchedThisRun.get(targetId)} 行是同一人同一段任职（姓名、入职日期、身份证号一致），已合并为同一条员工记录，取最后一次出现的值`,
      });
    }

    // 无任何可用去重键
    if (targetId === null && !p.idCardKey && !hireIso && !phoneKey) {
      noKeyCount++;
      addIssue({
        row: p.row,
        name: p.name,
        field: null,
        rawValue: null,
        type: "OTHER",
        severity: "WARN",
        message:
          "身份证号 / 入职日期 / 电话均缺失，无任何可用去重键，已作为新员工插入；重复执行导入可能产生重复记录，请尽快补录身份证号",
      });
    }

    // 审计：在「已有员工」的前提下仍要新建记录 —— 说明该行无法被任何键匹配，
    // 逐条记录行号，便于人工核查是否产生重复。
    if (targetId === null && existing.length > 0) {
      newOnRerun.push({ row: p.row, name: p.name ?? "", hasId: !!p.idCardKey, hasHire: !!hireIso, hasPhone: !!phoneKey });
      addIssue({
        row: p.row,
        name: p.name,
        field: null,
        // 注意：这里绝不写入完整身份证号/手机号原文，只写「有没有该字段」
        rawValue: JSON.stringify({
          hasIdCard: !!p.idCardKey,
          hasHireDate: !!hireIso,
          hasPhone: !!phoneKey,
        }),
        type: "OTHER",
        severity: "WARN",
        message:
          "库中已有员工，但本行无法被任何去重键（含溯源键）匹配，已新建记录。请人工核对是否为重复员工",
      });
    }

    // 身份证号重复但入职日期不一致 → 明确说明按重新入职处理
    if (
      targetId === null &&
      p.idCardKey &&
      hireIso &&
      (idToIds.get(p.idCardKey)?.size ?? 0) > 0 &&
      !byIdHire.has(`${p.idCardKey}|${hireIso}`)
    ) {
      addIssue({
        row: p.row,
        name: p.name,
        field: "入职日期",
        rawValue: hireIso,
        type: "DUPLICATE_KEY",
        severity: "WARN",
        message:
          "同一身份证号已存在其他入职日期的任职记录，本次按【重新入职】新建一条独立任职记录（未合并，避免丢失历史任职）",
      });
    }

    // 组装写入数据
    const storeId = p.storeNameRaw ? (storeIdByName.get(p.storeNameRaw) ?? null) : null;
    const positionId = p.jobGradeRaw
      ? (positionIdByName.get(p.jobGradeRaw) ?? null)
      : null;

    const data = {
      name: p.name!,
      idCardNo: p.idCardRaw,
      phone: p.phone,
      storeId,
      positionId,
      hireDate: p.hireDate,
      status: p.status,
      resignDate: p.resignDate,
      resignDateRaw: p.resignDateRaw,
      resignReason: p.resignReason,
      sourceSheet: DB_SHEET,
      sourceRowNo: p.row,
      importBatch: batchId,
      dataFlags: p.dataFlags.length ? JSON.stringify(p.dataFlags) : null,
      deletedAt: null,
      ...p.fields,
    } as Record<string, unknown>;

    // 更新已有员工时保留「首次来源行号」，不随重复行漂移（完整映射见 EmployeeSourceRow）
    if (targetId !== null) delete data.sourceRowNo;

    // 无论新增还是更新，都登记「该 Excel 行 → 员工」的溯源映射
    let resolvedId: number | null = null;

    try {
      if (targetId === null) {
        const employeeId = alloc.alloc();
        const created = await prisma.employee.create({
          data: {
            ...data,
            employeeId,
          } as unknown as Prisma.EmployeeUncheckedCreateInput,
        });
        registerEmployee({
          id: created.id,
          name: created.name,
          idCardNo: created.idCardNo,
          phone: created.phone,
          hireDate: created.hireDate,
          sourceRowNo: created.sourceRowNo,
          sourceSheet: created.sourceSheet,
        });
        touchedThisRun.set(created.id, p.row);
        resolvedId = created.id;
        inserted++;
      } else {
        const snap = snapshotById.get(targetId);
        const isUnchanged = snap ? dataIsUnchanged(data, snap) : false;
        let after: any = snap;
        if (!isUnchanged) {
          await prisma.employee.update({ where: { id: targetId }, data: data as never });
          // 目标已存在：补齐索引（身份证 / 电话可能在本行才出现）
          after = (await prisma.employee.findUnique({
            where: { id: targetId },
            select: AFTER_SELECT,
          })) as any;
          if (!inRunDup) updated++;
        } else {
          // 匹配到已有员工且所有字段完全一致 → 未变化，跳过写入
          unchanged++;
        }
        if (after) registerEmployee(after);
        if (!touchedThisRun.has(targetId)) touchedThisRun.set(targetId, p.row);
        resolvedId = targetId;
      }
    } catch (e) {
      failed++;
      addIssue({
        row: p.row,
        name: p.name,
        field: null,
        rawValue: null,
        type: "OTHER",
        severity: "ERROR",
        message: `写入失败：${(e as Error).message}`,
      });
    }

    if (resolvedId !== null) {
      sourceRowWrites.set(`${DB_SHEET}|${p.row}`, {
        employeeId: resolvedId,
        rowNo: p.row,
      });
      bySourceRow.set(`${DB_SHEET}|${p.row}`, resolvedId);
    }
    void matchedBy;
  }

  await alloc.persist();

  // ---- 6.1 持久化「Excel 行 → 员工」溯源映射（保证重复执行导入幂等） ----
  const srcList = Array.from(sourceRowWrites.values());
  const SRC_CHUNK = 400;
  for (let i = 0; i < srcList.length; i += SRC_CHUNK) {
    await prisma.$transaction(
      srcList.slice(i, i + SRC_CHUNK).map((s) =>
        prisma.employeeSourceRow.upsert({
          where: { sheet_rowNo: { sheet: DB_SHEET, rowNo: s.rowNo } },
          create: {
            employeeId: s.employeeId,
            sheet: DB_SHEET,
            rowNo: s.rowNo,
            batchId,
          },
          update: { employeeId: s.employeeId },
        })
      )
    );
  }
  const totalSourceRows = await prisma.employeeSourceRow.count();
  console.log(
    `✓ 溯源映射已落库：本次登记 ${srcList.length} 条，累计 ${totalSourceRows} 条（Excel 行 → 员工）`
  );
  console.log("");

  console.log("── 导入结果 ──────────────────────────────");
  console.log(`  新增      : ${inserted}`);
  console.log(`  更新      : ${updated}`);
  console.log(`  未变化    : ${unchanged}`);
  console.log(`  运行内重复: ${duplicated}`);
  console.log(`  跳过      : ${rowsSkipped.length}`);
  console.log(`  失败      : ${failed}`);
  console.log(
    `  匹配来源  : 身份证+入职 ${matchByIdCardHire} / 身份证(唯一) ${matchByIdCardOnly} / 姓名+入职 ${matchByNameHire} / 姓名+电话 ${matchByNamePhone} / 来源行号 ${matchBySourceRow}`
  );
  if (newOnRerun.length) {
    console.log("");
    console.log(`  ⚠ 库中已有员工，仍有 ${newOnRerun.length} 行无法被任何键匹配而新建：`);
    newOnRerun.forEach((x) =>
      console.log(
        `     行${x.row} ${x.name}  有身份证=${x.hasId} 有入职日期=${x.hasHire} 有电话=${x.hasPhone}`
      )
    );
    console.log("     这些行已记入 ImportIssue，请人工核对是否重复。");
  }
  console.log("");

  // ---- 7. 结束状态 ----
  const afterStats = {
    total: await prisma.employee.count(),
    active: await prisma.employee.count({ where: { status: "ACTIVE" } }),
    resigned: await prisma.employee.count({ where: { status: "RESIGNED" } }),
    candidate: await prisma.employee.count({ where: { status: "CANDIDATE" } }),
    stores: await prisma.store.count(),
    positions: await prisma.position.count(),
  };

  // 导入完成后，统计「同一身份证号对应多条任职记录」的真实数量（重新入职）
  const finalIdCards = await prisma.employee.groupBy({
    by: ["idCardNo"],
    where: { idCardNo: { not: null }, deletedAt: null },
    _count: { _all: true },
  });
  const dupIdCards = finalIdCards.filter(
    (g) => g._count._all > 1 && g.idCardNo && RE_ID18.test(g.idCardNo)
  ).length;
  const rehireExtra = finalIdCards.reduce(
    (s, g) =>
      s +
      (g.idCardNo && RE_ID18.test(g.idCardNo) && g._count._all > 1
        ? g._count._all - 1
        : 0),
    0
  );

  // ---- 8. 校验源文件未被修改 ----
  const bufAfter = await readFile(EXCEL_PATH);
  const shaAfter = createHash("sha256").update(bufAfter).digest("hex");
  const excelUnchanged = shaBefore === shaAfter;
  console.log(`原始 Excel SHA256（导入后）: ${shaAfter}`);
  console.log(`原始 Excel 是否被修改        : ${excelUnchanged ? "否 ✓" : "是 ✗ 异常！"}`);

  // ---- 9. 落库：批次 + 异常明细 ----
  const batchStatus =
    failed > 0 ? "PARTIAL" : issues.some((i) => i.severity === "ERROR") ? "PARTIAL" : "SUCCESS";

  await prisma.importBatch.create({
    data: {
      id: batchId,
      sourceFile: EXCEL_PATH,
      sourceSha256: shaBefore,
      sourceSheet: DB_SHEET,
      totalRows: parsed.length + rowsSkipped.length,
      inserted,
      updated,
      unchanged,
      skipped: rowsSkipped.length,
      duplicated,
      failed,
      issueCount: issues.length,
      status: batchStatus,
      message: `新增 ${inserted}，更新 ${updated}，未变化 ${unchanged}，重复 ${duplicated}，跳过 ${rowsSkipped.length}，失败 ${failed}`,
      startedAt,
      finishedAt: new Date(),
    },
  });

  // 分批写入异常明细（避免单次事务过大）
  const CHUNK = 500;
  for (let i = 0; i < issues.length; i += CHUNK) {
    await prisma.importIssue.createMany({
      data: issues.slice(i, i + CHUNK).map((it) => ({
        batchId,
        sourceRowNo: it.row,
        employeeName: it.name,
        fieldName: it.field,
        rawValue: it.rawValue,
        issueType: it.type,
        severity: it.severity,
        message: it.message,
      })),
    });
  }

  // ---- 10. 生成报告 ----
  const report = buildReport({
    batchId,
    startedAt,
    excelPath: EXCEL_PATH,
    shaBefore,
    shaAfter,
    excelUnchanged,
    sheetNames: wb.worksheets.map((w) => w.name),
    parsedCount: parsed.length,
    rowsSkipped,
    inserted,
    updated,
    unchanged,
    duplicated,
    failed,
    matchByIdCardHire,
    matchByIdCardOnly,
    dupIdCards,
    rehireExtra,
    matchBySourceRow,
    newOnRerun,
    matchByNameHire,
    matchByNamePhone,
    noKeyCount,
    statusStat,
    afterStats,
    storeNames,
    jobGrades,
    issues,
    rosterActive,
    rosterResigned,
  });

  await mkdir(path.join(ROOT, "docs"), { recursive: true });
  await writeFile(path.join(ROOT, "docs", "import-report.md"), report, "utf8");
  console.log("");
  console.log("✓ 导入报告已生成：docs/import-report.md");
  console.log(`✓ 数据库现状：员工 ${afterStats.total} 人（在职 ${afterStats.active} / 离职 ${afterStats.resigned}）· 门店 ${afterStats.stores} · 职位 ${afterStats.positions}`);
  console.log("═".repeat(72));

  await prisma.$disconnect();

  // 有 ERROR 级异常时返回非 0，便于外部感知（但仍已完成导入）
  if (failed > 0) process.exitCode = 2;
}

// ------------------------------------------------------------
// 报告生成
// ------------------------------------------------------------
interface ReportInput {
  batchId: string;
  startedAt: Date;
  excelPath: string;
  shaBefore: string;
  shaAfter: string;
  excelUnchanged: boolean;
  sheetNames: string[];
  parsedCount: number;
  rowsSkipped: { row: number; reason: string }[];
  inserted: number;
  updated: number;
  unchanged: number;
  duplicated: number;
  failed: number;
  // 身份证 + 入职日期
  matchByIdCardHire: number;
  // 身份证（库中唯一，缺少入职日期时的谨慎匹配）
  matchByIdCardOnly: number;
  /** 库中同一身份证对应多条任职记录的数量（重新入职） */
  dupIdCards: number;
  /** 因重新入职而多出来的任职记录条数 */
  rehireExtra: number;
  matchByNameHire: number;
  matchByNamePhone: number;
  /** 通过「来源 Sheet + 原始行号」溯源键兜底匹配的行数 */
  matchBySourceRow: number;
  /** 库中已有员工却仍新建的行（审计重复风险） */
  newOnRerun: {
    row: number;
    name: string;
    hasId: boolean;
    hasHire: boolean;
    hasPhone: boolean;
  }[];
  noKeyCount: number;
  statusStat: { ACTIVE: number; RESIGNED: number; CANDIDATE: number };
  afterStats: {
    total: number;
    active: number;
    resigned: number;
    candidate: number;
    stores: number;
    positions: number;
  };
  storeNames: string[];
  jobGrades: string[];
  issues: Issue[];
  rosterActive: Set<string>;
  rosterResigned: Set<string>;
}

function buildReport(o: ReportInput): string {
  const byType = new Map<string, Issue[]>();
  for (const i of o.issues) {
    if (!byType.has(i.type)) byType.set(i.type, []);
    byType.get(i.type)!.push(i);
  }

  // 报告默认包含真实员工姓名（内部审计用）。
  // 若要公开报告（例如提交到 GitHub），请设置 REPORT_MASK_NAMES=true 重新生成，
  // 姓名会被掩码为「张**」，原始行号仍保留，可据此在系统内定位到具体员工。
  const MASK_NAMES = process.env.REPORT_MASK_NAMES === "true";
  const nm = (n: string | null | undefined) => {
    if (!n) return "—";
    if (!MASK_NAMES) return n;
    return n.length <= 1 ? n : n[0] + "*".repeat(n.length - 1);
  };

  const typeLabel: Record<string, string> = {
    MISSING_ID: "身份证号缺失",
    INVALID_ID: "身份证号格式异常",
    FIELD_MISPLACED: "字段填写错列（已按内容归位）",
    INVALID_DATE: "日期无法解析或超出合理范围",
    EMPTY_NAME: "有数据但姓名为空",
    DUPLICATE_KEY: "重复行（同一人出现多次）",
    FALLBACK_MATCH: "使用备用匹配策略去重",
    PRECISION_RISK: "数值超精度风险",
    PRECISION_SUSPECT: "数值精度存疑",
    STATUS_CONFLICT: "在离职状态冲突",
    RESIGN_DATE_MISSING: "离职日期缺失或为文本",
    SOURCE_MISSING: "源数据未提供（非业务错误）",
    OTHER: "其他",
  };

  const L: string[] = [];
  const push = (...s: string[]) => L.push(...s);

  push(
    "# Excel 迁移导入报告",
    "",
    `> 本文件由 \`scripts/import-excel.ts\` 自动生成，请勿手工编辑。`,
    `> 生成时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    "## 0. 执行摘要",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    `| 导入批次号 | \`${o.batchId}\` |`,
    `| 源文件 | \`${o.excelPath}\` |`,
    `| 源文件 SHA256（导入前） | \`${o.shaBefore}\` |`,
    `| 源文件 SHA256（导入后） | \`${o.shaAfter}\` |`,
    `| 原始 Excel 是否被修改 | **${o.excelUnchanged ? "否（已校验一致，未被写入）" : "是（异常！请立即排查）"}** |`,
    `| 源 Sheet | \`数据库\` |`,
    `| 工作簿全部 Sheet | ${o.sheetNames.map((s) => `\`${s}\``).join(" · ")} |`,
    `| 员工姓名的展示方式 | ${MASK_NAMES ? "**已掩码**（REPORT_MASK_NAMES=true，可安全提交到代码仓库）" : "**完整姓名**（内部审计用；如需公开请设置 REPORT_MASK_NAMES=true 重新生成）"} |`,
    "",
    "---",
    "",
    "## 1. 数据行统计",
    "",
    "| 指标 | 数量 | 说明 |",
    "| --- | --- | --- |",
    `| Excel 数据区总行数 | ${o.parsedCount + o.rowsSkipped.length} | 「数据库」Sheet 第 3 行 ~ 第 1996 行 |`,
    `| 原始 Excel 数据行数（有姓名，参与导入） | **${o.parsedCount}** | 有效业务数据行 |`,
    `| 成功导入数量（新增） | **${o.inserted}** | 写入为全新员工记录 |`,
    `| 成功导入数量（更新） | **${o.updated}** | 匹配到已有员工并更新字段（重复执行导入时的主要路径） |`,
    `| 未变化数量 | **${o.unchanged}** | 匹配到已有员工且所有字段完全一致，未写入（幂等重跑不产生无意义写库） |`,
    `| 跳过数量 | **${o.rowsSkipped.length}** | 整行为空或姓名为空 |`,
    `| 重复数量 | **${o.duplicated}** | 同一次运行中同一人同一段任职出现多行，已合并 |`,
    `| 异常数量 | **${o.issues.length}** | 明细见第 6 节，全部落库在 \`ImportIssue\` 表 |`,
    `| 写入失败数量 | **${o.failed}** | 数据库写入报错 |`,
    "",
    "---",
    "",
    "## 2. 去重与重复执行逻辑",
    "",
    "导入脚本**可重复执行**，重复执行不会无限创建重复员工。匹配优先级如下：",
    "",
    "| 优先级 | 匹配键 | 本次命中 | 说明 |",
    "| --- | --- | --- | --- |",
    `| ① | **身份证号 + 入职日期** | ${o.matchByIdCardHire} | 主策略。最可靠，且能区分同一人的多次任职 |`,
    `| ② | 身份证号（库中唯一）+ 缺入职日期 | ${o.matchByIdCardOnly} | 谨慎策略，仅在无歧义时使用 |`,
    `| ③ | 姓名 + 入职日期 | ${o.matchByNameHire} | 身份证号缺失时的备用策略 |`,
    `| ④ | 姓名 + 联系电话 | ${o.matchByNamePhone} | 前三者都不足时的兜底策略 |`,
    `| ⑤ | 来源 Sheet + 原始行号（溯源键） | ${o.matchBySourceRow} | 无任何业务键时的最后兜底，映射持久化在 \`EmployeeSourceRow\` 表，保证重复执行幂等 |`,
    `| — | 本次运行内已落地的同一条记录 | ${o.duplicated} | 真正的重复行，合并为一条 |`,
    "",
    "### 2.1 为什么不用「身份证号」单列做主键（重要）",
    "",
    `实测导入后库中有 **${o.dupIdCards}** 个身份证号对应 2~3 条记录`,
    `（即 **${o.rehireExtra}** 条因「重新入职」而多出来的任职记录），`,
    "它们的**入职日期不同** —— 这些是**重新入职**，属于真实的多次任职记录。",
    "若按身份证号合并，会直接丢失这些历史任职数据，违反「原 Excel 数据必须保留完整」。",
    "",
    "因此去重主键为 **`身份证号 + 入职日期`**：",
    "",
    "- 同一人、同一入职日期 → 视为同一条任职记录 → **更新**（保证重复执行幂等）。",
    "- 同一人、不同入职日期 → 视为**重新入职** → **新建独立任职记录**，并写入 `DUPLICATE_KEY` 异常说明。",
    "",
    "### 2.2 重复执行的安全性验证",
    "",
    o.newOnRerun.length === 0
      ? "- 本次运行时库中已有员工，且**没有任何一行因无法匹配而新建记录** —— 说明重复执行导入完全幂等。"
      : `- ⚠ 本次运行时库中已有员工，仍有 **${o.newOnRerun.length}** 行无法被任何键匹配而新建记录，请人工核对是否重复：`,
    "",
  );
  if (o.newOnRerun.length) {
    push(
      "| 原始行号 | 姓名 | 有身份证号 | 有入职日期 | 有电话 |",
      "| --- | --- | --- | --- | --- |"
    );
    o.newOnRerun.forEach((x) =>
      push(
        `| ${x.row} | ${nm(x.name)} | ${x.hasId ? "是" : "否"} | ${x.hasHire ? "是" : "否"} | ${
          x.hasPhone ? "是" : "否"
        } |`
      )
    );
  }

  push(
    "",
    "### 2.3 其他规则",
    "",
    `- 无任何业务去重键（无身份证号、无入职日期、无电话）的行：**${o.noKeyCount}** 条。这类行由溯源键（来源 Sheet + 原始行号）保证幂等，已在异常表中逐条列出，仍建议尽快补录身份证号。`,
    "- 溯源键的局限：若有人手工在 Excel 中**插入/删除行**，行号会整体位移，此时溯源键可能失效，重新导入可能产生少量重复记录。**补录身份证号是根治办法。**",
    `- 身份证号规范化规则：去除空格与不可见字符，末位 \`x\` 统一为大写 \`X\`；仅当长度严格为 18 位（17 位数字 + 数字/X）时才作为去重键。`,
    `- 15/16/17 位等不完整的身份证号**不会被当作去重键**，但会**原样保留**在 \`idCardNo\` 字段中。`,
    "- 合并单元格的从属格一律视为空（ExcelJS 会把主格的值回传给整个合并区域，不排除会产生幽灵数据行）。",
    "",
    "---",
    "",
    "## 3. 状态统计（在职 / 离职）",
    "",
    "| 状态 | 人数 | 说明 |",
    "| --- | --- | --- |",
    `| 在职（ACTIVE） | **${o.afterStats.active}** | — |`,
    `| 离职（RESIGNED） | **${o.afterStats.resigned}** | 包含有离职日期与仅有离职名册/文本的记录 |`,
    `| 候选人（CANDIDATE） | **${o.afterStats.candidate}** | 本阶段未从 Excel 产生 |`,
    `| 员工总数（数据库实测） | **${o.afterStats.total}** | 与导入统计一致即为成功 |`,
    "",
    "### 状态判定规则（重要）",
    "",
    "Excel「数据库」Sheet **没有独立的在职/离职状态列**，状态由以下信号综合判定，任一命中即为**离职**：",
    "",
    "| 信号 | 来源 | 命中人数（参考） |",
    "| --- | --- | --- |",
    `| ① 出现在「离职」名册 Sheet | \`离职\` Sheet 的人员名单 | ${o.rosterResigned.size} 个姓名+入职日期键 |`,
    "| ② 离职日期可解析为日期 | 「数据库」AA 列「备注（离职日期）」 | — |",
    "| ③ 离职原因非空 | 「数据库」Z 列「离职原因」 | — |",
    "| ④ 备注文本含离职语义 | 「数据库」AA 列自由文本 | — |",
    "",
    "判定细节：",
    "",
    "- 「备注（离职日期）」列是**自由文本混合列**，既可能是日期，也可能是「9/30已离职」「已辞职」「离职重新入职」等描述。",
    "- 文本含「**重新入职 / 又入职 / 回归 / 再入职**」时**不判定为离职**，按在职处理，并写入异常表提示人工复核。",
    "- 若某人同时出现在「在职」名册且带有离职信号，按**离职**处理并写入 \`STATUS_CONFLICT\` 异常，等待人工复核。",
    "- 出自「离职」名册但「数据库」中无离职日期/原因的记录，状态为离职、**离职日期留空**（不做猜测填充），写入 \`RESIGN_DATE_MISSING\` 异常，可在员工详情页「离职信息」分组中人工补录。",
    "",
    "---",
    "",
    "## 4. 门店与职位基础数据",
    "",
    `- 门店数量：**${o.afterStats.stores}**（来源：「数据库」B 列「门店名称」的全部历史取值）`,
    `- 职位数量：**${o.afterStats.positions}**（来源：「数据库」H 列「工种级别」的全部历史取值）`,
    "",
    "导入时按 Excel 原始取值逐字创建主数据，**不做名称归并、不做猜测性改名**。",
    "员工记录同时保留了 \`storeNameRaw\` / \`jobGradeRaw\` 原文列，因此后续在「门店管理 / 职位管理」中重命名或合并主数据，都不会丢失 Excel 历史原文。",
    "",
    "<details><summary>门店清单（点击展开）</summary>",
    "",
    ...o.storeNames.map((s, i) => `${i + 1}. ${s}`),
    "",
    "</details>",
    "",
    "<details><summary>职位 / 工种清单（点击展开）</summary>",
    "",
    ...o.jobGrades.map((s, i) => `${i + 1}. ${s}`),
    "",
    "</details>",
    "",
    "---",
    "",
    "## 5. 字段转换异常汇总",
    "",
    "| 异常类型 | 代码 | 数量 | 严重级别 |",
    "| --- | --- | --- | --- |"
  );

  for (const [type, list] of Array.from(byType.entries()).sort(
    (a, b) => b[1].length - a[1].length
  )) {
    push(
      `| ${typeLabel[type] ?? type} | \`${type}\` | ${list.length} | ${
        list.some((x) => x.severity === "ERROR") ? "ERROR" : "WARN"
      } |`
    );
  }

  push("", "---", "", "## 6. 异常员工明细（逐条列出，不静默处理）", "");

  if (o.issues.length === 0) {
    push("本次导入未发现异常。");
  } else {
    push(
      "| # | 员工姓名 | 原始 Excel 行号 | 异常字段 | 异常类型 | 异常原因 |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    const display = o.issues.slice(0, 400);
    display.forEach((it, idx) => {
      push(
        `| ${idx + 1} | ${nm(it.name)} | ${it.row ?? "—"} | ${it.field ?? "—"} | \`${it.type}\` | ${String(
          it.message
        ).replace(/\|/g, "\\|")} |`
      );
    });
    if (o.issues.length > display.length) {
      push(
        "",
        `> 报告仅展示前 ${display.length} 条，其余 ${o.issues.length - display.length} 条已完整落库在 \`ImportIssue\` 表（可按批次号 \`${o.batchId}\` 查询）。`
      );
    }
  }

  // 跳过行
  push("", "### 跳过行明细（原始数据仍完整保留在 Excel 中）", "");
  if (o.rowsSkipped.length === 0) {
    push("无跳过行。");
  } else {
    const empty = o.rowsSkipped.filter((r) => r.reason === "整行为空");
    const noName = o.rowsSkipped.filter((r) => r.reason === "姓名为空");
    push(
      `- 整行为空：**${empty.length}** 行（Sheet 尾部预留行，不构成数据丢失）`,
      `- 有数据但姓名为空：**${noName.length}** 行`,
      ""
    );
    if (noName.length) {
      push("| 原始行号 | 原因 |", "| --- | --- |");
      noName.forEach((r) => push(`| ${r.row} | ${r.reason} |`));
    }
  }

  // 无法确定的数据
  const uncertain = o.issues.filter((i) =>
    ["INVALID_ID", "FIELD_MISPLACED", "INVALID_DATE", "RESIGN_DATE_MISSING", "STATUS_CONFLICT", "OTHER"].includes(
      i.type
    )
  );
  push(
    "",
    "---",
    "",
    "## 7. 目前无法确定的数据（需人工核对）",
    "",
    `共 **${uncertain.length}** 条。这些值的**原始内容均已被保留**，没有被丢弃或被程序改写，只是无法自动判断正确语义。`,
    ""
  );
  push(
    "| 行号 | 姓名 | 字段 | 情况 |",
    "| --- | --- | --- | --- |"
  );
  const uncDisplay = uncertain.slice(0, 120);
  uncDisplay.forEach((it) => {
    push(
      `| ${it.row ?? "—"} | ${nm(it.name)} | ${it.field ?? "—"} | ${String(it.message).replace(/\|/g, "\\|")} |`
    );
  });
  if (uncertain.length > uncDisplay.length) {
    push("", `> 仅列出前 ${uncDisplay.length} 条，完整清单见 \`ImportIssue\` 表。`);
  }
  if (uncertain.length === 0) {
    push("无。");
  }

  push(
    "",
    "---",
    "",
    "## 8. 原始 Excel 完整性核对",
    "",
    "| 校验项 | 结果 |",
    "| --- | --- |",
    `| 导入前后 SHA256 一致 | ${o.excelUnchanged ? "✅ 一致" : "❌ 不一致"} |`,
    `| 导入前 SHA256 | \`${o.shaBefore}\` |`,
    `| 导入后 SHA256 | \`${o.shaAfter}\` |`,
    "| 导入脚本是否写入 Excel | ❌ 从不写入（仅 \`workbook.xlsx.readFile\` 只读读取） |",
    "| 长数字字段（身份证/银行卡/手机）处理 | 全程按字符串处理，未转数字、未丢前导零、未科学计数法化 |",
    "| 空值处理 | 统一转 \`null\`，未做任何猜测性填充 |",
    "",
    "---",
    "",
    "## 9. 复现方式",
    "",
    "```bash",
    "# 1) 首次：建库",
    "npm run db:push",
    "",
    "# 2) 执行导入（可重复执行，不会重复创建员工）",
    "npm run import:excel",
    "",
    "# 3) 查看数据",
    "npm run dev      # 浏览器打开 http://localhost:3000",
    "npm run db:studio",
    "```",
    "",
    "---",
    "",
    "## 10. 当前未完成内容（第一阶段范围外，按需求明确不做）",
    "",
    "- 完整招聘系统、完整社保系统、复杂薪资系统",
    "- 人员流失率报表、Excel 导出模板",
    "- 复杂权限控制（当前仅预留 ADMIN / HR 两种角色）",
    "- 远程访问（Tailscale / Cloudflare Tunnel）",
    "",
    "以上内容的数据字段已全部在 \`Employee\` 表中保留，后续拆分模块时无需重新迁移。"
  );

  return L.join("\n") + "\n";
}

main().catch(async (e) => {
  console.error("✗ 导入过程发生未捕获错误：", e);
  await prisma.$disconnect();
  process.exit(1);
});
