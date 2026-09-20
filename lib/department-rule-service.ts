/**
 * 部门自动归属服务（第四阶段）
 *
 * 目的：解决 1902 名员工「无部门归属」的问题 —— Excel 源数据里根本没这个信息，
 * 靠人一条条点不现实，所以按规则**生成推荐**，人确认后再批量写入。
 *
 * 规则三维度（都是可选的，已填的维度之间是 AND）：
 *   - storeId      按门店匹配
 *   - positionId   按岗位匹配
 *   - employeeType 按「工种级别原文 jobGradeRaw 包含该文本」匹配
 *     ⚠️ 源数据里没有独立的「员工类型」字段，这一维是用工种原文做的文本匹配，
 *        页面上有明确标注，避免误以为源数据真有该字段。
 *
 * 优先级：priority 越小越优先；一名员工命中多条规则时取优先级最高的那条。
 *
 * 重要：本模块**只生成推荐**，不自动写入。写入走标准的批量更新流程
 *      （自带 EmployeeHistory 变更记录），执行前必须先预览。
 */
import { prisma } from "./prisma";
import { DEFAULT_OPERATOR } from "./history-service";

export interface RuleRow {
  id: number;
  departmentId: number;
  departmentName: string;
  storeId: number | null;
  storeName: string | null;
  positionId: number | null;
  positionName: string | null;
  employeeType: string | null;
  priority: number;
  enabled: boolean;
  remark: string | null;
}

const selectRule = {
  id: true,
  departmentId: true,
  storeId: true,
  positionId: true,
  employeeType: true,
  priority: true,
  enabled: true,
  remark: true,
  department: { select: { name: true } },
  store: { select: { name: true } },
  position: { select: { name: true } },
} as const;

type RawRule = {
  id: number;
  departmentId: number;
  storeId: number | null;
  positionId: number | null;
  employeeType: string | null;
  priority: number;
  enabled: boolean;
  remark: string | null;
  department: { name: string } | null;
  store: { name: string } | null;
  position: { name: string } | null;
};

function shapeRule(r: RawRule): RuleRow {
  return {
    id: r.id,
    departmentId: r.departmentId,
    departmentName: r.department?.name ?? "—",
    storeId: r.storeId,
    storeName: r.store?.name ?? null,
    positionId: r.positionId,
    positionName: r.position?.name ?? null,
    employeeType: r.employeeType,
    priority: r.priority,
    enabled: r.enabled,
    remark: r.remark,
  };
}

export async function listRules(onlyEnabled = false): Promise<RuleRow[]> {
  const rows = await prisma.departmentRule.findMany({
    where: onlyEnabled ? { enabled: true } : {},
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    select: selectRule,
  });
  return rows.map((r) => shapeRule(r as unknown as RawRule));
}

export async function createRule(input: {
  departmentId: number;
  storeId?: number | null;
  positionId?: number | null;
  employeeType?: string | null;
  priority?: number;
  enabled?: boolean;
  remark?: string | null;
}): Promise<RuleRow> {
  if (!input.departmentId) throw new Error("必须选择要归属的部门");
  const created = await prisma.departmentRule.create({
    data: {
      departmentId: input.departmentId,
      storeId: input.storeId ?? null,
      positionId: input.positionId ?? null,
      employeeType: input.employeeType?.trim() || null,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      remark: input.remark?.trim() || null,
    },
    select: selectRule,
  });
  return shapeRule(created as unknown as RawRule);
}

export async function updateRule(
  id: number,
  input: Partial<{
    departmentId: number;
    storeId: number | null;
    positionId: number | null;
    employeeType: string | null;
    priority: number;
    enabled: boolean;
    remark: string | null;
  }>
): Promise<RuleRow> {
  const updated = await prisma.departmentRule.update({
    where: { id },
    data: {
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
      ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
      ...(input.employeeType !== undefined
        ? { employeeType: input.employeeType?.trim() || null }
        : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.remark !== undefined ? { remark: input.remark?.trim() || null } : {}),
    },
    select: selectRule,
  });
  return shapeRule(updated as unknown as RawRule);
}

export async function deleteRule(id: number) {
  await prisma.departmentRule.delete({ where: { id } });
  return { id };
}

// ------------------------------------------------------------
// 推荐预览与执行
// ------------------------------------------------------------

export interface AutoPreviewItem {
  employeeId: number;
  employeeCode: string;
  name: string;
  storeName: string | null;
  positionName: string | null;
  jobGradeRaw: string | null;
  ruleId: number;
  departmentId: number;
  departmentName: string;
  matchedBy: string;
}

export interface AutoPreview {
  /** 会受影响的员工数 */
  affected: number;
  /** 按部门汇总 */
  byDepartment: { departmentId: number; departmentName: string; count: number }[];
  /** 命中的规则 */
  byRule: { ruleId: number; departmentName: string; count: number; matchedBy: string }[];
  /** 未命中任何规则的员工数（仍需人工处理） */
  unmatched: number;
  /** 明细（预览页展示前 N 条） */
  items: AutoPreviewItem[];
  /** 是否覆盖已有部门的员工 */
  overrideExisting: boolean;
}

interface EmpLite {
  id: number;
  employeeId: string;
  name: string;
  storeId: number | null;
  positionId: number | null;
  departmentId: number | null;
  jobGradeRaw: string | null;
  store: { name: string } | null;
  position: { name: string } | null;
}

