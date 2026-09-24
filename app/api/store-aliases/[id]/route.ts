import { NextResponse } from "next/server";
import {
  removeStoreAlias,
  StoreAliasDeleteAbortedError,
} from "@/lib/store-service";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/store-aliases/:id —— 删除别名
 *
 * 注意：删除别名**不会**把已统一归属的员工退回去（只改外键、不回滚），
 * 否则会出现「删个别名导致几十人归属被清空」的危险副作用。
 *
 * Stage 7.1.4（P0）：删除 + 审计 同一事务（actor = Session 操作人）；
 * 事务整体回滚时返回 409 ALIAS_DELETE_ABORTED（别名未删、审计未落，零残留）。
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的别名 ID" }, { status: 400 });
    }
    const removed = await removeStoreAlias(numId, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: removed });
  } catch (e) {
    if (e instanceof StoreAliasDeleteAbortedError) {
      return NextResponse.json(
        { ok: false, code: "ALIAS_DELETE_ABORTED", error: e.message },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
