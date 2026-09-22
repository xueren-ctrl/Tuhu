/**
 * 门店合并服务（第四阶段）
 *
 * 把疑似同一家店的多条门店记录合并到一条「主门店」名下。
 *
 * 四条硬性要求（需求书原文）：
 *   1. 只修改 `Employee.storeId` —— 不动任何其它员工字段
 *   2. 禁止删除员工数据         —— 只改外键，不删行、不删档案
 *   3. 保留 `StoreAlias` 记录   —— 被合并的门店名登记为别名，历史写法不丢
 *   4. 生成 `EmployeeHistory`   —— 每次改归属都逐条留痕
 *
 * 被合并的门店记录本身也不删除，只置为 INACTIVE —— 保留 id 与名称，可追溯、可回退。
 */
import { prisma } from "./prisma";
import { DEFAULT_OPERATOR, recordEmployeeHistory } from "./history-service";
import { EMPLOYEE_STATUS } from "./constants";
import { findAliasCandidates } from "./store-service";
import { computeDbVersion } from "./import-preview-service";

export interface MergeClusterStore {
  id: number;
  name: string;
  code: string | null;
  status: string;
  total: number;
  active: number;
  resigned: number;
}

export interface MergeCluster {
  /** 建议作为主门店的 id（在职人数最多；相同时总人数最多） */
  suggestedMainId: number;
  stores: MergeClusterStore[];
  reason: string;
}

function newBatchKey(prefix: string): string {
  return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * 疑似同一门店的**分组**：在两两候选之上做并查集，
 * 得到「A店 / A店服务中心 / A途虎」这样的簇（而不只是成对关系）。
 */
export async function findMergeClusters(): Promise<MergeCluster[]> {
  const pairs = await findAliasCandidates();
  if (!pairs.length) return [];

  // Stage 7.1.1：候选只允许 ACTIVE 门店参与（INACTIVE 的旧门店不再进入新候选）。
  // 候选对若含已停用门店，直接剔除 —— 簇里每个门店都必须 ACTIVE。
  const activeStores = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, code: true, status: true },
  });
  const activeIds = new Set(activeStores.map((s) => s.id));
  const validPairs = pairs.filter(
    (p) => activeIds.has(p.standardId) && activeIds.has(p.aliasId)
  );
  if (!validPairs.length) return [];

  const stores = activeStores;
  const grouped = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const stat = new Map<number, { active: number; total: number }>();
  for (const g of grouped) {
    if (g.storeId === null) continue;
    const cur = stat.get(g.storeId) ?? { active: 0, total: 0 };
    cur.total += g._count._all;
    if (g.status === EMPLOYEE_STATUS.ACTIVE) cur.active += g._count._all;
    stat.set(g.storeId, cur);
  }

  // 并查集
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const roots: number[] = [];
  for (const p of validPairs) {
    union(p.standardId, p.aliasId);
    if (!roots.includes(p.standardId)) roots.push(p.standardId);
    if (!roots.includes(p.aliasId)) roots.push(p.aliasId);
  }

  const groups = new Map<number, number[]>();
  for (const id of roots) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }

  const out: MergeCluster[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const list = ids
      .map((id) => stores.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map<MergeClusterStore>((s) => {
        const c = stat.get(s.id) ?? { active: 0, total: 0 };
        return {
          id: s.id,
          name: s.name,
          code: s.code,
          status: s.status,
          total: c.total,
          active: c.active,
          resigned: c.total - c.active,
        };
      });
    if (list.length < 2) continue;

    const sorted = [...list].sort((a, b) => b.active - a.active || b.total - a.total || a.id - b.id);
    const reason =
      validPairs.find((p) => ids.includes(p.standardId) && ids.includes(p.aliasId))?.reason ?? "名称高度相似";
    out.push({ suggestedMainId: sorted[0].id, stores: list, reason });
  }
  return out.sort((a, b) => b.stores.length - a.stores.length);
}

