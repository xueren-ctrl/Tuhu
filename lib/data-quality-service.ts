/**
 * 数据质量中心服务（第三阶段新增）
 *
 * 五个问题类别，全部**实时从数据库算**（不落中间表），每类都能下钻到明细。
 *
 * 判定口径（写在代码里，也展示在页面上，避免"口径不明"）：
 *  1. 状态冲突 —— 数据源里同一人同时出现在「在职」名册且带有离职信号。
 *     这类冲突在导入时已逐条记录（ImportIssue.STATUS_CONFLICT），
 *     本模块按「来源行号 → 员工」的溯源映射把它关联到具体员工。
 *  2. 无部门   —— departmentId 为空。
 *  3. 无岗位   —— positionId 为空。
 *  4. 无门店   —— storeId 为空，**且** departmentId 也为空。
 *     （只挂部门的员工，如运营部，storeId 为空是正常的，不计为问题。）
 *  5. 真正重复记录 —— 姓名 + 身份证号 + 入职日期 三者完全相同。
 *  6. 无去重键    —— 身份证号 / 手机号 / 入职日期 全为空，无法判定是否同一人。
 *
 * ⚠️ 第五阶段拆分说明：原先这两档合并在「重复员工」里，HR 容易误解成
 *    「系统已判定这些人是重复员工」。实际上「无去重键」只是**高风险待补录**，
 *    系统根本没有判定他们是重复。因此拆成 exact-duplicate / no-identity-key 两类。
 *
 * ⚠️ 重要：「同一身份证号多条记录」**不是**重复员工 —— 那是合法的「重新入职」，
 *    由「身份证号 + 入职日期」区分保留。本模块单列说明，绝不当作重复处理。
 */
import { prisma } from "./prisma";
import { maskByField } from "./mask";
import { countHandledByType, listHandledEmployeeIds } from "./quality-issue-service";

export type DqCategoryKey =
  | "status-conflict"
  | "no-department"
  | "no-position"
  | "no-store"
  | "exact-duplicate"
  | "no-identity-key";

export interface DqCategoryMeta {
  key: DqCategoryKey;
  label: string;
  rule: string;
  /** 该问题可直接用什么手段修 */
  fix: string;
  /** 是否可在批量编辑工具里一键修 */
  batchFixable: boolean;
  severity: "high" | "medium" | "low";
}

export const DQ_CATEGORIES: DqCategoryMeta[] = [
  {
    key: "status-conflict",
    label: "状态冲突",
    rule: "同一人同时出现在「在职」名册且带有离职信号（如又出现在离职名册）。已在导入时逐条记录，此处关联到具体员工。",
    fix: "由 HR 逐人确认口径，确认后直接在该员工详情页修改状态。",
    batchFixable: false,
    severity: "high",
  },
  {
    key: "no-department",
    label: "无部门员工",
    rule: "departmentId 为空。Excel 只提供了「运营部」的部门归属，门店员工的部门信息源数据中不存在。",
    fix: "用「批量编辑」按门店批量指定部门。",
    batchFixable: true,
    severity: "medium",
  },
  {
    key: "no-position",
    label: "无岗位员工",
    rule: "positionId 为空（Excel「工种级别」列为空）。",
    fix: "用「批量编辑」批量指定岗位。",
    batchFixable: true,
    severity: "low",
  },
  {
    key: "no-store",
    label: "无门店员工",
    rule: "storeId 为空且 departmentId 也为空 —— 既不在任何门店，也不在任何部门。仅挂部门的员工不计入。",
    fix: "用「批量编辑」批量指定门店；若门店名称原文为空，需先补录来源。",
    batchFixable: true,
    severity: "high",
  },
  {
    key: "exact-duplicate",
    label: "真正重复记录",
    rule: "姓名 + 身份证号 + 入职日期 三者完全相同 —— 系统已判定为同一段任职被录入了多次。",
    fix: "核对后停用多余记录（软删除，可恢复）。**不要**直接物理删除，历史任职要保留。",
    batchFixable: false,
    severity: "high",
  },
  {
    key: "no-identity-key",
    label: "无去重键（高风险）",
    rule: "身份证号 / 手机号 / 入职日期 全为空，**系统无法判定**这些人是否与别人重复 —— 这只是「待补录」，不是「已判定重复」。",
    fix: "在员工详情页补录身份证号或手机号 + 入职日期，补录后系统即可自动去重。",
    batchFixable: false,
    severity: "high",
  },
];

