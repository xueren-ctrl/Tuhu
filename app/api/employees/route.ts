import { NextResponse } from "next/server";
import {
  createEmployee,
  listEmployees,
} from "@/lib/employee-service";
import { operatorFromRequest } from "@/lib/operator";
import {
  employeeCreateSchema,
  employeeQuerySchema,
  formatZodError,
} from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * GET /api/employees
 * 员工列表：搜索 / 筛选 / 分页 / 排序 全部由数据库实时查询完成。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const raw = Object.fromEntries(url.searchParams.entries());
    const parsed = employeeQuerySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const result = await listEmployees(parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[GET /api/employees]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "查询员工列表失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/** POST /api/employees —— 新增员工，自动生成 employee_id */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = employeeCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const created = await createEmployee(
      parsed.data as Record<string, unknown>,
      operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/employees]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "新增员工失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
