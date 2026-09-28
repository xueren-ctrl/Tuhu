import { prisma } from "./prisma";

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
}

export interface PositionScopeOptions {
  store: PositionScopeItem[];
  ops: PositionScopeItem[];
  /** 字典里缺失的职位名（新建职位后字典未补齐时会命中，属异常，会在测试里报错） */
  missing: string[];
}

export async function getPositionScopeOptions(): Promise<PositionScopeOptions> {
  const names = [...STORE_POSITION_NAMES, ...OPS_POSITION_NAMES];
  const rows = await prisma.position.findMany({
    where: { name: { in: [...names] }, status: "ACTIVE" },
    select: { id: true, name: true },
  });
  const byName = new Map(rows.map((r) => [r.name, r.id]));

  const pick = (list: readonly string[], group: PositionGroup): PositionScopeItem[] =>
    list
      .filter((n) => byName.has(n))
      .map((n) => ({
        id: byName.get(n)!,
        name: n,
        group,
        hasNote: n === BEAUTY_POSITION_NAME,
      }));

  const missing = names.filter((n) => !byName.has(n));
  return {
    store: pick(STORE_POSITION_NAMES, "store"),
    ops: pick(OPS_POSITION_NAMES, "ops"),
    missing,
  };
}

/** 全部启用职位（仅供「筛选/查看」场景展开用，不用于录入） */
export async function getAllActivePositions(): Promise<{ id: number; name: string }[]> {
  return prisma.position.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
