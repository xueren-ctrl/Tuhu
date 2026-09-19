import { NextResponse } from "next/server";
import {
  getEmployeeById,
  restoreEmployee,
  softDeleteEmployee,
  updateEmployee,
} from "@/lib/employee-service";
import { employeeUpdateSchema, formatZodError } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/employees/:id —— 详情（完整字段） */
export async function GET(req: Request, ctx: Ctx) {
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

/** PUT /api/employees/:id —— 编辑（employee_id / 创建时间不可改） */
export async function PUT(req: Request, ctx: Ctx) {
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
    const updated = await updateEmployee(numId, parsed.data as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    console.error("[PUT /api/employees/:id]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "保存员工失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/employees/:id
 * 第一阶段统一为软删除 / 停用，不做物理删除；?restore=1 可恢复。
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的员工 ID" }, { status: 400 });
    }
    const url = new URL(req.url);
    if (url.searchParams.get("restore") === "1") {
      const r = await restoreEmployee(numId);
      return NextResponse.json({ ok: true, data: r, mode: "restore" });
    }
    const r = await softDeleteEmployee(numId);
    return NextResponse.json({ ok: true, data: r, mode: "soft-delete" });
  } catch (e) {
    console.error("[DELETE /api/employees/:id]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "停用员工失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
