import { prisma } from "./prisma";

/**
 * 门店选择范围（Stage 9.30）
 *
 * 用户口径（2026-09-28 明确要求）：
 *   门店下拉只放 **在职表里的门店** + **南昌3店里的门店**，
 *   不用全部 67 家门店（历史/停业门店太多，翻不动也容易选错）。
 *
 * ⚠️ 为什么不直接用 `Store.status = ACTIVE`（67 家）：
 *   那是「门店主数据里所有启用门店」，包含大量已无人或只有离职人员的店。
 *
 * 口径（实时查库，不写死）：
 *   在职表 = Employee.status = 'ACTIVE'   → 实测 37 家（含 290 人）
 *   南昌3店 = Employee.status = 'NC3'     → 实测 3 家（含 15 人）
 *   合计 40 家。
 *   ⚠️ 用户口述是「36 + 3」，差的 1 家是 `东城景湖春天`(#342) 与
 *      `东城景湖春天店`(#343) —— 两条**独立的门店记录**（详见 README 记忆）。
 *      本服务不擅自合并门店（那是生产治理动作，需用户逐组确认），
 *      只在返回里带上各家在职人数，让用户能在联想列表里分辨。
 *
 * 返回的 `activeCount` 用于 UI 显示「在职 N 人」，这是同名门店唯一可靠的区分方式。
 */
export interface StoreScopeItem {
  id: number;
  name: string;
  /** 该店在职人数（status=ACTIVE） */
  activeCount: number;
  /** 该店南昌3店人数（status=NC3），在职表口径为 0 */
  nc3Count: number;
}

export interface StoreScopeOptions {
  /** 在职 + 南昌3店 的门店（按名称排序） */
  stores: StoreScopeItem[];
  /** 门店主数据里启用门店总数（页面用来提示「还有更多历史门店」） */
  allStoreCount: number;
}

export async function getStoreScopeOptions(): Promise<StoreScopeOptions> {
  const rows = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { status: { in: ["ACTIVE", "NC3"] }, storeId: { not: null }, deletedAt: null },
    _count: { _all: true },
  });

  // 汇总到 storeId 维度
  const acc = new Map<number, StoreScopeItem>();
  for (const r of rows) {
    if (r.storeId === null) continue;
    const cur = acc.get(r.storeId) ?? { id: r.storeId, name: "", activeCount: 0, nc3Count: 0 };
    if (r.status === "ACTIVE") cur.activeCount += r._count._all;
    else cur.nc3Count += r._count._all;
    acc.set(r.storeId, cur);
  }

  // 取门店名（可能存在 storeId 指向已删除 Store 的脏数据 → 直接丢弃，不给用户选）
  const ids = [...acc.keys()];
  const stores = ids.length
    ? await prisma.store.findMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(stores.map((s) => [s.id, s.name]));

  const list: StoreScopeItem[] = [];
  for (const item of acc.values()) {
    const name = nameById.get(item.id);
    if (!name) continue; // 门店已停用/删除 → 不进选择范围
    list.push({ ...item, name });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const allStoreCount = await prisma.store.count({ where: { status: "ACTIVE" } });
  return { stores: list, allStoreCount };
}

/**
 * 全部启用门店（仅用于「筛选/查看」场景，不用于录入）。
 *
 * 为什么单独提供：筛离职人员时要能按历史门店查，否则查不到人。
 */
export async function getAllActiveStores(): Promise<{ id: number; name: string }[]> {
  return prisma.store.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
