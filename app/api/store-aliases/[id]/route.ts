import { NextResponse } from "next/server";
import { removeStoreAlias } from "@/lib/store-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/store-aliases/:id —— 删除别名
 *
 * 注意：删除别名**不会**把已统一归属的员工退回去（只改外键、不回滚），
 * 否则会出现「删个别名导致几十人归属被清空」的危险副作用。
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的别名 ID" }, { status: 400 });
    }
    const removed = await removeStoreAlias(numId);
    return NextResponse.json({ ok: true, data: removed });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
