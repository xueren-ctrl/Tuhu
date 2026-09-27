import { prisma } from "./prisma";
import { recordStoreChange } from "./store-period-service";
import { toDateOnly } from "./format";

/**
 * 调店单（Stage 9.28）
 *
 * 解决途虎门店调动「很反复」的问题：店长说某人要调去 B 店，几天后又说不去了。
 * 直接改员工档案门店会产生大量「A→B→A」往返噪音（实测 136 条里 99 组是往返），
 * 且**业务反复是事实、不能删**（曾打算调但没调，本身就该可追溯）。
 *
 * 参照 Oracle HCM / Sage People / 用友人力云 / Femas / Cloud5 的通行做法：
 * **绝不物理删除，用状态机表达撤销/作废**，并强制填写原因（审计要留 why）。
 *
 * 状态流转：
 *   PENDING   待生效 —— 店长改口就在这里作废，**不用改回门店**，间隔几天都没问题
 *   EFFECTED  已生效 —— 到期由计划任务自动执行，或登记时选「立即生效」
 *   CANCELLED 已作废 —— 店长撤回 / 误登记（未生效就没发生过，档案不动）
 *   REVERSED  已撤销 —— 生效后才发现不对，档案门店已自动回退
 */

export type TransferStatus = "PENDING" | "EFFECTED" | "CANCELLED" | "REVERSED";

export const STATUS_LABEL: Record<TransferStatus, string> = {
  PENDING: "待生效",
  EFFECTED: "已生效",
  CANCELLED: "已作废",
  REVERSED: "已撤销",
};

export class TransferError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "TransferError";
  }
}

/** 把 Date 规整成「纯日期」（UTC 零点），与项目内其他日期字段一致 */
function dayOnly(d: Date): Date {
  return toDateOnly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) ?? new Date();
}

/**
 * 登记一张调店单。
 * @param effectiveDate 生效日期；传 null 或不传 = 立即生效
 */
export async function createTransferOrder({
  employeeId,
  toStoreId,
  effectiveDate,
  reason,
  operator,
}: {
  employeeId: number;
  toStoreId: number;
  effectiveDate?: Date | null;
  reason?: string | null;
  operator: string;
}): Promise<{ orderId: number; status: TransferStatus }> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, name: true, storeId: true, deletedAt: true },
  });
  if (!emp) throw new TransferError("员工不存在", "EMP_NOT_FOUND");
  if (emp.deletedAt) throw new TransferError("该员工已删除，不能登记调店单", "EMP_DELETED");
  if (emp.storeId === null) {
    throw new TransferError("该员工当前未挂门店，请先在员工档案里指定门店", "NO_SOURCE_STORE");
  }
  if (emp.storeId === toStoreId) {
    throw new TransferError("目标门店与当前门店相同，无需调店", "SAME_STORE");
  }
  const target = await prisma.store.findUnique({ where: { id: toStoreId }, select: { id: true, name: true, status: true } });
  if (!target) throw new TransferError("目标门店不存在", "STORE_NOT_FOUND");
  if (target.status !== "ACTIVE") {
    throw new TransferError(`目标门店「${target.name}」已停用，不能调入`, "STORE_INACTIVE");
  }

  // 已有待生效的单子 → 拒绝（避免同一员工多张待生效单互相冲突）
  const pending = await prisma.transferOrder.findFirst({
    where: { employeeId, status: "PENDING" },
    orderBy: { id: "desc" },
    include: { toStore: { select: { name: true } } },
  });
  if (pending) {
    throw new TransferError(
      `该员工已有一张待生效的调店单（调往「${pending.toStore.name}」，${pending.effectiveDate
        .toISOString()
        .slice(0, 10)} 生效）。请先作废那张再登记新的。`,
      "PENDING_EXISTS"
    );
  }

  const immediate = !effectiveDate;
  const effDay = immediate ? dayOnly(new Date()) : dayOnly(effectiveDate!);

  // 立即生效 → 直接走「执行生效」逻辑，状态直接落到 EFFECTED
  if (immediate || effDay.getTime() <= dayOnly(new Date()).getTime()) {
    await applyTransfer({ employeeId, toStoreId, operator, orderRemark: reason ?? null });
    const order = await prisma.transferOrder.create({
      data: {
        employeeId,
        fromStoreId: emp.storeId,
        toStoreId,
        effectiveDate: effDay,
        status: "EFFECTED",
        reason: reason ?? null,
        createdBy: operator,
        effectedAt: new Date(),
      },
    });
    return { orderId: order.id, status: "EFFECTED" };
  }

  // 未来生效 → 挂 PENDING，等计划任务执行
  const order = await prisma.transferOrder.create({
    data: {
      employeeId,
      fromStoreId: emp.storeId,
      toStoreId,
      effectiveDate: effDay,
      status: "PENDING",
      reason: reason ?? null,
      createdBy: operator,
    },
  });
  return { orderId: order.id, status: "PENDING" };
}

