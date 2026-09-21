import { NextResponse } from "next/server";
import { setStoreStatus, updateStore } from "@/lib/settings-service";
import { formatZodError, storeSchema } from "@/lib/validation";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/stores/:id —— 编辑门店 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的门店 ID" }, { status: 400 });
    }
    const body = await req.json();
    // 允许部分更新
    const parsed = storeSchema.partial().safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const updated = await updateStore(numId, parsed.data as Record<string, unknown>, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}

/** PATCH /api/stores/:id —— 启用 / 停用门店 */
export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的门店 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { status?: string };
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return NextResponse.json({ ok: false, error: "status 只能是 ACTIVE 或 INACTIVE" }, { status: 400 });
    }
    const updated = await setStoreStatus(numId, body.status, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
