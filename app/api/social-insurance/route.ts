import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";
import {
  createEntry,
  listSocialInsurance,
  listStoreMappings,
  removeEntry,
  socialInsuranceStats,
  SiError,
  updateEntryFields,
} from "@/lib/social-insurance-service";

export const dynamic = "force-dynamic";

/**
 * /api/social-insurance —— 社保参保名单（Stage 9.37）
 *
 * GET  ?stats=1     顶部统计 + 需要处理的人
 * GET  ?stores=1    门店名映射（待人工确认）
 * GET  ?page=&insured=&storeId=&keyword=&sort=&unlinked=&needReview=
 * POST 新增参保记录（实时更新用）
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  const u = new URL(req.url);

  try {
    if (u.searchParams.get("stats") === "1") {
      return NextResponse.json({ ok: true, data: await socialInsuranceStats() });
    }
    if (u.searchParams.get("stores") === "1") {
      return NextResponse.json({ ok: true, data: await listStoreMappings() });
    }
    const data = await listSocialInsurance({
      insured: u.searchParams.get("insured") ?? undefined,
      storeId: u.searchParams.get("storeId") ?? undefined,
      keyword: u.searchParams.get("keyword") ?? undefined,
      unlinked: u.searchParams.get("unlinked") ?? undefined,
      needReview: u.searchParams.get("needReview") ?? undefined,
      sort: (u.searchParams.get("sort") as never) ?? undefined,
      page: Number(u.searchParams.get("page") ?? 1),
      pageSize: Number(u.searchParams.get("pageSize") ?? 50),
    });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[GET /api/social-insurance]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const created = await createEntry(
      {
        name: String(body.name ?? ""),
        storeId: body.storeId ? Number(body.storeId) : null,
        storeNameRaw: body.storeNameRaw ? String(body.storeNameRaw) : null,
        employeeId: body.employeeId ? Number(body.employeeId) : null,
        insuredDate: body.insuredDate ? String(body.insuredDate) : null,
        datePrecision: (body.datePrecision as "DAY" | "MONTH") ?? undefined,
        baseAmount: body.baseAmount ? String(body.baseAmount) : null,
        note: body.note ? String(body.note) : null,
        insured: body.insured === undefined ? true : Boolean(body.insured),
      },
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    if (e instanceof SiError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const msg = (e as Error).message;
    console.error("[POST /api/social-insurance]", msg);
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
    await updateEntryFields(
      id,
      {
        baseAmount: body.baseAmount === undefined ? undefined : (body.baseAmount ? String(body.baseAmount) : null),
        note: body.note === undefined ? undefined : (body.note ? String(body.note) : null),
      },
      await operatorFromRequest(req)
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SiError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const msg = (e as Error).message;
    console.error("[PUT /api/social-insurance]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const u = new URL(req.url);
    const id = Number(u.searchParams.get("id"));
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    await removeEntry(id, await operatorFromRequest(req));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SiError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const msg = (e as Error).message;
    console.error("[DELETE /api/social-insurance]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
