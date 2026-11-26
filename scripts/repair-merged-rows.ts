/**
 * ============================================================
 * Tuhu 导出修复 —— 合并行拆分 + 脏值修复脚本
 * scripts/repair-merged-rows.ts
 *
 * 背景（2026-11-26）：
 *  2026-11-23 的旧版导入用了错的 46 列映射（多了不存在的薪资待遇列，
 *  23 列之后全错位 +1），11-24 修复映射后重跑更新了 2003/2004 行，
 *  但刘钰贤等行因身份证+入职时间都空、匹配器找不到而没被更新；
 *  同名多行（如许颖行 1689/1693）又被姓名匹配合并进同一条 Employee。
 *  本脚本用修复后的解析逻辑（lib/excel-import 的 parser/field-mapping）
 *  重算每一行的字段值，按 sourceRowNo 把库里的值恢复成原文件对应行的值，
 *  并把被合并的多行拆成独立 Employee。
 *
 * 用法（默认 dry-run，只出报告不写库）：
 *   DATABASE_URL="file:/abs/path/hr-test.db" \
 *     npx tsx scripts/repair-merged-rows.ts \
 *       --excel /abs/path/orig-clean.xlsx --db /abs/path/hr-test.db [--apply]
 *
 *   --excel <path>   原始 Excel（只读；脚本前后校验 SHA256）
 *   --db <path>      目标 SQLite 库文件（必须是副本！）
 *   --apply          写库。默认不传 = dry-run（只比对、出报告）。
 *   --batch <id>     修复批次号（默认 IMP-REPAIR-YYYYMMDD-HHMMSS-xxxx）
 *   --report <path>  报告输出路径（默认 ~/workspace/tuhu-fix/mismatch-report.md，
 *                     也可以用 $TUHU_FIX_REPORT 覆盖）
 *
 * 安全：
 *  - 写库前先备份目标库文件（同目录加 .bak-YYYYMMDD-HHMM 后缀），再写库。
 *  - 绝不写原始 Excel；绝不碰线上路径（--db 指向线上 /root/Tuhu 或
 *    ~/workspace/tuhu-migrate/extracted/migrate/hr.db 原始备份时直接拒绝）。
 *  - 修复是把库里的值恢复成原文件对应行的值，不是改原文件的值；
 *    历史脏数据按原样记录，不悄悄“纠正”。
 *  - 报告正文不写身份证号/电话等敏感值（只写行号+姓名+字段名+一致/不一致）。
 *  - 可重复执行：修复后重跑 --dry-run 应为 0 不一致。
 * ============================================================
 */

import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkbook, parseOpsSheets } from "../lib/excel-import/parser";
import type { EmployeeRecord } from "../lib/excel-import/types";
import { SPEC_BY_FIELD, STORED_SPECS } from "../lib/excel-import/field-mapping";
import {
  dateFromIso,
  normalizeForCompare,
  normalizeIdCard,
} from "../lib/excel-import/normalization";

const DB_SHEET = "数据库";
const EMPLOYEE_ID_PREFIX = process.env.EMPLOYEE_ID_PREFIX?.trim() || "THHR";
const RE_ID18 = /^\d{17}[\dX]$/;

/** 拒绝写入的路径（线上库 / 原始备份副本） */
const FORBIDDEN_DB_PATTERNS = [
  /\/root\/Tuhu\//,
  /tuhu-migrate\/extracted\/migrate\/hr\.db$/,
];

function usage(): never {
  console.error(
    "用法：npx tsx scripts/repair-merged-rows.ts --excel <xlsx> --db <sqlite> [--apply] [--batch <id>] [--report <path>]"
  );
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 上海时间 YYYYMMDD-HHMM（备份后缀 / 默认批次号用） */
function shanghaiStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const s = new Date(utc + 8 * 3600000);
  return `${s.getFullYear()}${p(s.getMonth() + 1)}${p(s.getDate())}-${p(s.getHours())}${p(s.getMinutes())}`;
}

