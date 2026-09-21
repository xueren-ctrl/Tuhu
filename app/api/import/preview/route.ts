import { NextResponse } from "next/server";
import { createPreview, listPreviews } from "@/lib/import-preview-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 上传文件可能较大，放宽 body 限制
export const maxDuration = 60;

/**
 * 只接受 .xlsx。
 *
 * 为什么不再宣称支持 .xls：ExcelJS **不支持读取 xls（BIFF8）二进制格式**，
 * 之前接口允许 .xls 却会在解析阶段失败 —— 属于「前端允许、后端无法解析」。
 * 与其假装支持，不如明确拒绝，并提示用户另存为 .xlsx。
 */
const ACCEPT_EXT = /\.xlsx$/i;
/** 文件大小上限：20MB（防止超大文件耗尽服务资源） */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/import/preview —— 上传 Excel 并生成 Diff（**不写库**）
 * multipart/form-data，字段名 file
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "请选择要上传的 Excel 文件" }, { status: 400 });
    }
    const blob = file as File;
    if (!ACCEPT_EXT.test(blob.name)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "只支持 .xlsx 文件。ExcelJS 无法读取旧版 .xls（BIFF8 二进制格式），请用 Excel 打开后「另存为 → Excel 工作簿(*.xlsx)」再上传。",
        },
        { status: 400 }
      );
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `文件过大：${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 20MB。请拆分后上传。`,
        },
        { status: 413 }
      );
    }
    const data = await createPreview({
      buffer,
      fileName: blob.name,
      operator: await operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/** GET /api/import/preview —— 预览批次列表 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const data = await listPreviews();
    return NextResponse.json({ ok: true, total: data.length, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
