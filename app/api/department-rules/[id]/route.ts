import { NextResponse } from "next/server";
import { deleteRule, updateRule } from "@/lib/department-rule-service";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/department-rules/:id —— 编辑规则 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的规则 ID" }, { status: 400 });
    }
    const body = (await req.json()) as Record<string, unknown>;
    const data = await updateRule(numId, {
      departmentId: body.departmentId === undefined ? undefined : Number(body.departmentId),
      storeId: body.storeId === undefined ? undefined : body.storeId ? Number(body.storeId) : null,
      positionId:
        body.positionId === undefined ? undefined : body.positionId ? Number(body.positionId) : null,
      employeeType: body.employeeType === undefined ? undefined : ((body.employeeType as string) || null),
      priority: body.priority === undefined ? undefined : Number(body.priority),
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      remark: body.remark === undefined ? undefined : ((body.remark as string) || null),
    });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/** DELETE /api/department-rules/:id —— 删除规则 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await requireApiUser(_req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的规则 ID" }, { status: 400 });
    }
    await deleteRule(numId);
    return NextResponse.json({ ok: true, data: { id: numId } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
