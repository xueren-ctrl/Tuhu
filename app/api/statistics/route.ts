import { NextResponse } from "next/server";
import {
  getDashboardStats,
  getDepartmentDistribution,
  getPositionDistribution,
  getStoreDistribution,
} from "@/lib/employee-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/statistics —— 全局统计（第三阶段规格书第四节）
 *
 * 返回（全部实时聚合 Employee 表，无 mock、无硬编码）：
 *   员工总数 / 在职数量 / 离职数量 / 门店数量 / 部门数量 / 岗位数量
 * 另附按门店、按部门、按岗位的分布，供人员分布统计页与首页复用。
 *
 * 查询参数：
 *   ?detail=1  附带 storeDistribution / departmentDistribution / positionDistribution
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const withDetail =
      url.searchParams.get("detail") === "1" ||
      url.searchParams.get("detail") === "true";

    const stats = await getDashboardStats();

    const base = {
      totalEmployees: stats.total,
      activeEmployees: stats.active,
      resignedEmployees: stats.resigned,
      candidateEmployees: stats.candidate,
      storeCount: stats.storeCount,
      departmentCount: stats.departmentCount,
      positionCount: stats.positionCount,
      deletedEmployees: stats.deleted,
      activeRate: stats.activeRate,
      generatedAt: new Date().toISOString(),
    };

    if (!withDetail) {
      return NextResponse.json({ ok: true, data: base });
    }

    const [storeDistribution, departmentDistribution, positionDistribution] =
      await Promise.all([
        getStoreDistribution(),
        getDepartmentDistribution(),
        getPositionDistribution(),
      ]);

    return NextResponse.json({
      ok: true,
      data: {
        ...base,
        storeDistribution,
        departmentDistribution,
        positionDistribution,
      },
    });
  } catch (e) {
    console.error("[GET /api/statistics]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "统计失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
