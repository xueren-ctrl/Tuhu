import { NextResponse } from "next/server";
import { changeEmployeeStatus } from "@/lib/employee-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";
import { EMPLOYEE_STATUS_VALUES } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/employees/status
 * body: { ids: number[], status: string }
 *
 * 批量 / 单个更改员工状态。状态决定这个人出现在哪些表
 * （映射见 lib/sheet-fields.ts 的 STATUS_SHEETS）。
 *
 * - 逐人一个事务：员工档案 + 变更历史 + 审计同事务；
 * - 已成功的保持生效（批量操作可断点续做），失败项在 failed 里逐条返回；
 * - 只有 ADMIN / HR 可调用（requireApiUser 已做登录校验，此处不再细分角色）。
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;

  try {
    const body = (await req.json()) as { ids?: unknown; status?: unknown };
    const status = String(body.status ?? "").trim();
    if (!EMPLOYEE_STATUS_VALUES.includes(status)) {
      return NextResponse.json(
        { ok: false, error: "非法的员工状态：" + status },
        { status: 400 }
      );
    }
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = rawIds
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "请至少选择一名员工" }, { status: 400 });
    }
    if (ids.length > 2000) {
      return NextResponse.json({ ok: false, error: "一次最多处理 2000 人" }, { status: 400 });
    }

    const result = await changeEmployeeStatus(ids, status, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[POST /api/employees/status]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "更改状态失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
