import { prisma } from "./prisma";

/**
 * 门店人员编制（Stage 9.14）
 *
 * 复刻 Excel「门店人员编制」Sheet。核心原则：
 *
 *   **「现有」全部实时统计，「满编」来自人工维护的目标值。**
 *   - 现有各类人数 = 在职表按 `门店 + 工种` 实时 COUNT，**不落库**。
 *     员工一改状态 / 一新增 / 一调岗，这里立刻变，不存在两份数据打架。
 *   - 满编目标 = `StoreHeadcount` 表（从 Excel 一次性导入，之后可在软件里改）。
 *     Excel 里这几列本来就是手填常量、会随经营调整，所以必须能改。
 *
 * 工种口径 —— **逐字对齐 Excel「门店人员编制」Sheet 里的 COUNTIFS 公式**
 * （Stage 9.15 修：此前 4 处口径与 Excel 不符，详见下方「踩坑」注释）：
 *   店长(第3列) → jobGradeRaw ∈ {店长, 代理店长}
 *   技术店长     → jobGradeRaw = 技术店长
 *   副店长       → jobGradeRaw = 副店长
 *   客服经理     → jobGradeRaw = 客服经理
 *   机修现有     → jobGradeRaw ∈ {机修, 技术店长}   ⚠️ **含技术店长**！
 *   美容现有     → jobGradeRaw = 美容（全部，不分职位备注）
 *   后勤         → jobGradeRaw = 后勤
 *   现有美容师傅 → jobGradeRaw = 美容 且 **positionNote** = 师傅
 *   现有美容中小工 → jobGradeRaw = 美容 且 positionNote ∈ {学徒, 中工}
 *   当前合计人数 → SUM(C:I) − D
 *
 * ⚠️ 踩坑 1：「美容师傅/中小工」的判据是 **`positionNote`（职位备注，Excel 在职表 I 列）**，
 *    **不是 `position.name`（职位字典）**。数据库里 position.name 恒为「美容」，
 *    从来不含「师傅」→ 用它判断会让「现有美容师傅」**全表恒为 0**（用户报的现象）。
 * ⚠️ 踩坑 2：「美容中小工」= positionNote ∈ {学徒, 中工}，**不是「非师傅」** ——
 *    positionNote 为空的人两边都不算（只进「美容现有」总数）。
 * ⚠️ 踩坑 3：「机修现有」含「技术店长」—— 而「当前合计人数」= SUM(C:I)−D
 *    正是为了把被 G 列重复计入的技术店长扣掉一次。
 * ⚠️ 踩坑 4：S/T/U 三个缺编列 = 满编 − 现有，**可以是负数（超编）**，
 *    Excel 原样显示 -2；只有 R 列「缺编」汇总用 SUMIF(...,">0") 只累加正数。
 */

export interface HeadcountRow {
  sortOrder: number;
  storeId: number;
  storeName: string;
  /** 现有（实时统计） */
  current: {
    manager: number; // 店长
    techManager: number; // 技术店长
    deputyManager: number; // 副店长
    serviceManager: number; // 客服经理
    mechanic: number; // 机修现有
    beauty: number; // 美容现有（= 师傅 + 中小工）
    logistics: number; // 后勤
    beautyMaster: number; // 现有美容师傅
    beautyJunior: number; // 现有美容中小工
    total: number; // 当前合计人数
  };
  /** 满编（人工维护的目标值，null = 未设） */
  full: {
    serviceManager: number | null;
    mechanic: number | null;
    beauty: number | null;
    beautyMaster: number | null;
    beautyJunior: number | null;
  };
  /** 缺编明细：允许负数（负数 = 超编，Excel 原样显示 -2） */
  gap: {
    /** 缺编汇总 = 只累加各职位「正数」缺编（对应 Excel R 列 SUMIF(S:U,">0")） */
    total: number;
    /** 各职位缺编明细：满编 − 现有，**负数表示超编**，不做 MAX(0,·) 截断 */
    mechanic: number;
    beauty: number;
    serviceManager: number;
    /** 文字说明，只拼接「正数」缺编；无缺编时为空串 */
    detail: string;
  };
}

/** 整表汇总行 */
export interface HeadcountSummary {
  stores: number;
  currentTotal: number;
  fullTotal: number;
  gapTotal: number;
  /** 有缺编的门店数 */
  storesWithGap: number;
  /** 完全满编 / 超出编制的门店数 */
  storesFull: number;
}

const trim = (s: unknown) => String(s ?? "").trim();