function matchRule(emp: EmpLite, rule: RuleRow): string | null {
  if (rule.storeId !== null && rule.storeId !== emp.storeId) return null;
  if (rule.positionId !== null && rule.positionId !== emp.positionId) return null;
  if (rule.employeeType) {
    const text = emp.jobGradeRaw ?? "";
    if (!text.includes(rule.employeeType)) return null;
  }
  const parts: string[] = [];
  if (rule.storeId !== null) parts.push("门店=" + (rule.storeName ?? ""));
  if (rule.positionId !== null) parts.push("岗位=" + (rule.positionName ?? ""));
  if (rule.employeeType) parts.push("工种含「" + rule.employeeType + "」");
  return parts.length ? parts.join(" 且 ") : "全部员工";
}

/**
 * 生成部门归属推荐（**只读，不写库**）
 */
export async function previewDepartmentAuto(opts: {
  overrideExisting?: boolean;
  limit?: number;
} = {}): Promise<AutoPreview> {
  const overrideExisting = opts.overrideExisting ?? false;
  const limit = opts.limit ?? 500;

  const rules = await listRules(true);
  if (!rules.length) {
    return {
      affected: 0,
      byDepartment: [],
      byRule: [],
      unmatched: 0,
      items: [],
      overrideExisting,
    };
  }

  const emps = await prisma.employee.findMany({
    where: {
      deletedAt: null,
      ...(overrideExisting ? {} : { departmentId: null }),
    },
    select: {
      id: true,
      employeeId: true,
      name: true,
      storeId: true,
      positionId: true,
      departmentId: true,
      jobGradeRaw: true,
      store: { select: { name: true } },
      position: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });

  const items: AutoPreviewItem[] = [];
  let unmatched = 0;
  for (const e of emps as unknown as EmpLite[]) {
    let hit: { rule: RuleRow; why: string } | null = null;
    for (const rule of rules) {
      const why = matchRule(e, rule);
      if (why) {
        hit = { rule, why };
        break; // 规则已按 priority 升序，第一个命中即最优
      }
    }
    if (!hit) {
      unmatched++;
      continue;
    }
    if (!overrideExisting && e.departmentId === hit.rule.departmentId) continue;
    items.push({
      employeeId: e.id,
      employeeCode: e.employeeId,
      name: e.name,
      storeName: e.store?.name ?? null,
      positionName: e.position?.name ?? e.jobGradeRaw ?? null,
      jobGradeRaw: e.jobGradeRaw,
      ruleId: hit.rule.id,
      departmentId: hit.rule.departmentId,
      departmentName: hit.rule.departmentName,
      matchedBy: hit.why,
    });
  }

  const deptMap = new Map<number, { departmentId: number; departmentName: string; count: number }>();
  const ruleMap = new Map<
    number,
    { ruleId: number; departmentName: string; count: number; matchedBy: string }
  >();
  for (const it of items) {
    const d = deptMap.get(it.departmentId) ?? {
      departmentId: it.departmentId,
      departmentName: it.departmentName,
      count: 0,
    };
    d.count++;
    deptMap.set(it.departmentId, d);

    const r = ruleMap.get(it.ruleId) ?? {
      ruleId: it.ruleId,
      departmentName: it.departmentName,
      count: 0,
      matchedBy: it.matchedBy,
    };
    r.count++;
    ruleMap.set(it.ruleId, r);
  }

  return {
    affected: items.length,
    byDepartment: [...deptMap.values()].sort((a, b) => b.count - a.count),
    byRule: [...ruleMap.values()].sort((a, b) => b.count - a.count),
    unmatched,
    items: items.slice(0, limit),
    overrideExisting,
  };
}

/**
 * 执行自动归属（复用批量更新的同一条路径，因此自带变更记录）
 */
export async function applyDepartmentAuto(opts: {
  overrideExisting?: boolean;
  operator?: string;
}) {
  const preview = await previewDepartmentAuto({ overrideExisting: opts.overrideExisting });
  if (!preview.affected) {
    return {
      matched: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      batchKey: null,
      byDepartment: [],
    };
  }

  const { batchUpdateEmployees } = await import("./employee-service");
  // 按部门分组提交，次数可控且每次的变更记录语义清晰
  const result = {
    matched: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    batchKey: "" as string | null,
    byDepartment: [] as { departmentId: number; departmentName: string; updated: number }[],
  };

  const byDept = new Map<number, number[]>();
  for (const it of preview.items) {
    if (!byDept.has(it.departmentId)) byDept.set(it.departmentId, []);
    byDept.get(it.departmentId)!.push(it.employeeId);
  }

  for (const [departmentId, ids] of byDept) {
    const r = await batchUpdateEmployees({
      ids,
      patch: { departmentId },
      operator: opts.operator ?? DEFAULT_OPERATOR,
    });
    result.matched += r.matched;
    result.updated += r.updated;
    result.unchanged += r.unchanged;
    result.failed += r.failed;
    result.batchKey = r.batchKey;
    const name = preview.byDepartment.find((d) => d.departmentId === departmentId)?.departmentName ?? "—";
    result.byDepartment.push({ departmentId, departmentName: name, updated: r.updated });
  }

  return result;
}
