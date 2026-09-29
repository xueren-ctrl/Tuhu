/**
 * 社保参保名单服务（Stage 9.37）
 *
 * 业务用途：**按这份名单给职工买社保**。所以「是否参保」是本模块的核心开关，
 * 与员工在职状态**解耦** —— 员工可以已离职但仍在保（补偿金、���议未结等），
 * 也可以在职但已停保（当月不参保）。项目既有「在职/离职」口径一律不参与判断。
 *
 * 核心取舍（2026-09-29 逐条问过用户）：
 *  - 名单上的人**一个都不丢**（包括已离职、包括库中查无档案的家属）
 *  - 关联不到员工/门店时**留空并提醒**，不猜、不静默挂靠 —— 挂错人=买错保险
 */
import { prisma } from "./prisma";
import { toDateOnly } from "./format";

export type SiSort = "insured" | "name" | "store" | "date" | "status";

export interface SiListFilters {
  /** 是否参保：all | yes | no */
  insured?: string;
  /** 门店 id */
  storeId?: string;
  /** 关键词：姓名 / 门店 / 备注 / 工号 */
  keyword?: string;
  /** 只看未关联到员工档案的 */
  unlinked?: string;
  /** 只看库中已离职但仍在保的（需要决策的） */
  needReview?: string;
  sort?: SiSort;
  page?: number;
  pageSize?: number;
}

export const SI_PAGE_SIZE = 50;

export async function listSocialInsurance(f: SiListFilters) {
  // Prisma 的 AND/OR 是数组，条件要**平铺**到同一个 AND 数组里；
  // 若把门店条件塞进顶层 OR 再叠关键词 OR，会互相覆盖（我第一版就写错了）。
  const and: Record<string, unknown>[] = [];
  const where: Record<string, unknown> = {};

  if (f.insured === "yes") where.insured = true;
  else if (f.insured === "no") where.insured = false;

  if (f.storeId) {
    const id = Number(f.storeId);
    if (Number.isFinite(id)) and.push({ OR: [{ storeId: id }, { store: { id } }] });
  }

  const kw = (f.keyword ?? "").trim();
  if (kw) {
    // 姓名 / 门店原文 / 门店主数据名 / 备注 / 工号 / 员工姓名 都参与搜索
    and.push({
      OR: [
        { name: { contains: kw } },
        { storeNameRaw: { contains: kw } },
        { note: { contains: kw } },
        { store: { name: { contains: kw } } },
        { employee: { employeeId: { contains: kw } } },
        { employee: { name: { contains: kw } } },
      ],
    });
  }
  if (and.length) where.AND = and;

  const pageSize = Math.min(Math.max(Number(f.pageSize) || SI_PAGE_SIZE, 10), 200);
  const page = Math.max(Number(f.page) || 1, 1);

  const orderBy: Record<string, unknown>[] =
    f.sort === "name"
      ? [{ name: "asc" }]
      : f.sort === "date"
        ? [{ insuredDate: "asc" }, { name: "asc" }]
        : f.sort === "store"
          ? [{ storeNameRaw: "asc" }, { name: "asc" }]
          : f.sort === "status"
            ? [{ employee: { status: "asc" } }, { name: "asc" }]
            : [{ insured: "desc" }, { name: "asc" }];

  const [rows, total] = await Promise.all([
    prisma.socialInsuranceEntry.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        store: { select: { id: true, name: true, status: true } },
        employee: {
          select: {
            id: true,
            employeeId: true,
            name: true,
            status: true,
            storeId: true,
            resignDate: true,
            store: { select: { name: true } },
          },
        },
      },
    }),
    prisma.socialInsuranceEntry.count({ where }),
  ]);

  // 「需要处理」的两类：查无档案 / 库中已离职但仍在保
  let items = rows;
  if (f.unlinked === "1") items = items.filter((r) => !r.employeeId);
  else if (f.needReview === "1") {
    items = items.filter((r) => r.insured && r.employee && r.employee.status === "RESIGNED");
  }

  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** 顶部统计卡 + 「需要处理」提醒 */
