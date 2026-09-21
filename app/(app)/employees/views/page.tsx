import Link from "next/link";
import { getDashboardStats, getStoreDistribution, getDepartmentDistribution } from "@/lib/employee-service";
import { Button, Card, StatCard, Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /employees/views —— 人员视图总览（第二阶段）
 *
 * 替代 Excel 中的分表视图：在职 / 离职 / 各门店 / 运营部 / 人员分布明细。
 * 全部数据实时来自 Employee 表，不复制员工数据、不使用 mock。
 */
export default async function ViewsOverviewPage() {
  const [stats, storeDist, deptDist] = await Promise.all([
    getDashboardStats(),
    getStoreDistribution(),
    getDepartmentDistribution(),
  ]);

  const storeRows = storeDist.filter((r) => r.id !== null);
  const deptRows = deptDist.filter((r) => r.id !== null);
  const unassignedDept = deptDist.find((r) => r.id === null);

  const VIEWS = [
    {
      href: "/employees/views/active",
      title: "在职人员",
      replaces: "Excel「在职」Sheet",
      value: stats.active,
      unit: "人",
      tone: "green" as const,
      desc: "status = ACTIVE 的全部员工，支持搜索与筛选。",
    },
    {
      href: "/employees/views/resigned",
      title: "离职人员",
      replaces: "Excel「离职」Sheet",
      value: stats.resigned,
      unit: "人",
      tone: "red" as const,
      desc: "status = RESIGNED，含离职日期与离职原因。",
    },
    {
      href: "/employees/views/stores",
      title: "门店人员查询",
      replaces: "Excel 各门店 Sheet（南昌3店 等）",
      value: stats.storeCount,
      unit: "家门店",
      tone: "blue" as const,
      desc: "按 Store 表动态生成，不建独立页面。",
    },
    {
      href: "/employees/views/departments",
      title: "部门人员查询",
      replaces: "Excel「运营部」「运营部离职」Sheet",
      value: stats.departmentCount,
      unit: "个部门",
      tone: "amber" as const,
      desc: "按 Department 查询部门人数与岗位分布。",
    },
    {
      href: "/employees/views/distribution",
      title: "人员分布统计",
      replaces: "Excel「人员分布明细」「人员流失率」Sheet",
      value: stats.total,
      unit: "人",
      tone: "slate" as const,
      desc: "总人数 / 各门店 / 各部门 / 岗位数量实时统计。",
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        本模块把原 Excel 的<b>分表视图</b>软件化。所有页面都直接查询 <code>Employee</code> 表
        ——<b>不复制员工数据、不生成新的员工表、不使用 mock 数据</b>。
        员工状态、门店、部门的任何改动会立刻反映到全部视图中。
      </Alert>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="员工总数" value={stats.total} sub="实时来自数据库" tone="blue" />
        <StatCard label="在职人数" value={stats.active} sub={`占比 ${stats.activeRate}%`} tone="green" />
        <StatCard label="离职人数" value={stats.resigned} sub="含历史离职档案" tone="red" />
        <StatCard label="门店数量" value={stats.storeCount} sub="启用中的门店" tone="slate" />
        <StatCard label="部门 / 岗位" value={`${stats.departmentCount} / ${stats.positionCount}`} sub="部门数 / 岗位数" tone="amber" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {VIEWS.map((v) => (
          <Link key={v.href} href={v.href} className="group">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold text-slate-800">{v.title}</h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">替代 {v.replaces}</p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[22px] font-semibold leading-none tabular-nums">{v.value}</div>
                  <div className="text-[11px] text-slate-400">{v.unit}</div>
                </div>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-slate-500">{v.desc}</p>
              <div className="mt-3 text-[12px] font-medium text-brand-600 group-hover:underline">
                进入查看 →
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={`门店人数 Top 10（共 ${storeRows.length} 家）`}
          extra={
            <Link href="/employees/views/stores">
              <Button size="sm" variant="ghost">
                查看全部 →
              </Button>
            </Link>
          }
          bodyClassName="p-0"
        >
          <table className="grid-table">
            <thead>
              <tr className="text-left text-[11.5px] text-slate-500">
                <th className="px-4 py-2 font-medium">门店</th>
                <th className="px-3 py-2 font-medium w-[76px]">在职</th>
                <th className="px-3 py-2 font-medium w-[76px]">离职</th>
                <th className="px-3 py-2 font-medium w-[76px]">合计</th>
              </tr>
            </thead>
            <tbody>
              {storeRows.slice(0, 10).map((r) => (
                <tr key={r.key} className="text-[12.5px]">
                  <td className="px-4 py-2">
                    <Link
                      href={`/employees/views/stores?storeId=${r.id}`}
                      className="hover:text-brand-600 hover:underline"
                    >
                      {r.label}
                    </Link>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-emerald-700">{r.active}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{r.resigned}</td>
                  <td className="px-3 py-2 font-medium tabular-nums">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title={`部门人数（共 ${deptRows.length} 个部门）`} bodyClassName="p-0">
          {deptRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12.5px] text-slate-400">
              暂无部门数据
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2 font-medium">部门</th>
                  <th className="px-3 py-2 font-medium w-[76px]">在职</th>
                  <th className="px-3 py-2 font-medium w-[76px]">离职</th>
                  <th className="px-3 py-2 font-medium w-[76px]">合计</th>
                </tr>
              </thead>
              <tbody>
                {deptRows.map((r) => (
                  <tr key={r.key} className="text-[12.5px]">
                    <td className="px-4 py-2">
                      <Link
                        href={`/employees/views/departments?departmentId=${r.id}`}
                        className="hover:text-brand-600 hover:underline"
                      >
                        {r.label}
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-emerald-700">{r.active}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{r.resigned}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">{r.total}</td>
                  </tr>
                ))}
                {unassignedDept ? (
                  <tr className="text-[12.5px] text-slate-400">
                    <td className="px-4 py-2">未分配部门（门店员工）</td>
                    <td className="px-3 py-2 tabular-nums">{unassignedDept.active}</td>
                    <td className="px-3 py-2 tabular-nums">{unassignedDept.resigned}</td>
                    <td className="px-3 py-2 tabular-nums">{unassignedDept.total}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
          <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[11.5px] leading-relaxed text-slate-400">
            Excel 只提供了「运营部」的部门归属，门店员工的部门未在源数据中体现，
            因此系统不擅自填充。HR 可在员工编辑页为门店员工指定部门。
          </div>
        </Card>
      </div>
    </div>
  );
}
