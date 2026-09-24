/**
 * Diff 计算（第五阶段 · 共享底座）
 *
 * 【头号修复】Diff 必须区分两套值：
 *   - displayOldValue / displayNewValue：**脱敏后**，只用于页面展示；
 *   - rawOldValue    / rawNewValue   ：**真实值**，只用于写库。
 *
 * 上一版实现把脱敏后的 newValue 直接当写库值，会造成
 * 「手机号 13800138000 → 库里被写成 138****8000」的不可逆数据损坏。
 * 现在 raw 值由本次重新解析得到（includeRaw=true，仅存在于内存），
 * 落库的 diffJson 与接口返回里**只有 display 值**，服务端永不外发原始敏感值。
 */
import { prisma } from "../prisma";
import { maskByField } from "../mask";
import { resolveStoreNamesBatch, isStoreUsable } from "../store-service";
import type { EmployeeRecord, ParseResult } from "./types";
import { COMPARABLE_SPECS, FIELD_LABELS, SENSITIVE_FIELDS, SPEC_BY_FIELD } from "./field-mapping";
import { DB_SHEET } from "./parser";
import { normalizeForCompare } from "./normalization";
import type { FieldKind } from "./types";

export interface FieldChange {
  field: string;
  label: string;
  kind: FieldKind | "fk";
  sensitive: boolean;
  /** 页面展示用（已脱敏） */
  displayOldValue: string | null;
  displayNewValue: string | null;
  /** 写库用（真实值）；仅 includeRaw=true 时返回，绝不落库、绝不下发前端 */
  rawOldValue?: string | null;
  rawNewValue?: string | null;
  /** 外键字段（storeId / positionId）解析出的 id，供写库 */
  newFkId?: number | null;
  oldFkId?: number | null;
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
  jobGrade: string | null;
  reason: string;
  /**
   * Stage 7.1.5：门店原文名的统一解析结果（可选，兼容 7.1.5 之前生成的 diffJson）。
   * "name"      —— 命中 ACTIVE 同名门店
   * "alias"     —— 命中指向 ACTIVE 门店的别名
   * "unresolved"—— INACTIVE 同名门店且无有效别名（不自动重绑，storeId=null，记 STORE_UNRESOLVED）
   * "absent"    —— 门店与别名都不存在（预览/提交保持 storeId=null；正式导入可新建 ACTIVE 门店）
   */
  storeResolution?: "name" | "alias" | "unresolved" | "absent";
}

export interface DiffSummary {
  totalRows: number;
  validRows: number;
  skippedRows: number;
  /** 匹配到已有员工的行数 */
  matched: number;
  /** 匹配上且无任何字段变化 */
  unchanged: number;
  modified: number;
  newCount: number;
  statusChanges: number;
  storeChanges: number;
  positionChanges: number;
  /** 解析期异常条数（不静默） */
  issueCount: number;
}

export interface DiffResult {
  summary: DiffSummary;
  modified: ModifiedEmployee[];
  created: NewEmployeeRow[];
}

/** 需要读取的员工字段（全部可比较字段 + 外键 + 主键） */
const EMPLOYEE_SELECT = (() => {
  const sel: Record<string, boolean> = { id: true, employeeId: true, storeId: true, positionId: true };
  for (const s of COMPARABLE_SPECS) sel[s.field] = true;
  return sel;
})();

/**
 * 一行员工的宽类型。
 * Prisma 的 select 是运行时拼出来的（字段来自 FIELD_SPECS），
 * 无法给出字面量类型，因此这里显式断言为「已知字段 + 任意其它字段」。
 */
type EmpRow = {
  id: number;
  employeeId: string;
  storeId: number | null;
  positionId: number | null;
} & Record<string, unknown>;

function display(field: string, v: string | null): string | null {
  if (v === null) return null;
  return SENSITIVE_FIELDS.has(field) ? String(maskByField(field, v) ?? v) : v;
}

/**
 * 计算 Diff（只读，不写库）
 * @param includeRaw 是否附带真实值。仅提交阶段在内存中使用。
 */
