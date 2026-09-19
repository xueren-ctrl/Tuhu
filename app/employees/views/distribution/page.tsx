import Link from "next/link";
import {
  getDashboardStats,
  getDepartmentDistribution,
  getPositionDistribution,
  getStoreDistribution,
  type DistributionRow,
} from "@/lib/employee-service";
import { Alert, Badge, Button, Card, StatCard } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /employees/views/distribution —— 人员分布统计
 * 替代 Excel「门店人员分布明细」「人员流失率」Sheet。
 * 全部通过数据库实时聚合，不落中间表、不写死数字。
 */

function DistributionTable({
  rows,
  firstColLabel,
  linkPrefix,
  linkQueryKey,
  emptyText,
}: {
  rows: DistributionRow[];
  firstColLabel: string;
  linkPrefix?: string;
  linkQueryKey?: string;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <div className="px-4 py-10 text-center text-[12.5px] text-slate-400">{emptyText}</div>;
  }
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="overflow-x-auto">
      <table className="grid-table">
        <thead>
          <tr className="text-left text-[11.5px] text-slate-500">
            <th className="px-4 py-2.5 font-medium">{firstColLabel}</th>
            <th className="px-3 py-2.5 font-medium w-[70px]">在职</th>
            <th className="px-3 py-2.5 font-medium w-[70px]">离职</th>
            <th className="px-3 py-2.5 font-medium w-[70px]">合计</th>
            <th className="px-3 py-2.5 font-medium w-[150px]">占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const label =
              linkPrefix && linkQueryKey && r.id !== null ? (
                <Link
                  href={`${linkPrefix}?${linkQueryKey}=${r.id}`}
                  className="hover:text-brand-600 hover:underline"
                >
                  {r.label}
                </Link>
              ) : r.id === null ? (
                <span className="text-slate-400">{r.label}</span>
              ) : (
                r.label
              );
            return (
              <tr key={r.key} className="text-[12.5px]">
                <td className="px-4 py-2">{label}</td>
                <td className="px-3 py-2 tabular-nums text-emerald-700">{r.active}</td>
                <td className="px-3 py-2 tabular-nums text-slate-500">{r.resigned}</td>
                <td className="px-3 py-2 font-medium tabular-nums">{r.total}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-[80px] overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${(r.total / max) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] tabular-nums text-slate-400">{r.total}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function DistributionPage() {
  const [stats, storeDist, deptDist, posDist] = await Promise.all([
    getDashboardStats(),
    getStoreDistribution(),
    getDepartmentDistribution(),
    getPositionDistribution(),
  ]);

  const storeRows = storeDist.filter((r) => r.id !== null);
  const deptRows = deptDist.filter((r) => r.id !== null);
  const posRows = posDist.filter((r) => r.id !== null);
  const unassignedStore = storeDist.find((r) => r.id === null);
  const unassignedDept = deptDist.find((r) => r.id === null);
  const unassignedPos = posDist.find((r) => r.id === null);

  // 有一名以上员工的岗位数（更贴近「在用的岗位」口径）
  const activePositionCount = posRows.filter((r) => r.total > 0).length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        替代 Excel「门店人员分布明细」「人员流失率」Sheet。以下全部为
        <b>数据库实时聚合结果</b>，员工状态 / 门店 / 部门 / 岗位任意改动后刷新即变。
      </Alert>

      {/* ---- 总览 ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="总人数" value={stats.total} sub="未停用档案" tone="blue" />
        <StatCard label="在职人数" value={stats.active} sub={`占比 ${stats.activeRate}%`} tone="green" />
        <StatCard label="离职人数" value={stats.resigned} sub="含历史档案" tone="red" />
        <StatCard label="门店数量" value={stats.storeCount} sub="启用中" tone="slate" />
        <StatCard label="部门数量" value={stats.departmentCount} sub="启用中" tone="amber" />
        <StatCard label="岗位数量" value={stats.positionCount} sub={`其中 ${activePositionCount} 个在用`} tone="blue" />
      </div>

      {/* ---- 各门店人数 ---- */}
      <Card
        title={`各门店人数（${storeRows.length} 家）`}
        extra={
          <Link href="/employees/views/stores">
            <Button size="sm" variant="ghost">
              门店人员查询 →
            </Button>
          </Link>
        }
        bodyClassName="p-0"
      >
        <DistributionTable
          rows={storeRows}
          firstColLabel="门店"
          linkPrefix="/employees/views/stores"
          linkQueryKey="storeId"
          emptyText="暂无门店数据"
        />
        {unassignedStore ? (
          <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[12px] text-slate-500">
            另有 <b>{unassignedStore.total}</b> 名员工未归属任何门店
            （在职 {unassignedStore.active} / 离职 {unassignedStore.resigned}），
            主要是部门人员：
            <Link href="/employees?storeId=__none__" className="ml-1 text-brand-600 hover:underline">
              查看
            </Link>
          </div>
        ) : null}
      </Card>

      {/* ---- 各部门人数 ---- */}
      <Card
        title={`各部门人数（${deptRows.length} 个）`}
        extra={
          <Link href="/employees/views/departments">
            <Button size="sm" variant="ghost">
              部门人员查询 →
            </Button>
          </Link>
        }
        bodyClassName="p-0"
      >
        <DistributionTable
          rows={deptRows}
          firstColLabel="部门"
          linkPrefix="/employees/views/departments"
          linkQueryKey="departmentId"
          emptyText="暂无部门数据"
        />
        {unassignedDept ? (
          <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[12px] text-slate-500">
            另有 <b>{unassignedDept.total}</b> 名员工未分配部门
            （在职 {unassignedDept.active} / 离职 {unassignedDept.resigned}）。
            Excel 源数据只提供了「运营部」的部门归属，门店员工的部门未体现，系统不擅自填充。
            <Link href="/employees?departmentId=__none__" className="ml-1 text-brand-600 hover:underline">
              查看
            </Link>
          </div>
        ) : null}
      </Card>

      {/* ---- 岗位分布 ---- */}
      <Card
        title={`岗位分布（${posRows.length} 个岗位定义，其中 ${activePositionCount} 个在用）`}
        extra={
          <Link href="/settings/positions">
            <Button size="sm" variant="ghost">
              职位管理 →
            </Button>
          </Link>
        }
        bodyClassName="p-0"
      >
        <DistributionTable rows={posRows} firstColLabel="岗位 / 工种" emptyText="暂无岗位数据" />
        {unassignedPos ? (
          <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[12px] text-slate-500">
            另有 <b>{unassignedPos.total}</b> 名员工未分配岗位（Excel「工种级别」为空）。
          </div>
        ) : null}
        <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[11.5px] leading-relaxed text-slate-400">
          岗位名称取自 Excel「工种级别」的原始取值（如「青铜机修技师」），
          <b>未做名称归并</b>，以保证与源数据一致。需要更粗的口径时，
          可在职位管理中为岗位设置「大类」，后续阶段将支持按大类统计。
        </div>
      </Card>

      {/* ---- 口径说明 ---- */}
      <Card title="统计口径">
        <div className="grid gap-3 text-[12.5px] leading-relaxed text-slate-600 sm:grid-cols-3">
          <div>
            <Badge tone="green">在职</Badge>
            <p className="mt-1.5">
              <code>status = ACTIVE</code> 且未软删除。与「在职人员」视图口径完全一致。
            </p>
          </div>
          <div>
            <Badge tone="red">离职</Badge>
            <p className="mt-1.5">
              <code>status = RESIGNED</code>。含离职日期为空的历史记录（Excel 原文为文本，未能解析日期）。
            </p>
          </div>
          <div>
            <Badge tone="slate">未分配</Badge>
            <p className="mt-1.5">
              门店 / 部门 / 岗位字段为 null 的记录。系统<b>不使用 mock 数据填充</b>，留待 HR 维护。
            </p>
          </div>
        </div>
        <p className="mt-3 border-t border-[var(--hr-border)] pt-3 text-[11.5px] text-slate-400">
          接口：<code>GET /api/statistics?detail=1</code> —— 返回上述全部聚合数据（JSON）。
        </p>
      </Card>
    </div>
  );
}
