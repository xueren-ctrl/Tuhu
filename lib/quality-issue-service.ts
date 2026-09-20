/**
 * 数据质量问题工单服务（第四阶段）
 *
 * 把数据质量中心从「只展示问题」升级为「有处理流程」：
 * 每个问题可以有人认领、处理、关闭；关闭后统计口径立即变化。
 *
 * 口径：**待处理 = 检出总数 − (已关闭 + 已忽略)**
 *
 * 注意「关闭」的语义：它代表「人工确认这条不用管了 / 已处理完」，
 * 不等于数据被改好。因此必须填 result（处理结果说明），
 * 否则后人看到「已关闭」却不知道为什么关，等于把问题藏起来了。
 */
import { prisma } from "./prisma";

export type IssueStatus = "OPEN" | "CLOSED" | "IGNORED";

export const ISSUE_STATUS_LABEL: Record<string, string> = {
  OPEN: "待处理",
  CLOSED: "已关闭",
  IGNORED: "已忽略",
};

export interface QualityIssueRow {
  id: number;
  issueType: string;
  employeeId: number;
  employeeCode: string | null;
  employeeName: string | null;
  status: IssueStatus;
  handler: string | null;
  handledAt: string | null;
  result: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * 按类别统计「已处理（关闭 + 忽略）」的工单数
 */
export async function countHandledByType(): Promise<Record<string, number>> {
  const rows = await prisma.qualityIssue.groupBy({
    by: ["issueType", "status"],
    where: { status: { in: ["CLOSED", "IGNORED"] } },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.issueType] = (out[r.issueType] ?? 0) + r._count._all;
  }
  return out;
}

/** 某员工在某类问题上的工单状态（没有工单视为 OPEN） */
export async function getIssueStatus(issueType: string, employeeId: number): Promise<IssueStatus> {
  const r = await prisma.qualityIssue.findUnique({
    where: { issueType_employeeId: { issueType, employeeId } },
    select: { status: true },
  });
  return ((r?.status as IssueStatus) ?? "OPEN") as IssueStatus;
}

/** 批量取某类问题的已处理员工 id 集合 */
export async function listHandledEmployeeIds(
  issueType: string
): Promise<{ closed: Set<number>; ignored: Set<number> }> {
  const rows = await prisma.qualityIssue.findMany({
    where: { issueType, status: { in: ["CLOSED", "IGNORED"] } },
    select: { employeeId: true, status: true },
  });
  const closed = new Set<number>();
  const ignored = new Set<number>();
  for (const r of rows) {
    if (r.status === "CLOSED") closed.add(r.employeeId);
    else ignored.add(r.employeeId);
  }
  return { closed, ignored };
}

/**
 * 设置工单状态（幂等 upsert：同一员工同一类问题只会有一张工单）
 */
export async function setIssueStatus(opts: {
  issueType: string;
  employeeId: number;
  status: IssueStatus;
  handler?: string | null;
  result?: string | null;
  note?: string | null;
}): Promise<QualityIssueRow> {
  const { issueType, employeeId, status } = opts;
  if (status !== "OPEN" && !opts.result?.trim()) {
    throw new Error("关闭 / 忽略工单时必须填写处理结果说明");
  }

  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { employeeId: true, name: true },
  });

  const data = {
    issueType,
    employeeId,
    employeeCode: emp?.employeeId ?? null,
    status,
    handler: opts.handler ?? null,
    handledAt: status === "OPEN" ? null : new Date(),
    result: status === "OPEN" ? null : (opts.result?.trim() ?? null),
    note: opts.note?.trim() || null,
  };

  const row = await prisma.qualityIssue.upsert({
    where: { issueType_employeeId: { issueType, employeeId } },
    create: data,
    update: data,
  });

  return {
    id: row.id,
    issueType: row.issueType,
    employeeId: row.employeeId,
    employeeCode: row.employeeCode,
    employeeName: emp?.name ?? null,
    status: row.status as IssueStatus,
    handler: row.handler,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    result: row.result,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 批量关闭（用于「本类全部关闭」这类操作，逐条 upsert，幂等） */
export async function closeMany(opts: {
  issueType: string;
  employeeIds: number[];
  status?: Extract<IssueStatus, "CLOSED" | "IGNORED">;
  handler?: string | null;
  result?: string | null;
}): Promise<{ handled: number }> {
  const status = opts.status ?? "CLOSED";
  const result = opts.result?.trim() || (status === "CLOSED" ? "批量关闭" : "批量忽略");
  let handled = 0;
  for (const id of opts.employeeIds) {
    await setIssueStatus({
      issueType: opts.issueType,
      employeeId: id,
      status,
      handler: opts.handler ?? null,
      result,
    });
    handled++;
  }
  return { handled };
}

/** 列出某类问题的工单（含员工信息，便于回溯） */
export async function listIssues(opts: {
  issueType?: string;
  status?: IssueStatus | "ALL";
  take?: number;
} = {}): Promise<QualityIssueRow[]> {
  const take = opts.take ?? 100;
  const rows = await prisma.qualityIssue.findMany({
    where: {
      ...(opts.issueType ? { issueType: opts.issueType } : {}),
      ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    },
    orderBy: [{ handledAt: "desc" }, { id: "desc" }],
    take,
  });
  const empIds = rows.map((r) => r.employeeId);
  const emps = await prisma.employee.findMany({
    where: { id: { in: empIds } },
    select: { id: true, name: true, employeeId: true },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return rows.map((r) => ({
    id: r.id,
    issueType: r.issueType,
    employeeId: r.employeeId,
    employeeCode: r.employeeCode ?? byId.get(r.employeeId)?.employeeId ?? null,
    employeeName: byId.get(r.employeeId)?.name ?? null,
    status: r.status as IssueStatus,
    handler: r.handler,
    handledAt: r.handledAt ? r.handledAt.toISOString() : null,
    result: r.result,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}
