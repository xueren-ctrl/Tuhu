import { NextResponse } from "next/server";
import { createRule, listRules } from "@/lib/department-rule-service";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

/** GET /api/department-rules —— 部门自动归属规则列表 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const data = await listRules();
    return NextResponse.json({ ok: true, total: data.length, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** POST /api/department-rules —— 新增规则（Stage 7.1.4：审计 actor = Session 操作人） */
export async function POST(req: Request) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const data = await createRule(
      {
        departmentId: Number(body.departmentId),
        storeId: body.storeId ? Number(body.storeId) : null,
        positionId: body.positionId ? Number(body.positionId) : null,
        employeeType: (body.employeeType as string) ?? null,
        priority: body.priority === undefined ? undefined : Number(body.priority),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
        remark: (body.remark as string) ?? null,
      },
      await operatorFromRequest(req) // 审计 actor 只来自 Session；body/operator 头一律不读
    );
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
