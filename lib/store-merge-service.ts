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

  const stores = await prisma.store.findMany({ select: { id: true, name: true, code: true, status: true } });
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
  for (const p of pairs) {
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
      pairs.find((p) => ids.includes(p.standardId) && ids.includes(p.aliasId))?.reason ?? "名称高度相似";
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

/** 执行合并 */
export async function mergeStores(opts: {
  mainStoreId: number;
  mergeStoreIds: number[];
  operator?: string;
}): Promise<MergeResult> {
  const { mainStoreId } = opts;
  const operator = opts.operator ?? DEFAULT_OPERATOR;
  const mergeIds = Array.from(new Set(opts.mergeStoreIds)).filter((id) => id !== mainStoreId);
  if (!mergeIds.length) throw new Error("请至少选择一家要合并进来的门店");

  const main = await prisma.store.findUnique({ where: { id: mainStoreId } });
  if (!main) throw new Error("主门店不存在");

  const batchKey = newBatchKey("merge");
  let employeesMoved = 0;
  let aliasesCreated = 0;
  let storesDeactivated = 0;
  const mergedStoreNames: string[] = [];

  for (const srcId of mergeIds) {
    const src = await prisma.store.findUnique({ where: { id: srcId } });
    if (!src) continue;
    mergedStoreNames.push(src.name);

    // ① 只改 storeId：把挂在这家店的员工迁到主门店（不删除、不改其它字段）
    const targets = await prisma.employee.findMany({
      where: { deletedAt: null, storeId: srcId },
      select: { id: true, employeeId: true, storeId: true },
    });
    for (const t of targets) {
      await prisma.employee.update({ where: { id: t.id }, data: { storeId: mainStoreId } });
      await recordEmployeeHistory({
        employeeId: t.id,
        employeeCode: t.employeeId,
        source: "BATCH_UPDATE",
        batchKey,
        operator,
        changes: [{ field: "storeId", oldValue: srcId, newValue: mainStoreId }],
      });
      employeesMoved++;
    }

    // ② 保留历史写法：把被合并的门店名登记为别名
    if (src.name !== main.name) {
      const exists = await prisma.storeAlias.findUnique({ where: { alias: src.name } });
      if (!exists) {
        try {
          await prisma.storeAlias.create({
            data: {
              storeId: mainStoreId,
              alias: src.name,
              note: "门店合并：原独立门店记录「" + src.name + "」并入「" + main.name + "」",
            },
          });
          aliasesCreated++;
        } catch {
          /* 别名冲突时不阻断合并 */
        }
      }
      // 顺带把原文列仍写着旧名、且尚未归属主门店的员工也统一过来（同样只改外键）
      const stragglers = await prisma.employee.findMany({
        where: {
          deletedAt: null,
          storeNameRaw: src.name,
          OR: [{ storeId: null }, { storeId: { not: mainStoreId } }],
        },
        select: { id: true, employeeId: true, storeId: true },
      });
      for (const t of stragglers) {
        await prisma.employee.update({ where: { id: t.id }, data: { storeId: mainStoreId } });
        await recordEmployeeHistory({
          employeeId: t.id,
          employeeCode: t.employeeId,
          source: "BATCH_UPDATE",
          batchKey,
          operator,
          changes: [{ field: "storeId", oldValue: t.storeId, newValue: mainStoreId }],
        });
        employeesMoved++;
      }
    }

    // ③ 停用被合并的门店记录（不删除）
    await prisma.store.update({ where: { id: srcId }, data: { status: "INACTIVE" } });
    storesDeactivated++;
  }

  await prisma.auditLog.create({
    data: {
      actor: operator,
      action: "MERGE_STORE",
      entity: "Store",
      entityId: String(mainStoreId),
      summary:
        "合并门店：" + mergeIds.length + " 家并入「" + main.name + "」，迁移员工 " + employeesMoved + " 人",
      detail: JSON.stringify({ mergeStoreIds: mergeIds, batchKey }),
    },
  });

  const mainTotalAfter = await prisma.employee.count({
    where: { deletedAt: null, storeId: mainStoreId },
  });

  return {
    mainStoreId,
    mainStoreName: main.name,
    mergedStoreIds: mergeIds,
    mergedStoreNames,
    employeesMoved,
    aliasesCreated,
    storesDeactivated,
    batchKey,
    mainTotalAfter,
  };
}
