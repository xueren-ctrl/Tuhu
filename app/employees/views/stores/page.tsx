import Link from "next/link";
import {
  getStoreDistribution,
  getStoreSummary,
} from "@/lib/employee-service";
import { getSelectOptions } from "@/lib/settings-service";
import { prisma } from "@/lib/prisma";
import { Alert, Button, Card, StatCard } from "@/components/ui";
import PersonnelListView from "@/components/employees/PersonnelListView";
import { UNASSIGNED_LABEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * /employees/views/stores —— 门店人员查询
 *
 * 替代 Excel 中各门店的各别 Sheet（如「南昌3店」）。
 * 门店列表由 Store 表**动态生成**，不为每个门店创建单独页面。
 *
 * 两种状态：
 *   ?storeId 缺省  → 门店总览（每家门店的人数汇总，可点击进入）
 *   ?storeId=123  → 该门店详情（在职/离职人数 + 岗位分布 + 员工列表）
 */
export default async function StorePersonnelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rawStoreId = Array.isArray(sp.storeId) ? sp.storeId[0] : sp.storeId;
  const storeId = rawStoreId && /^\d+$/.test(rawStoreId) ? Number(rawStoreId) : null;

  // ---------- 未选择门店：门店总览 ----------
  if (!storeId) {
    const [dist, storeCount] = await Promise.all([
      getStoreDistribution(),
      prisma.store.count({ where: { status: "ACTIVE" } }),
    ]);
    const stores = dist.filter((r) => r.id !== null);
    const unassigned = dist.find((r) => r.id === null);
    const totalInStores = stores.reduce((s, r) => s + r.total, 0);

    return (
      <div className="mx-auto max-w-[1400px] space-y-4">
        <Alert tone="info">
          选择门店查看该门店的人员情况。门店清单由 <code>Store</code> 表动态生成，
          <b>不会为每家门店创建单独页面</b>；门店增删改后本页自动变化。
        </Alert>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="门店数量" value={storeCount} sub="启用中的门店" tone="blue" />
          <StatCard label="已归属门店的员工" value={totalInStores} sub="有 storeId 的员工" tone="green" />
          <StatCard
            label="未分配门店"
            value={unassigned?.total ?? 0}
            sub="如运营部等非门店人员"
            tone="amber"
          />
          <StatCard label="本页门店数" value={stores.length} sub="含已停用门店" tone="slate" />
        </div>

        <Card title={`门店列表（${stores.length}）`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium">门店名称</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">在职</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">离职</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">合计</th>
                  <th className="px-3 py-2.5 font-medium w-[180px]">在职占比</th>
                  <th className="px-4 py-2.5 font-medium w-[110px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((r) => {
                  const pct = r.total ? Math.round((r.active / r.total) * 100) : 0;
                  return (
                    <tr key={r.key} className="text-[12.5px]">
                      <td className="px-4 py-2 font-medium">{r.label}</td>
                      <td className="px-3 py-2 tabular-nums text-emerald-700">{r.active}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-500">{r.resigned}</td>
                      <td className="px-3 py-2 font-medium tabular-nums">{r.total}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-[100px] overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[11px] tabular-nums text-slate-500">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/employees/views/stores?storeId=${r.id}`}>
                          <Button size="sm" variant="ghost">
                            查看人员 →
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {unassigned ? (
                  <tr className="text-[12.5px] text-slate-400">
                    <td className="px-4 py-2">{UNASSIGNED_LABEL}门店（如部门人员）</td>
                    <td className="px-3 py-2 tabular-nums">{unassigned.active}</td>
                    <td className="px-3 py-2 tabular-nums">{unassigned.resigned}</td>
                    <td className="px-3 py-2 tabular-nums">{unassigned.total}</td>
                    <td className="px-3 py-2 text-[11px]">—</td>
                    <td className="px-4 py-2">
                      <Link href="/employees?storeId=__none__">
                        <Button size="sm" variant="ghost">
                          查看
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  // ---------- 已选择门店：门店详情 ----------
  const [store, summary, options] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, code: true, region: true, address: true, plannedHeadcount: true },
    }),
    getStoreSummary(storeId),
    getSelectOptions(),
  ]);

  if (!store) {
    return (
      <div className="mx-auto max-w-[1000px]">
        <Alert tone="error">
          门店不存在（id={storeId}）。请返回{" "}
          <Link href="/employees/views/stores" className="underline">
            门店列表
          </Link>{" "}
          重新选择。
        </Alert>
      </div>
    );
  }

  const maxActive = Math.max(1, ...summary.positionDistribution.map((p) => p.active));

  return (
    <PersonnelListView
      basePath="/employees/views/stores"
      searchParams={sp}
      locked={{ storeId: String(storeId) }}
      title={`${store.name} · 人员列表`}
      hint={`当前门店：${store.name}${store.region ? `（${store.region}）` : ""}。门店由 URL 参数 storeId 决定，页面本身只有一个。`}
      advanced
      emptyText="该门店暂无员工记录"
      labelOverrides={{ store: "门店" }}
      columns={[
        "employeeId",
        "name",
        "position",
        "hireDate",
        "phone",
        "status",
        "resignDate",
        "resignReason",
      ]}
      header={
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Link href="/employees/views/stores">
                <Button size="sm">← 门店列表</Button>
              </Link>
              <h2 className="text-[15px] font-semibold">{store.name}</h2>
              {store.code ? (
                <span className="text-[11.5px] text-slate-400">编码 {store.code}</span>
              ) : null}
              {store.plannedHeadcount ? (
                <span className="text-[11.5px] text-slate-400">
                  计划编制 {store.plannedHeadcount} 人
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="该门店员工总数" value={summary.total} sub="含离职" tone="blue" />
            <StatCard label="在职人数" value={summary.active} sub="status = ACTIVE" tone="green" />
            <StatCard label="离职人数" value={summary.resigned} sub="status = RESIGNED" tone="red" />
            <StatCard
              label="岗位数量"
              value={summary.positionDistribution.filter((p) => p.id !== null).length}
              sub="该门店出现的岗位数"
              tone="amber"
            />
          </div>

          <Card title="岗位分布（该门店）">
            {summary.positionDistribution.length === 0 ? (
              <p className="text-[12.5px] text-slate-400">暂无岗位数据</p>
            ) : (
              <ul className="space-y-2">
                {summary.positionDistribution.map((p) => (
                  <li key={p.key} className="flex items-center gap-3">
                    <span className="w-[180px] shrink-0 truncate text-[12.5px] text-slate-700" title={p.label}>
                      {p.label}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded bg-slate-100">
                      <div
                        className="h-full rounded bg-emerald-500"
                        style={{ width: `${(p.active / maxActive) * 100}%` }}
                      />
                    </div>
                    <span className="w-[150px] shrink-0 text-right text-[11.5px] tabular-nums text-slate-500">
                      在职 <b className="text-emerald-700">{p.active}</b> / 离职 {p.resigned} / 共 {p.total}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-[var(--hr-border)] pt-3 text-[11.5px] text-slate-400">
              岗位名称取自 Excel「工种级别」列的历史取值（如「青铜机修技师」），
              未做归并。如需合并粗类，可在
              <Link href="/settings/positions" className="text-brand-600 hover:underline">
                职位管理
              </Link>
              中维护岗位大类。
            </p>
          </Card>
        </div>
      }
    />
  );
}
