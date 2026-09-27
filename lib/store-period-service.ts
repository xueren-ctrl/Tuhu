import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * 任职门店历史（Stage 9.19）
 *
 * 途虎门店之间人员调动频繁：去别的店帮忙、待一阵调回、或调走不回来。
 * Employee 只有**当前** storeId，光靠它算「月初人数」必然不准 ——
 * 1 号那天他到底在哪个店？调走后原店还挂着不挂着？
 *
 * 本模块维护 `EmployeeStorePeriod`（一段任职一行），并在改门店时自动记账。
 *
 * 口径（用户确认）：
 *   **按当前门店计** —— 员工只在当前所属门店算人数，
 *   调走就从原店减掉、调入就���新店加上。绝不「两边都算」（会重复计数、总数虚高）。
 *
 * 兜底策略：历史数据（建表之前）没有任职记录，
 * 统计时**回退到 Employee 当前的 storeId**，并把该员工视为
 * 「从入职起一直在现在这家店」—— 对当前口径而言这是最贴近的近似。
 */

const DAY = 86_400_000;
const toUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * 记录一次门店变更（结束旧段 + 开新段）。
 *
 * @param oldStoreId 变更**前**的门店（Employee 档案此时可能已改成新店，
 *                    所以必须由调用方把旧值传进来，不能只靠库里的当前值）。
 * @param newStoreId 变更后的门店
 * @param onDate     生效日期（默认今天，UTC 零点）
 *
 * @param tx Prisma 客户端或事务客户端
 */
export async function recordStoreChange(
  tx: Prisma.TransactionClient,
  employeeId: number,
  newStoreId: number,
  oldStoreId: number | null,
  onDate: Date = new Date()
): Promise<void> {
  const day = toUtc(onDate);
  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, hireDate: true },
  });
  if (!emp) return;
  // 没换门店 → 无事可记（也避免重复记同一段）
  if (oldStoreId === newStoreId) return;

  // ① 结束旧段：把该员工在旧门店下「无结束日期」的段，toDate 设为生效日
  if (oldStoreId !== null) {
    await tx.employeeStorePeriod.updateMany({
      where: { employeeId, storeId: oldStoreId, toDate: null },
      data: { toDate: day, source: "AUTO" },
    });
  }

  // ② 开新段：起始 = 生效日；若入职日更晚则用入职日（不能早于入职）
  const from = emp.hireDate && emp.hireDate.getTime() > day.getTime() ? toUtc(emp.hireDate) : day;
  await tx.employeeStorePeriod.create({
    data: { employeeId, storeId: newStoreId, fromDate: from, toDate: null, source: "AUTO" },
  });
}

/**
 * 取「某员工在指定日期属于哪家门店」。
 * 优先查任职历史；查不到则回退到 Employee 当前门店（视为长期在此店）。
 *
 * @returns 门店 id；无法确定时返回 null
 */
export async function storeOfAt(
  employeeId: number,
  at: Date,
  currentStoreId: number | null
): Promise<number | null> {
  const day = toUtc(at);
  const hit = await prisma.employeeStorePeriod.findFirst({
    where: {
      employeeId,
      AND: [
        { OR: [{ fromDate: null }, { fromDate: { lte: day } }] },
        { OR: [{ toDate: null }, { toDate: { gt: day } }] },
      ],
    },
    orderBy: { fromDate: "desc" },
    select: { storeId: true },
  });
  return hit?.storeId ?? currentStoreId;
}

/**
 * 批量版：为一批员工取「某日期各自的门店」。
 * 返回 Map<employeeId, storeId>，用于统计时把员工归到正确的店。
 */
export async function storesOfManyAt(
  employeeIds: number[],
  at: Date,
  fallback: Map<number, number | null>
): Promise<Map<number, number | null>> {
  const day = toUtc(at);
  const out = new Map<number, number | null>(fallback);
  if (employeeIds.length === 0) return out;
  const periods = await prisma.employeeStorePeriod.findMany({
    where: {
      employeeId: { in: employeeIds },
      AND: [
        { OR: [{ fromDate: null }, { fromDate: { lte: day } }] },
        { OR: [{ toDate: null }, { toDate: { gt: day } }] },
      ],
    },
    select: { employeeId: true, storeId: true, fromDate: true },
    orderBy: { fromDate: "desc" },
  });
  // 同一员工可能命中多段（数据重叠）→ 取 fromDate 最大的那段
  const seen = new Set<number>();
  for (const p of periods) {
    if (p.employeeId === null) continue;
    if (seen.has(p.employeeId)) continue;
    seen.add(p.employeeId);
    out.set(p.employeeId, p.storeId);
  }
  return out;
}

/**
 * 数据体检：找出「任职时间段重叠」的员工（同一人在两个门店同期任职）。
 * 这种数据会让统计失真，单独列出来供人工处理，**不自动修改**。
 */
export async function findOverlappingPeriods(): Promise<
  { employeeId: number; employeeName: string; segments: { store: string; from: string; to: string }[] }[]
> {
  const periods = await prisma.employeeStorePeriod.findMany({
    where: { employeeId: { not: null } },
    select: {
      employeeId: true,
      fromDate: true,
      toDate: true,
      store: { select: { name: true } },
      employee: { select: { name: true } },
    },
    orderBy: [{ employeeId: "asc" }, { fromDate: "asc" }],
  });
  const byEmp = new Map<number, typeof periods>();
  for (const p of periods) {
    if (p.employeeId === null) continue;
    if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []);
    byEmp.get(p.employeeId)!.push(p);
  }
  const bad: { employeeId: number; employeeName: string; segments: { store: string; from: string; to: string }[] }[] = [];
  for (const [empId, list] of byEmp) {
    if (list.length < 2) continue;
    let overlap = false;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      const aTo = a.toDate ? a.toDate.getTime() : Infinity;
      const bFrom = b.fromDate ? b.fromDate.getTime() : -Infinity;
      if (aTo > bFrom) { overlap = true; break; }
    }
    if (overlap) {
      bad.push({
        employeeId: empId,
        employeeName: list[0].employee?.name ?? `#${empId}`,
        segments: list.map((s) => ({
          store: s.store.name,
          from: s.fromDate ? s.fromDate.toISOString().slice(0, 10) : "未知",
          to: s.toDate ? s.toDate.toISOString().slice(0, 10) : "至今",
        })),
      });
    }
  }
  return bad;
}

/** 供测试用：某员工在指定日期的门店（同步包装） */
export async function storeOfAtSync(employeeId: number, at: Date, currentStoreId: number | null) {
  return storeOfAt(employeeId, at, currentStoreId);
}
export { DAY };