export async function computeDiff(
  parsed: ParseResult,
  opts: { includeRaw?: boolean } = {}
): Promise<DiffResult> {
  const includeRaw = opts.includeRaw === true;

  const [employeesRaw, stores, positions, sourceRows] = await Promise.all([
    prisma.employee.findMany({ where: { deletedAt: null }, select: EMPLOYEE_SELECT }),
    // stores 仅用于「id → 名称」展示映射；外键解析一律走下方统一 resolver（含 ACTIVE/别名判定）
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employeeSourceRow.findMany({
      where: { sheet: DB_SHEET },
      select: { employeeId: true, rowNo: true },
    }),
  ]);

  const storeIdToName = new Map(stores.map((s) => [s.id, s.name]));

  // Stage 7.1.5：门店外键解析统一走 resolveStoreNamesBatch（单一事实来源，
  // 与 import-excel.ts / resolveStoreByName 完全同一套规则）：
  //   ACTIVE 同名门店 > 指向 ACTIVE 门店的别名 > null（INACTIVE 同名且无别名绝不重绑）。
  // 预览与提交（commit）共用本函数，「预览看到挂 A 店、提交却挂 INACTIVE A」从此不可能发生。
  const rowStoreNames = Array.from(
    new Set(parsed.rows.map((r) => (r.storeNameRaw ?? "").trim()).filter(Boolean))
  );
  const storeResolutions = await resolveStoreNamesBatch(rowStoreNames);
  const positionNameToId = new Map(positions.map((p) => [p.name.trim(), p.id]));
  const positionIdToName = new Map(positions.map((p) => [p.id, p.name]));

  const employees = employeesRaw as unknown as EmpRow[];
  const byIdEmp = new Map<number, EmpRow>();
  const byIdHire = new Map<string, number>();
  const idToIds = new Map<string, Set<number>>();
  const idSingle = new Map<string, number>();
  const idCardsWithHire = new Set<string>();
  const byNameHire = new Map<string, number>();
  const byNamePhone = new Map<string, number>();
  const hireByEmpId = new Map<number, string | null>();

  for (const e of employees) {
    byIdEmp.set(e.id, e);
    const hireIso = e.hireDate
      ? new Date(e.hireDate as string | number | Date).toISOString().slice(0, 10)
      : null;
    const idc = normalizeForCompare("idCardNo", e.idCardNo);
    hireByEmpId.set(e.id, hireIso);
    if (idc) {
      if (hireIso) {
        byIdHire.set(`${idc}|${hireIso}`, e.id);
        idCardsWithHire.add(idc);
      }
      const set = idToIds.get(idc) ?? new Set<number>();
      set.add(e.id);
      idToIds.set(idc, set);
      if (set.size === 1) idSingle.set(idc, e.id);
      else idSingle.delete(idc);
    }
    if (hireIso) byNameHire.set(`${e.name}|${hireIso}`, e.id);
    const ph = normalizeForCompare("phone", e.phone);
    if (ph) byNamePhone.set(`${e.name}|${ph}`, e.id);
  }
  const bySourceRow = new Map<number, number>();
  for (const s of sourceRows) bySourceRow.set(s.rowNo, s.employeeId);

  const modified: ModifiedEmployee[] = [];
  const created: NewEmployeeRow[] = [];

  for (const row of parsed.rows) {
    // ---- 匹配级联（与正式导入完全一致）----
    let empId: number | null = null;
    const idc = row.idCardKey;
    if (idc && row.hireDate) empId = byIdHire.get(`${idc}|${row.hireDate}`) ?? null;
    if (empId === null && idc && idSingle.has(idc)) {
      const single = idSingle.get(idc)!;
      if (!row.hireDate || !idCardsWithHire.has(idc)) empId = single;
    }
    if (empId === null && row.hireDate) empId = byNameHire.get(`${row.name}|${row.hireDate}`) ?? null;
    if (empId === null) {
      const ph = normalizeForCompare("phone", row.phone);
      if (ph) {
        const cand = byNamePhone.get(`${row.name}|${ph}`);
        if (cand !== undefined && hireByEmpId.get(cand) === null) empId = cand;
      }
    }
    if (empId === null) empId = bySourceRow.get(row.rowNo) ?? null;

    if (empId === null || !byIdEmp.has(empId)) {
      // Stage 7.1.5：created 行也走统一 resolver，标出门店解析结果，
      // 预览 / 提交对同一行得到一致的门店归属（ACTIVE 门店 > 指向 ACTIVE 门店的别名 > 无法解析）。
      const cStoreRes = row.storeNameRaw ? storeResolutions.get(row.storeNameRaw.trim()) : undefined;
      const storeResolution: NewEmployeeRow["storeResolution"] =
        cStoreRes === undefined
          ? "absent"
          : cStoreRes.matchedBy === "name"
            ? "name"
            : cStoreRes.matchedBy === "alias"
              ? "alias"
              : cStoreRes.matchedBy === "inactive-no-alias"
                ? "unresolved"
                : "absent";
      created.push({
        rowNo: row.rowNo,
        name: row.name,
        storeName: row.storeNameRaw,
        hireDate: row.hireDate,
        jobGrade: row.jobGradeRaw,
        storeResolution,
        reason: row.idCardKey ? "库中没有匹配的身份证号 + 入职日期" : "无任何可用去重键，无法匹配",
      });
      continue;
    }

    const e = byIdEmp.get(empId)!;
    const changes: FieldChange[] = [];

    const push = (field: string, oldV: unknown, newV: unknown) => {
      const a = normalizeForCompare(field, oldV);
      const b = normalizeForCompare(field, newV);
      if (a === b) return;
      const spec = SPEC_BY_FIELD.get(field);
      const kind: FieldKind = spec?.kind ?? "text";
      const sensitive = spec?.sensitive ?? false;
      const c: FieldChange = {
        field,
        label: FIELD_LABELS[field] ?? field,
        kind,
        sensitive,
        displayOldValue: display(field, a),
        displayNewValue: display(field, b),
      };
      if (includeRaw) {
        c.rawOldValue = a;
        c.rawNewValue = b;
      }
      changes.push(c);
    };

    // ---- 全部 46 列字段逐一比对 ----
    for (const spec of COMPARABLE_SPECS) {
      if (spec.col === 0 && spec.field !== "gender" && spec.field !== "status") continue;
      push(spec.field, (e as Record<string, unknown>)[spec.field], row.values[spec.field]);
    }

    // ---- 门店（外键）—— Stage 7.1.5 统一 resolver ----
    // 解析规则（与 import-excel.ts 完全一致）：
    //   ACTIVE 同名门店 > 指向 ACTIVE 门店的别名 > null。
    //   INACTIVE 同名门店且无有效别名（unresolved）→ newStoreId = null（不自动重绑，
    //   会生成 storeId→null 的变更并记 STORE_UNRESOLVED，绝不挂回 INACTIVE 门店）。
    const storeRes = row.storeNameRaw ? storeResolutions.get(row.storeNameRaw.trim()) : undefined;
    const newStoreId = storeRes && isStoreUsable(storeRes) ? storeRes.storeId : null;
    if ((newStoreId ?? null) !== (e.storeId ?? null)) {
      const c: FieldChange = {
        field: "storeId",
        label: "门店",
        kind: "fk",
        sensitive: false,
        displayOldValue: e.storeId ? (storeIdToName.get(e.storeId) ?? String(e.storeId)) : null,
        displayNewValue:
          newStoreId !== null ? (storeIdToName.get(newStoreId) ?? row.storeNameRaw) : null,
        newFkId: newStoreId,
        oldFkId: e.storeId,
      };
      changes.push(c);
    }

    // ---- 岗位（外键）----
    const newPositionId = row.jobGradeRaw
      ? (positionNameToId.get(row.jobGradeRaw.trim()) ?? null)
      : null;
    if ((newPositionId ?? null) !== (e.positionId ?? null)) {
      changes.push({
        field: "positionId",
        label: "岗位",
        kind: "fk",
        sensitive: false,
        displayOldValue: e.positionId ? (positionIdToName.get(e.positionId) ?? String(e.positionId)) : null,
        displayNewValue:
          newPositionId !== null ? (positionIdToName.get(newPositionId) ?? row.jobGradeRaw) : null,
        newFkId: newPositionId,
        oldFkId: e.positionId,
      });
    }

    if (!changes.length) continue;
    modified.push({
      employeeId: e.id,
      employeeCode: e.employeeId,
      name: String(e.name ?? ""),
      rowNo: row.rowNo,
      changes,
      hasStatusChange: changes.some((c) => c.field === "status"),
      hasStoreChange: changes.some((c) => c.field === "storeId"),
      hasPositionChange: changes.some((c) => c.field === "positionId"),
    });
  }

  const summary: DiffSummary = {
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
    issueCount: parsed.issues.length,
  };

  return { summary, modified, created };
}
