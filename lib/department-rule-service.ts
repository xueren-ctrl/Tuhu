/**
 * 部门自动归属服务（第四阶段）
 *
 * 目的：解决大量员工「无部门归属」的问题 —— Excel 源数据里根本没这个信息，
 * 靠人一条条点不现实，所以按规则**生成推荐**，人确认后再批量写入。
 * （具体人数是实时统计，本模块注释与 UI 均不写死任何历史数字。）
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
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { DEFAULT_OPERATOR } from "./history-service";
import { computeDbVersion } from "./import-preview-service";
import type { Prisma } from "@prisma/client";

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

export async function createRule(
  input: {
    departmentId: number;
    storeId?: number | null;
    positionId?: number | null;
    employeeType?: string | null;
    priority?: number;
    enabled?: boolean;
    remark?: string | null;
  },
  operator = DEFAULT_OPERATOR
): Promise<RuleRow> {
  if (!input.departmentId) throw new Error("必须选择要归属的部门");
  const data = {
    departmentId: input.departmentId,
    storeId: input.storeId ?? null,
    positionId: input.positionId ?? null,
    employeeType: input.employeeType?.trim() || null,
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
    remark: input.remark?.trim() || null,
  };
  // Stage 7.1.4：业务写入 + 审计 同一事务（失败整体回滚，不留「改了没审计」）
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.departmentRule.create({ data, select: selectRule });
    await tx.auditLog.create({
      data: {
        actor: operator,
        action: "CREATE",
        entity: "DepartmentRule",
        entityId: String(row.id),
        summary: `新增部门自动归属规则 → 部门=${row.departmentId}`,
        detail: JSON.stringify({
          ruleId: row.id,
          departmentId: data.departmentId,
          storeId: data.storeId,
          positionId: data.positionId,
          employeeType: data.employeeType,
          priority: data.priority,
          enabled: data.enabled,
          remark: data.remark,
        }),
      },
    });
    return row;
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
  }>,
  operator = DEFAULT_OPERATOR
): Promise<RuleRow> {
  // Stage 7.1.4：查旧值 + 业务修改 + 审计 同一事务（任一失败整体回滚）
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.departmentRule.findUnique({
      where: { id },
      select: {
        id: true,
        departmentId: true,
        storeId: true,
        positionId: true,
        employeeType: true,
        priority: true,
        enabled: true,
        remark: true,
      },
    });
    if (!before) throw new Error("规则不存在");

    const updates: Record<string, unknown> = {};
    if (input.departmentId !== undefined) updates.departmentId = input.departmentId;
    if (input.storeId !== undefined) updates.storeId = input.storeId;
    if (input.positionId !== undefined) updates.positionId = input.positionId;
    if (input.employeeType !== undefined)
      updates.employeeType = input.employeeType?.trim() || null;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.remark !== undefined) updates.remark = input.remark?.trim() || null;

    const after = await tx.departmentRule.update({
      where: { id },
      data: updates,
      select: selectRule,
    });

    // 审计：只记「真正变化」的字段（修改前 + 修改后）
    const auditFields = [
      "departmentId",
      "storeId",
      "positionId",
      "employeeType",
      "priority",
      "enabled",
      "remark",
    ] as const;
    const changed: Record<string, { oldValue: unknown; newValue: unknown }> = {};
    for (const f of auditFields) {
      const ov = before[f as "departmentId"];
      const nv = after[f as "departmentId"];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) changed[f] = { oldValue: ov, newValue: nv };
    }
    if (Object.keys(changed).length) {
      await tx.auditLog.create({
        data: {
          actor: operator,
          action: "UPDATE",
          entity: "DepartmentRule",
          entityId: String(id),
          summary: `修改部门自动归属规则（${Object.keys(changed).join("、")}）`,
          detail: JSON.stringify({ ruleId: id, changes: changed }),
        },
      });
    }
    return after;
  });
  return shapeRule(result as unknown as RawRule);
}

export async function deleteRule(id: number, operator = DEFAULT_OPERATOR) {
  // Stage 7.1.4：删除 + 审计 同一事务（审计 detail 保存删除前规则内容）
  await prisma.$transaction(async (tx) => {
    const before = await tx.departmentRule.findUnique({ where: { id } });
    if (!before) throw new Error("规则不存在");
    await tx.departmentRule.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        actor: operator,
        action: "DELETE",
        entity: "DepartmentRule",
        entityId: String(id),
        summary: `删除部门自动归属规则（部门=${before.departmentId}）`,
        detail: JSON.stringify({
          ruleId: id,
          departmentId: before.departmentId,
          storeId: before.storeId,
          positionId: before.positionId,
          employeeType: before.employeeType,
          priority: before.priority,
          enabled: before.enabled,
          remark: before.remark,
        }),
      },
    });
  });
  return { id };
}

// ------------------------------------------------------------
// 推荐预览与执行（Stage 7.1 整改）
//
// 核心原则：**预览与执行分离，数量以全量计算为准，绝不按展示用 items 截断**。
//   preview：全量统计 affected / unmatched / byDepartment / byRule；
//             items 只作为页面展示（itemLimit 截断），并携带数据版本快照 snapshot。
//   apply：重新计算完整匹配集合（内部调 matchAllEmployees，不受 limit 影响），
//           且先复核 snapshot（库版本 / 员工数 / 规则数 / 匹配数任一变化 → 拒绝，要求重新预览）。
// 旧实现 apply 直接消费 preview.items（slice 500），>500 人时会漏改 —— 已废弃。
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
  /** 全部实际匹配的员工数（全量口径，**不受 items 截断影响**） */
  affected: number;
  /** 按部门汇总（全量） */
  byDepartment: { departmentId: number; departmentName: string; count: number }[];
  /** 命中的规则（全量） */
  byRule: { ruleId: number; departmentName: string; count: number; matchedBy: string }[];
  /** 未命中任何规则的员工数（全量，仍需人工处理） */
  unmatched: number;
  /** 明细：仅供页面展示用，按 itemLimit 截断；**执行数量以 affected 为准，绝不用 items 长度** */
  items: AutoPreviewItem[];
  /** items 是否被截断（展示口径提示） */
  itemsTruncated: boolean;
  /** 是否覆盖已有部门的员工 */
  overrideExisting: boolean;
  /** 数据版本快照（预览时冻结），apply 必须携带它做一致性校验，防止「旧预览执行到已变化的库」 */
  snapshot: AutoPreviewSnapshot;
}

