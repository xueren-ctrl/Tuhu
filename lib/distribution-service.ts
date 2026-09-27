import { prisma } from "./prisma";

/**
 * 门店人员分布明细（Stage 9.23）
 *
 * 复刻 Excel「门店人员分布明细」Sheet，**10 列逐列一致**：
 *   序号 | 门店 | 门店人数 | 店长 | 副店长 | 技术店长 | 客服经理 | 后勤 | 机修 | 美容
 *
 * ── 全部实时统计，不落库 ────────────────────────────────────────
 * 员工一入职 / 离职 / 调店 / 改工种，这里立刻变，不需要刷新或重新导入。
 *
 * ── 与 Excel 的口径逐条核对（读原始 TEXTJOIN 公式得出）────────────
 *   • **门店名单与顺序**取自 `StoreHeadcount.sortOrder`（= Excel 编制表顺序），
 *     实测与分布明细表 B 列**36 家完全一致、顺序也一致**。
 *   • **门店人数** = 该店全部在职人数（Excel 的 `SUM(编制表C:I)-D`
 *     实际结果与「各工种人名拼接数」逐店相等 —— 已在导入时校验）。
 *   • 7 个工种列各用「、」拼接人名（Excel 用 `TEXTJOIN("、",TRUE,IF(...))`）：
 *       店长     ← jobGradeRaw ∈ {店长, 代理店长}
 *       副店长   ← jobGradeRaw = 副店长
 *       技术店长 ← jobGradeRaw = 技术店长
 *       客服经理 ← jobGradeRaw = 客服经理
 *       后勤     ← jobGradeRaw = 后勤
 *       机修     ← jobGradeRaw = 机修
 *       美容     ← jobGradeRaw = 美容
 *     ⚠️ 严格按 `jobGradeRaw` 原文匹配，**不做任何归一化** ——
 *        与编制表不同（「机修」在编制表里含技术店长，这里不包含）。
 *   • **空工种显示「—」**（Excel 的 TEXTJOIN 空结果），不显示空白。
 *
 * ✅ 2026-09 实测：36 家 × 7 工种 = 252 组人名与 Excel 缓存**逐字一致**，
 *    总人数 290 与 Excel C 列合计 290 完全吻合。
 */

/** 7 个工种列，顺序与 Excel D~J 列严格一致 */
export const DISTRIBUTION_GRADES = [
  { key: "storeManager", label: "店长", grades: ["店长", "代理店长"] },
  { key: "deputyManager", label: "副店长", grades: ["副店长"] },
  { key: "techManager", label: "技术店长", grades: ["技术店长"] },
  { key: "serviceManager", label: "客服经理", grades: ["客服经理"] },
  { key: "logistics", label: "后勤", grades: ["后勤"] },
  { key: "mechanic", label: "机修", grades: ["机修"] },
  { key: "beauty", label: "美容", grades: ["美容"] },
] as const;

export type DistributionGradeKey = (typeof DISTRIBUTION_GRADES)[number]["key"];

export interface DistributionRow {
  sortOrder: number;
  storeName: string;
  /** 门店人数 = 该店全部在职人数 */
  headcount: number;
  /** 各工种的人名数组（空数组表示无人） */
  people: Record<DistributionGradeKey, string[]>;
}

export interface DistributionSummary {
  storeCount: number;
  headcountTotal: number;
  /** 各工种总人数 */
  gradeTotals: Record<DistributionGradeKey, number>;
  /** 各工种最多的门店（按人数降序，最多 3 家） */
  topByGrade: { label: string; key: DistributionGradeKey; stores: { storeName: string; count: number }[] }[];
  /** 覆盖不到的工种（库里有、但 7 列不包含的），正常应为空 */
  uncoveredGrades: { grade: string; count: number }[];
}

export async function getDistribution(): Promise<{
  rows: DistributionRow[];
  summary: DistributionSummary;
}> {
  // ① 门店顺序 = 编制表顺序（与 Excel 分布明细表 B 列一致）
  const plans = await prisma.storeHeadcount.findMany({
    orderBy: [{ sortOrder: "asc" }, { storeId: "asc" }],
    include: { store: { select: { id: true, name: true } } },
  });

  // ② 全部在职且有门店的员工
  const emps = await prisma.employee.findMany({
    where: { deletedAt: null, status: "ACTIVE", storeId: { not: null } },
    select: { storeId: true, name: true, jobGradeRaw: true },
  });

  const byStore = new Map<number, typeof emps>();
  for (const e of emps) {
    const sid = e.storeId!;
    if (!byStore.has(sid)) byStore.set(sid, []);
    byStore.get(sid)!.push(e);
  }

  // ③ 逐店按工种分组
  const rows: DistributionRow[] = plans.map((p) => {
    const list = byStore.get(p.store.id) ?? [];
    const people = {} as Record<DistributionGradeKey, string[]>;
    for (const g of DISTRIBUTION_GRADES) {
      // 严格按 jobGradeRaw 原文匹配，不做任何归一化
      people[g.key] = list
        .filter((e) => g.grades.includes(String(e.jobGradeRaw ?? "").trim() as never))
        .map((e) => e.name);
    }
    return { sortOrder: p.sortOrder, storeName: p.store.name, headcount: list.length, people };
  });

  // ④ 汇总
  const gradeTotals = {} as Record<DistributionGradeKey, number>;
  for (const g of DISTRIBUTION_GRADES) {
    gradeTotals[g.key] = rows.reduce((s, r) => s + r.people[g.key].length, 0);
  }
  const topByGrade = DISTRIBUTION_GRADES.map((g) => ({
    label: g.label,
    key: g.key,
    stores: [...rows]
      .map((r) => ({ storeName: r.storeName, count: r.people[g.key].length }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  }));

  // 覆盖检查：库里出现、但 7 个工种列都不包含的取值
  const covered = new Set<string>(DISTRIBUTION_GRADES.flatMap((g) => [...g.grades]));
  const uncoveredMap = new Map<string, number>();
  for (const e of emps) {
    const g = String(e.jobGradeRaw ?? "").trim();
    if (g && !covered.has(g)) uncoveredMap.set(g, (uncoveredMap.get(g) ?? 0) + 1);
  }
  const uncoveredGrades = [...uncoveredMap.entries()]
    .map(([grade, count]) => ({ grade, count }))
    .sort((a, b) => b.count - a.count);

  return {
    rows,
    summary: {
      storeCount: rows.length,
      headcountTotal: rows.reduce((s, r) => s + r.headcount, 0),
      gradeTotals,
      topByGrade,
      uncoveredGrades,
    },
  };
}