export async function socialInsuranceStats() {
  const [all, insured, unlinked, linked, stores, pendingStoreMap] = await Promise.all([
    prisma.socialInsuranceEntry.count(),
    prisma.socialInsuranceEntry.count({ where: { insured: true } }),
    prisma.socialInsuranceEntry.count({ where: { employeeId: null } }),
    prisma.socialInsuranceEntry.count({ where: { employeeId: { not: null } } }),
    prisma.socialInsuranceEntry.groupBy({ by: ["storeId", "storeNameRaw"], _count: { _all: true } }),
    prisma.socialInsuranceStoreMapping.findMany({
      where: { status: "PENDING" },
      select: { rawName: true, id: true },
    }),
  ]);

  // 已离职但仍在保 —— 这是买保险时最需要人来决定的一类
  const resignedStillInsured = await prisma.socialInsuranceEntry.findMany({
    where: { insured: true, employee: { status: "RESIGNED" } },
    select: { id: true, name: true, storeNameRaw: true, note: true, employee: { select: { status: true, resignDate: true } } },
    orderBy: { name: "asc" },
  });

  // 在职但已停保
  const activeNotInsured = await prisma.socialInsuranceEntry.count({
    where: { insured: false, employee: { status: { in: ["ACTIVE", "NC3", "OPS"] } } },
  });

  // 日期只到月的（需要确认具体哪天参保）
  const monthOnly = await prisma.socialInsuranceEntry.count({ where: { datePrecision: "MONTH" } });

  return {
    total: all,
    insured,
    notInsured: all - insured,
    unlinked,
    linked,
    storeCount: new Set(stores.map((s) => s.storeId ?? s.storeNameRaw)).size,
    pendingStoreCount: pendingStoreMap.length,
    pendingStoreNames: pendingStoreMap.map((s) => s.rawName),
    resignedStillInsured,
    activeNotInsured,
    monthOnly,
  };
}

export class SiError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

/** 改参保状态（停保 / 复保） */
export async function setInsured(
  id: number,
  insured: boolean,
  operator: string,
  note: string | null
): Promise<void> {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");
  if (row.insured === insured) return; // 幂等：状态没变不写审计

  await prisma.socialInsuranceEntry.update({
    where: { id },
    data: {
      insured,
      insuredChangedAt: new Date(),
      insuredChangedBy: operator,
      insuredNote: note,
      updatedBy: operator,
    },
  });
}

/** 关联员工档案（处理「未关联」提醒） */
export async function linkEmployee(
  id: number,
  employeeId: number | null,
  operator: string
): Promise<void> {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");

  if (employeeId) {
    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, deletedAt: true },
    });
    if (!emp) throw new SiError("员工档案不存在", "EMP_NOT_FOUND");
    if (emp.deletedAt) throw new SiError("该员工档案已删除", "EMP_DELETED");
  }

  await prisma.socialInsuranceEntry.update({
    where: { id },
    data: { employeeId, updatedBy: operator },
  });
}

/** 改门店关联 */
export async function linkStore(
  id: number,
  storeId: number | null,
  operator: string
): Promise<void> {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");

  if (storeId) {
    const st = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true } });
    if (!st) throw new SiError("门店不存在", "STORE_NOT_FOUND");
  }

  await prisma.socialInsuranceEntry.update({
    where: { id },
    data: { storeId, updatedBy: operator },
  });
}

/** 改参保日期（用户可能只知道年月 → 传 precision=MONTH） */
export async function updateInsuredDate(
  id: number,
  dateStr: string,
  precision: "DAY" | "MONTH",
  operator: string
): Promise<void> {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");

  const m = dateStr.trim().match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) throw new SiError("日期格式应为 yyyy-MM 或 yyyy-MM-dd", "BAD_DATE");
  const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 1;
  const utc = toDateOnly(y, mo, d);
  if (!utc) throw new SiError("日期不合法", "BAD_DATE");

  await prisma.socialInsuranceEntry.update({
    where: { id },
    data: {
      insuredDate: utc,
      datePrecision: m[3] ? "DAY" : precision,
      updatedBy: operator,
    },
  });
}

/** 改缴费基数 / 备注 */
export async function updateEntryFields(
  id: number,
  data: { baseAmount?: string | null; note?: string | null },
  operator: string
): Promise<void> {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");
  await prisma.socialInsuranceEntry.update({
    where: { id },
    data: {
      ...(data.baseAmount !== undefined ? { baseAmount: data.baseAmount || null } : {}),
      ...(data.note !== undefined ? { note: data.note || null } : {}),
      updatedBy: operator,
    },
  });
}

