import { NextResponse } from "next/server";
import { setDepartmentStatus, updateDepartment } from "@/lib/settings-service";
import { departmentSchema, formatZodError } from "@/lib/validation";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/departments/:id —— 编辑部门 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const guard = await requireApiUser(req);
    if (guard instanceof Response) return guard;

    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的部门 ID" }, { status: 400 });
    }
    const body = await req.json();
    const parsed = departmentSchema.partial().safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const updated = await updateDepartment(
      numId,
      parsed.data as Record<string, unknown>,
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/** PATCH /api/departments/:id —— 启用 / 停用部门 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const guard = await requireApiUser(req);
    if (guard instanceof Response) return guard;

    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的部门 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { status?: string };
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return NextResponse.json(
        { ok: false, error: "status 只能是 ACTIVE 或 INACTIVE" },
        { status: 400 }
      );
    }
    const updated = await setDepartmentStatus(
      numId,
      body.status,
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
