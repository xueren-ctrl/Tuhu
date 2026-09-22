import { NextResponse } from "next/server";
import {
  applyDepartmentAuto,
  previewDepartmentAuto,
  StalePreviewError,
  type AutoPreviewSnapshot,
} from "@/lib/department-rule-service";
import { BatchUpdateAbortedError } from "@/lib/employee-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/departments/auto（仅 ADMIN，第六阶段）
 * body: {
 *   action: "preview" | "apply",
 *   overrideExisting?: boolean,
 *   itemLimit?: number,            // 仅 preview 用：展示明细上限（默认 500，不影响执行数量）
 *   snapshot?: AutoPreviewSnapshot // apply 用：预览时冻结的数据版本快照，服务端复核
 * }
 *
 * preview —— 只读生成推荐（全量统计 + 展示截断 + 版本快照），不写库（可反复调用）
 * apply   —— 先复核快照（库有变化 → 409 STALE_PREVIEW），再按**全量匹配**写入
 *            （Stage 7.1：执行数量恒等于全量 affected，绝不按展示 items 截断）
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as {
      action?: string;
      overrideExisting?: boolean;
      itemLimit?: number;
      snapshot?: AutoPreviewSnapshot;
    };
    const action = body.action ?? "preview";
    const overrideExisting = Boolean(body.overrideExisting);

    if (action === "preview") {
      const data = await previewDepartmentAuto({
        overrideExisting,
        itemLimit:
          typeof body.itemLimit === "number" && body.itemLimit > 0
            ? Math.min(5000, body.itemLimit)
            : undefined,
      });
      return NextResponse.json({ ok: true, mode: "preview", data });
    }
    if (action === "apply") {
      const data = await applyDepartmentAuto({
        overrideExisting,
        operator: await operatorFromRequest(req),
        snapshot: body.snapshot,
      });
      return NextResponse.json({ ok: true, mode: "apply", data });
    }
    return NextResponse.json({ ok: false, error: "action 只能是 preview 或 apply" }, { status: 400 });
    } catch (e) {
      if (e instanceof StalePreviewError) {
        return NextResponse.json({ ok: false, code: "STALE_PREVIEW", error: e.message }, { status: 409 });
      }
      if (e instanceof BatchUpdateAbortedError) {
        // Stage 7.1.1 整批原子：本次 apply 的所有修改（员工 / 历史 / 审计）已整体回滚
        return NextResponse.json(
          { ok: false, code: "BATCH_ABORTED", error: e.message },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
    }
}
