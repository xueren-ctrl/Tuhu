/**
 * 员工变更历史服务（第三阶段新增）
 *
 * 职责：把员工的所有修改操作自动、完整、可读地留痕。
 * 约定：
 * 1. 一个字段一行；同一次操作的多字段用同一个 batchKey 归组。
 * 2. 敏感字段（身份证 / 银行卡 / 手机号 / 住址 / 薪资）只记脱敏值，
 *    与列表接口的脱敏口径一致，避免 EmployeeHistory 变成新的泄露面。
 * 3. 只记「真正变化」的字段：值相同不写记录（否则批量操作会灌入大量噪声）。
 */
import { prisma } from "./prisma";
import { EMPLOYEE_FIELD_MAP, SENSITIVE_FIELDS } from "./constants";
import { maskByField } from "./mask";

/** 非实体字段（占位符），用于记录「新增 / 停用 / 恢复」这类整体事件 */
export const RECORD_EVENT_FIELD = "__record__";

const SENSITIVE = new Set<string>(SENSITIVE_FIELDS);

export interface HistoryChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** 字段中文名（取不到就回落为字段名本身） */
export function fieldLabel(field: string): string {
  if (field === RECORD_EVENT_FIELD) return "档案事件";
  return EMPLOYEE_FIELD_MAP[field]?.label ?? field;
}

/** 统一转成可读文本；日期只取到天，避免时区噪声 */
function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "是" : "否";
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 落库前统一脱敏 */
function safeText(field: string, v: unknown): string | null {
  if (SENSITIVE.has(field)) {
    if (v === null || v === undefined || v === "") return null;
    const masked = maskByField(field, v);
    return masked === null || masked === undefined ? null : String(masked);
  }
  return toText(v);
}

/** 比较两个值是否等价（日期按天比较，null 与空串等价） */
function sameValue(a: unknown, b: unknown): boolean {
  const na = toText(a);
  const nb = toText(b);
  return na === nb;
}

/**
 * 计算差异（只保留真正变化的字段）
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[]
): HistoryChange[] {
  const out: HistoryChange[] = [];
  for (const f of fields) {
    if (!(f in after)) continue;
    if (sameValue(before[f], after[f])) continue;
    out.push({ field: f, oldValue: before[f], newValue: after[f] });
  }
  return out;
}

/**
 * 写入变更历史
 * @returns 实际写入的行数（0 表示没有变化）
 */
export async function recordEmployeeHistory(opts: {
  employeeId: number;
  employeeCode?: string | null;
  source?: string;
  operator?: string;
  batchKey?: string;
  changes: HistoryChange[];
}): Promise<number> {
  const changes = opts.changes.filter((c) => !sameValue(c.oldValue, c.newValue));
  if (!changes.length) return 0;

  await prisma.employeeHistory.createMany({
    data: changes.map((c) => ({
      employeeId: opts.employeeId,
      employeeCode: opts.employeeCode ?? null,
      batchKey: opts.batchKey ?? null,
      source: opts.source ?? "UPDATE",
      fieldName: c.field,
      fieldLabel: fieldLabel(c.field),
      oldValue: safeText(c.field, c.oldValue),
      newValue: safeText(c.field, c.newValue),
      operator: opts.operator ?? DEFAULT_OPERATOR,
    })),
  });
  return changes.length;
}

/** 记录一次整体事件（新增 / 停用 / 恢复） */
export async function recordEmployeeEvent(opts: {
  employeeId: number;
  employeeCode?: string | null;
  source: "CREATE" | "SOFT_DELETE" | "RESTORE";
  label: string;
  value?: string | null;
  operator?: string;
}): Promise<number> {
  await prisma.employeeHistory.create({
    data: {
      employeeId: opts.employeeId,
      employeeCode: opts.employeeCode ?? null,
      source: opts.source,
      fieldName: RECORD_EVENT_FIELD,
      fieldLabel: opts.label,
      oldValue: null,
      newValue: opts.value ?? null,
      operator: opts.operator ?? DEFAULT_OPERATOR,
    },
  });
  return 1;
}

/** 当前版本未启用登录，操作人统一记为运行身份；接入登录后从会话取 */
export const DEFAULT_OPERATOR = "系统（未启用登录）";

/** 某员工的变更历史（按时间倒序，不分页 —— 单人工况下量很小） */
export async function listEmployeeHistory(employeeId: number, take = 300) {
  const rows = await prisma.employeeHistory.findMany({
    where: { employeeId },
    orderBy: [{ operatedAt: "desc" }, { id: "desc" }],
    take,
  });
  return rows.map((r) => ({
    id: r.id,
    batchKey: r.batchKey,
    source: r.source,
    fieldName: r.fieldName,
    fieldLabel: r.fieldLabel ?? fieldLabel(r.fieldName),
    oldValue: r.oldValue,
    newValue: r.newValue,
    operator: r.operator,
    operatedAt: r.operatedAt.toISOString(),
  }));
}

/** 全局最近变更（用于变更记录总览页） */
export async function listRecentHistory(opts: { take?: number; skip?: number } = {}) {
  const take = opts.take ?? 50;
  const skip = opts.skip ?? 0;
  const [rows, total] = await Promise.all([
    prisma.employeeHistory.findMany({
      orderBy: [{ operatedAt: "desc" }, { id: "desc" }],
      take,
      skip,
      include: {
        employee: { select: { id: true, name: true, employeeId: true, status: true } },
      },
    }),
    prisma.employeeHistory.count(),
  ]);
  return {
    total,
    data: rows.map((r) => ({
      id: r.id,
      employeePk: r.employeeId,
      employeeCode: r.employeeCode ?? r.employee?.employeeId ?? null,
      employeeName: r.employee?.name ?? null,
      source: r.source,
      fieldLabel: r.fieldLabel ?? fieldLabel(r.fieldName),
      fieldName: r.fieldName,
      oldValue: r.oldValue,
      newValue: r.newValue,
      operator: r.operator,
      operatedAt: r.operatedAt.toISOString(),
    })),
  };
}

/** 变更来源的中文说明 */
export const HISTORY_SOURCE_LABEL: Record<string, string> = {
  CREATE: "新增",
  UPDATE: "编辑",
  BATCH_UPDATE: "批量修改",
  SOFT_DELETE: "停用",
  RESTORE: "恢复",
};
