import { NextResponse } from "next/server";
import {
  VersionConflictError,
  commitPreview,
  discardPreview,
  getPreview,
} from "@/lib/import-preview-service";
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
 *
 * 查询参数 retry=1 表示「只重试上一次失败的项目」。
 *
 * 状态机：PENDING → COMMITTING → SUCCESS / PARTIAL / FAILED
 *  - 有失败时**绝不**返回成功：HTTP 207（多状态码语义）并附失败明细；
 *  - 预览后数据库被改动 → 409，要求重新生成预览。
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const retry = url.searchParams.get("retry") === "1";
    const data = await commitPreview({ id, operator: operatorFromRequest(req), retry });

    // 有失败项：用 207 明确告诉调用方「不是全部成功」，避免前端误判为成功
    if (data.failed > 0) {
      return NextResponse.json(
        { ok: false, error: `部分成功：成功 ${data.updated + data.created} 条，失败 ${data.failed} 条`, data },
        { status: 207 }
      );
    }
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return NextResponse.json({ ok: false, error: e.message, code: "VERSION_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
