import { NextResponse } from "next/server";
import { commitPreview, discardPreview, getPreview } from "@/lib/import-preview-service";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/import/preview/:id —— 查看预览明细（含完整 Diff） */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const data = await getPreview(id);
    if (!data) return NextResponse.json({ ok: false, error: "预览批次不存在" }, { status: 404 });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** DELETE /api/import/preview/:id —— 丢弃（不写入任何数据） */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const data = await discardPreview(id);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/**
 * POST /api/import/preview/:id —— 确认写入
 * 只有 PENDING 批次能提交，且只能提交一次。
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const data = await commitPreview({ id, operator: operatorFromRequest(req) });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