/** 预览时的数据版本指纹，apply 前复核，库有变化则拒绝执行 */
export interface AutoPreviewSnapshot {
  dbVersion: string;
  /** 预览时的「无部门（或未覆盖时全量）」员工总数 */
  baseEmployeeCount: number;
  ruleCount: number;
  matchedCount: number;
  noDeptCount: number;
  /**
   * Stage 7.1.3：命中员工集合指纹（SHA-256，对「规则id→部门id:员工id…」排序串哈希）。
   * 防止「规则数量不变 + 匹配总人数不变，但实际命中员工集合已变化」的陈旧执行。
   */
  matchedFingerprint: string;
  /**
   * Stage 7.1.4：预览时使用的「是否覆盖已有部门」参数。
   * apply 时若与当前请求的 overrideExisting 不一致 → 409 STALE_PREVIEW（不执行）。
   * 治理快照必须显式绑定执行参数，不能只靠 baseCount/noDeptCount 间接兜底。
   */
  overrideExisting: boolean;
}

export class StalePreviewError extends Error {
  constructor(detail: string) {
    super("预览已过期（数据库在预览后发生变化），请重新预览后再执行。" + detail);
    this.name = "StalePreviewError";
  }
}

/**
 * Stage 7.1.3：部门自动归属 apply 必须携带预览快照（预览→确认→执行 闭环）。
 * 缺失 snapshot 时 service 层直接拒绝（route 映射 400 DEPARTMENT_PREVIEW_REQUIRED），
 * 不保留「无 snapshot 兼容直接执行」的分支。
 */
