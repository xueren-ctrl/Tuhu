import { NextResponse } from "next/server";
import { listEmployeeHistory } from "@/lib/history-service";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/employees/:id/history —— 该员工的字段变更历史 */
export async function GET(_req: Request, ctx: Ctx) {
  const auth = await requireApiUser(_req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的员工 ID" }, { status: 400 });
    }
    const data = await listEmployeeHistory(numId);
    return NextResponse.json({ ok: true, total: data.length, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
