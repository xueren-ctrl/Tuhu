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
 * 工种口径（与 Excel 的 COUNTIFS 完全一致）：
 *   店长      → jobGradeRaw ∈ {店长, 代理店长}   ⚠️ 代理店长在部分门店也计入店长
 *   技术店长   → jobGradeRaw = 技术店长
 *   副店长    → jobGradeRaw = 副店长
 *   客服经理   → jobGradeRaw = 客服经理
 *   后勤      → jobGradeRaw = 后勤
 *   机修现有   → jobGradeRaw = 机修
 *   美容师傅   → jobGradeRaw = 美容 且 职位含「师傅」
 *   美容中小工 → jobGradeRaw = 美容 且 非师傅
 *
 * 「美容」在 Excel 里还有第 8 列「美容现有」= 机修?不，是 美容师傅 + 美容中小工
 * （Excel 第 8 列是美容现有总数 = 第16、17列之和）。
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
  /** 缺编 */
  gap: {
    /** 缺编汇总 = MAX(0, 各职位满编 - 现有) 之和 */
    total: number;
    /** 各职位缺编明细 */
    mechanic: number;
    beauty: number;
    serviceManager: number;
    /** 文字说明，如「塘厦田心店 缺美容1人」；无缺编时为空串 */
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
      position: { select: { name: true } },
    },
  });

  // storeId -> 工种计数
  const stat = new Map<number, Record<string, number>>();
  const bump = (storeId: number, key: string) => {
    if (storeId === null || storeId === undefined) return;
    if (!stat.has(storeId)) stat.set(storeId, {});
    const m = stat.get(storeId)!;
    m[key] = (m[key] ?? 0) + 1;
  };

  for (const e of employees) {
    if (e.storeId === null) continue;
    const grade = trim(e.jobGradeRaw);
    const posName = trim(e.position?.name);
    if (grade === "店长" || grade === "代理店长") {
      bump(e.storeId, "manager");
    } else if (grade === "技术店长") {
      bump(e.storeId, "techManager");
    } else if (grade === "副店长") {
      bump(e.storeId, "deputyManager");
    } else if (grade === "客服经理") {
      bump(e.storeId, "serviceManager");
    } else if (grade === "后勤") {
      bump(e.storeId, "logistics");
    } else if (grade === "机修") {
      bump(e.storeId, "mechanic");
    } else if (grade === "美容") {
      // 美容再按职位细分：含「师傅」算师傅，其余算中小工
      if (posName.includes("师傅")) bump(e.storeId, "beautyMaster");
      else bump(e.storeId, "beautyJunior");
    }
  }

  // 3) 组装每一行
  const rows: HeadcountRow[] = plans.map((h) => {
    const m = stat.get(h.storeId) ?? {};
    const beautyMaster = m.beautyMaster ?? 0;
    const beautyJunior = m.beautyJunior ?? 0;
    const current = {
      manager: m.manager ?? 0,
      techManager: m.techManager ?? 0,
      deputyManager: m.deputyManager ?? 0,
      serviceManager: m.serviceManager ?? 0,
      mechanic: m.mechanic ?? 0,
      beauty: beautyMaster + beautyJunior, // 美容现有 = 师傅 + 中小工
      logistics: m.logistics ?? 0,
      beautyMaster,
      beautyJunior,
      total:
        (m.manager ?? 0) +
        (m.techManager ?? 0) +
        (m.deputyManager ?? 0) +
        (m.serviceManager ?? 0) +
        (m.mechanic ?? 0) +
        beautyMaster +
        beautyJunior +
        (m.logistics ?? 0),
    };

    // 缺编：满编为 null（未设）时按 0 参与，视为「不要求」
    const gapOf = (full: number | null, actual: number) =>
      full === null || full === undefined ? 0 : Math.max(0, full - actual);

    const gapBeauty = Math.max(
      gapOf(h.beautyFull, current.beauty),
      // Excel 里「美容缺编」用的是 美容满编 与 美容现有 之差
      0
    );
    const gapMechanic = gapOf(h.mechanicFull, current.mechanic);
    const gapService = gapOf(h.serviceManagerFull, current.serviceManager);
    const gapTotal = gapMechanic + gapBeauty + gapService;

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

  const payload = {
    serviceManagerFull: data.serviceManagerFull ?? null,
    mechanicFull: data.mechanicFull ?? null,
    beautyFull: data.beautyFull ?? null,
    beautyMasterFull: data.beautyMasterFull ?? null,
    beautyJuniorFull: data.beautyJuniorFull ?? null,
  };

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
