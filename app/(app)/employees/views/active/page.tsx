import PersonnelListView from "@/components/employees/PersonnelListView";
import { getDashboardStats } from "@/lib/employee-service";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/active —— 在职人员（Stage 7.3 主视图）
 *
 * 替代 Excel「在职」Sheet。规则：status = ACTIVE（在 URL 中锁定，不可被覆盖）。
 * 表中 7 个「是否」字段（是否住宿舍 / 社保购买 / 劳动合同 / 社保协议 /
 * 消防承诺书 / 宿舍免责协议 / 入职体检）可直接在下拉里改成 是 / 否 / 留空，
 * 无需进入详情页。
 *
 * Stage 7.3.1：**排除「其他」门店**。那里是「有入职记录但不在三张当前在职表里」的
 * 待确认人员，只该出现在「其他员工」页，不该混在正常在职列表中。
 */
export default async function ActiveEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stats = await getDashboardStats();

  // 「其他」门店 id（若存在则从本页排除）
  const other = await prisma.store.findFirst({
    where: { name: "其他" },
    select: { id: true },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/active"
      searchParams={sp}
      locked={{ status: "ACTIVE" }}
      hiddenLocked={other ? { excludeStoreIds: String(other.id) } : {}}
      title="在职员工"
      hint="对应 Excel「在职」+「南昌3店」+「运营部」三张表 —— 固定 status = ACTIVE。表中的「是否」字段可直接用下拉改成 是 / 否 / 留空。"
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
            value={stats.active}
            sub={`占全员 ${stats.activeRate}%`}
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
