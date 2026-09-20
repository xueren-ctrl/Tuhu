import { Alert, Card, StatCard } from "@/components/ui";
import StoreAliasPanel from "@/components/stores/StoreAliasPanel";
import { findAliasCandidates, listStoresWithCounts } from "@/lib/store-service";

export const dynamic = "force-dynamic";

/**
 * /stores 门店管理（第三阶段）
 *
 * 展示门店名称 / 编码 / 员工数量 / 在职 / 离职，并支持门店别名管理。
 * 全部数字实时来自 Employee 表按 storeId 聚合，不落任何统计表。
 */
export default async function StoresPage() {
  const [stores, candidates] = await Promise.all([
    listStoresWithCounts({ includeInactive: true }),
    findAliasCandidates(),
  ]);

  const active = stores.filter((s) => s.status === "ACTIVE").length;
  const withAlias = stores.filter((s) => s.aliases.length > 0).length;
  const totalEmp = stores.reduce((s, x) => s + x.total, 0);
  const totalActive = stores.reduce((s, x) => s + x.active, 0);
  const totalResigned = stores.reduce((s, x) => s + x.resigned, 0);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        门店别名用于解决「同一家门店在历史 Excel 里有多种写法」的问题
        —— 例如标准名 <strong>A店</strong>，别名可能是 <strong>A途虎</strong>、
        <strong>A养车</strong>。把别名登记到标准门店后，
        <strong>用标准名或别名检索，结果完全一致</strong>，分布统计也不会再把同一家店拆成两行。
        <br />
        <strong>别名不会复制任何员工数据</strong>：只把员工的门店外键指向标准门店，
        Excel 原文列（storeNameRaw）原样保留，随时可追溯。
      </Alert>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="门店总数" value={stores.length} sub={`启用中 ${active} 家`} tone="blue" />
        <StatCard label="已登记别名" value={withAlias} sub={`共 ${stores.reduce((s, x) => s + x.aliasCount, 0)} 个别名`} tone="amber" />
        <StatCard label="门店关联员工" value={totalEmp} sub="按 storeId 聚合" tone="slate" />
        <StatCard label="其中在职" value={totalActive} tone="green" />
        <StatCard label="其中离职" value={totalResigned} tone="red" />
      </div>

      {candidates.length > 0 && (
        <Card title={`疑似同一门店的别名候选（${candidates.length} 组，仅提示，不会自动合并）`}>
          <div className="mb-2 text-[12.5px] leading-relaxed text-slate-600">
            系统里这些门店两两名称高度相似，疑似同一家店的两种写法（{candidates.length} 组，
            意味着 66 家门店实际可能只有约 {stores.length - candidates.length} 家）。
            建议把<strong>右侧名称</strong>登记为<strong>左侧名称</strong>的别名，
            登记后该店的人数、在职、离职会合并计算，分布统计也不再被拆成两行。
            <br />
            <strong>系统不会自动合并</strong>（合并属业务判断）。请先人工确认，
            再到下方门店列表点「管理别名」按建议操作，或先停用其中一条记录。
          </div>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-3 py-2 font-medium">建议保留（标准名）</th>
                  <th className="px-3 py-2 text-right font-medium">在职 / 总人数</th>
                  <th className="px-3 py-2 font-medium">建议登记为别名</th>
                  <th className="px-3 py-2 text-right font-medium">在职 / 总人数</th>
                  <th className="px-3 py-2 font-medium">判定依据</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c, i) => (
                  <tr key={`${c.standardId}-${c.aliasId}-${i}`} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-800">{c.standardName}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {c.standardActive} / {c.standardTotal}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{c.aliasName}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {c.aliasActive} / {c.aliasTotal}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <StoreAliasPanel stores={stores} />
    </div>
  );
}
