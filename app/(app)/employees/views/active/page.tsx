import PersonnelListView from "@/components/employees/PersonnelListView";
import { getDashboardStats } from "@/lib/employee-service";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/active —— 在职人员
 *
 * Stage 9 起：**status = 已入职** 就是这一页，与「在职」表完全一致（URL 中锁定，不可覆盖）。
 * 南昌3店 / 运营部 / 其他 / 离职 各有自己的状态与页面，不会再混进来。
 * 表中 7 个「是否」字段（是否住宿舍 / 社保购买 / 劳动合同 / 社保协议 /
 * 消防承诺书 / 宿舍免责协议 / 入职体检）可直接在下拉里改成 是 / 否 / 留空。
 */
export default async function ActiveEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stats = await getDashboardStats();

  const activeCount = await prisma.employee.count({
    where: { status: "ACTIVE", deletedAt: null },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/active"
      searchParams={sp}
      locked={{ status: "ACTIVE" }}
      title="在职员工"
      hint="对应「在职」表 —— 状态固定为「已入职」。南昌3店 / 运营部 / 其他各自单独成页。表中的「是否」字段可直接用下拉改成 是 / 否 / 留空。"
      advanced
      deletable
      emptyText="当前没有在职人员"
      labelOverrides={{ resignReason: "离职原因" }}
      columns={[
        "name",
        "store",
        "department",
        "position",
        "hireDate",
        "phone",
        "dormitory",
        "socialInsurancePurchased",
        "laborContract",
        "socialInsuranceAgreement",
        "fireSafetyCommitment",
        "dormitoryWaiver",
        "onboardingMedical",
        "status",
      ]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="在职人数"
            value={activeCount}
            sub="对应 Excel「在职」Sheet"
            tone="green"
          />
          <StatCard
            label="全部门店"
            value={stats.storeCount}
            sub="在职员工分布的门店数"
            tone="blue"
          />
          <StatCard
            label="部门数量"
            value={stats.departmentCount}
            sub="已建立的部门"
            tone="amber"
          />
          <StatCard
            label="岗位数量"
            value={stats.positionCount}
            sub="已建立的岗位"
            tone="slate"
          />
        </div>
      }
      footer={
        <Card title="怎么用这一页">
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-600">
            <li>
              <strong>改「是否」字段</strong>：直接在表格里的下拉选
              <code className="rounded bg-slate-100 px-1 text-[11px]">是 / 否 /（空）</code>
              ，保存后自动刷新，不用进详情页。
            </li>
            <li>
              <strong>历史第三态</strong>：像「在职」「外宿」「新增人员」「实习」
              这类旧值会以黄色「历史：xxx」显示，原样保留，可随时改成 是/否/空。
            </li>
            <li>
              <strong>改其他资料</strong>：点员工姓名进详情页，或用右上角
              <code className="rounded bg-slate-100 px-1 text-[11px]">＋ 新增员工</code>{" "}
              新建。
            </li>
            <li>
              <strong>离职</strong>：把状态改成离职，员工会从本页消失并出现在
              <a className="underline" href="/employees/views/resigned">
                离职人员
              </a>{" "}
              页。
            </li>
          </ul>
        </Card>
      }
    />
  );
}