export interface MergeResult {
  mainStoreId: number;
  mainStoreName: string;
  mergedStoreIds: number[];
  mergedStoreNames: string[];
  employeesMoved: number;
  aliasesCreated: number;
  storesDeactivated: number;
  batchKey: string;
  /** 合并后主门店的实时人数 */
  mainTotalAfter: number;
}

// ------------------------------------------------------------
// Stage 7.1.1：门店合并预览快照 + 陈旧预览拒绝执行
//
// 与部门自动归属的 AutoPreviewSnapshot 同一套原则：
// 预览时冻结 dbVersion + 各店人数指纹；执行前复核，
// 任一变化（门店被改 / 员工归属被改 / 版本指纹变化）→ 409 STALE_MERGE_PREVIEW。
// ------------------------------------------------------------

/** 门店合并预览快照（执行前必须携带并复核） */
export interface MergePreviewSnapshot {
  dbVersion: string;
  mainStoreId: number;
  mergeStoreIds: number[];
  /** 各被合并门店当时的员工人数（storeId → total） */
  perStoreCount: Record<number, number>;
  /** 迁移员工总数（= perStoreCount 之和） */
  moveCount: number;
  mainTotalBefore: number;
}

export class StaleMergePreviewError extends Error {
  constructor(detail: string) {
    super("门店合并预览已过期（数据库在预览后发生变化），请重新预览后再执行。" + detail);
    this.name = "StaleMergePreviewError";
  }
}

/**
 * 门店合并预览（**只读，不写库**）。
 * 生成快照供执行时复核；同时做服务端的业务前置校验，
 * 把「该拒绝的请求」挡在执行之前。
 * @returns 快照 + 逐店明细 + 预期结果（别名/迁移数/合并后人数）
 */
export async function previewStoreMerge(opts: {
  mainStoreId: number;
  mergeStoreIds: number[];
}): Promise<{
  snapshot: MergePreviewSnapshot;
  preview: {
    mainStore: { id: number; name: string; total: number };
    mergedStores: { id: number; name: string; total: number; active: number; status: string }[];
    aliasesToCreate: string[];
    moveCount: number;
    mainTotalAfter: number;
  };
}> {
  const main = await prisma.store.findUnique({ where: { id: opts.mainStoreId } });
  if (!main) throw new Error("主门店不存在");
  if (main.status !== "ACTIVE") {
    throw new Error("主门店已停用，不能选作主门店（请先重新启用或换一家 ACTIVE 门店）");
  }

  const mergeIds = Array.from(new Set(opts.mergeStoreIds)).filter((id) => id !== main.id);
  if (!mergeIds.length) throw new Error("请至少选择一家要合并进来的门店");

  const srcStores = await prisma.store.findMany({
    where: { id: { in: mergeIds } },
    select: { id: true, name: true, status: true },
  });
  if (srcStores.length !== mergeIds.length) {
    const missing = mergeIds.filter((id) => !srcStores.some((s) => s.id === id));
    throw new Error("部分被合并门店不存在：" + missing.join("、"));
  }
  for (const s of srcStores) {
    if (s.status !== "ACTIVE") {
      throw new Error("「" + s.name + "」已停用，无法再作为被合并门店参与新合并（它可能已是某次合并的产物）");
    }
  }
  // 主门店名不能同时出现在被合并名单里（名称相同但记录不同属罕见脏数据，直接拒绝人工处理）
  if (srcStores.some((s) => s.name === main.name)) {
    throw new Error("存在与主门店同名的被合并门店记录，请先在门店管理中人工处理，不自动合并");
  }

  // 逐店人数（含离职；与员工迁移口径一致：storeId 精确匹配）
  const perStoreCount: Record<number, number> = {};
  const perStoreActive: Record<number, number> = {};
  let moveCount = 0;
  for (const id of mergeIds) {
    perStoreCount[id] = await prisma.employee.count({ where: { deletedAt: null, storeId: id } });
    perStoreActive[id] = await prisma.employee.count({
      where: { deletedAt: null, storeId: id, status: EMPLOYEE_STATUS.ACTIVE },
    });
    moveCount += perStoreCount[id];
  }
  const mainTotalBefore = await prisma.employee.count({ where: { deletedAt: null, storeId: main.id } });

  // 将建立的别名（已存在的别名跳过）
  const existingAliases = await prisma.storeAlias.findMany({
    where: { alias: { in: srcStores.map((s) => s.name) } },
    select: { alias: true },
  });
  const existingSet = new Set(existingAliases.map((a) => a.alias));
  const aliasesToCreate = srcStores.filter((s) => !existingSet.has(s.name)).map((s) => s.name);

  const dbVersion = await computeDbVersion();
  const snapshot: MergePreviewSnapshot = {
    dbVersion,
    mainStoreId: main.id,
    mergeStoreIds: mergeIds,
    perStoreCount,
    moveCount,
    mainTotalBefore,
  };

  return {
    snapshot,
    preview: {
      mainStore: { id: main.id, name: main.name, total: mainTotalBefore },
      mergedStores: srcStores.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        total: perStoreCount[s.id] ?? 0,
        active: perStoreActive[s.id] ?? 0,
      })),
      aliasesToCreate,
      moveCount,
      mainTotalAfter: mainTotalBefore + moveCount,
    },
  };
}