export interface DqSummaryRow {
  key: DqCategoryKey;
  label: string;
  /** 检出的总数 */
  count: number;
  /** 已处理（关闭 + 忽略）的工单数 */
  handled: number;
  /** 待处理 = count − handled */
  pending: number;
  severity: "high" | "medium" | "low";
  batchFixable: boolean;
}

export interface DqSummary {
  totalEmployees: number;
  /** 五类问题的数量 */
  rows: DqSummaryRow[];
  /** 问题总数（各类相加，同一员工可能落在多类里） */
  totalIssues: number;
  /** 已处理工单总数 */
  handledTotal: number;
  /** 待处理问题总数 */
  pendingTotal: number;
  /** 至少还有一类「待处理」问题的员工数（去重，已关闭的不计） */
  affectedEmployees: number;
  /** 参考信息：不算问题的合法情况 */
  notes: {
    /** 同一身份证号多条记录 = 合法重新入职 */
    rehireGroups: number;
    /** storeId 为空但已归到部门（如运营部），属正常 */
    departmentOnly: number;
  };
  generatedAt: string;
}

/** 五类问题的数量汇总 */
export async function getDataQualitySummary(): Promise<DqSummary> {
  const whereAlive = { deletedAt: null } as const;

  const [
    totalEmployees,
    conflictCount,
    noDepartment,
    noPosition,
    noStore,
    deptOnly,
    exactDupGroups,
    noKeyCount,
  ] = await Promise.all([
    prisma.employee.count({ where: whereAlive }),
    countStatusConflicts(),
    prisma.employee.count({ where: { ...whereAlive, departmentId: null } }),
    prisma.employee.count({ where: { ...whereAlive, positionId: null } }),
    prisma.employee.count({ where: { ...whereAlive, storeId: null, departmentId: null } }),
    prisma.employee.count({ where: { ...whereAlive, storeId: null, departmentId: { not: null } } }),
    countExactDuplicates(),
    prisma.employee.count({
      where: { ...whereAlive, idCardNo: null, phone: null, hireDate: null },
    }),
  ]);

  // 合法重新入职组数：同一身份证号（不含空）对应多条记录
  const byIdCard = await prisma.employee.groupBy({
    by: ["idCardNo"],
    where: { ...whereAlive, idCardNo: { not: null } },
    _count: { _all: true },
  });
  const rehireGroups = byIdCard.filter((g) => g._count._all > 1).length;

  const counts: Record<DqCategoryKey, number> = {
    "status-conflict": conflictCount,
    "no-department": noDepartment,
    "no-position": noPosition,
    "no-store": noStore,
    "exact-duplicate": exactDupGroups,
    "no-identity-key": noKeyCount,
  };

  // 工单进度：已处理（关闭 + 忽略）的数量，按类别统计
  const handled = await countHandledByType();

  const rows = DQ_CATEGORIES.map<DqSummaryRow>((c) => {
    const h = handled[c.key] ?? 0;
    return {
      key: c.key,
      label: c.label,
      count: counts[c.key],
      handled: h,
      pending: Math.max(0, counts[c.key] - h),
      severity: c.severity,
      batchFixable: c.batchFixable,
    };
  });

  return {
    totalEmployees,
    rows,
    totalIssues: rows.reduce((s, r) => s + r.count, 0),
    handledTotal: rows.reduce((s, r) => s + r.handled, 0),
    pendingTotal: rows.reduce((s, r) => s + r.pending, 0),
    affectedEmployees: await countAffectedEmployees(),
    notes: { rehireGroups, departmentOnly: deptOnly },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 至少还有一类「待处理」问题的员工数。
 * 注意：某类问题若已被关闭/忽略，该员工在此类上不计入受影响。
 */
async function countAffectedEmployees(): Promise<number> {
  const whereAlive = { deletedAt: null } as const;
  const [dept, pos, store, nokey, exactDup] = await Promise.all([
    prisma.employee.findMany({ where: { ...whereAlive, departmentId: null }, select: { id: true } }),
    prisma.employee.findMany({ where: { ...whereAlive, positionId: null }, select: { id: true } }),
    prisma.employee.findMany({
      where: { ...whereAlive, storeId: null, departmentId: null },
      select: { id: true },
    }),
    prisma.employee.findMany({
      where: { ...whereAlive, idCardNo: null, phone: null, hireDate: null },
      select: { id: true },
    }),
    listExactDuplicateIds(),
  ]);
  const set = new Set<number>();
  // 已关闭 / 已忽略的工单需要从「受影响」里剔除
  const pairs: [string, { id: number }[]][] = [
    ["no-department", dept],
    ["no-position", pos],
    ["no-store", store],
    ["exact-duplicate", exactDup],
    ["no-identity-key", nokey],
  ];
  for (const [type, list] of pairs) {
    const handledIds = await listHandledEmployeeIds(type);
    const done = new Set([...handledIds.closed, ...handledIds.ignored]);
    for (const r of list) if (!done.has(r.id)) set.add(r.id);
  }

  const conflicts = await getStatusConflictEmployeeIds();
  const conflictHandled = await listHandledEmployeeIds("status-conflict");
  const conflictDone = new Set([...conflictHandled.closed, ...conflictHandled.ignored]);
  for (const id of conflicts) if (!conflictDone.has(id)) set.add(id);
  return set.size;
}

/**
 * 真正重复记录（姓名 + 身份证号 + 入职日期 全同）的员工 id 列表。
 * 与「无去重键」严格分开 —— 后者系统并未判定重复。
 */
export async function listExactDuplicateIds(): Promise<{ id: number }[]> {
  const rows = await prisma.employee.findMany({
    where: { deletedAt: null, idCardNo: { not: null }, hireDate: { not: null } },
    select: { id: true, name: true, idCardNo: true, hireDate: true },
  });
  const seen = new Map<string, number>();
  for (const e of rows) {
    const k = `${e.name}|${e.idCardNo}|${e.hireDate?.toISOString()}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return rows
    .filter((e) => (seen.get(`${e.name}|${e.idCardNo}|${e.hireDate?.toISOString()}`) ?? 0) > 1)
    .map((e) => ({ id: e.id }));
}

/** 最新导入批次 */
async function latestBatchId(): Promise<string | null> {
  const b = await prisma.importBatch.findFirst({ orderBy: { startedAt: "desc" }, select: { id: true } });
  return b?.id ?? null;
}

/**
 * 状态冲突：取最新批次的 STATUS_CONFLICT 记录，
 * 用「来源行号 → EmployeeSourceRow → 员工」精确关联。
 */
async function loadStatusConflicts() {
  const batchId = await latestBatchId();
  if (!batchId) return [];
  const issues = await prisma.importIssue.findMany({
    where: { batchId, issueType: "STATUS_CONFLICT" },
    orderBy: { sourceRowNo: "asc" },
  });
  if (!issues.length) return [];

  const rowNos = issues.map((i) => i.sourceRowNo).filter((n): n is number => n !== null);
  const maps = await prisma.employeeSourceRow.findMany({
    where: { sheet: "数据库", rowNo: { in: rowNos } },
    select: { rowNo: true, employeeId: true },
  });
  const rowToEmp = new Map(maps.map((m) => [m.rowNo, m.employeeId]));

  return issues.map((i) => ({
    issueId: i.id,
    sourceRowNo: i.sourceRowNo,
    employeePk: i.sourceRowNo !== null ? rowToEmp.get(i.sourceRowNo) ?? null : null,
    name: i.employeeName,
    message: i.message,
    rawValue: i.rawValue,
  }));
}

async function countStatusConflicts(): Promise<number> {
  const batchId = await latestBatchId();
  if (!batchId) return 0;
  return prisma.importIssue.count({ where: { batchId, issueType: "STATUS_CONFLICT" } });
}

async function getStatusConflictEmployeeIds(): Promise<number[]> {
  const rows = await loadStatusConflicts();
  return rows.map((r) => r.employeePk).filter((x): x is number => x !== null);
}

/** 真正重复的组数：姓名 + 身份证号 + 入职日期 三者都相同 */
async function countExactDuplicates(): Promise<number> {
  const rows = await prisma.employee.groupBy({
    by: ["name", "idCardNo", "hireDate"],
    where: { deletedAt: null, idCardNo: { not: null }, hireDate: { not: null } },
    _count: { _all: true },
    having: { hireDate: { _count: { gt: 1 } } },
  });
  // groupBy 的 having 在 SQLite 上对多字段的支持有限，这里再过滤一次保证正确
  return rows.filter((r) => r._count._all > 1).length;
}

export interface DqDetailRow {
  id: number;
  employeeId: string;
  name: string;
  status: string;
  storeName: string | null;
  departmentName: string | null;
  positionName: string | null;
  hireDate: string | null;
  phone: string | null;
  idCardNo: string | null;
  reason: string;
  /** 溯源行号（状态冲突类才有） */
  sourceRowNo: number | null;
  /** 工单状态：OPEN 待处理 / CLOSED 已关闭 / IGNORED 已忽略 */
  issueStatus: string;
  handler: string | null;
  handledAt: string | null;
  result: string | null;
}

interface DetailOptions {
  page?: number;
  pageSize?: number;
}

const detailSelect = {
  id: true,
  employeeId: true,
  name: true,
  status: true,
  hireDate: true,
  phone: true,
  idCardNo: true,
  storeNameRaw: true,
  jobGradeRaw: true,
  departmentNameRaw: true,
  store: { select: { name: true } },
  department: { select: { name: true } },
  position: { select: { name: true } },
} as const;

type DetailRaw = {
  id: number;
  employeeId: string;
  name: string;
  status: string;
  hireDate: Date | null;
  phone: string | null;
  idCardNo: string | null;
  storeNameRaw: string | null;
  jobGradeRaw: string | null;
  departmentNameRaw: string | null;
  store: { name: string } | null;
  department: { name: string } | null;
  position: { name: string } | null;
};

function shape(r: DetailRaw, reason: string, sourceRowNo: number | null = null): DqDetailRow {
  return {
    issueStatus: "OPEN",
    handler: null,
    handledAt: null,
    result: null,
    id: r.id,
    employeeId: r.employeeId,
    name: r.name,
    status: r.status,
    storeName: r.store?.name ?? r.storeNameRaw ?? null,
    departmentName: r.department?.name ?? r.departmentNameRaw ?? null,
    positionName: r.position?.name ?? r.jobGradeRaw ?? null,
    hireDate: r.hireDate ? r.hireDate.toISOString().slice(0, 10) : null,
    // 明细列表与列表接口保持同一脱敏口径
    phone: (maskByField("phone", r.phone) as string | null) ?? null,
    idCardNo: (maskByField("idCardNo", r.idCardNo) as string | null) ?? null,
    reason,
    sourceRowNo,
  };
}

/** 某类问题的明细（分页） */
export async function getDataQualityDetail(
  key: DqCategoryKey,
  opts: DetailOptions = {}
): Promise<{ total: number; data: DqDetailRow[]; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(5, opts.pageSize ?? 20));
  const skip = (page - 1) * pageSize;
  const whereAlive = { deletedAt: null } as const;

  const withStatus = async (rows: DqDetailRow[]): Promise<DqDetailRow[]> => {
    if (!rows.length) return rows;
    const issues = await prisma.qualityIssue.findMany({
      where: { issueType: key, employeeId: { in: rows.map((r) => r.id) } },
      select: { employeeId: true, status: true, handler: true, handledAt: true, result: true },
    });
    const byId = new Map(issues.map((i) => [i.employeeId, i]));
    return rows.map((r) => {
      const i = byId.get(r.id);
      return i
        ? {
            ...r,
            issueStatus: i.status,
            handler: i.handler,
            handledAt: i.handledAt ? i.handledAt.toISOString() : null,
            result: i.result,
          }
        : r;
    });
  };


  if (key === "status-conflict") {
    const all = await loadStatusConflicts();
    const pks = all.map((r) => r.employeePk).filter((x): x is number => x !== null);
    const emps = await prisma.employee.findMany({
      where: { id: { in: pks } },
      select: detailSelect,
    });
    const byPk = new Map(emps.map((e) => [e.id, e as unknown as DetailRaw]));
    const rows = all
      .map((c) => {
        const e = c.employeePk !== null ? byPk.get(c.employeePk) : undefined;
        if (!e) return null;
        return shape(e, `同时出现在在职名册且带有离职信号（${c.rawValue ?? "离职名册"}）`, c.sourceRowNo);
      })
      .filter((x): x is DqDetailRow => x !== null);
    const rows2 = await withStatus(rows);
    return { total: rows2.length, data: rows2.slice(skip, skip + pageSize), page, pageSize };
  }

  if (key === "exact-duplicate") {
    const ids = (await listExactDuplicateIds()).map((x) => x.id);
    const exact = await prisma.employee.findMany({
      where: { id: { in: ids } },
      orderBy: [{ name: "asc" }, { hireDate: "asc" }],
      select: detailSelect,
    });
    const rows = await withStatus(
      exact.map((e) =>
        shape(e as unknown as DetailRaw, "姓名 + 身份证号 + 入职日期 与另一条记录完全相同")
      )
    );
    return { total: rows.length, data: rows.slice(skip, skip + pageSize), page, pageSize };
  }

  if (key === "no-identity-key") {
    const noKey = await prisma.employee.findMany({
      where: { ...whereAlive, idCardNo: null, phone: null, hireDate: null },
      orderBy: { id: "asc" },
      select: detailSelect,
    });
    const rows = await withStatus(
      noKey.map((e) =>
        shape(
          e as unknown as DetailRaw,
          "身份证号 / 手机号 / 入职日期 全为空 —— 系统无法判定是否与他人重复（待补录，不是已判定重复）"
        )
      )
    );
    return { total: rows.length, data: rows.slice(skip, skip + pageSize), page, pageSize };
  }

  const whereMap = {
    "no-department": { departmentId: null },
    "no-position": { positionId: null },
    "no-store": { storeId: null, departmentId: null },
  } as const;
  const reasonMap = {
    "no-department": "未指定部门（Excel 源数据只有「运营部」有部门信息）",
    "no-position": "未指定岗位（Excel「工种级别」为空）",
    "no-store": "既无门店也无部门（Excel「门店名称」为空）",
  } as const;

  const where = { ...whereAlive, ...whereMap[key] };
  const [total, rows] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy: [{ status: "asc" }, { name: "asc" }],
      skip,
      take: pageSize,
      select: detailSelect,
    }),
  ]);

  const data = await withStatus(
    rows.map((r) => shape(r as unknown as DetailRaw, reasonMap[key]))
  );
  return { total, data, page, pageSize };
}

/** 合法重新入职参考列表（不算问题，供 HR 对照） */
export async function listRehireGroups(limit = 50) {
  const groups = await prisma.employee.groupBy({
    by: ["idCardNo"],
    where: { deletedAt: null, idCardNo: { not: null } },
    _count: { _all: true },
  });
  const dupIds = groups.filter((g) => g._count._all > 1).map((g) => g.idCardNo as string);
  if (!dupIds.length) return [];

  const emps = await prisma.employee.findMany({
    where: { deletedAt: null, idCardNo: { in: dupIds } },
    orderBy: [{ idCardNo: "asc" }, { hireDate: "asc" }],
    select: {
      id: true,
      employeeId: true,
      name: true,
      status: true,
      hireDate: true,
      resignDate: true,
      idCardNo: true,
      store: { select: { name: true } },
      storeNameRaw: true,
    },
  });

  const byCard = new Map<string, typeof emps>();
  for (const e of emps) {
    const k = e.idCardNo as string;
    if (!byCard.has(k)) byCard.set(k, []);
    byCard.get(k)!.push(e);
  }
  return Array.from(byCard.entries())
    .slice(0, limit)
    .map(([card, list]) => ({
      idCardMasked: maskByField("idCardNo", card) as string,
      name: list[0].name,
      count: list.length,
      records: list.map((e) => ({
        id: e.id,
        employeeId: e.employeeId,
        name: e.name,
        status: e.status,
        hireDate: e.hireDate ? e.hireDate.toISOString().slice(0, 10) : null,
        resignDate: e.resignDate ? e.resignDate.toISOString().slice(0, 10) : null,
        storeName: e.store?.name ?? e.storeNameRaw ?? null,
      })),
    }));
}
