import PersonnelListView from "@/components/employees/PersonnelListView";
import { getDashboardStats } from "@/lib/employee-service";
import { Card, StatCard } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /employees/views/active —— 在职人员
 * 替代 Excel「在职」Sheet。规则：status = ACTIVE（在 URL 中锁定，不可被覆盖）。
 */
export default async function ActiveEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stats = await getDashboardStats();

  return (
    <PersonnelListView
      basePath="/employees/views/active"
      searchParams={sp}
      locked={{ status: "ACTIVE" }}
      title="在职人员"
      hint="替代 Excel「在职」Sheet —— 固定筛选 status = ACTIVE。员工状态改为离职后会自动从此列表消失。"
      advanced
      emptyText="当前没有在职人员"
      labelOverrides={{ resignReason: "离职原因" }}
      columns={[
        "employeeId",
        "name",
        "gender",
        "age",
        "store",
        "department",
        "position",
        "hireDate",
        "phone",
        "status",
      ]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="在职人数" value={stats.active} sub={`占全员 ${stats.activeRate}%`} tone="green" />
          <StatCard label="全部门店" value={stats.storeCount} sub="在职员工分布的门店数" tone="blue" />
          <StatCard label="部门数量" value={stats.departmentCount} sub="已建立的部门" tone="amber" />
          <StatCard label="岗位数量" value={stats.positionCount} sub="已建立的岗位" tone="slate" />
        </div>
      }
      footer={
        <Card title="导出接口（预留）">
          <p className="text-[12.5px] leading-relaxed text-slate-500">
            本页数据可通过接口导出：{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11.5px]">
              GET /api/employees?status=ACTIVE&amp;pageSize=200
            </code>
            。第一阶段的 Excel 导出模板（<code>templates/</code>）已预留，
            正式导出功能按需求书安排在后续阶段实现。
          </p>
        </Card>
      }
    />
  );
}
