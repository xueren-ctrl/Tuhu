import { NextResponse } from "next/server";
import { batchUpdateEmployees } from "@/lib/employee-service";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

interface BatchBody {
  ids?: number[];
  filter?: Record<string, unknown>;
  storeId?: number | null;
  departmentId?: number | null;
  positionId?: number | null;
}

/**
 * POST /api/employees/batch —— 批量修改员工的归属字段
 *
 * 只接受 storeId / departmentId / positionId 三个字段（服务层还有白名单兜底）。
 * 每次修改都逐条写 EmployeeHistory，来源 BATCH_UPDATE，同一次共享 batchKey。
 *
 * Stage 6.1：操作人一律取自当前 Session（operatorFromRequest），
 * 客户端 body 里即使带 operator 字段也会被完全忽略。
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
      operator: await operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
