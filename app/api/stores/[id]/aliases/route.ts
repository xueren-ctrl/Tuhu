import { NextResponse } from "next/server";
import { addStoreAlias, listStoreAllNames, StoreAliasAbortedError } from "@/lib/store-service";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/stores/:id/aliases —— 该门店的标准名 + 全部别名 */
export async function GET(_req: Request, ctx: Ctx) {
  const auth = await requireApiUser(_req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的门店 ID" }, { status: 400 });
    }
    const names = await listStoreAllNames(numId);
    return NextResponse.json({ ok: true, data: names });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/**
 * POST /api/stores/:id/aliases —— 新增别名
 * body: { alias: string, note?: string }
 * 操作人只来自当前 Session（operatorFromRequest），客户端 operator 字段一律忽略。
 *
 * 副作用（按需求「查询时统一归属」）：把门店原文列写着该别名的员工
 * 重新挂到标准门店（只改 storeId 外键，原文列保留），并逐条写变更记录。
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的门店 ID" }, { status: 400 });
    }
    const body = (await req.json()) as { alias?: string; note?: string };
    if (!body.alias || !body.alias.trim()) {
      return NextResponse.json({ ok: false, error: "别名不能为空" }, { status: 400 });
    }
    const result = await addStoreAlias({
      storeId: numId,
      alias: body.alias,
      note: body.note ?? null,
      operator: await operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof StoreAliasAbortedError) {
      // Stage 7.1.3 全批事务：整笔已回滚（别名 / 员工 / 历史 / 审计 零残留）
      return NextResponse.json(
        { ok: false, code: "ALIAS_BATCH_ABORTED", error: e.message },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
