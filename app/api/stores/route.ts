import { NextResponse } from "next/server";
import { createStore, listStores } from "@/lib/settings-service";
import { formatZodError, storeSchema } from "@/lib/validation";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

/** GET /api/stores —— 门店列表（支持搜索与停用筛选） */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rows = await listStores({
      keyword: url.searchParams.get("keyword") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      includeInactive:
        url.searchParams.get("includeInactive") === "true" ||
        url.searchParams.get("includeInactive") === "1",
    });
    return NextResponse.json({ ok: true, data: rows, total: rows.length });
  } catch (e) {
    console.error("[GET /api/stores]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "查询门店失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/** POST /api/stores —— 新增门店 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = storeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const created = await createStore(parsed.data as Record<string, unknown>, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
