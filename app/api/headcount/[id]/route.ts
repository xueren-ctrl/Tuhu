import { NextResponse } from "next/server";
import { z } from "zod";
import { saveHeadcountPlan } from "@/lib/headcount-service";
import { requireApiUser } from "@/lib/auth";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 非负整数或 null（留空 = 不设该职位满编） */
const nonNeg = z.union([z.number().int().min(0).max(999), z.null()]);

const bodySchema = z
  .object({
    serviceManagerFull: nonNeg.optional(),
    mechanicFull: nonNeg.optional(),
    beautyFull: nonNeg.optional(),
    beautyMasterFull: nonNeg.optional(),
    beautyJuniorFull: nonNeg.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "请至少提供一个要修改的字段" });

/** PUT /api/headcount/:storeId —— 调整某家门店的满编目标 */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = await requireApiUser(req);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await ctx.params;
    const storeId = Number(id);
    if (!Number.isFinite(storeId) || storeId <= 0) {
      return NextResponse.json({ ok: false, error: "无效的门店 ID" }, { status: 400 });
    }
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；") },
        { status: 400 }
      );
    }
    const saved = await saveHeadcountPlan(storeId, parsed.data, await operatorFromRequest(req));
    return NextResponse.json({ ok: true, data: saved });
  } catch (e) {
    console.error("[PUT /api/headcount/:storeId]", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "保存满编目标失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
