import { NextResponse } from "next/server";
import {
  applyDepartmentAuto,
  previewDepartmentAuto,
  StalePreviewError,
  DepartmentPreviewRequiredError,
  type AutoPreviewSnapshot,
} from "@/lib/department-rule-service";
import { BatchUpdateAbortedError } from "@/lib/employee-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/departments/auto（仅 ADMIN，第六阶段；Stage 7.1.3 snapshot 强制）
 * body: {
 *   action: "preview" | "apply",
 *   overrideExisting?: boolean,
 *   itemLimit?: number,            // 仅 preview 用：展示明细上限（默认 500，不影响执行数量）
 *   snapshot: AutoPreviewSnapshot  // apply **必须**携带：预览时冻结的数据版本快照
 * }
 *
 * preview —— 只读生成推荐（全量统计 + 展示截断 + 版本快照），不写库（可反复调用）
 * apply   —— Stage 7.1.3：必须携带 snapshot（缺失 → 400 DEPARTMENT_PREVIEW_REQUIRED，
 *            绝不执行任何写入）；复核通过（库有变化 → 409 STALE_PREVIEW）后按
 *            **全量匹配**写入，整批原子事务（失败 409 BATCH_ABORTED 整体回滚）。
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
      // Stage 7.1.3：apply 强制 snapshot —— route 层直接拒绝，不信任前端、不兼容旧调用
      if (!body.snapshot) {
        return NextResponse.json(
          {
            ok: false,
            code: "DEPARTMENT_PREVIEW_REQUIRED",
            error:
              "部门自动归属执行必须先调用 preview 获取 snapshot 再 apply（预览→确认→执行），缺少 snapshot 拒绝执行。",
          },
          { status: 400 }
        );
      }
      const data = await applyDepartmentAuto({
        overrideExisting,
        operator: await operatorFromRequest(req),
        snapshot: body.snapshot,
      });
      return NextResponse.json({ ok: true, mode: "apply", data });
    }
    return NextResponse.json({ ok: false, error: "action 只能是 preview 或 apply" }, { status: 400 });
  } catch (e) {
    if (e instanceof DepartmentPreviewRequiredError) {
      // service 层兜底（正常不会到——route 已拦截）
      return NextResponse.json(
        { ok: false, code: "DEPARTMENT_PREVIEW_REQUIRED", error: e.message },
        { status: 400 }
      );
    }
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