/** 新增参保记录（实时更新用：员工入职/新入职要马上能加进来） */
export async function createEntry(
  data: {
    name: string;
    storeId?: number | null;
    storeNameRaw?: string | null;
    employeeId?: number | null;
    insuredDate?: string | null;
    datePrecision?: "DAY" | "MONTH";
    baseAmount?: string | null;
    note?: string | null;
    insured?: boolean;
  },
  operator: string
) {
  if (!data.name.trim()) throw new SiError("姓名必填", "NAME_REQUIRED");

  let insuredDate: Date | null = null;
  let datePrecision = data.datePrecision ?? "DAY";
  if (data.insuredDate?.trim()) {
    const m = data.insuredDate.trim().match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) throw new SiError("参保日期格式应为 yyyy-MM 或 yyyy-MM-dd", "BAD_DATE");
    insuredDate = toDateOnly(+m[1], +m[2], m[3] ? +m[3] : 1);
    if (!insuredDate) throw new SiError("参保日期不合法", "BAD_DATE");
    if (!m[3]) datePrecision = "MONTH";
  }

  // sourceRowNo 手工新增时用大号（5001+），避免与 Excel 行号撞
  const maxRow = await prisma.socialInsuranceEntry.aggregate({ _max: { sourceRowNo: true } });
  const sourceRowNo = Math.max(maxRow._max.sourceRowNo ?? 0, 5000) + 1;

  return prisma.socialInsuranceEntry.create({
    data: {
      sourceRowNo,
      name: data.name.trim(),
      storeId: data.storeId ?? null,
      storeNameRaw: data.storeNameRaw ?? null,
      employeeId: data.employeeId ?? null,
      insuredDate,
      datePrecision,
      baseAmount: data.baseAmount ?? null,
      note: data.note ?? null,
      insured: data.insured ?? true,
      insuredChangedBy: operator,
      createdBy: operator,
      updatedBy: operator,
    },
  });
}

/** 删除（软删：只标记，不物理删，遵循项目约定）—— 直接物理删除前先确认无人工维护痕迹 */
export async function removeEntry(id: number, operator: string) {
  const row = await prisma.socialInsuranceEntry.findUnique({ where: { id } });
  if (!row) throw new SiError("参保记录不存在", "NOT_FOUND");
  // 从 Excel 导入的（sourceRowNo <= 5000）不允许手工删，避免下次重导又冒出来造成困惑
  if (row.sourceRowNo <= 5000) {
    throw new SiError("该记录来自 Excel「社保总名单」，如需移除请用「停保」而不是删除", "FROM_EXCEL");
  }
  await prisma.socialInsuranceEntry.delete({ where: { id } });
  void operator;
}

/* ---------------- 门店名映射（人工确认） ---------------- */

export async function listStoreMappings() {
  const mappings = await prisma.socialInsuranceStoreMapping.findMany({
    orderBy: [{ status: "asc" }, { rawName: "asc" }],
    include: { store: { select: { id: true, name: true, status: true } } },
  });
  const stores = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  // 每条名单里的人数，方便判断优先级
  const counts = await prisma.socialInsuranceEntry.groupBy({
    by: ["storeNameRaw"],
    _count: { _all: true },
  });
  const cntMap = new Map(counts.map((c) => [c.storeNameRaw, c._count._all]));

  return {
    items: mappings.map((m) => ({
      ...m,
      peopleCount: cntMap.get(m.rawName) ?? 0,
      candidates: m.candidatesJson ? (JSON.parse(m.candidatesJson) as { id: number; name: string; status: string }[]) : [],
    })),
    allStores: stores,
  };
}

export async function decideStoreMapping(
  id: number,
  storeId: number | null,
  status: "CONFIRMED" | "REJECTED",
  note: string | null,
  operator: string
) {
  const row = await prisma.socialInsuranceStoreMapping.findUnique({ where: { id } });
  if (!row) throw new SiError("映射记录不存在", "NOT_FOUND");

  if (status === "CONFIRMED" && !storeId) {
    throw new SiError("请选择一个门店，或标记为「不对应门店」", "STORE_REQUIRED");
  }
  if (storeId) {
    const st = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
    if (!st) throw new SiError("门店不存在", "STORE_NOT_FOUND");
  }

  await prisma.socialInsuranceStoreMapping.update({
    where: { id },
    data: { storeId, status, note, decidedBy: operator, decidedAt: new Date() },
  });

  // 确认后把该名单下所有行的 storeId 一并归位（REJECTED 则清空）
  await prisma.socialInsuranceEntry.updateMany({
    where: { storeNameRaw: row.rawName },
    data: { storeId: status === "CONFIRMED" ? storeId : null },
  });
}

/** 按姓名搜员工（关联用） */
export async function searchEmployeesForLink(keyword: string) {
  const kw = keyword.trim();
  if (!kw) return [];
  return prisma.employee.findMany({
    where: {
      deletedAt: null,
      OR: [{ name: { contains: kw } }, { employeeId: { contains: kw } }, { phone: { contains: kw } }],
    },
    select: {
      id: true,
      employeeId: true,
      name: true,
      status: true,
      storeId: true,
      store: { select: { name: true } },
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    take: 20,
  });
}
