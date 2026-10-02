import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { exportExcel } from "@/lib/excel-export-service";

export const dynamic = "force-dynamic";
/** 导出整个工作簿要读写大文件，Node 侧时间放宽 */
export const maxDuration = 120;

/**
 * GET /api/export/excel —— 导出 Excel（Stage 9.38）
 *
 * 以**原始 `途虎HR人员登记.xlsx` 为底模**，把数据库最新数据回填到对应单元格。
 * 目标（用户 2026-10-02 要求）：导出后跟原 Excel 一模一样，只是数据更新了。
 *
 * - `?report=1` 返回导出明细（各 Sheet 回填了多少格），用于页面展示核对
 * - 否则直接返回 xlsx 文件流下载
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;

  try {
    const { buffer, filename, stats } = await exportExcel();

    if (new URL(req.url).searchParams.get("report") === "1") {
      return NextResponse.json({ ok: true, data: { filename, stats } });
    }

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(buffer.length),
        // 导出的是快照，不缓存
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[GET /api/export/excel]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}