export async function getStoreHeadcount(): Promise<{
  rows: HeadcountRow[];
  summary: HeadcountSummary;
}> {
  // 1) 门店 + 满编目标
  const plans = await prisma.storeHeadcount.findMany({
    orderBy: [{ sortOrder: "asc" }, { storeId: "asc" }],
    include: { store: { select: { id: true, name: true, status: true } } },
  });

  // 2) 实时统计：在职员工按 门店 + 工种 分组
  //    只取「已入职」这一类 —— 与「在职」Sheet 的口径保持一致
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, status: "ACTIVE" },
    select: {
      storeId: true,
      jobGradeRaw: true,
      // ⚠️ positionNote 才是「美容师傅 / 中小工」的判据（Excel 在职表 I 列 = 职位备注）
      positionNote: true,
      position: { select: { name: true } },
    },
  });

  // storeId -> 工种计数
  const stat = new Map<number, Record<string, number>>();
  const bump = (storeId: number, key: string, n = 1) => {
    if (storeId === null || storeId === undefined) return;
    if (!stat.has(storeId)) stat.set(storeId, {});
    const m = stat.get(storeId)!;
    m[key] = (m[key] ?? 0) + n;
  };

  for (const e of employees) {
    if (e.storeId === null) continue;
    const grade = trim(e.jobGradeRaw);
    const note = trim(e.positionNote);
    if (grade === "店长" || grade === "代理店长") {
      bump(e.storeId, "manager");
    } else if (grade === "技术店长") {
      bump(e.storeId, "techManager");
      // ⚠️ Excel G 列「机修现有」= COUNTIFS(工种, {"机修","技术店长"}) —— 含技术店长
      bump(e.storeId, "mechanic");
    } else if (grade === "副店长") {
      bump(e.storeId, "deputyManager");
    } else if (grade === "客服经理") {
      bump(e.storeId, "serviceManager");
    } else if (grade === "后勤") {
      bump(e.storeId, "logistics");
    } else if (grade === "机修") {
      bump(e.storeId, "mechanic");
    } else if (grade === "美容") {
      // 美容现有 = 全部美容工种（不分职位备注）
      bump(e.storeId, "beauty");
      // 再按**职位备注 positionNote**细分（不是 position.name！）
      if (note === "师傅") {
        bump(e.storeId, "beautyMaster");
      } else if (note === "学徒" || note === "中工") {
        bump(e.storeId, "beautyJunior");
      }
      // positionNote 为空 / 其它值 → 两边都不计（与 Excel COUNTIFS 一致）
    }
  }

  // 3) 组装每一行
  const rows: HeadcountRow[] = plans.map((h) => {
    const m = stat.get(h.storeId) ?? {};
    const beautyMaster = m.beautyMaster ?? 0;
    const beautyJunior = m.beautyJunior ?? 0;
    // 「美容现有」= 全部美容工种数。
    // ⚠️ 不能再用 beautyMaster + beautyJunior —— positionNote 为空的人
    //    在 Excel 里只计入「美容现有」，不计入师傅/中小工两列。
    const beauty = m.beauty ?? 0;
    const mechanic = m.mechanic ?? 0;
    const techManager = m.techManager ?? 0;
    const current = {
      manager: m.manager ?? 0,
      techManager,
      deputyManager: m.deputyManager ?? 0,
      serviceManager: m.serviceManager ?? 0,
      mechanic,
      beauty,
      logistics: m.logistics ?? 0,
      beautyMaster,
      beautyJunior,
      // Excel J 列 = SUM(C:I) − D：技术店长已含在 G「机修现有」里，要扣掉一次
      total:
        (m.manager ?? 0) +
        (m.deputyManager ?? 0) +
        (m.serviceManager ?? 0) +
        mechanic +
        beauty +
        (m.logistics ?? 0),
    };

    // 缺编明细：满编 − 现有，**允许负数**（负数 = 超编，Excel 原样显示 -2）
    // 满编为 null（未设）时按 0 参与
    const gapOf = (full: number | null, actual: number) =>
      full === null || full === undefined ? 0 : full - actual;

    const gapBeauty = gapOf(h.beautyFull, current.beauty);
    const gapMechanic = gapOf(h.mechanicFull, current.mechanic);
    const gapService = gapOf(h.serviceManagerFull, current.serviceManager);
    // 汇总列（R 列）= SUMIF(S:U, ">0")，只累加正数
    const gapTotal =
      Math.max(0, gapMechanic) + Math.max(0, gapBeauty) + Math.max(0, gapService);

    const parts: string[] = [];
    if (gapService > 0) parts.push(`缺客服经理${gapService}人`);
    if (gapMechanic > 0) parts.push(`缺机修${gapMechanic}人`);
    if (gapBeauty > 0) parts.push(`缺美容${gapBeauty}人`);

    return {
      sortOrder: h.sortOrder,
      storeId: h.storeId,
      storeName: h.store.name,
      current,
      full: {
        serviceManager: h.serviceManagerFull,
        mechanic: h.mechanicFull,
        beauty: h.beautyFull,
        beautyMaster: h.beautyMasterFull,
        beautyJunior: h.beautyJuniorFull,
      },
      gap: {
        total: gapTotal,
        mechanic: gapMechanic,
        beauty: gapBeauty,
        serviceManager: gapService,
        detail: parts.length ? `${h.store.name} ${parts.join(" ")}` : "",
      },
    };
  });

  // 4) 汇总
  const summary: HeadcountSummary = {
    stores: rows.length,
    currentTotal: rows.reduce((s, r) => s + r.current.total, 0),
    fullTotal: rows.reduce(
      (s, r) => s + (r.full.mechanic ?? 0) + (r.full.beauty ?? 0) + (r.full.serviceManager ?? 0),
      0
    ),
    gapTotal: rows.reduce((s, r) => s + r.gap.total, 0),
    storesWithGap: rows.filter((r) => r.gap.total > 0).length,
    storesFull: rows.filter((r) => r.gap.total === 0).length,
  };

  return { rows, summary };
}

