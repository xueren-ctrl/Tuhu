/** 职位选择范围（Stage 9.32 / Stage 9.41 修正） */

import { prisma } from "./prisma";
import { isManualEntry } from "./manual-entry-cutoff";

/**
 * 职位选择范围（Stage 9.32）
 *
 * 用户口径（2026-09-28 明确给出，勿自行增删）：
 *   **门店职位（7 种）**：店长、副店长、后勤、机修、技术店长、客服经理、美容
 *   **运营部职位（3 种）**：文员、区域经理、人事
 *   **职位备注**：只有「美容」才有，分为 师傅 / 中工 / 学徒 三种
 *
 * 为什么不用 `Position` 表全量（52 条）：
 *   那是 Excel 导入时建的历史字典，含「青铜机修技师」「美容学徒」「储备店长」等
 *   几百人的历史细分值。在职员工实际只用到上面 10 种（在职在用 7 种 + 运营部 3 种），
 *   让人从 52 项里翻是灾难。历史值仍可通过「更多职位」展开检索。
 *
 * ⚠️ 存量事实（2026-09-28 实测，改代码前先看）：
 *   - 1880 人有 positionId，只有 **752 人**落在 7 种范围内，其余都是**离职**人员的历史细分职位
 *     （青铜机修技师 405、青铜美容技师 308、美容学徒 133、学生 68、前台 59…）。
 *   - 运营部离职人员里也有范围外职位：视频剪辑、茶艺师、储备店长、抖音运营。
 *   - positionNote 只有 师傅/学徒/中工 三种，**唯一异常**：李小虎（已面试·美容）备注写的是「贴膜」。
 *   → 所以「编辑时当前值永远可选」和「筛选可展开更多职位」这两条保护是**必须的**，
 *     否则一编辑历史员工就会把职位悄悄改掉（丢数据）。
 *
 * ══════════════════════════════════════════════════════════════════
 * Stage 9.41（2026-10-05）修：新建的职位在「新增员工」表单里选不到
 * ══════════════════════════════════════════════════════════════════
 * 用户反馈：「我在职位管理新增了一个职位，在新增员工那里选不了」。
 *
 * **根因是死循环**：范围只认「写死的 7+3 个名字」，而新职位不在名单里 →
 * 表单选不了 → 用户没法给新人选这个职位 → 这个职位永远不会有人用 →
 * 更不会进入「有人用的职位」范围。**新建 = 永远选不了，必须改代码才能用。**
 *
 * 用户选择的方案（2026-10-05 确认）：**常用在前 + 完整可搜**
 *   · 白名单 7+3 仍然排在最前（最常用、最快）
 *   · **其余 ACTIVE 职位全部进候选，但排在后面**，让新建的能立刻选到
 *   · 历史上 43 个「无人使用」的历史细分职位也一并纳入（它们的危害只是列表长一点，
 *     而「选不到」的危害是用户没法正常录人 —— 后者严重得多）
 *   · 录入场景（新增/编辑员工）用 `getPositionScopeOptions()`
 *   · 筛选场景继续用 `getAllActivePositions()`（「更多职位」展开）
 *
 * ⚠️ 仍然**排除 INACTIVE**：停用的职位不该出现在录入表单里。
 */

/** 门店职位（顺序即联想列表展示顺序，按用户给出的顺序） */
export const STORE_POSITION_NAMES = [
  "店长",
  "副店长",
  "后勤",
  "机修",
  "技术店长",
  "客服经理",
  "美容",
] as const;

/** 运营部职位 */
export const OPS_POSITION_NAMES = ["文员", "区域经理", "人事"] as const;

/** 职位备注的可选值（仅「美容」职位有意义） */
export const POSITION_NOTE_OPTIONS = ["师傅", "中工", "学徒"] as const;

/** 唯一有职位备注的职位名 */
export const BEAUTY_POSITION_NAME = "美容";

export type PositionGroup = "store" | "ops";

export interface PositionScopeItem {
  id: number;
  name: string;
  group: PositionGroup;
  /** 是否需要填职位备注（= 美容） */
  hasNote: boolean;
  /**
   * 分层（Stage 9.41 v2）：
   * - `common` = 用户指定的常用 7+3 —— **排在最前**
   * - `other`  = 有人在用的其他职位（当前在职员工真在用）
   * - `manual` = **用户手动新建**的职位 —— 必须能选到
   *
   *   Excel 导入但从没人用过的历史职位（「青铜机修技师」…）**不进候选**
   *   （用户 2026-10-05：「之前那些已经不用的就不用选了」）
   */
  tier: "common" | "other" | "manual";
  /** 是否已被在职/南昌3店/运营部的人使用（用于「历史细分」提示） */
  inUse?: number;
}

