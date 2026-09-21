import { NextResponse } from "next/server";
import { batchUpdateEmployees } from "@/lib/employee-service";
import { DEFAULT_OPERATOR } from "@/lib/history-service";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface BatchBody {
  ids?: number[];
  filter?: Record<string, unknown>;
  storeId?: number | null;
  departmentId?: number | null;
  positionId?: number | null;
  operator?: string;
}

/**
 * POST /api/employees/batch —— 批量修改员工的归属字段
 *
 * 只接受 storeId / departmentId / positionId 三个字段（服务层还有白名单兜底）。
 * 每次修改都逐条写 EmployeeHistory，来源 BATCH_UPDATE，同一次共享 batchKey。
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as BatchBody;

    const patch: Record<string, number | null> = {};
    for (const k of ["storeId", "departmentId", "positionId"] as const) {
      if (k in body) patch[k] = body[k] ?? null;
    }
    if (!Object.keys(patch).length) {
      return NextResponse.json(
        { ok: false, error: "请至少选择一项要修改的内容（门店 / 部门 / 岗位）" },
        { status: 400 }
      );
    }
    if (!body.ids?.length && !body.filter) {
      return NextResponse.json(
        { ok: false, error: "请指定要修改的员工：勾选具体人员，或指定筛选条件" },
        { status: 400 }
      );
    }

    const result = await batchUpdateEmployees({
      ids: body.ids,
      filter: body.filter as never,
      patch: patch as never,
      operator: body.operator ?? DEFAULT_OPERATOR,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
