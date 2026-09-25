import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/candidates —— 候选人（只面试未入职）
 * 对应 Excel「招聘面试登记表」中「是否入职 = 否」的人。
 *
 * 这些人在 Stage 7.3 之前被误导入为在职员工，现已改回 status = CANDIDATE。
 * 若其中有人后来入职，直接把状态改成 ACTIVE 并补齐门店/入职日期即可。
 */
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const count = await prisma.employee.count({
    where: { status: "CANDIDATE", deletedAt: null },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/candidates"
      searchParams={sp}
      locked={{ status: "CANDIDATE" }}
      title="候选人（只面试未入职）"
      hint="对应 Excel「招聘面试登记表」中「是否入职 = 否」的人 —— 固定 status = CANDIDATE。"
      advanced
      deletable
      emptyText="当前没有候选人"
      columns={[
        "name",
        "phone",
        "position",
        "store",
        "hireDate",
        "remark",
        "status",
      ]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="候选人" value={count} sub="只面试、未入职" tone="amber" />
          <StatCard
            label="说明"
            value="—"
            sub="入职后把状态改成在职"
            tone="slate"
          />
        </div>
      }
      footer={
        <Card title="关于候选人">
          <p className="text-[12.5px] leading-relaxed text-slate-600">
            这些人在 2026-09-19 首次导入时被误当成了在职员工（因为「招聘面试登记表」
            里也有一列姓名，导入脚本没有区分「是否入职」）。
            Stage 7.3 已按「是否入职 = 否」把 {count} 人改回候选人状态。
            <br />
            <br />
            <strong>如果某位候选人后来入职了</strong>：点进详情页把状态改成「在职」，
            再补上门店和入职日期，他就会出现在
            <a className="underline" href="/employees/views/active">
              在职员工
            </a>{" "}
            页。
          </p>
        </Card>
      }
    />
  );
}
