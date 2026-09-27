import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/other —— 其他员工
 *
 * Stage 9 起：这里显示的是**状态 = 其他**的员工（不再按门店 id 判定）。
 * 这批人有真实入职日期，但不在「在职 / 南昌3店 / 运营部 / 离职」任何一张表里，
 * 单独一张表管理，方便逐个确认归属；确认后在「更改员工状态」里改成对应状态即可。
 */
export default async function OtherEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const where = { status: "OTHER", deletedAt: null } as const;

  const count = await prisma.employee.count({ where });
  // 按原始门店名统计，看看这些人原本挂在哪
  const rawGroups = await prisma.employee.groupBy({
    by: ["storeNameRaw"],
    where,
    _count: { _all: true },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/other"
      searchParams={sp}
      locked={{ status: "OTHER" }}
      title="其他"
      hint="状态为「其他」的历史人员：有入职日期但不在现行的在职 / 南昌3店 / 运营部 / 离职任何一张表里。"
      advanced
      deletable
      emptyText="暂无状态为「其他」的员工"
      columns={[
        "name",
        "storeNameRaw",
        "position",
        "hireDate",
        "phone",
        "dormitory",
        "laborContract",
        "socialInsurancePurchased",
        "status",
      ]}
      header={
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="其他员工" value={count} sub="待确认归属" tone="amber" />
          <StatCard
            label="原始门店取值"
            value={rawGroups.length}
            sub="这些人在 Excel 里原本写的门店"
            tone="slate"
          />
        </div>
      }
      footer={
        <Card title="这批人需要你确认归属">
          <p className="mb-2 text-[12.5px] leading-relaxed text-slate-600">
            他们与其余员工一样存在员工库里，只是状态为「其他」。
            确认实际归属后，到「更改员工状态」里把状态改成
            <strong>已入职 / 离职 / 南昌3店 / 运营部 / 运营部离职</strong>，
            他们就会自动出现在对应的表里，并从本页消失。
          </p>
          {rawGroups.length > 0 ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1.5 text-[12px] font-medium text-slate-700">
                他们原本的门店原文分布：
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rawGroups
                  .filter((g) => g.storeNameRaw != null)
                  .sort((a, b) => b._count._all - a._count._all)
                  .map((g) => (
                    <span
                      key={g.storeNameRaw}
                      className="rounded bg-white px-2 py-0.5 text-[11.5px] text-slate-600 ring-1 ring-slate-200"
                    >
                      {g.storeNameRaw} · {g._count._all} 人
                    </span>
                  ))}
              </div>
            </div>
          ) : null}
        </Card>
      }
    />
  );
}
