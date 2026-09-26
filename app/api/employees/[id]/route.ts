import { NextResponse } from "next/server";
import {
  getEmployeeById,
  restoreEmployee,
  softDeleteEmployee,
  updateEmployee,
} from "@/lib/employee-service";
import { employeeUpdateSchema, formatZodError } from "@/lib/validation";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/employees/:id —— 详情（完整字段） */
export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的员工 ID" }, { status: 400 });
    }
    const url = new URL(req.url);
    const mask = url.searchParams.get("mask") === "true";
    const data = await getEmployeeById(numId, { mask });
    if (!data) {
      return NextResponse.json({ ok: false, error: "员工不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    console.error("[GET /api/employees/:id]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "查询员工详情失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/**
 * 局部更新的公共实现（**不含鉴权** —— 鉴权由各 handler 自己显式调用 requireApiUser，
 * 这样 scripts/check-auth-coverage.mjs 的扫描才能确认每个方法都被守卫）。
 *
 * `employeeUpdateSchema` 本身就是「全部可选」的局部更新语义：传哪个字段就改哪个字段。
 * PUT 与 PATCH 共用它 —— 详情页表单用 PUT，表格的行内下拉（YesNoCell）用 PATCH。
 * ⚠️ 两个方法都必须存在：只留 PUT 会让行内下拉静默返回 405。
 */
async function doUpdate(req: Request, ctx: Ctx, method: "PUT" | "PATCH") {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的员工 ID" }, { status: 400 });
    }
    const body = await req.json();
    const parsed = employeeUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const updated = await updateEmployee(
      numId,
      parsed.data as Record<string, unknown>,
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    console.error("[" + method + " /api/employees/:id]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "保存员工失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/** PUT /api/employees/:id —— 编辑（employee_id / 创建时间不可改） */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  return doUpdate(req, ctx, "PUT");
}

/** PATCH /api/employees/:id —— 行内快速改单个字段（表格里的「是否」下拉走这里） */
export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  return doUpdate(req, ctx, "PATCH");
}

/**
 * DELETE /api/employees/:id
 * 第一阶段统一为软删除 / 停用，不做物理删除；?restore=1 可恢复。
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的员工 ID" }, { status: 400 });
    }
    const url = new URL(req.url);
    if (url.searchParams.get("restore") === "1") {
      const r = await restoreEmployee(numId, await operatorFromRequest(req));
      return NextResponse.json({ ok: true, data: r, mode: "restore" });
    }
    const r = await softDeleteEmployee(numId, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: r, mode: "soft-delete" });
  } catch (e) {
    console.error("[DELETE /api/employees/:id]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "停用员工失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
