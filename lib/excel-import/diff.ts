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

  const [employeesRaw, stores, aliases, positions, sourceRows] = await Promise.all([
    prisma.employee.findMany({ where: { deletedAt: null }, select: EMPLOYEE_SELECT }),
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.storeAlias.findMany({ select: { storeId: true, alias: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employeeSourceRow.findMany({
      where: { sheet: DB_SHEET },
      select: { employeeId: true, rowNo: true },
    }),
  ]);

  const storeNameToId = new Map<string, number>();
  for (const s of stores) storeNameToId.set(s.name.trim(), s.id);
  for (const a of aliases) if (!storeNameToId.has(a.alias.trim())) storeNameToId.set(a.alias.trim(), a.storeId);
  const storeIdToName = new Map(stores.map((s) => [s.id, s.name]));
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
      created.push({
        rowNo: row.rowNo,
        name: row.name,
        storeName: row.storeNameRaw,
        hireDate: row.hireDate,
        jobGrade: row.jobGradeRaw,
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

    // ---- 门店（外键）----
    const newStoreId = row.storeNameRaw
      ? (storeNameToId.get(row.storeNameRaw.trim()) ?? null)
      : null;
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
