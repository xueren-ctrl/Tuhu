"use client";

import HeadcountFullCell from "./HeadcountFullCell";
import type { HeadcountRow } from "@/lib/headcount-service";

/**
 * 门店名称单元格（Stage 9.16 简化）
 *
 * ⚠️ 只渲染**门店名单元格的内容**，绝不输出 `<td>`（Stage 9.14.1 修）：
 *     之前它自己渲染一个「调整」列的 <td>，而 Excel 原表里没有这一列，
 *     导致表头（22 列）与表体（23 个 td）列数不等、整张表错位 ——
 *     「客服经理」列下面显示的竟是「具体缺编明细」。
 *
 * 满编编辑逻辑已统一到 `HeadcountFullCell`（点满编数字即可编辑），
 * 这里只把门店名做成同样的入口，两个地方指向同一个编辑器，不再维护两套代码。
 */
export default function HeadcountPlanEditor({
  storeId,
  row,
}: {
  storeId: number;
  row: HeadcountRow;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-medium text-slate-700">{row.storeName}</span>
      {/* 复用满编编辑器：点「设」也能打开同一编辑框 */}
      <span className="-ml-1 inline-block align-middle">
        <HeadcountFullCell storeId={storeId} row={row} field="beautyFull" compact />
      </span>
    </span>
  );
}
