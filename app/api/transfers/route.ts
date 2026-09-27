import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";
import { prisma } from "@/lib/prisma";
import {
  createTransferOrder,
  cancelTransferOrder,
  reverseTransferOrder,
  runDueTransfers,
  STATUS_LABEL,
  TransferError,
} from "@/lib/transfer-order-service";

/**
 * /api/transfers —— 调店单（Stage 9.28）
 *
 * GET    列表（可按状态过滤）
 * POST   登记调店单（不传 effectiveDate = 立即生效）
 * PUT    作废待生效单 / 撤销已生效单
 * POST ?action=run-due   手动触发「执行到期单据」（计划任务用同一个入口）
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;

  const orders = await prisma.transferOrder.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: "asc" }, { effectiveDate: "desc" }],
    include: {
      employee: {
        select: { id: true, name: true, employeeId: true, storeId: true, store: { select: { id: true, name: true } } },
      },
      fromStore: { select: { id: true, name: true } },
      toStore: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json({
    ok: true,
    data: orders.map((o) => ({
      id: o.id,
      status: o.status,
      statusLabel: STATUS_LABEL[o.status as keyof typeof STATUS_LABEL] ?? o.status,
      employee: { id: o.employee.id, name: o.employee.name, code: o.employee.employeeId },
      fromStore: o.fromStore,
      toStore: o.toStore,
      effectiveDate: o.effectiveDate.toISOString().slice(0, 10),
      reason: o.reason,
      voidReason: o.voidReason,
      createdBy: o.createdBy,
      voidedBy: o.voidedBy,
      reversedBy: o.reversedBy,
      currentStoreId: o.employee.storeId,
    })),
  });
}

export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  const operator = await operatorFromRequest(req);
  let body: {
    action?: string;
    employeeId?: number;
    toStoreId?: number;
    effectiveDate?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  // 手动触发到期生效（与 Windows 计划任务同一个入口）
  if (body.action === "run-due") {
    const r = await runDueTransfers(operator);
    return NextResponse.json({ ok: true, data: r });
  }

  if (body.action === "cancel" || body.action === "reverse") {
    return NextResponse.json({ ok: false, error: "请用 PUT 作废/撤销" }, { status: 400 });
  }

  const { employeeId, toStoreId, effectiveDate, reason } = body;
  if (!Number.isFinite(employeeId) || !Number.isFinite(toStoreId)) {
    return NextResponse.json({ ok: false, error: "缺少 employeeId 或 toStoreId" }, { status: 400 });
  }

  // 生效日期：空 = 立即生效；否则按 YYYY-MM-DD 解析成 UTC 零点
  let eff: Date | null = null;
  const raw = (effectiveDate ?? "").trim();
  if (raw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) {
      return NextResponse.json({ ok: false, error: "生效日期格式应为 YYYY-MM-DD" }, { status: 400 });
    }
    eff = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  try {
    const r = await createTransferOrder({
      employeeId: employeeId!,
      toStoreId: toStoreId!,
      effectiveDate: eff,
      reason: reason ?? null,
      operator,
    });
    return NextResponse.json({ ok: true, data: r });
  } catch (e) {
    if (e instanceof TransferError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
}

export async function PUT(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  const operator = await operatorFromRequest(req);
  let body: { action?: "cancel" | "reverse"; orderId?: number; voidReason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { action, orderId, voidReason } = body;
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ ok: false, error: "缺少 orderId" }, { status: 400 });
  }
  try {
    if (action === "cancel") {
      await cancelTransferOrder({ orderId: orderId!, voidReason: voidReason ?? "", operator });
    } else if (action === "reverse") {
      await reverseTransferOrder({ orderId: orderId!, voidReason: voidReason ?? "", operator });
    } else {
      return NextResponse.json({ ok: false, error: "action 必须是 cancel 或 reverse" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TransferError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
}