export class DepartmentPreviewRequiredError extends Error {
  constructor() {
    super(
      "部门自动归属执行必须先预览并携带 snapshot（预览→确认→执行），缺少 snapshot 拒绝执行。"
    );
    this.name = "DepartmentPreviewRequiredError";
  }
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
 * 全量匹配（预览与执行共用同一套逻辑 —— 保证「预览数量 = 执行数量」）
 * @returns 每个待修改员工的完整明细（不截断）
 */
async function matchAllEmployees(opts: {
  overrideExisting?: boolean;
}): Promise<{ matched: AutoPreviewItem[]; unmatched: number; baseCount: number }> {
  const overrideExisting = opts.overrideExisting ?? false;
  const rules = await listRules(true);

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

  if (!rules.length) return { matched: [], unmatched: emps.length, baseCount: emps.length };

  const matched: AutoPreviewItem[] = [];
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
    matched.push({
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
  return { matched, unmatched, baseCount: emps.length };
}

/**
 * 生成部门归属推荐（**只读，不写库**）
 * @param itemLimit 展示明细上限（默认 500）——只影响 items，不影响 affected / 执行数量
 */
export async function previewDepartmentAuto(opts: {
  overrideExisting?: boolean;
  itemLimit?: number;
} = {}): Promise<AutoPreview> {
  const overrideExisting = opts.overrideExisting ?? false;
  const itemLimit = Math.max(1, opts.itemLimit ?? 500);

  const { matched, unmatched, baseCount } = await matchAllEmployees({ overrideExisting });
  const rules = await listRules(true);
  const dbVersion = await computeDbVersion();

  const noDeptCount = overrideExisting
    ? baseCount
    : await prisma.employee.count({ where: { deletedAt: null, departmentId: null } });

  const deptMap = new Map<number, { departmentId: number; departmentName: string; count: number }>();
  const ruleMap = new Map<
    number,
    { ruleId: number; departmentName: string; count: number; matchedBy: string }
  >();
  for (const it of matched) {
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
    affected: matched.length,
    byDepartment: [...deptMap.values()].sort((a, b) => b.count - a.count),
    byRule: [...ruleMap.values()].sort((a, b) => b.count - a.count),
    unmatched,
    items: matched.slice(0, itemLimit),
    itemsTruncated: matched.length > itemLimit,
    overrideExisting,
    snapshot: {
      dbVersion,
      baseEmployeeCount: baseCount,
      ruleCount: rules.length,
      matchedCount: matched.length,
      noDeptCount,
      matchedFingerprint: computeMatchedFingerprint(matched),
      // Stage 7.1.4：快照显式绑定「是否覆盖已有部门」参数，apply 时错配直接拒绝
      overrideExisting,
    },
  };
}

/**
 * Stage 7.1.3：命中员工集合指纹。
 * 对「ruleId→deptId:empId」排序串做 SHA-256。
 * 规则数量不变、匹配总人数不变、但命中员工集合（谁被哪条规则匹配到哪个部门）
 * 发生变化时，指纹必变 —— 这是防「陈旧预览执行到已变化的规则」的关键，
 * 不能只靠 matchedCount 兜底。
 */
/**
 * Stage 7.1.3：命中员工集合指纹。
 * 对「ruleId→deptId:empId」排序串做 SHA-256。
 * 规则数量不变、匹配总人数不变、但命中员工集合（谁被哪条规则匹配到哪个部门）
 * 发生变化时，指纹必变 —— 这是防「陈旧预览执行到已变化的规则」的关键，
 * 不能只靠 matchedCount 兜底。
 */
function computeMatchedFingerprint(matched: AutoPreviewItem[]): string {
  const sorted = matched
    .map((m) => `${m.ruleId}->${m.departmentId}:${m.employeeId}`)
    .sort()
    .join("|");
  return createHash("sha256").update(sorted).digest("hex");
}

/** 快照复核：库版本 / 规则数 / 匹配数 / 命中集合指纹任一变化即拒绝（防「早上的预览下午执行」） */
export async function assertSnapshotFresh(
  snapshot: AutoPreviewSnapshot,
  overrideExisting: boolean
): Promise<void> {
  const dbVersion = await computeDbVersion();
  const rules = await listRules(true);
  const { matched, baseCount } = await matchAllEmployees({ overrideExisting });
  const noDeptCount = overrideExisting
    ? baseCount
    : await prisma.employee.count({ where: { deletedAt: null, departmentId: null } });

  if (
    dbVersion !== snapshot.dbVersion ||
    rules.length !== snapshot.ruleCount ||
    matched.length !== snapshot.matchedCount ||
    baseCount !== snapshot.baseEmployeeCount ||
    noDeptCount !== snapshot.noDeptCount ||
    // Stage 7.1.3：命中集合指纹（规则数量不变但命中员工集合变化 → 也拒绝）
    computeMatchedFingerprint(matched) !== snapshot.matchedFingerprint ||
    // Stage 7.1.4：执行参数绑定（预览 overrideExisting=false 的快照不能拿去 override=true 执行；
    // 旧快照缺该字段 → undefined !== 请求值 → 同样拒绝，要求重新预览）
    (snapshot.overrideExisting ?? false) !== overrideExisting
  ) {
    throw new StalePreviewError(
      `预览时 员工=${snapshot.baseEmployeeCount} 无部门=${snapshot.noDeptCount} ` +
        `规则=${snapshot.ruleCount} 匹配=${snapshot.matchedCount}；` +
        `现在 员工=${baseCount} 无部门=${noDeptCount} 规则=${rules.length} 匹配=${matched.length}`
    );
  }
}

/**
 * 执行自动归属（Stage 7.1.1 整批原子事务；Stage 7.1.3 snapshot 强制）
 *
 * 入口（Stage 7.1.3 起唯一路径）：
 *  - **必须**携带 snapshot：先复核版本（库有变化 → StalePreviewError → 409），
 *    再按**全量匹配**写入。
 *  - **缺少 snapshot → 抛 DepartmentPreviewRequiredError → 400 DEPARTMENT_PREVIEW_REQUIRED**，
 *    绝不执行任何数据库写入。不再保留「无 snapshot 直接执行」的兼容分支。
 * 执行**绝不消费预览的 items**，而是重新跑 matchAllEmployees 的完整结果，
 * 因此即使展示明细被截断，实际写入数量也等于全量 affected。
 *
 * **事务模型（规格第四节）**：整个部门自动归属走一个 prisma.$transaction ——
 * 每个部门组的 batchUpdateEmployees（内含逐人 档案+历史+批次审计）全部在
 * 同一事务中执行，部门治理批次审计（type=department-auto）也写在事务内。
 * 任一部失败 → 整批回滚：没有「员工成功但 History 失败」的中间态。
 * 成功时 matched = updated + unchanged；失败时抛 BatchUpdateAbortedError，
 * 本次 apply 的全部修改（含已「完成」的部门组）整体回滚。
 */
export async function applyDepartmentAuto(opts: {
  overrideExisting?: boolean;
  operator?: string;
  snapshot: AutoPreviewSnapshot;
}) {
  const { snapshot } = opts;
  // Stage 7.1.3：snapshot 是强制前置条件（service 层兜底，route 层提前返回 400）
  if (!snapshot) throw new DepartmentPreviewRequiredError();
  await assertSnapshotFresh(snapshot, opts.overrideExisting ?? false);

  const { matched } = await matchAllEmployees({ overrideExisting: opts.overrideExisting });
  if (!matched.length) {
    return {
      matched: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      batchKey: null,
      byDepartment: [] as { departmentId: number; departmentName: string; updated: number }[],
    };
  }

  const { batchUpdateEmployees, BatchUpdateAbortedError } = await import("./employee-service");
  const operator = opts.operator ?? DEFAULT_OPERATOR;

  const byDept = new Map<number, { ids: number[]; name: string; ruleIds: number[] }>();
  for (const it of matched) {
    const g = byDept.get(it.departmentId) ?? { ids: [], name: it.departmentName, ruleIds: [] };
    g.ids.push(it.employeeId);
    if (!g.ruleIds.includes(it.ruleId)) g.ruleIds.push(it.ruleId);
    byDept.set(it.departmentId, g);
  }

  const result = {
    matched: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    batchKey: "" as string | null,
    byDepartment: [] as { departmentId: number; departmentName: string; updated: number }[],
  };

  try {
    // 整批原子：所有部门组 + 部门治理批次审计在同一个事务里
    await prisma.$transaction(async (tx) => {
      for (const [departmentId, g] of byDept) {
        const r = await batchUpdateEmployees({
          ids: g.ids,
          patch: { departmentId },
          operator,
          tx: tx as Prisma.TransactionClient,
        });
        result.matched += r.matched;
        result.updated += r.updated;
        result.unchanged += r.unchanged;
        result.batchKey = r.batchKey;
        result.byDepartment.push({ departmentId, departmentName: g.name, updated: r.updated });

        // 部门治理批次审计（与业务修改同事务；detail 含 batchKey / 类型 / 数量 / 规则）
        await tx.auditLog.create({
          data: {
            actor: operator,
            action: "BATCH_UPDATE",
            entity: "Department",
            entityId: String(departmentId),
            summary: `部门自动归属：${g.name} 批量写入 ${g.ids.length} 人`,
            detail: JSON.stringify({
              batchKey: r.batchKey,
              type: "department-auto",
              departmentId,
              departmentName: g.name,
              employeeCount: g.ids.length,
              updated: r.updated,
              ruleIds: g.ruleIds,
              overrideExisting: opts.overrideExisting ?? false,
              at: new Date().toISOString(),
            }),
          },
        });
      }
    });
  } catch (e) {
    if (e instanceof BatchUpdateAbortedError) {
      // 整批已回滚（员工档案 / 变更历史 / 审计全部未保留任何改动）
      throw e;
    }
    throw e;
  }

  return result;
}