export interface PositionScopeOptions {
  store: PositionScopeItem[];
  ops: PositionScopeItem[];
  /** 常用 7+3 里字典缺失的职位名（属异常，会在测试里报错） */
  missing: string[];
  /** 常用以外的候选数（有人在用的 + 手动新建的） */
  otherCount: number;
  /** 被排除的「导入但从没人用过」的历史职位数 */
  legacyCount: number;
}

/**
 * 候选职位 = 常用 7+3（在前） + 其余全部 ACTIVE（在后）
 *
 * ⚠️ Stage 9.41：以前这里只有写死的 7+3，导致「职位管理里新建的职位」在
 *    新增员工表单里**永远选不到**（用户 2026-10-05 反馈）。现在全部 ACTIVE 都进候选。
 */
export async function getPositionScopeOptions(): Promise<PositionScopeOptions> {
  const names = [...STORE_POSITION_NAMES, ...OPS_POSITION_NAMES];
  const rows = await prisma.position.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, createdAt: true },
  });
  const byName = new Map(rows.map((r) => [r.name, r.id]));

  /** 有在职/南昌3店/运营部员工在用的职位 → 标注「历史细分」（说明是旧职位不是新职位） */
  const usedCount = new Map<number, number>();
  const used = await prisma.employee.groupBy({
    by: ["positionId"],
    where: {
      positionId: { not: null },
      deletedAt: null,
      status: { in: ["ACTIVE", "NC3", "OPS"] },
    },
    _count: { _all: true },
  });
  for (const u of used) {
    if (u.positionId !== null) usedCount.set(u.positionId, u._count._all);
  }

  const store: PositionScopeItem[] = [];
  const ops: PositionScopeItem[] = [];
  const takenIds = new Set<number>();

  const pick = (list: readonly string[], group: PositionGroup) => {
    for (const n of list) {
      const id = byName.get(n);
      // 重复名字只取一次（字典里可能有同名两条）
      if (id === undefined || takenIds.has(id)) continue;
      takenIds.add(id);
      const item: PositionScopeItem = {
        id,
        name: n,
        group,
        hasNote: n === BEAUTY_POSITION_NAME,
        tier: "common",
      };
      (group === "store" ? store : ops).push(item);
    }
  };
  pick(STORE_POSITION_NAMES, "store");
  pick(OPS_POSITION_NAMES, "ops");

  const missing = names.filter((n) => !byName.has(n));

  /**
   * ── Stage 9.41 v2（用户二次纠正）：只收「常用」+「手动新建」+「有人在用」 ──
   * 排除：**Excel 导入但从没人用过的历史细分职位**（青铜机修技师、储备店长、前台…共 40 种）。
   * 用户原话：「之前那些已经不用的门店和职位就不用���了」。
   * 判定：`isManualEntry(createdAt)`（见 lib/manual-entry-cutoff.ts）
   *   —— 导入是 2026-09-19 13:43 一次性建的，手动新建的明显更晚。
   */
  const OPS_HINT = /(运营|人事|行政|财务|文员|经理|助理|前台文员)/;
  const others: PositionScopeItem[] = [];
  let legacyCount = 0;
  for (const r of rows) {
    if (takenIds.has(r.id)) continue;
    const inUse = usedCount.get(r.id) ?? 0;
    const isManual = isManualEntry(r.createdAt);
    // 没人用 + 不是手动新建 → 历史遗留，不进候选
    if (inUse === 0 && !isManual) {
      legacyCount++;
      continue;
    }
    others.push({
      id: r.id,
      name: r.name,
      group: (OPS_HINT.test(r.name) ? "ops" : "store") as PositionGroup,
      hasNote: r.name === BEAUTY_POSITION_NAME,
      tier: isManual ? "manual" : "other",
      inUse,
    });
  }
  // 有人在用的排前面（更像「正常在用的职位」），其次按名字
  others.sort((a, b) => {
    const ua = a.inUse ?? 0;
    const ub = b.inUse ?? 0;
    if (ua !== ub) return ub - ua;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  for (const o of others) {
    (o.group === "store" ? store : ops).push(o);
  }

  return { store, ops, missing, otherCount: others.length, legacyCount };
}

/** 全部启用职位（仅供「筛选/查看」场景展开用，不用于录入） */
export async function getAllActivePositions(): Promise<{ id: number; name: string }[]> {
  return prisma.position.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
