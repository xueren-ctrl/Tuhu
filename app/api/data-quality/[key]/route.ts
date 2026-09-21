import { NextResponse } from "next/server";
import {
  DQ_CATEGORIES,
  getDataQualityDetail,
  type DqCategoryKey,
} from "@/lib/data-quality-service";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

const VALID = new Set(DQ_CATEGORIES.map((c) => c.key));

/** GET /api/data-quality/:key —— 某一类问题的明细（分页，敏感字段脱敏） */
export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { key } = await ctx.params;
    if (!VALID.has(key as DqCategoryKey)) {
      return NextResponse.json(
        { ok: false, error: `未知的问题类别：${key}` },
        { status: 400 }
      );
    }
    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 20);
    const data = await getDataQualityDetail(key as DqCategoryKey, { page, pageSize });
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