/**
 * 执行生效：真正改员工门店 + 记任职历史。
 * 内部复用现有 `recordStoreChange`（Stage 9.19 起改门店自动记任职历史），
 * 保证「调店单生效」与「在员工页改门店」产生的历史完全一致。
 */
async function applyTransfer({
  employeeId,
  toStoreId,
  operator,
  orderRemark,
}: {
  employeeId: number;
  toStoreId: number;
  operator: string;
  orderRemark: string | null;
}) {
  await prisma.$transaction(async (t) => {
    const emp = await t.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, storeId: true },
    });
    if (!emp) throw new TransferError("员工不存在", "EMP_NOT_FOUND");
    if (emp.storeId === toStoreId) return; // 已经是目标店，幂等
    if (emp.storeId === null) throw new TransferError("该员工未挂门店，无法生效", "NO_SOURCE_STORE");

    // ① 任职历史（旧段关闭 + 新段开始）—— 与档案改动同事务
    await recordStoreChange(t as never, employeeId, toStoreId, emp.storeId, new Date());

    // ② 改档案门店
    await t.employee.update({ where: { id: employeeId }, data: { storeId: toStoreId } });

    // ③ 写通用变更历史（EmployeeHistory）—— 这样「调店记录」页也能看到这张单
    await t.employeeHistory.create({
      data: {
        employeeId,
        fieldName: "storeId",
        fieldLabel: "门店",
        oldValue: String(emp.storeId),
        newValue: String(toStoreId),
        source: "UPDATE",
        operator,
        note: orderRemark,
      },
    });

    // ④ 审计
    await t.auditLog.create({
      data: {
        actor: operator,
        action: "TRANSFER_EFFECT",
        entity: "TransferOrder",
        entityId: String(employeeId),
        summary: `调店生效：${emp.name} 门店改到 #${toStoreId}`,
        detail: JSON.stringify({ employeeId, from: emp.storeId, to: toStoreId, remark: orderRemark }),
      },
    });
  });
}

/** 作废待生效单据（店长撤回 / 误登记）。**档案不动**——因为还没生效过。 */
export async function cancelTransferOrder({
  orderId,
  voidReason,
  operator,
}: {
  orderId: number;
  voidReason: string;
  operator: string;
}): Promise<void> {
  const reason = String(voidReason ?? "").trim();
  if (!reason) throw new TransferError("必须填写作废原因（审计需要）", "REASON_REQUIRED");

  const order = await prisma.transferOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new TransferError("调店单不存在", "ORDER_NOT_FOUND");
  if (order.status !== "PENDING") {
    throw new TransferError(`该单据已是「${STATUS_LABEL[order.status as TransferStatus]}」，不能作废`, "NOT_PENDING");
  }
  await prisma.transferOrder.update({
    where: { id: orderId },
    data: { status: "CANCELLED", voidReason: reason, voidedBy: operator, voidedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      actor: operator,
      action: "TRANSFER_CANCEL",
      entity: "TransferOrder",
      entityId: String(orderId),
      summary: `作废调店单 #${orderId}（${order.fromStoreId} → ${order.toStoreId}）`,
      detail: JSON.stringify({ orderId, reason }),
    },
  });
}

