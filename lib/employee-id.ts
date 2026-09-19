import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * employee_id 生成器
 *
 * 格式：THHR + 年份(4位) + 6位流水号
 * 例：THHR2026000001
 *
 * 约束：
 *  - 永久唯一，创建后任何普通编辑都不得修改；
 *  - 使用 EmployeeIdCounter 表按年维护流水号，避免并发/重复执行时撞号；
 *  - 绝不使用 姓名 / 姓名+入职日期 / 身份证号 充当主键。
 */

export const EMPLOYEE_ID_PREFIX =
  process.env.EMPLOYEE_ID_PREFIX?.trim() || "THHR";

const SEQ_WIDTH = 6;

export function formatEmployeeId(year: number, seq: number): string {
  return `${EMPLOYEE_ID_PREFIX}${year}${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

export function parseEmployeeId(
  employeeId: string
): { prefix: string; year: number; seq: number } | null {
  const m = new RegExp(`^([A-Z]+)(\\d{4})(\\d{${SEQ_WIDTH}})$`).exec(
    employeeId.trim().toUpperCase()
  );
  if (!m) return null;
  return { prefix: m[1], year: Number(m[2]), seq: Number(m[3]) };
}

export function employeeIdYear(employeeId: string): number | null {
  const p = parseEmployeeId(employeeId);
  return p ? p.year : null;
}

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
> | Prisma.TransactionClient;

/**
 * 取下一个可用流水号并生成 employee_id（在事务内调用）。
 * year 缺省为当前年份。
 */
export async function nextEmployeeId(
  tx: TxClient,
  year: number = new Date().getFullYear()
): Promise<string> {
  const counter = await tx.employeeIdCounter.upsert({
    where: { year },
    create: { year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
    select: { lastValue: true },
  });

  // 双保险：若历史数据已存在更大的序号，则继续向后取，保证永不重复
  const candidate = formatEmployeeId(year, counter.lastValue);
  const exists = await tx.employee.findUnique({
    where: { employeeId: candidate },
    select: { id: true },
  });
  if (!exists) return candidate;

  const rows = await tx.employee.findMany({
    where: { employeeId: { startsWith: `${EMPLOYEE_ID_PREFIX}${year}` } },
    select: { employeeId: true },
  });
  let maxSeq = 0;
  for (const r of rows) {
    const p = parseEmployeeId(r.employeeId);
    if (p && p.seq > maxSeq) maxSeq = p.seq;
  }
  const nextSeq = Math.max(counter.lastValue, maxSeq + 1);
  await tx.employeeIdCounter.update({
    where: { year },
    data: { lastValue: nextSeq },
  });
  return formatEmployeeId(year, nextSeq);
}
