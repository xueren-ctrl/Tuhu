import { prisma } from "./prisma";
import { isManualEntry } from "./manual-entry-cutoff";

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
  /**
   * 分层（Stage 9.41，用户 2026-10-05 两次更正）：
   * - `inScope` = 在职表/南昌3店里有人的门店 —— **排在最前**
   * - `manual`  = **用户手动新建**的门店 —— 排在中间，
   *   必须能选到，否则新建门店后没法给第一个人录进去（死循环）
   * - `legacy`  = Excel 导入但**从来没人用过**的门店 —— **不显示**
   *   （用户原话：「之前那些已经不用的门店和职位就不用选了」）
   */
  tier: "inScope" | "manual" | "legacy";
  /** 该店历史总人数（含离职），用于给新门店一个可信度提示 */
  historyCount: number;
}

export interface StoreScopeOptions {
  /** 候选门店：有人的在前 → 手动新建的次之（均按名称拼音排） */
  stores: StoreScopeItem[];
  /** 门店主数据里启用门店总数（页面用来提示「还有更多历史门店」） */
  allStoreCount: number;
  /** 被排除的「导入但从没人用过」的门店数（页面可提示"已折叠 N 家历史门店"） */
  legacyCount: number;
}

/**
 * 候选门店 = 在职/南昌3店里有人的 + **用户手动新建的**
 *
 * ══════════════════════════════════════════════════════════════════
 * Stage 9.41 演进（用户两次更正，勿走回头路）
 * ══════════════════════════════════════════════════════════════════
 * 原始问题：「我新增了一个门店，也选不了」
 *   根因是死循环 —— 范围 =「有在职或南昌3店员工的门店」，
 *   而新建的门店一个人都没有 → 进不了范围 → 表单选不了 →
 *   没法给第一个人录员工 → 这店永远没人 → 永远进不了范围。
 *   等于「**开了一家新店，软件就再也录不进人了**」，比职位那个更严重。
 *
 * v1（我第一版理解错了）：候选 = **全部 ACTIVE 门店**（67 → 合并后 52 家）
 *   后果：把**13 家 Excel 导入但从来没人用过的店**也塞进了列表，
 *   用户看到一堆用不上的店反而更难找。用户明确纠正：
 *   > 「我说的是我手动新增的门店和职位，之前那些已经不用的门店和职位就不用选了」
 *
 * v2（本版）：候选 = **有人的 ∪ 手动新建的**
 *   · 有人的（39 家）—— 在职/南昌3店里有员工，肯定要用
 *   · 手动新建的 —— 用 `createdAt` 识别。导入是 2026-09-19 13:43 **一次性**建的
 *     （66 家门店 / 52 种职位全在同一秒），手动新建的 createdAt 明显更晚：
 *     实测门店 #435 `dajdia店`=10-05、#434 `其他`=09-25；职位 #323 `dd`=10-05。
 *   · 导入但没人用的 → **不显示**。它们仍在 `getAllActiveStores()` 里，
 *     筛离职人员时按「更多门店」照样能查到，只是不占录入时的位置。
 *
 * 仍排除 INACTIVE（停用门店不该出现在录入表单）。
 */
export async function getStoreScopeOptions(): Promise<StoreScopeOptions> {
  // ⚠️ Stage 9.41 改：查全部 ACTIVE 门店（不再只查「有人的」），
  //    否则新建的门店永远进不了候选。**legacy 的会在这里被过滤掉**。
  const allActive = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, createdAt: true },
  });

  // 按门店 × 状态统计人数（含离职，用于给「空店」提示历史规模）
  const rows = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { storeId: { not: null }, deletedAt: null },
    _count: { _all: true },
  });

  const acc = new Map<number, { activeCount: number; nc3Count: number; historyCount: number }>();
  for (const r of rows) {
    if (r.storeId === null) continue;
    const cur = acc.get(r.storeId) ?? { activeCount: 0, nc3Count: 0, historyCount: 0 };
    if (r.status === "ACTIVE") cur.activeCount += r._count._all;
    else if (r.status === "NC3") cur.nc3Count += r._count._all;
    cur.historyCount += r._count._all;
    acc.set(r.storeId, cur);
  }

  const list: StoreScopeItem[] = [];
  let legacyCount = 0;
  for (const s of allActive) {
    const cur = acc.get(s.id);
    const activeCount = cur?.activeCount ?? 0;
    const nc3Count = cur?.nc3Count ?? 0;
    const hasPeople = activeCount > 0 || nc3Count > 0;
    const isManual = isManualEntry(s.createdAt);
    // 没人用 + 不是手动新建 → 历史遗留，不进候选
    if (!hasPeople && !isManual) {
      legacyCount++;
      continue;
    }
    list.push({
      id: s.id,
      name: s.name,
      activeCount,
      nc3Count,
      tier: hasPeople ? "inScope" : "manual",
      historyCount: cur?.historyCount ?? 0,
    });
  }

  // 有人在职的排前面，手动新建的排后面（各组内按名称拼音排）
  list.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "inScope" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  return { stores: list, allStoreCount: allActive.length, legacyCount };
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
