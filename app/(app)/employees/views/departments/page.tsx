import Link from "next/link";
import { getDepartmentDistribution, getDepartmentSummary } from "@/lib/employee-service";
import { prisma } from "@/lib/prisma";
import { Alert, Button, Card, StatCard } from "@/components/ui";
import PersonnelListView from "@/components/employees/PersonnelListView";

export const dynamic = "force-dynamic";

/**
 * /employees/views/departments —— 部门人员查询
 * 替代 Excel「运营部」「运营部离职」Sheet。按 Department 查询。
 * 与门店视图同样：部门列表由 Department 表动态生成，不建独立页面。
 */
export default async function DepartmentPersonnelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rawId = Array.isArray(sp.departmentId) ? sp.departmentId[0] : sp.departmentId;
  const departmentId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

  // ---------- 未选择部门：部门总览 ----------
  if (!departmentId) {
    const [dist, deptCount] = await Promise.all([
      getDepartmentDistribution(),
      prisma.department.count({ where: { status: "ACTIVE" } }),
    ]);
    const depts = dist.filter((r) => r.id !== null);
    const unassigned = dist.find((r) => r.id === null);

    return (
      <div className="mx-auto max-w-[1400px] space-y-4">
        <Alert tone="info">
          部门清单由 <code>Department</code> 表动态生成，替代 Excel 的
          「运营部」「运营部离职」Sheet。可在
          <Link href="/settings/departments" className="mx-1 text-brand-600 underline">
            部门管理
          </Link>
          中新增 / 编辑 / 停用部门。
        </Alert>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="部门数量" value={deptCount} sub="启用中的部门" tone="amber" />
          <StatCard
            label="已归属部门的员工"
            value={depts.reduce((s, r) => s + r.total, 0)}
            sub="有 departmentId 的员工"
            tone="green"
          />
          <StatCard
            label="未分配部门"
            value={unassigned?.total ?? 0}
            sub="Excel 未提供其部门归属"
            tone="slate"
          />
          <StatCard label="本页部门数" value={depts.length} sub="含已停用部门" tone="blue" />
        </div>

        <Card title={`部门列表（${depts.length}）`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium">部门名称</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">在职</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">离职</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">合计</th>
                  <th className="px-4 py-2.5 font-medium w-[110px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {depts.map((r) => (
                  <tr key={r.key} className="text-[12.5px]">
                    <td className="px-4 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 tabular-nums text-emerald-700">{r.active}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{r.resigned}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">{r.total}</td>
                    <td className="px-4 py-2">
                      <Link href={`/employees/views/departments?departmentId=${r.id}`}>
                        <Button size="sm" variant="ghost">
                          查看人员 →
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
                {depts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-[12.5px] text-slate-400">
                      暂无部门数据
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

  // ---------- 已选择部门：部门详情 ----------
  const [department, summary] = await Promise.all([
    prisma.department.findUnique({
      where: { id: departmentId },
      select: {
        id: true,
        name: true,
        code: true,
        deptType: true,
        managerName: true,
        remark: true,
        _count: { select: { employees: true } },
      },
    }),
    getDepartmentSummary(departmentId),
  ]);

  if (!department) {
    return (
      <div className="mx-auto max-w-[1000px]">
        <Alert tone="error">
          部门不存在（id={departmentId}）。请返回{" "}
          <Link href="/employees/views/departments" className="underline">
            部门列表
          </Link>{" "}
          重新选择。
        </Alert>
      </div>
    );
  }

  const maxActive = Math.max(1, ...summary.positionDistribution.map((p) => p.active));

  return (
    <PersonnelListView
      basePath="/employees/views/departments"
      searchParams={sp}
      locked={{ departmentId: String(departmentId) }}
      title={`${department.name} · 人员列表`}
      hint={`当前部门：${department.name}。部门由 URL 参数 departmentId 决定，页面本身只有一个。`}
      advanced
      emptyText="该部门暂无员工记录"
      columns={["employeeId", "name", "position", "hireDate", "phone", "status", "resignDate", "resignReason"]}
      header={
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/employees/views/departments">
              <Button size="sm">← 部门列表</Button>
            </Link>
            <h2 className="text-[15px] font-semibold">{department.name}</h2>
            {department.code ? (
              <span className="text-[11.5px] text-slate-400">编码 {department.code}</span>
            ) : null}
            {department.deptType ? (
              <span className="text-[11.5px] text-slate-400">类型 {department.deptType}</span>
            ) : null}
            {department.managerName ? (
              <span className="text-[11.5px] text-slate-400">负责人 {department.managerName}</span>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="部门总人数" value={summary.total} sub="含离职" tone="blue" />
            <StatCard label="在职人数" value={summary.active} sub="status = ACTIVE" tone="green" />
            <StatCard label="离职人数" value={summary.resigned} sub="status = RESIGNED" tone="red" />
            <StatCard
              label="岗位数量"
              value={summary.positionDistribution.filter((p) => p.id !== null).length}
              sub="该部门出现的岗位数"
              tone="amber"
            />
          </div>

          <Card title="岗位分布（该部门）">
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
          </Card>
        </div>
      }
    />
  );
}
