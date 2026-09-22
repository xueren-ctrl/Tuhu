import { NextResponse } from "next/server";
import {
  mergeStores,
  previewStoreMerge,
  assertMergeSnapshotFresh,
  StaleMergePreviewError,
  type MergePreviewSnapshot,
} from "@/lib/store-merge-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/stores/merge —— 合并门店（仅 ADMIN，第六阶段）
 * body: { mainStoreId: number, mergeStoreIds: number[], snapshot?: MergePreviewSnapshot }
 *
 * 行为（需求书四条硬要求 + Stage 7.1.1 收口）：
 *   1. 只修改 Employee.storeId（storeId 精确匹配，不做 raw 原文兜底迁移）
 *   2. 禁止删除员工数据（只改外键；被合并的门店记录也不删，只停用）
 *   3. 被合并的门店名登记为 StoreAlias 保留
 *   4. 每次归属变更都写 EmployeeHistory（整簇一个事务，失败整体回滚）
 *
 * Stage 7.1.1 服务端校验（不信任客户端）：
 *   - 主门店 / 被合并门店必须都存在且 ACTIVE（INACTIVE 旧门店拒绝参与新合并）
 *   - 同名门店记录拒绝自动合并（人工处理）
 *   - 携带 snapshot 时先复核版本指纹与逐店人数 → 任一变化 409 STALE_MERGE_PREVIEW
 *   - 执行前实时重算人数，写库数量以实时值为准（预览数量 = 执行数量）
 */
/**
 * GET /api/stores/merge?mainStoreId=&mergeStoreIds=a,b —— 合并预览（只读，不写库）
 * 返回快照 + 逐店人数/别名/预期结果；执行 POST 时携带 snapshot 做一致性复核。
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const url = new URL(req.url);
    const mainStoreId = Number(url.searchParams.get("mainStoreId"));
    const mergeStoreIds = (url.searchParams.get("mergeStoreIds") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!Number.isFinite(mainStoreId) || mainStoreId <= 0 || !mergeStoreIds.length) {
      return NextResponse.json({ ok: false, error: "参数不完整（mainStoreId / mergeStoreIds）" }, { status: 400 });
    }
    const data = await previewStoreMerge({ mainStoreId, mergeStoreIds });
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request) {
  const auth = await requireApiUser(req, { roles: ["ADMIN"] });
  if (auth instanceof Response) return auth;
  try {
    const body = (await req.json()) as {
      mainStoreId?: number;
      mergeStoreIds?: number[];
      snapshot?: MergePreviewSnapshot;
    };
    const mainStoreId = Number(body.mainStoreId);
    if (!Number.isFinite(mainStoreId) || mainStoreId <= 0) {
      return NextResponse.json({ ok: false, error: "请指定主门店" }, { status: 400 });
    }
    const mergeStoreIds = (body.mergeStoreIds ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!mergeStoreIds.length) {
      return NextResponse.json({ ok: false, error: "请至少选择一家要合并进来的门店" }, { status: 400 });
    }

    // ① 服务端前置校验（存在性 / ACTIVE / 同名 / 逐店人数实时统计）
    await previewStoreMerge({ mainStoreId, mergeStoreIds });

    // ② 快照复核：库在预览后变化 → 409（页面应重新预览）
    if (body.snapshot) {
      try {
        await assertMergeSnapshotFresh(body.snapshot);
      } catch (e) {
        if (e instanceof StaleMergePreviewError) {
          return NextResponse.json({ ok: false, code: "STALE_MERGE_PREVIEW", error: e.message }, { status: 409 });
        }
        throw e;
      }
    }

    // ③ 执行（内部再做一次业务校验 + 逐店实时人数，整簇事务）
    const result = await mergeStores({
      mainStoreId,
      mergeStoreIds,
      operator: await operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // 状态已变化类错误（停用/同名/不存在）返回 409，参数类错误 400
    const stateErrors = ["已停用", "不存在", "同名"];
    const isState = stateErrors.some((k) => msg.includes(k));
    return NextResponse.json(
      { ok: false, code: isState ? "MERGE_STATE_CHANGED" : undefined, error: msg },
      { status: isState ? 409 : 400 }
    );
  }
}
