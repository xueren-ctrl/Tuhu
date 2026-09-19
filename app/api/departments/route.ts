import { NextResponse } from "next/server";
import { createDepartment, listDepartments } from "@/lib/settings-service";
import { departmentSchema, formatZodError } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** GET /api/departments —— 部门列表（支持搜索与停用筛选） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rows = await listDepartments({
      keyword: url.searchParams.get("keyword") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      includeInactive:
        url.searchParams.get("includeInactive") === "true" ||
        url.searchParams.get("includeInactive") === "1",
    });
    return NextResponse.json({ ok: true, data: rows, total: rows.length });
  } catch (e) {
    console.error("[GET /api/departments]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "查询部门失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/** POST /api/departments —— 新增部门 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = departmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const created = await createDepartment(parsed.data as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