/**
 * 快照复核（执行前调用）：版本指纹 + 逐店人数任一变化即拒绝（STALE_MERGE_PREVIEW → 409）。
 * 防止「页面预览是 10 点的数据，10:30 点了执行却按旧数字合并」。
 */
export async function assertMergeSnapshotFresh(
  snapshot: MergePreviewSnapshot
): Promise<void> {
  const dbVersion = await computeDbVersion();
  const nowCounts: Record<number, number> = {};
  let nowMove = 0;
  for (const id of snapshot.mergeStoreIds) {
    nowCounts[id] = await prisma.employee.count({ where: { deletedAt: null, storeId: id } });
    nowMove += nowCounts[id];
  }
  const nowMain = await prisma.employee.count({ where: { deletedAt: null, storeId: snapshot.mainStoreId } });

  const drift =
    dbVersion !== snapshot.dbVersion ||
    nowMove !== snapshot.moveCount ||
    nowMain !== snapshot.mainTotalBefore ||
    snapshot.mergeStoreIds.some((id) => nowCounts[id] !== (snapshot.perStoreCount[id] ?? 0));

  if (drift) {
    throw new StaleMergePreviewError(
      `预览时 迁移=${snapshot.moveCount} 主店=${snapshot.mainTotalBefore}；` +
        `现在 迁移=${nowMove} 主店=${nowMain}`
    );
  }
}

/**
 * 执行合并（Stage 7.1 事务安全整改）
 *
 * 整个「合并簇」是一个**原子操作**：员工归属修改、EmployeeHistory、StoreAlias、
 * 门店停用、AuditLog 全部在同一个 prisma.$transaction 内完成。
 * 任何一步失败 → 整体回滚，绝不留下：
 *   - 部分员工被改挂、部分没改（半套 storeId）
 *   - 孤儿 StoreAlias（别名建了但员工没迁完）
 *   - 门店提前 INACTIVE 但迁移未发生
 *   - 半套 EmployeeHistory
 *   - 记了「成功合并」的 AuditLog
 */