/**
 * 撤销已生效的单据：**门店自动回退到原门店**。
 * 行业惯例（Oracle）：只允许撤销「生效后未被进一步改动」的，避免覆盖后续变更。
 */
export async function reverseTransferOrder({
  orderId,
  voidReason,
  operator,
}: {
  orderId: number;
  voidReason: string;
  operator: string;
}): Promise<void> {
  const reason = String(voidReason ?? "").trim();
  if (!reason) throw new TransferError("必须填写撤销原因（审计需要）", "REASON_REQUIRED");

  const order = await prisma.transferOrder.findUnique({
    where: { id: orderId },
    include: { employee: { select: { id: true, name: true, storeId: true } } },
  });
  if (!order) throw new TransferError("调店单不存在", "ORDER_NOT_FOUND");
  if (order.status !== "EFFECTED") {
    throw new TransferError(
      `只有「已生效」的单据才能撤销（当前：${STATUS_LABEL[order.status as TransferStatus]}）`,
      "NOT_EFFECTED"
    );
  }
  // 安全阀：生效后又被别人改过门店，就不要盲目回退
  if (order.employee.storeId !== order.toStoreId) {
    throw new TransferError(
      `该员工在生效后又被改过门店（现在在 #${order.employee.storeId}），` +
        `撤销会覆盖那次改动。请先确认，或改为直接在员工档案里调整。`,
      "STORE_MOVED_SINCE"
    );
  }

  await prisma.$transaction(async (t) => {
    // 回退门店 + 记任职历史 + 写变更历史（同事务）
    await recordStoreChange(t as never, order.employeeId, order.fromStoreId, order.toStoreId, new Date());
    await t.employee.update({
      where: { id: order.employeeId },
      data: { storeId: order.fromStoreId },
    });
    await t.employeeHistory.create({
      data: {
        employeeId: order.employeeId,
        fieldName: "storeId",
        fieldLabel: "门店",
        oldValue: String(order.toStoreId),
        newValue: String(order.fromStoreId),
        source: "UPDATE",
        operator,
        note: `撤销调店单 #${orderId}：${reason}`,
      },
    });
    await t.transferOrder.update({
      where: { id: orderId },
      data: { status: "REVERSED", voidReason: reason, reversedBy: operator, reversedAt: new Date() },
    });
    await t.auditLog.create({
      data: {
        actor: operator,
        action: "TRANSFER_REVERSE",
        entity: "TransferOrder",
        entityId: String(orderId),
        summary: `撤销调店单 #${orderId}：${order.employee.name} 门店回退到 #${order.fromStoreId}`,
        detail: JSON.stringify({ orderId, reason, backTo: order.fromStoreId }),
      },
    });
  });
}

/**
 * 执行所有到期的待生效单据（由 Windows 计划任务每天调）。
 * 单张失败不影响其他（返回失败明细，便于排查）。
 */
export async function runDueTransfers(
  operator = "system:auto-transfer"
): Promise<{ effected: number; failed: { orderId: number; error: string }[]; skipped: number }> {
  const today = dayOnly(new Date());
  const due = await prisma.transferOrder.findMany({
    where: { status: "PENDING", effectiveDate: { lte: today } },
    orderBy: { effectiveDate: "asc" },
  });
  let effected = 0;
  let skipped = 0;
  const failed: { orderId: number; error: string }[] = [];
  for (const o of due) {
    try {
      await applyTransfer({ employeeId: o.employeeId, toStoreId: o.toStoreId, operator, orderRemark: o.reason });
      await prisma.transferOrder.update({
        where: { id: o.id },
        data: { status: "EFFECTED", effectedAt: new Date() },
      });
      effected++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 「已经是目标店」= 幂等（可能已被手工改过），标记为已生效而不是反复失败
      if (msg.includes("员工未挂门店")) {
        skipped++;
        continue;
      }
      failed.push({ orderId: o.id, error: msg });
    }
  }
  return { effected, failed, skipped };
}
