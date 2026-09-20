import { NextResponse } from "next/server";
import { createPreview, listPreviews } from "@/lib/import-preview-service";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 上传文件可能较大，放宽 body 限制
export const maxDuration = 60;

/**
 * POST /api/import/preview —— 上传 Excel 并生成 Diff（**不写库**）
 * multipart/form-data，字段名 file
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "请选择要上传的 Excel 文件" }, { status: 400 });
    }
    const blob = file as File;
    if (!/\.(xlsx|xls)$/i.test(blob.name)) {
      return NextResponse.json({ ok: false, error: "只支持 .xlsx / .xls 文件" }, { status: 400 });
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    const data = await createPreview({
      buffer,
      fileName: blob.name,
      operator: operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/** GET /api/import/preview —— 预览批次列表 */
export async function GET() {
  try {
    const data = await listPreviews();
    return NextResponse.json({ ok: true, total: data.length, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
