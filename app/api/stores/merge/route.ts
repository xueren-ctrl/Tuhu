import { NextResponse } from "next/server";
import { mergeStores } from "@/lib/store-merge-service";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

/**
 * POST /api/stores/merge —— 合并门店
 * body: { mainStoreId: number, mergeStoreIds: number[] }
 *
 * 行为（需求书四条硬要求）：
 *   1. 只修改 Employee.storeId
 *   2. 禁止删除员工数据（只改外键；被合并的门店记录也不删，只停用）
 *   3. 被合并的门店名登记为 StoreAlias 保留
 *   4. 每次归属变更都写 EmployeeHistory
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { mainStoreId?: number; mergeStoreIds?: number[] };
    const mainStoreId = Number(body.mainStoreId);
    if (!Number.isFinite(mainStoreId) || mainStoreId <= 0) {
      return NextResponse.json({ ok: false, error: "请指定主门店" }, { status: 400 });
    }
    const mergeStoreIds = (body.mergeStoreIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!mergeStoreIds.length) {
      return NextResponse.json({ ok: false, error: "请至少选择一家要合并进来的门店" }, { status: 400 });
    }
    const result = await mergeStores({
      mainStoreId,
      mergeStoreIds,
      operator: operatorFromRequest(req),
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
