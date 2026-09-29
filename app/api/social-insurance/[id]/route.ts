import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";
import {
  decideStoreMapping,
  linkEmployee,
  linkStore,
  setInsured,
  SiError,
  updateInsuredDate,
} from "@/lib/social-insurance-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * /api/social-insurance/[id] —— 单条参保记录操作（Stage 9.37）
 *
 * PUT action=insured     停保 / 复保（**买保险最常用的操作**）
 * PUT action=link-employee 关联员工档案（处理「未关联」提醒）
 * PUT action=link-store  改门店关联
 * PUT action=date        改参保日期（支持只到月）
 */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id: idStr } = await ctx.params;
    const id = Number(idStr);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id 不合法" }, { status: 400 });

    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const operator = await operatorFromRequest(req);

    switch (action) {
      case "insured": {
        await setInsured(id, Boolean(body.insured), operator, body.note ? String(body.note) : null);
        return NextResponse.json({ ok: true });
      }
      case "link-employee": {
        await linkEmployee(id, body.employeeId ? Number(body.employeeId) : null, operator);
        return NextResponse.json({ ok: true });
      }
      case "link-store": {
        await linkStore(id, body.storeId ? Number(body.storeId) : null, operator);
        return NextResponse.json({ ok: true });
      }
      case "date": {
        await updateInsuredDate(
          id,
          String(body.date ?? ""),
          body.precision === "MONTH" ? "MONTH" : "DAY",
          operator
        );
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ ok: false, error: `未知操作：${action}` }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SiError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const msg = (e as Error).message;
    console.error("[PUT /api/social-insurance/:id]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