function isoDate(d: Date | null | undefined): string {
  if (!d || !(d instanceof Date) || !Number.isFinite(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** 比对归一：null/undefined → ""，Date → yyyy-MM-dd，其余去空格 */
function cmpVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isoDate(v);
  return String(v).trim();
}

/** dataFlags（JSON 数组字符串）按集合比对，顺序不敏感 */
function flagsEqual(a: unknown, b: unknown): boolean {
  const parse = (x: unknown): string[] => {
    if (x === null || x === undefined || x === "") return [];
    try {
      const p = JSON.parse(String(x));
      return Array.isArray(p) ? p.map(String).sort() : [String(x)];
    } catch {
      return [String(x)];
    }
  };
  const pa = parse(a);
  const pb = parse(b);
  return pa.length === pb.length && pa.every((v, i) => v === pb[i]);
}

/** 字段名 → 中文名（报告用，不含敏感值） */
const FIELD_LABEL = new Map(STORED_SPECS.map((s) => [s.field, s.label]));

async function main() {
  const excelPath = arg("--excel");
  const dbPath = arg("--db");
  const apply = process.argv.includes("--apply");
  const batchId =
    arg("--batch") ??
    `IMP-REPAIR-${shanghaiStamp()}-${Math.random().toString(36).slice(2, 6)}`;
  const reportPath =
    arg("--report") ??
    process.env.TUHU_FIX_REPORT ??
    path.join(
      process.env.HOME ?? "~",
      "workspace",
      "tuhu-fix",
      "mismatch-report.md"
    );
  if (!excelPath || !dbPath) usage();

  const dbAbs = path.resolve(dbPath);
  const excelAbs = path.resolve(excelPath);
  for (const re of FORBIDDEN_DB_PATTERNS) {
    if (re.test(dbAbs)) {
      console.error(`✗ 拒绝写入 ${dbAbs}：该路径是线上库或原始备份，只允许写副本`);
      process.exit(2);
    }
  }

  console.log("═".repeat(72));
  console.log("Tuhu 合并行拆分 + 脏值修复");
  console.log("═".repeat(72));
  console.log(`源文件   : ${excelAbs}`);
  console.log(`目标库   : ${dbAbs}（${apply ? "APPLY 写库" : "DRY-RUN 只出报告"}）`);
  console.log(`修复批次 : ${batchId}`);
  console.log("");

  // ---- 0. 校验源文件 + 记录 SHA256 ----
  let shaBefore = "";
  try {
    shaBefore = createHash("sha256").update(await readFile(excelAbs)).digest("hex");
  } catch {
    console.error(`✗ 找不到原始 Excel：${excelAbs}`);
    process.exit(1);
  }
  console.log(`原始 Excel SHA256: ${shaBefore.slice(0, 16)}…`);

  // ---- 1. 解析（复用 lib/excel-import 的共享底座，不另写列映射） ----
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelAbs);
  const parseResult = parseWorkbook(wb);
  if (!parseResult.ok) {
    console.error(`✗ 解析失败：${parseResult.error ?? ""}`);
    process.exit(1);
  }
  const rowsByNo = new Map<number, EmployeeRecord>();
  for (const r of parseResult.rows) rowsByNo.set(r.rowNo, r);
  const opsRows = parseOpsSheets(wb);
  console.log(
    `✓ 已解析「数据库」：有效行 ${parseResult.rows.length}，跳过 ${parseResult.skipped.length} 行；` +
      `运营部 ${opsRows.length} 行`
  );

  // ---- 2. 连目标库（DATABASE_URL 由 --db 决定，绝不读 .env 里的线上库） ----
  process.env.DATABASE_URL = `file:${dbAbs}`;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  // 门店 / 职位解析（复用 lib/store-service 的规则，不建新门店）：
  //   ① ACTIVE 同名 → 用它；② 指向 ACTIVE 门店的别名 → 用它；
  //   ③/④ INACTIVE 同名无有效别名 / ⑤ 既无门店也无别名 → 保留库里现有值并记一笔。
  const [stores, aliases, positions] = await Promise.all([
    prisma.store.findMany({ select: { id: true, name: true, status: true } }),
    prisma.storeAlias.findMany({ select: { alias: true, storeId: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
  ]);
  const aliasTargetStatus = new Map(
    (
      await prisma.store.findMany({
        where: { id: { in: Array.from(new Set(aliases.map((a) => a.storeId))) } },
        select: { id: true, status: true },
      })
    ).map((s) => [s.id, s.status])
  );
  const storeByName = new Map(stores.map((s) => [s.name.trim(), s]));
  const aliasByStr = new Map(aliases.map((a) => [a.alias.trim(), a]));
  const positionByName = new Map(positions.map((p) => [p.name, p.id]));
  const resolveStore = (raw: string | null): number | "UNRESOLVED" | null => {
    if (!raw) return null;
    const n = raw.trim();
    const store = storeByName.get(n);
    if (store && store.status === "ACTIVE") return store.id;
    const alias = aliasByStr.get(n);
    if (alias && aliasTargetStatus.get(alias.storeId) === "ACTIVE") return alias.storeId;
    return "UNRESOLVED";
  };

  /** 解析行 → 期望写库值（与 scripts/import-excel.ts 的 toParsedRow + data 组装同一口径） */
  const rowToExpected = (
    r: EmployeeRecord
  ): Record<string, string | number | Date | null> => {
    const fields: Record<string, string | number | Date | null> = {};
    for (const [k, v] of Object.entries(r.values)) {
      if (k === "hireDate" || k === "resignDate") continue;
      const kind = SPEC_BY_FIELD.get(k)?.kind;
      fields[k] = kind === "date" ? dateFromIso(v as string | null) : v;
    }
    return {
      name: r.name,
      idCardNo: (r.values.idCardNo as string | null) ?? null,
      phone: r.phone,
      storeId: r.storeNameRaw ? resolveStore(r.storeNameRaw) : null,
      positionId: r.jobGradeRaw ? (positionByName.get(r.jobGradeRaw) ?? "UNRESOLVED") : null,
      hireDate: dateFromIso(r.hireDate),
      status: r.status,
      resignDate: dateFromIso(r.resignDate),
      resignDateRaw: (r.values.resignDateRaw as string | null) ?? null,
      resignReason: (r.values.resignReason as string | null) ?? null,
      dataFlags: r.dataFlags.length ? JSON.stringify(r.dataFlags) : null,
      ...fields,
    } as Record<string, string | number | Date | null>;
  };

  // ---- 3. 读库：员工 + 溯源映射 + 招聘/薪资链接 ----
  const employees = await prisma.employee.findMany();
  const empById = new Map(employees.map((e) => [e.id, e]));
  const sourceRows = await prisma.employeeSourceRow.findMany({
    where: { sheet: DB_SHEET },
  });
  const links = await prisma.sheetRowEmployeeLink.findMany();
  const sheetRows = await prisma.sheetRow.findMany();
  const sheetRowByKey = new Map(sheetRows.map((s) => [`${s.sheet}|${s.rowNo}`, s]));
  console.log(
    `✓ 库内员工 ${employees.length} 人，溯源映射 ${sourceRows.length} 条，` +
      `招聘/薪资链接 ${links.length} 条`
  );

  // 期望值（每行）与门店/职位无法解析的记录
  const expectedByRow = new Map<number, Record<string, string | number | Date | null>>();
  const unresolvableStore = new Map<number, string>();
  const unresolvablePosition = new Map<number, string>();
  for (const r of parseResult.rows) {
    const exp = rowToExpected(r);
    if (exp.storeId === "UNRESOLVED") {
      unresolvableStore.set(r.rowNo, r.storeNameRaw ?? "");
      exp.storeId = null; // 先置空占位，下方比对时用库里现有值代替（不碰它）
    }
    if (exp.positionId === "UNRESOLVED") {
      unresolvablePosition.set(r.rowNo, r.jobGradeRaw ?? "");
      exp.positionId = null;
    }
    expectedByRow.set(r.rowNo, exp);
  }

  /** 期望值与库内记录逐字段比对（dataFlags 按集合比；storeId/positionId 无法解析时跳过） */
  const COMPARE_FIELDS = [
    "name",
    "idCardNo",
    "phone",
    "storeId",
    "positionId",
    "hireDate",
    "status",
    "resignDate",
    "resignDateRaw",
    "resignReason",
    "dataFlags",
    ...STORED_SPECS.map((s) => s.field).filter(
      (f) =>
        ![
          "name",
          "idCardNo",
          "phone",
          "hireDate",
          "status",
          "resignDate",
          "resignDateRaw",
          "resignReason",
          "dataFlags",
        ].includes(f)
    ),
  ];
  const diffFields = (
    rowNo: number,
    emp: (typeof employees)[number]
  ): string[] => {
    const exp = expectedByRow.get(rowNo)!;
    const out: string[] = [];
    for (const f of COMPARE_FIELDS) {
      if (f === "storeId" && unresolvableStore.has(rowNo)) continue;
      if (f === "positionId" && unresolvablePosition.has(rowNo)) continue;
      const ev = exp[f];
      const av = (emp as unknown as Record<string, unknown>)[f];
      if (f === "dataFlags") {
        if (!flagsEqual(ev, av)) out.push(f);
      } else if (cmpVal(ev) !== cmpVal(av)) {
        out.push(f);
      }
    }
    return out;
  };

  // ---- 4. 分组：哪些员工被多个源行指向（合并行） ----
  const rowsByEmp = new Map<number, number[]>();
  for (const s of sourceRows) {
    const arr = rowsByEmp.get(s.employeeId) ?? [];
    arr.push(s.rowNo);
    rowsByEmp.set(s.employeeId, arr);
  }
  const mergedGroups = Array.from(rowsByEmp.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([empId, rows]) => ({ empId, rows: rows.sort((a, b) => a - b) }));

  // ---- 5. 逐员工比对：全部不一致清单 ----
  interface Mismatch {
    rowNo: number;
    name: string;
    empId: number;
    employeeId: string;
    fields: string[];
  }
  const mismatches: Mismatch[] = [];
  const rowToEmp = new Map<number, number>(); // 源行 -> 员工（溯源映射）
  for (const s of sourceRows) rowToEmp.set(s.rowNo, s.employeeId);
  for (const [rowNo, empId] of rowToEmp) {
    const rec = rowsByNo.get(rowNo);
    const emp = empById.get(empId);
    if (!rec || !emp) continue;
    const fields = diffFields(rowNo, emp);
    if (fields.length > 0) {
      mismatches.push({ rowNo, name: rec.name, empId, employeeId: emp.employeeId, fields });
    }
  }
  // 没有任何溯源映射的解析行（导入漏建的员工）
  const unmappedRows = parseResult.rows.filter((r) => !rowToEmp.has(r.rowNo));
  // 没有对应解析行的溯源映射（孤儿映射，动都不动，只报告）
  const orphanMappings = sourceRows.filter((s) => !rowsByNo.has(s.rowNo));
  // 非 Excel 来源的员工（手工建档等）：跳过
  const nonExcelEmps = employees.filter(
    (e) => !rowsByEmp.has(e.id) && (e.importBatch === null || e.importBatch === undefined)
  );

  // ---- 6. 拆分决策：每组选 keeper，其余新建 ----
  interface SplitPlan {
    empId: number;
    employeeId: string;
    name: string;
    keeperRow: number;
    splitRows: { rowNo: number; newEmployeeId: string; newId: number }[];
  }
  /** keeper 评分：身份证+2 / 入职时间+1；不匹配扣分；平局按与库内现值相同的字段数、再按行号 */
  const keeperScore = (rowNo: number, emp: (typeof employees)[number]): number => {
    const rec = rowsByNo.get(rowNo)!;
    let s = 0;
    const rowId = rec.idCardKey;
    const empId = normalizeIdCard(emp.idCardNo);
    if (rowId && empId) s += rowId === empId ? 2 : -2;
    const rowHire = rec.hireDate;
    const empHire = isoDate(emp.hireDate);
    if (rowHire && empHire) s += rowHire === empHire ? 1 : -1;
    return s;
  };
  const splitPlans: SplitPlan[] = [];
  for (const g of mergedGroups) {
    const emp = empById.get(g.empId)!;
    const scored = g.rows.map((rowNo) => {
      const exp = expectedByRow.get(rowNo)!;
      let same = 0;
      for (const f of COMPARE_FIELDS) {
        if (f === "dataFlags") {
          if (flagsEqual(exp[f], (emp as unknown as Record<string, unknown>)[f])) same++;
        } else if (cmpVal(exp[f]) === cmpVal((emp as unknown as Record<string, unknown>)[f])) {
          same++;
        }
      }
      return { rowNo, score: keeperScore(rowNo, emp), same };
    });
    scored.sort((a, b) => b.score - a.score || b.same - a.same || a.rowNo - b.rowNo);
    splitPlans.push({
      empId: g.empId,
      employeeId: emp.employeeId,
      name: emp.name,
      keeperRow: scored[0].rowNo,
      splitRows: scored.slice(1).map((s) => ({ rowNo: s.rowNo, newEmployeeId: "", newId: 0 })),
    });
  }

  // ---- 7. 运营部回填计划（按身份证号匹配；与 import-excel.ts 6.2 同一规则） ----
  interface OpsPlan {
    sheet: string;
    rowNo: number;
    name: string;
    empId: number | null;
    employeeId: string | null;
    patch: Record<string, string>;
    note: string;
  }
  const opsPlans: OpsPlan[] = [];
  {
    const byIdCard = new Map<string, typeof employees>();
    for (const e of employees) {
      const k = normalizeIdCard(e.idCardNo);
      if (!k) continue;
      const arr = byIdCard.get(k) ?? [];
      arr.push(e);
      byIdCard.set(k, arr);
    }
    for (const o of opsRows) {
      const rowId = normalizeIdCard(o.idCardRaw);
      if (!rowId) {
        opsPlans.push({ ...o, empId: null, employeeId: null, patch: {}, note: "无身份证号，未匹配" });
        continue;
      }
      let cands = byIdCard.get(rowId) ?? [];
      if (cands.length > 1) {
        const byName = cands.filter(
          (e) => normalizeForCompare("name", e.name) === normalizeForCompare("name", o.name)
        );
        if (byName.length > 0) cands = byName;
        if (cands.length > 1 && o.hireDate) {
          const byHire = cands.filter((e) => e.hireDate && isoDate(e.hireDate) === o.hireDate);
          if (byHire.length > 0) cands = byHire;
        }
      }
      if (cands.length === 0) {
        opsPlans.push({ ...o, empId: null, employeeId: null, patch: {}, note: "身份证号在库中无匹配" });
        continue;
      }
      if (cands.length > 1) {
        opsPlans.push({ ...o, empId: null, employeeId: null, patch: {}, note: `身份证号对应 ${cands.length} 条记录，无法唯一确定` });
        continue;
      }
      const emp = cands[0];
      const patch: Record<string, string> = {};
      if (o.workPhone && o.workPhone !== emp.workPhone) patch.workPhone = o.workPhone;
      if (o.householdAddress && o.householdAddress !== emp.householdAddress)
        patch.householdAddress = o.householdAddress;
      opsPlans.push({
        ...o,
        empId: emp.id,
        employeeId: emp.employeeId,
        patch,
        note: Object.keys(patch).length > 0 ? "需回填" : "已一致",
      });
    }
  }

  // ---- 8. 招聘/薪资链接重指计划（仅当链接存在时；本备份库里是 0 条，走个过场） ----
  interface LinkPlan {
    sheet: string;
    rowNo: number;
    oldEmpId: number;
    newEmpId: number | null;
    note: string;
  }
  const linkPlans: LinkPlan[] = [];
  {
    // 拆分涉及的旧员工 -> 候选新员工集合（含 keeper 本人）
    const splitNewIds = new Map<number, number[]>(); // oldEmpId -> [keeperId, ...newIds]
    for (const p of splitPlans) splitNewIds.set(p.empId, [p.empId]);
    const parseCells = (json: string): string[] => {
      try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? "" : String(x))) : [];
      } catch {
        return [];
      }
    };
    for (const l of links) {
      const candIds = splitNewIds.get(l.employeeId);
      if (!candIds) continue; // 未被拆分的员工，链接不动
      const sr = sheetRowByKey.get(`${l.sheet}|${l.rowNo}`);
      if (!sr) {
        linkPlans.push({ sheet: l.sheet, rowNo: l.rowNo, oldEmpId: l.employeeId, newEmpId: null, note: "无 SheetRow 镜像，无法判断，保留原指向" });
        continue;
      }
      const cells = parseCells(sr.cellsJson);
      // 招聘面试登记表：姓名 col2、电话 col3、入职 col11；薪资表：姓名 col4、入职 col3
      const nm = l.sheet === "招聘面试登记表" ? cells[1] ?? "" : cells[3] ?? "";
      const ph = l.sheet === "招聘面试登记表" ? cells[2] ?? "" : "";
      const hd = l.sheet === "招聘面试登记表" ? cells[10] ?? "" : cells[2] ?? "";
      const scored = candIds
        .map((id) => {
          const e = empById.get(id);
          if (!e) return { id, score: -1 };
          let s = 0;
          if (nm && normalizeForCompare("name", e.name) === normalizeForCompare("name", nm)) s += 2;
          else if (nm) s -= 2;
          if (hd && isoDate(e.hireDate) === hd.trim().slice(0, 10)) s += 2;
          if (ph && e.phone && normalizeForCompare("phone", e.phone) === normalizeForCompare("phone", ph)) s += 1;
          return { id, score: s };
        })
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0 && scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
        linkPlans.push({ sheet: l.sheet, rowNo: l.rowNo, oldEmpId: l.employeeId, newEmpId: scored[0].id, note: scored[0].id === l.employeeId ? "仍指向原记录（keeper）" : "改指拆分后的新记录" });
      } else {
        linkPlans.push({ sheet: l.sheet, rowNo: l.rowNo, oldEmpId: l.employeeId, newEmpId: null, note: "无法唯一确定归属，保留原指向" });
      }
    }
  }

  // ---- 9. 汇总（dry-run 到此为止；apply 才往下写库） ----
  const keeperMismatchCount = mismatches.filter((m) =>
    splitPlans.some((p) => p.empId === m.empId)
  ).length;
  const singleMismatchCount = mismatches.length - keeperMismatchCount;
  const opsFillCount = opsPlans.filter((o) => Object.keys(o.patch).length > 0).length;
  const opsOkCount = opsPlans.filter((o) => o.note === "已一致").length;
  const opsSkipCount = opsPlans.length - opsFillCount - opsOkCount;
  const linkRepointCount = linkPlans.filter((l) => l.newEmpId !== null && l.newEmpId !== l.oldEmpId).length;

  console.log("");
  console.log("── 比对结果（dry-run / apply 前） ──────────");
  console.log(`  解析行         : ${parseResult.rows.length}`);
  console.log(`  不一致的员工   : ${mismatches.length}（单行记录 ${singleMismatchCount} · 合并组 keeper ${keeperMismatchCount}）`);
  console.log(`  合并组         : ${mergedGroups.length} 组，拆分后新增 ${splitPlans.reduce((s, p) => s + p.splitRows.length, 0)} 条员工`);
  console.log(`  无溯源映射的行 : ${unmappedRows.length}（导入漏建，需新建）`);
  console.log(`  孤儿溯源映射   : ${orphanMappings.length}（不动，只报告）`);
  console.log(`  非 Excel 员工  : ${nonExcelEmps.length}（手工建档等，跳过）`);
  console.log(`  运营部回填     : ${opsFillCount} 人需回填，${opsOkCount} 人已一致，${opsSkipCount} 行未匹配`);
  console.log(`  链接重指       : ${linkRepointCount} 条需改指（共 ${linkPlans.length} 条涉及拆分）`);
  if (unresolvableStore.size > 0)
    console.log(`  门店无法解析   : ${unresolvableStore.size} 行（保留库里现有 storeId，见报告）`);
  if (unresolvablePosition.size > 0)
    console.log(`  职位无法解析   : ${unresolvablePosition.size} 行（保留库里现有 positionId，见报告）`);

  // ---- 10. 写库（仅 --apply） ----
  let backupPath = "";
  const repairIssues: {
    row: number | null;
    name: string | null;
    field: string | null;
    rawValue: string | null;
    type: string;
    severity: string;
    message: string;
  }[] = [];
  let created = 0;
  let updated = 0;
  if (apply) {
    backupPath = `${dbAbs}.bak-${shanghaiStamp()}`;
    await copyFile(dbAbs, backupPath);
    console.log(`✓ 已备份目标库：${backupPath}`);

    // 工号分配器（与 import-excel.ts 同一规则：THHR + 年份 + 6 位流水）
    const importYear = new Date().getFullYear();
    const prefix = `${EMPLOYEE_ID_PREFIX}${importYear}`;
    let next = 0;
    for (const e of employees) {
      const m = /^([A-Z]+)(\d{4})(\d{6})$/.exec(e.employeeId);
      if (m && Number(m[2]) === importYear) next = Math.max(next, Number(m[3]));
    }
    const counter = await prisma.employeeIdCounter.findUnique({ where: { year: importYear } });
    next = Math.max(next, counter?.lastValue ?? 0);
    const alloc = (): string => {
      next += 1;
      return `${prefix}${String(next).padStart(6, "0")}`;
    };

    // 10.1 先拆分：新建员工 + 纠正溯源映射
    for (const p of splitPlans) {
      for (const s of p.splitRows) {
        const exp = expectedByRow.get(s.rowNo)!;
        const newEmployeeId = alloc();
        const data = buildEmployeeData(exp, s.rowNo, batchId);
        // storeId/positionId 无法解析时沿用 keeper 现值（不碰）
        const keeper = empById.get(p.empId)!;
        if (unresolvableStore.has(s.rowNo)) data.storeId = keeper.storeId;
        if (unresolvablePosition.has(s.rowNo)) data.positionId = keeper.positionId;
        const createdEmp = await prisma.employee.create({
          data: { ...data, employeeId: newEmployeeId } as never,
        });
        s.newEmployeeId = newEmployeeId;
        s.newId = createdEmp.id;
        empById.set(createdEmp.id, createdEmp as (typeof employees)[number]);
        await prisma.employeeSourceRow.upsert({
          where: { sheet_rowNo: { sheet: DB_SHEET, rowNo: s.rowNo } },
          create: { employeeId: createdEmp.id, sheet: DB_SHEET, rowNo: s.rowNo, batchId },
          update: { employeeId: createdEmp.id },
        });
        rowToEmp.set(s.rowNo, createdEmp.id);
        created++;
        repairIssues.push({
          row: s.rowNo,
          name: p.name,
          field: null,
          rawValue: null,
          type: "DUPLICATE_KEY",
          severity: "WARN",
          message: `同名多行被合并进同一条员工记录（${p.employeeId}），已拆分：本行新建独立记录 ${newEmployeeId}`,
        });
      }
      // keeper：sourceRowNo 指回 keeper 行（首次来源行号不随重复行漂移）
      await prisma.employee.update({
        where: { id: p.empId },
        data: { sourceRowNo: p.keeperRow },
      });
    }

    // 10.2 再逐行修复：keeper 与单行不一致记录按 sourceRowNo 重写重算值
    //     （含 null 覆盖：Excel 空格 = 该字段无值，脏的错位值必须清掉；
    //      但 storeId/positionId 无法解析时保留现值）
    //     刚在 10.1 新建的拆分行已按重算值创建，跳过，不重复计数。
    const newlyCreatedIds = new Set<number>();
    for (const p of splitPlans) {
      for (const s of p.splitRows) {
        if (s.newId) newlyCreatedIds.add(s.newId);
      }
    }
    const fixRows = new Map<number, number>(); // rowNo -> empId（拆分后已更新）
    for (const [rowNo, empId] of rowToEmp) fixRows.set(rowNo, empId);
    for (const m of mismatches) {
      const empId = fixRows.get(m.rowNo);
      if (empId === undefined || newlyCreatedIds.has(empId)) continue;
      const exp = expectedByRow.get(m.rowNo)!;
      const data = buildEmployeeData(exp, m.rowNo, batchId);
      const emp = empById.get(empId)!;
      if (unresolvableStore.has(m.rowNo)) data.storeId = emp.storeId;
      if (unresolvablePosition.has(m.rowNo)) data.positionId = emp.positionId;
      // sourceRowNo：keeper 行 / 单行行都指回本行
      data.sourceRowNo = m.rowNo;
      await prisma.employee.update({ where: { id: empId }, data: data as never });
      updated++;
    }

    // 10.3 无溯源映射的解析行：新建员工（导入漏建的补录）
    for (const r of unmappedRows) {
      const exp = expectedByRow.get(r.rowNo)!;
      const newEmployeeId = alloc();
      const data = buildEmployeeData(exp, r.rowNo, batchId);
      if (unresolvableStore.has(r.rowNo)) data.storeId = null;
      if (unresolvablePosition.has(r.rowNo)) data.positionId = null;
      const createdEmp = await prisma.employee.create({
        data: { ...data, employeeId: newEmployeeId } as never,
      });
      await prisma.employeeSourceRow.create({
        data: { employeeId: createdEmp.id, sheet: DB_SHEET, rowNo: r.rowNo, batchId },
      });
      created++;
      repairIssues.push({
        row: r.rowNo,
        name: r.name,
        field: null,
        rawValue: null,
        type: "OTHER",
        severity: "WARN",
        message: `解析行在库中无溯源映射（导入漏建），已新建员工记录 ${newEmployeeId}`,
      });
    }

    // 10.4 运营部回填
    for (const o of opsPlans) {
      if (o.empId === null || Object.keys(o.patch).length === 0) continue;
      await prisma.employee.update({ where: { id: o.empId }, data: o.patch });
      updated++;
    }
    for (const o of opsPlans) {
      if (o.empId !== null) continue;
      repairIssues.push({
        row: o.rowNo,
        name: o.name,
        field: "身份证号",
        rawValue: null,
        type: "OTHER",
        severity: "WARN",
        message: `「${o.sheet}」第 ${o.rowNo} 行：${o.note}，未回填工作电话/户籍地址`,
      });
    }

    // 10.5 招聘/薪资链接重指
    for (const l of linkPlans) {
      if (l.newEmpId === null || l.newEmpId === l.oldEmpId) continue;
      await prisma.sheetRowEmployeeLink.updateMany({
        where: { sheet: l.sheet, rowNo: l.rowNo },
        data: { employeeId: l.newEmpId },
      });
    }

    // 10.6 工号计数器 + 批次 + 异常落库
    await prisma.employeeIdCounter.upsert({
      where: { year: importYear },
      create: { year: importYear, lastValue: next },
      update: { lastValue: next },
    });
    await prisma.importBatch.create({
      data: {
        id: batchId,
        sourceFile: excelAbs,
        sourceSha256: shaBefore,
        sourceSheet: DB_SHEET,
        totalRows: parseResult.rows.length,
        inserted: created,
        updated,
        unchanged: parseResult.rows.length - mismatches.length - unmappedRows.length,
        skipped: parseResult.skipped.length,
        duplicated: splitPlans.reduce((s, p) => s + p.splitRows.length, 0),
        failed: 0,
        issueCount: repairIssues.length,
        status: "SUCCESS",
        message:
          `修复批次：新建 ${created}（拆分 ${splitPlans.reduce((s, p) => s + p.splitRows.length, 0)} + 漏建 ${unmappedRows.length}），` +
          `更新 ${updated}（含运营部回填 ${opsFillCount}），不一致 ${mismatches.length} 行`,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    if (repairIssues.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < repairIssues.length; i += CHUNK) {
        await prisma.importIssue.createMany({
          data: repairIssues.slice(i, i + CHUNK).map((it) => ({
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
    }
    console.log(`✓ 写库完成：新建 ${created} 条，更新 ${updated} 条，批次 ${batchId}`);

    // 写库后重读库内快照，供第 11 节“已知 7 行核对”以实测值为准
    const freshEmps = await prisma.employee.findMany();
    empById.clear();
    for (const e of freshEmps) empById.set(e.id, e);
    const freshSR = await prisma.employeeSourceRow.findMany({
      where: { sheet: DB_SHEET },
    });
    rowToEmp.clear();
    for (const s of freshSR) rowToEmp.set(s.rowNo, s.employeeId);
  }

  /** 期望值 → Prisma create/update 数据（与 import-excel.ts 的 data 组装同一口径） */
  function buildEmployeeData(
    exp: Record<string, string | number | Date | null>,
    rowNo: number,
    batch: string
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { ...exp };
    data.sourceSheet = DB_SHEET;
    data.sourceRowNo = rowNo;
    data.importBatch = batch;
    data.deletedAt = null;
    return data;
  }

  // ---- 11. 已知 7 行核对（只写一致/不一致，不写敏感值） ----
  interface KnownCheck {
    label: string;
    rows: number[];
    check: () => string[];
  }
  const knownChecks: KnownCheck[] = [];
  {
    knownChecks.push({
      label: "刘钰贤（行 1675，id 1646）",
      rows: [1675],
      check: () => {
        const out: string[] = [];
        const exp = expectedByRow.get(1675)!;
        // apply 后以库内实测值为准；dry-run 以重算期望值为准（验证解析逻辑本身）
        const cur = apply ? empById.get(1646) : undefined;
        const get = (f: string) =>
          cur !== undefined
            ? (cur as unknown as Record<string, unknown>)[f]
            : exp[f];
        const t: [string, string, unknown][] = [
          ["现居住地址应为空", "currentAddress", ""],
          ["面试地点", "interviewLocation", "大朗富丽东路店"],
          ["面试结果", "interviewResult", "通过"],
          ["面试人", "interviewerName", "刘超勇"],
          ["是否入职", "interviewHired", "否"],
          ["面试评估表", "docInterviewEvaluation", "√"],
          ["备注（42 列）应为空", "remark3", ""],
          ["年龄原文", "ageRaw", "24"],
          ["离职日期原文应为空", "resignDateRaw", ""],
          ["是否满7天应为空（无入职时间）", "computed7Days", ""],
        ];
        for (const [label, f, want] of t) {
          out.push(`${label}：${cmpVal(get(f)) === cmpVal(want) ? "✓ 与原文件一致" : "✗ 不一致"}`);
        }
        return out;
      },
    });
    const splitCheck = (label: string, rows: number[]) => {
      knownChecks.push({
        label,
        rows,
        check: () => {
          const out: string[] = [];
          if (!apply) {
            // dry-run：核对拆分计划（keeper 选择 + 各行期望的身份证/入职是否取自原文件）
            for (const p of splitPlans) {
              if (!p.name || !rows.some((r) => p.keeperRow === r || p.splitRows.some((s) => s.rowNo === r))) continue;
              out.push(
                `${p.name}：keeper 行 ${p.keeperRow}（保留 ${p.employeeId}），` +
                  p.splitRows.map((s) => `行 ${s.rowNo} 新建`).join("、")
              );
            }
            for (const rowNo of rows) {
              const exp = expectedByRow.get(rowNo)!;
              out.push(
                `行 ${rowNo}：重算身份证${exp.idCardNo ? "有值" : "空"}、入职时间${exp.hireDate ? "有值" : "空"}（与原文件一致，不写明文）`
              );
            }
            return out;
          }
          // apply：以库内实测值为准逐行核对
          for (const rowNo of rows) {
            const empId = rowToEmp.get(rowNo);
            const rec = rowsByNo.get(rowNo)!;
            const emp = empId !== undefined ? empById.get(empId) : undefined;
            const exp = expectedByRow.get(rowNo)!;
            const idOk =
              emp !== undefined &&
              normalizeIdCard(emp.idCardNo) === normalizeIdCard(exp.idCardNo as string | null);
            const hireOk =
              emp !== undefined && isoDate(emp.hireDate) === isoDate(exp.hireDate as Date | null);
            out.push(
              `行 ${rowNo}（${rec.name}）：${emp ? `员工 ${emp.employeeId}` : "无员工"}，` +
                `身份证${idOk ? "✓" : "✗"}、入职时间${hireOk ? "✓" : "✗"}`
            );
          }
          return out;
        },
      });
    };
    splitCheck("许颖（行 1689 与 1693，应拆成两条）", [1689, 1693]);
    splitCheck("罗涛涛（行 1786 与 1940，应拆成两条）", [1786, 1940]);
    splitCheck("颜泉（行 1902 首月保障 6000 与行 2008 首月保障 8000，应拆成两条）", [1902, 2008]);
    splitCheck("杨兆健（行 532 / 1686 / 1705）", [532, 1686, 1705]);
    splitCheck("张俊（行 1579 与 1850，应拆成两条）", [1579, 1850]);
    splitCheck("罗龙平（行 192 电话应为原文；行 198 按新规则处理）", [192, 198]);
  }

  // ---- 12. 写报告 ----
  const shaAfter = createHash("sha256").update(await readFile(excelAbs)).digest("hex");
  const excelUnchanged = shaBefore === shaAfter;
  const L: string[] = [];
  const push = (...s: string[]) => L.push(...s);
  push(
    "# Tuhu 合并行拆分 + 脏值修复报告",
    "",
    `> 生成时间：${new Date().toLocaleString("zh-CN")}（上海时间）`,
    `> 模式：${apply ? "**APPLY（已写库）**" : "**DRY-RUN（只比对，未写库）**"}`,
    `> 原始 Excel：\`${path.basename(excelAbs)}\`（SHA256 ${shaBefore.slice(0, 16)}…，修复前后${excelUnchanged ? "未变 ✓" : "⚠ 已变！"})`,
    `> 目标库：\`${dbAbs}\``,
    `> 修复批次：\`${batchId}\``,
    backupPath ? `> 写库前备份：\`${backupPath}\`` : "> 写库前备份：（dry-run，未备份）",
    "",
    "## 1. 汇总",
    "",
    "| 指标 | 数量 |",
    "| --- | --- |",
    `| 解析有效行（数据库表） | ${parseResult.rows.length} |`,
    `| 库内员工 | ${employees.length} |`,
    `| 不一致的员工记录 | ${mismatches.length} |`,
    `| 其中：单行记录值错位 | ${singleMismatchCount} |`,
    `| 其中：合并组 keeper 值错位 | ${keeperMismatchCount} |`,
    `| 合并组（一个员工被多行指向） | ${mergedGroups.length} |`,
    `| 拆分后新建员工 | ${splitPlans.reduce((s, p) => s + p.splitRows.length, 0)} |`,
    `| 无溯源映射的解析行（导入漏建） | ${unmappedRows.length} |`,
    `| 孤儿溯源映射（只报告，不动） | ${orphanMappings.length} |`,
    `| 非 Excel 来源员工（跳过） | ${nonExcelEmps.length} |`,
    `| 运营部行数 | ${opsPlans.length} |`,
    `| 运营部需回填 | ${opsFillCount} |`,
    `| 运营部已一致 | ${opsOkCount} |`,
    `| 运营部未匹配 | ${opsSkipCount} |`,
    `| 招聘/薪资链接需改指 | ${linkRepointCount} |`,
    `| 门店名无法解析（保留现值） | ${unresolvableStore.size} |`,
    `| 职位名无法解析（保留现值） | ${unresolvablePosition.size} |`,
    apply ? `| 写库：新建 | ${created} |` : "",
    apply ? `| 写库：更新 | ${updated} |` : "",
    "",
    "## 2. 全部不一致清单（行号 + 姓名 + 字段名，不含敏感值）",
    "",
    mismatches.length === 0
      ? "无不一致记录 ✓（重跑 --dry-run 应为 0 不一致）"
      : "| 源行 | 姓名 | 员工编号 | 不一致字段 |",
  );
  if (mismatches.length > 0) {
    push("| --- | --- | --- | --- |");
    const sorted = [...mismatches].sort((a, b) => a.rowNo - b.rowNo);
    for (const m of sorted) {
      push(
        `| ${m.rowNo} | ${m.name} | ${m.employeeId} | ${m.fields
          .map((f) => FIELD_LABEL.get(f) ?? f)
          .join("、")} |`
      );
    }
  }
  push(
    "",
    "## 3. 拆分计划（每组：keeper 行保留原员工编号，其余行新建）",
    "",
    splitPlans.length === 0 ? "无合并组。" : "| 员工 | keeper 行 | 拆出行（新建） |",
    ""
  );
  if (splitPlans.length > 0) {
    push("| --- | --- | --- |");
    for (const p of splitPlans) {
      push(
        `| ${p.name}（${p.employeeId}） | 行 ${p.keeperRow} | ${p.splitRows
          .map((s) => `行 ${s.rowNo}${s.newEmployeeId ? ` → ${s.newEmployeeId}` : "（待新建）"}`)
          .join("；")} |`
      );
    }
  }
  push(
    "",
    "## 4. 运营部回填（工作电话 / 户籍地址，按身份证号匹配）",
    "",
    "| 表 | 行 | 姓名 | 结果 |",
    "| --- | --- | --- | --- |"
  );
  for (const o of opsPlans) {
    const res =
      o.empId === null
        ? `未匹配：${o.note}`
        : Object.keys(o.patch).length > 0
          ? `回填 ${Object.keys(o.patch).map((f) => (f === "workPhone" ? "工作电话" : "户籍地址")).join("、")}（${o.employeeId}）`
          : `已一致（${o.employeeId}）`;
    push(`| ${o.sheet} | ${o.rowNo} | ${o.name} | ${res} |`);
  }
  push(
    "",
    "## 5. 已知 7 行核对",
    ""
  );
  for (const k of knownChecks) {
    push(`### ${k.label}`, "");
    for (const line of k.check()) push(`- ${line}`);
    push("");
  }
  // 罗龙平电话原文单独核对（不写敏感值，只写是否一致）
  {
    const exp192 = expectedByRow.get(192)!;
    push(
      "### 罗龙平行 192 电话原文",
      "",
      `- 行 192 电话重算值与原文件文本一致：${cmpVal(exp192.phone) === "做了3天就走了" ? "✓" : "✗"}`,
      `- 行 198 电话重算值与原文件文本一致：${cmpVal(expectedByRow.get(198)!.phone) === "无法适应 已离职" ? "✓" : "✗"}`,
      ""
    );
    const exp1902 = expectedByRow.get(1902)!;
    const exp2008 = expectedByRow.get(2008)!;
    push(
      "### 颜泉首月保障",
      "",
      `- 行 1902 首月保障与原文件一致：${cmpVal(exp1902.firstMonthGuarantee) === "6000" ? "✓（6000）" : "✗"}`,
      `- 行 2008 首月保障与原文件一致：${cmpVal(exp2008.firstMonthGuarantee) === "8000" ? "✓（8000）" : "✗"}`,
      ""
    );
  }
  push(
    "## 6. 其他",
    "",
    `- 无溯源映射的解析行：${unmappedRows.length > 0 ? unmappedRows.map((r) => `行 ${r.rowNo}（${r.name}）`).join("、") : "无"}`,
    `- 孤儿溯源映射：${orphanMappings.length > 0 ? orphanMappings.map((s) => `${s.sheet} 行 ${s.rowNo} → 员工 ${s.employeeId}`).join("、") : "无"}`,
    `- 门店名无法解析：${unresolvableStore.size > 0 ? Array.from(unresolvableStore.entries()).map(([row, nm]) => `行 ${row}「${nm}」`).join("、") : "无"}`,
    `- 职位名无法解析：${unresolvablePosition.size > 0 ? Array.from(unresolvablePosition.entries()).map(([row, nm]) => `行 ${row}「${nm}」`).join("、") : "无"}`,
    `- 招聘/薪资链接：共 ${linkPlans.length} 条涉及拆分，其中 ${linkRepointCount} 条需改指；其余保留原指向（无法唯一确定或仍指向 keeper）。`,
    `- 全量核对：修复后每条 Employee 与其源行的（身份证号 + 入职时间）组合应与原文件一致；` +
      `复核方法：重跑本脚本 --dry-run，应为 0 不一致。`,
    "",
    "## 7. 部署提示（给负责部署的人）",
    "",
    "- 本脚本只修副本，不碰线上。部署时：先备份线上 hr.db，再在 agents 上跑本脚本 --apply，顺序见部署清单。",
    "- 修复后务必重新导出并跑比对脚本，确认 2 处 \"[object Object]\" 消失、串位行减少。",
    ""
  );
  await writeFile(reportPath, L.join("\n"), "utf8");
  console.log("");
  console.log(`✓ 报告已写：${reportPath}`);
  console.log(
    `原始 Excel 是否被修改：${excelUnchanged ? "否 ✓" : "是 ✗ 异常！"}`
  );
  console.log("═".repeat(72));

  await prisma.$disconnect();
  if (!excelUnchanged) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗ 修复脚本失败：", e);
  process.exit(1);
});
