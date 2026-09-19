import { NextResponse } from "next/server";
import { setPositionStatus, updatePosition } from "@/lib/settings-service";
import { formatZodError, positionSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/positions/:id —— 编辑职位 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的职位 ID" }, { status: 400 });
    }
    const body = await req.json();
    const parsed = positionSchema.partial().safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const updated = await updatePosition(numId, parsed.data as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}

/** PATCH /api/positions/:id —— 启用 / 停用职位 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的职位 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { status?: string };
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return NextResponse.json({ ok: false, error: "status 只能是 ACTIVE 或 INACTIVE" }, { status: 400 });
    }
    const updated = await setPositionStatus(numId, body.status);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
