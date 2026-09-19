import { NextResponse } from "next/server";
import { createPosition, listPositions } from "@/lib/settings-service";
import { formatZodError, positionSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** GET /api/positions —— 职位列表 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rows = await listPositions({
      keyword: url.searchParams.get("keyword") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      includeInactive:
        url.searchParams.get("includeInactive") === "true" ||
        url.searchParams.get("includeInactive") === "1",
    });
    return NextResponse.json({ ok: true, data: rows, total: rows.length });
  } catch (e) {
    console.error("[GET /api/positions]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "查询职位失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}

/** POST /api/positions —— 新增职位 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = positionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const created = await createPosition(parsed.data as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
