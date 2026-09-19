import { NextResponse } from "next/server";
import { getDashboardStats } from "@/lib/employee-service";

export const dynamic = "force-dynamic";

/** GET /api/stats —— 首页统计，全部实时从数据库计算 */
export async function GET() {
  try {
    const stats = await getDashboardStats();
    return NextResponse.json({ ok: true, data: stats });
  } catch (e) {
    console.error("[GET /api/stats]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "统计失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
