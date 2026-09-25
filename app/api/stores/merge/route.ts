import { NextResponse } from "next/server";
import {
  mergeStores,
  previewStoreMerge,
  assertMergeRequestFresh,
  StaleMergePreviewError,
  MergePreviewRequiredError,
  InvalidMergeClusterError,
  MergeStoreStateChangedError,
  type MergePreviewSnapshot,
} from "@/lib/store-merge-service";
import { operatorFromRequest } from "@/lib/operator";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

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
    const msg = (e as Error).message ?? String(e);
    const stateErrors = ["已停用", "不存在", "同名"];
    const isState = stateErrors.some((k) => msg.includes(k));
    return NextResponse.json(
      { ok: false, code: isState ? "MERGE_STATE_CHANGED" : undefined, error: msg },
      { status: isState ? 409 : 400 }
    );
  }
}

/**
 * POST /api/stores/merge —— 合并门店（仅 ADMIN）
 * body: { mainStoreId: number, mergeStoreIds: number[], snapshot: MergePreviewSnapshot }
 *
 * Stage 7.1.2 收口（预览→确认→执行 闭环）：
 *   - snapshot 是**强制前置条件**：缺失 → 400 MERGE_PREVIEW_REQUIRED，绝不执行
 *   - snapshot 必须与本次请求绑定：mainStoreId 一致 + mergeStoreIds 集合一致（排序比较）
 *   - 服务端候选簇校验：所选门店必须全部属于同一个当前 ACTIVE 候选簇（允许簇内部分合并）
 *   - 版本/逐店人数复核：任一漂移 → 409 STALE_MERGE_PREVIEW
 *   - 状态校验：主店/sourceStore 必须存在且 ACTIVE → 否则 409 MERGE_STATE_CHANGED
 *   - mergeStores 内部仍重查 ACTIVE/同名/存在性/实时员工（最终执行前重读，事务原子）
 *
 * 四类错误码：
 *   400 MERGE_PREVIEW_REQUIRED   —— 缺 snapshot
 *   409 STALE_MERGE_PREVIEW      —— 参数错配 / 版本人数漂移
 *   409 INVALID_MERGE_CLUSTER    —— 不属于同一当前候选簇
 *   409 MERGE_STATE_CHANGED      —— 门店停用/不存在/同名
 */
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

    // ① 总前置校验：snapshot 强制 + 请求绑定 + 版本人数 + ACTIVE + 候选簇（任一失败绝不写入）
    try {
      await assertMergeRequestFresh({ mainStoreId, mergeStoreIds, snapshot: body.snapshot });
    } catch (e) {
      if (e instanceof MergePreviewRequiredError) {
        return NextResponse.json(
          { ok: false, code: "MERGE_PREVIEW_REQUIRED", error: e.message },
          { status: 400 }
        );
      }
      if (e instanceof StaleMergePreviewError) {
        return NextResponse.json(
          { ok: false, code: "STALE_MERGE_PREVIEW", error: e.message },
          { status: 409 }
        );
      }
      if (e instanceof InvalidMergeClusterError) {
        return NextResponse.json(
          { ok: false, code: "INVALID_MERGE_CLUSTER", error: e.message },
          { status: 409 }
        );
      }
      // ACTIVE / 不存在 / 同名类业务校验错误
      const msg = (e as Error).message ?? String(e);
      const stateErrors = ["已停用", "不存在", "同名"];
      const isState = stateErrors.some((k) => msg.includes(k));
      return NextResponse.json(
        { ok: false, code: isState ? "MERGE_STATE_CHANGED" : undefined, error: msg },
        { status: isState ? 409 : 400 }
      );
    }

    // ② 执行（mergeStores 内部仍重查 ACTIVE/同名/存在性/实时员工；整簇事务原子）
    // Stage 7.1.6：snapshot 一并透传给 mergeStores —— 服务层会再做一次
    // assertMergeRequestFresh 作为最终防线（绕过路由直接调用也无法跳过闭环校验）。
    const result = await mergeStores({
      mainStoreId,
      mergeStoreIds,
      operator: await operatorFromRequest(req),
      snapshot: body.snapshot,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    // Stage 7.1.3：事务内（写入前一刻）状态二次校验失败 —— 门店被并发停用/删除
    if (e instanceof MergeStoreStateChangedError) {
      return NextResponse.json(
        { ok: false, code: "MERGE_STATE_CHANGED", error: e.message },
        { status: 409 }
      );
    }
    const msg = (e as Error).message ?? String(e);
    const stateErrors = ["已停用", "不存在", "同名"];
    const isState = stateErrors.some((k) => msg.includes(k));
    return NextResponse.json(
      { ok: false, code: isState ? "MERGE_STATE_CHANGED" : undefined, error: msg },
      { status: isState ? 409 : 400 }
    );
  }
}
