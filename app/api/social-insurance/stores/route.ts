import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";
import { decideStoreMapping, searchEmployeesForLink, SiError } from "@/lib/social-insurance-service";

export const dynamic = "force-dynamic";

/**
 * /api/social-insurance/stores —— 门店名 → 门店主数据的人工确认（Stage 9.37）
 *
 * PUT  确认一条映射（确认后自动把该名单下的参保行门店归位）
 * GET  ?search=关键字  搜员工（关联档案用）
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  const kw = new URL(req.url).searchParams.get("search") ?? "";
  try {
    return NextResponse.json({ ok: true, data: await searchEmployeesForLink(kw) });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[GET /api/social-insurance/stores]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    const status = body.status === "REJECTED" ? "REJECTED" : "CONFIRMED";
    await decideStoreMapping(
      id,
      body.storeId ? Number(body.storeId) : null,
      status,
      body.note ? String(body.note) : null,
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SiError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const msg = (e as Error).message;
    console.error("[PUT /api/social-insurance/stores]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
