import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/candidates —— 已面试（还没入职）
 *
 * Stage 9：状态改为 INTERVIEWED，对应 Excel「招聘面试登记表」中「是否入职 = 否」的人。
 * 这类人只出现在「招聘面试登记表」这一张表里。
 * 入职后到「更改员工状态」把状态改成 已入职 / 南昌3店 / 运营部，即可进入对应表。
 */
export default async function InterviewedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const count = await prisma.employee.count({
    where: { status: "INTERVIEWED", deletedAt: null },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/candidates"
      searchParams={sp}
      locked={{ status: "INTERVIEWED" }}
      title="已面试（未入职）"
      hint="对应「招聘面试登记表」中还没入职的人 —— 状态固定为「已面试」，只出现在招聘面试登记表。"
      advanced
      deletable
      emptyText="当前没有已面试未入职的人"
      columns={["name", "phone", "position", "store", "hireDate", "remark", "status"]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="已面试" value={count} sub="面试过、还没入职" tone="amber" />
          <StatCard
            label="出现在"
            value="招聘面试登记表"
            sub="改状态后会自动进入在职 / 离职等表"
            tone="slate"
          />
        </div>
      }
      footer={
        <Card title="关于「已面试」">
          <p className="text-[12.5px] leading-relaxed text-slate-600">
            这批人来自「招聘面试登记表」，面试过但还没有入职记录。
            他们只出现在<strong>招聘面试登记表</strong>，不会进入在职 / 薪资等表。
            一旦确认入职，到「更改员工状态」把状态改成
            <strong>已入职 / 南昌3店 / 运营部</strong>，补齐门店与入职日期后即进入对应表。
          </p>
        </Card>
      }
    />
  );
}
