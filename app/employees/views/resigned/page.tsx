import PersonnelListView from "@/components/employees/PersonnelListView";
import { getDashboardStats } from "@/lib/employee-service";
import { Alert, StatCard } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /employees/views/resigned —— 离职人员
 * 替代 Excel「离职」Sheet。规则：status = RESIGNED。
 */
export default async function ResignedEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stats = await getDashboardStats();

  return (
    <PersonnelListView
      basePath="/employees/views/resigned"
      searchParams={sp}
      locked={{ status: "RESIGNED" }}
      title="离职人员"
      hint="替代 Excel「离职」Sheet —— 固定筛选 status = RESIGNED。展示原门店、职位、入职日期、离职日期与离职原因。"
      advanced
      emptyText="当前没有离职人员"
      labelOverrides={{ store: "原门店", position: "职位" }}
      columns={[
        "employeeId",
        "name",
        "store",
        "position",
        "hireDate",
        "resignDate",
        "resignReason",
      ]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="离职人数" value={stats.resigned} sub="含历史离职档案" tone="red" />
          <StatCard label="在职人数" value={stats.active} sub="当前在职" tone="green" />
          <StatCard label="员工总数" value={stats.total} sub="在职 + 离职" tone="blue" />
          <StatCard
            label="离职占比"
            value={stats.total ? `${Math.round((stats.resigned / stats.total) * 1000) / 10}%` : "0%"}
            sub="离职 / 总数"
            tone="slate"
          />
        </div>
      }
      footer={
        <Alert tone="warn">
          部分离职记录的<b>离职日期为空</b>——原因是 Excel「备注（离职日期）」列为自由文本
          （如「9/30已离职」），无法解析出具体日期。原文已完整保留在员工的
          <code>resignDateRaw</code> 字段中，可在员工详情页「离职信息」分组查看并人工补录。
        </Alert>
      }
    />
  );
}