export async function mergeStores(opts: {
  mainStoreId: number;
  mergeStoreIds: number[];
  operator?: string;
}): Promise<MergeResult> {
  const { mainStoreId } = opts;
  const operator = opts.operator ?? DEFAULT_OPERATOR;
  const mergeIds = Array.from(new Set(opts.mergeStoreIds)).filter((id) => id !== mainStoreId);
  if (!mergeIds.length) throw new Error("请至少选择一家要合并进来的门店");

  // ---- 执行前服务端业务校验（不信任客户端，全部重查数据库）----
  const main = await prisma.store.findUnique({ where: { id: mainStoreId } });
  if (!main) throw new Error("主门店不存在");
  if (main.status !== "ACTIVE") {
    throw new Error("主门店已停用，不能选作主门店");
  }
  const srcStores = await prisma.store.findMany({
    where: { id: { in: mergeIds } },
    select: { id: true, name: true, status: true },
  });
  if (srcStores.length !== mergeIds.length) {
    throw new Error("部分被合并门店不存在");
  }
  for (const s of srcStores) {
    if (s.status !== "ACTIVE") {
      throw new Error("「" + s.name + "」已停用，无法再参与合并");
    }
  }
  if (srcStores.some((s) => s.name === main.name)) {
    throw new Error("存在与主门店同名的被合并门店记录，请先人工处理");
  }

  const batchKey = newBatchKey("merge");

  // 整个合并簇包进一个事务；tx 内任何一步抛错 → 全部回滚
  const stats = await prisma.$transaction(async (tx) => {
    let employeesMoved = 0;
    let aliasesCreated = 0;
    let storesDeactivated = 0;
    const mergedStoreNames: string[] = [];

    for (const srcId of mergeIds) {
      const src = await tx.store.findUnique({ where: { id: srcId } });
      if (!src) continue;
      mergedStoreNames.push(src.name);

      // ① 只改 storeId：把挂在这家店的员工迁到主门店（不删除、不改其它字段，raw 原文保留）
      const targets = await tx.employee.findMany({
        where: { deletedAt: null, storeId: srcId },
        select: { id: true, employeeId: true, storeId: true },
      });
      for (const t of targets) {
        await tx.employee.update({ where: { id: t.id }, data: { storeId: mainStoreId } });
        await recordEmployeeHistory({
          employeeId: t.id,
          employeeCode: t.employeeId,
          source: "BATCH_UPDATE",
          batchKey,
          operator,
          changes: [{ field: "storeId", oldValue: srcId, newValue: mainStoreId }],
          tx,
        });
        employeesMoved++;
      }

      // ② 保留历史写法：把被合并的门店名登记为别名
      if (src.name !== main.name) {
        const exists = await tx.storeAlias.findUnique({ where: { alias: src.name } });
        if (!exists) {
          await tx.storeAlias.create({
            data: {
              storeId: mainStoreId,
              alias: src.name,
              note: "门店合并：原独立门店记录「" + src.name + "」并入「" + main.name + "」",
            },
          });
          aliasesCreated++;
        }
      }

      // ③ 停用被合并的门店记录（不删除）
      await tx.store.update({ where: { id: srcId }, data: { status: "INACTIVE" } });
      storesDeactivated++;
    }

    // ④ 审计：与业务修改同事务 —— 成功才记录，失败整体回滚（不留半套痕迹）
    await tx.auditLog.create({
      data: {
        actor: operator,
        action: "MERGE_STORE",
        entity: "Store",
        entityId: String(mainStoreId),
        summary:
          "合并门店：" + mergeIds.length + " 家并入「" + main.name + "」，迁移员工 " + employeesMoved + " 人",
        detail: JSON.stringify({
          batchKey,
          type: "store-merge",
          mainStore: { id: mainStoreId, name: main.name },
          mergeStoreIds: mergeIds,
          mergeStoreNames: mergedStoreNames,
          employeesMoved,
          aliasesCreated,
          storesDeactivated,
          at: new Date().toISOString(),
        }),
      },
    });

    return { employeesMoved, aliasesCreated, storesDeactivated, mergedStoreNames };
  });

  const mainTotalAfter = await prisma.employee.count({
    where: { deletedAt: null, storeId: mainStoreId },
  });

  return {
    mainStoreId,
    mainStoreName: main.name,
    mergedStoreIds: mergeIds,
    mergedStoreNames: stats.mergedStoreNames,
    employeesMoved: stats.employeesMoved,
    aliasesCreated: stats.aliasesCreated,
    storesDeactivated: stats.storesDeactivated,
    batchKey,
    mainTotalAfter,
  };
}
