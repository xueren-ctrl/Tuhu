import { NextResponse } from "next/server";
import { getSelectOptions } from "@/lib/settings-service";

export const dynamic = "force-dynamic";

/** GET /api/options —— 门店 / 职位下拉选项 */
export async function GET() {
  try {
    const data = await getSelectOptions();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    console.error("[GET /api/options]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "加载基础数据失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
