import { NextResponse } from "next/server";
import { applyDepartmentAuto, previewDepartmentAuto } from "@/lib/department-rule-service";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

/**
 * POST /api/departments/auto
 * body: { action: "preview" | "apply", overrideExisting?: boolean }
 *
 * preview —— 只读生成推荐，不写库（可反复调用）
 * apply   —— 按推荐批量写入（走标准更新流程，自带变更记录）
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: string; overrideExisting?: boolean };
    const action = body.action ?? "preview";
    const overrideExisting = Boolean(body.overrideExisting);

    if (action === "preview") {
      const data = await previewDepartmentAuto({ overrideExisting });
      return NextResponse.json({ ok: true, mode: "preview", data });
    }
    if (action === "apply") {
      const data = await applyDepartmentAuto({
        overrideExisting,
        operator: operatorFromRequest(req),
      });
      return NextResponse.json({ ok: true, mode: "apply", data });
    }
    return NextResponse.json({ ok: false, error: "action 只能是 preview 或 apply" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
