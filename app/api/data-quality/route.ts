import { NextResponse } from "next/server";
import { getDataQualitySummary } from "@/lib/data-quality-service";

export const dynamic = "force-dynamic";

/** GET /api/data-quality —— 五类数据问题的数量汇总（实时计算） */
export async function GET() {
  try {
    const data = await getDataQualitySummary();
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