/**
 * 保存某家门店的满编目标（人工调整用）
 *
 * 用 upsert：没有就建，有了就改。传 null 表示「不设该职位的满编」。
 */
export async function saveHeadcountPlan(
  storeId: number,
  data: {
    serviceManagerFull?: number | null;
    mechanicFull?: number | null;
    beautyFull?: number | null;
    beautyMasterFull?: number | null;
    beautyJuniorFull?: number | null;
  },
  operator: string
) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true } });
  if (!store) throw new Error("门店不存在");

  const before = await prisma.storeHeadcount.findUnique({
    where: { storeId },
    select: {
      serviceManagerFull: true,
      mechanicFull: true,
      beautyFull: true,
      beautyMasterFull: true,
      beautyJuniorFull: true,
    },
  });

  /**
   * ⚠️ 只更新**请求里真正带了的字段**（Stage 9.15.2 修，严重 bug）。
   *
   * 之前写的是 `data.x ?? null` 全量覆盖 —— 调用方只要没传某个字段，
   * 它就被强行置空。而前端「全部保存」是 for 循环**逐个字段**发请求的
   * （每次只带 1 个字段），于是每点一次「全部保存」就把另外 4 个满编值抹成空。
   * 实测把「常平朗贝社区店」的 客服/美容/师傅/中小工 满编全清空了（审计 14:08:21）。
   *
   * 现在：只有 `"x" in data` 的字段才写入；显式传 `null` 仍表示「清空该字段」。
   */
  const FIELDS = [
    "serviceManagerFull",
    "mechanicFull",
    "beautyFull",
    "beautyMasterFull",
    "beautyJuniorFull",
  ] as const;
  const payload: Record<string, number | null> = {};
  for (const k of FIELDS) {
    if (k in data && data[k] !== undefined) payload[k] = data[k] ?? null;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("没有要修改的满编字段");
  }

  const saved = await prisma.storeHeadcount.upsert({
    where: { storeId },
    create: { storeId, ...payload },
    update: payload,
  });

  // 留痕：满编调整是经营决策，必须能查「谁在什么时候把哪家店的编制改成多少」
  const changes: string[] = [];
  const LABEL: Record<string, string> = {
    serviceManagerFull: "客服经理满编",
    mechanicFull: "机修满编",
    beautyFull: "美容满编",
    beautyMasterFull: "美容师傅满编",
    beautyJuniorFull: "美容中小工满编",
  };
  for (const [k, label] of Object.entries(LABEL)) {
    const b = before ? (before as Record<string, number | null>)[k] ?? null : null;
    const a = (saved as unknown as Record<string, number | null>)[k] ?? null;
    if (b !== a) changes.push(`${label} ${b ?? "空"} → ${a ?? "空"}`);
  }
  if (changes.length) {
    await prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entity: "StoreHeadcount",
        entityId: String(storeId),
        actor: operator,
        detail: `${store.name} 编制调整：${changes.join("；")}`,
      },
    });
  }

  return saved;
}
