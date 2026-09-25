import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/other —— 其他员工
 *
 * Stage 7.3 新建：这批人有**真实入职日期**，但不在新表的
 * 「在职」/「南昌3店」/「运营部」三张表里，也不在「离职」表里。
 * 多数集中在「骏达中路」「常马路」等门店。
 * 归到一个叫「其他」的门店（id=434）下单独管理，方便你逐个确认归属。
 */
export default async function OtherEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // 找「其他」门店（Stage 7.3 创建）
  const other = await prisma.store.findFirst({
    where: { name: "其他" },
    select: { id: true, name: true },
  });

  if (!other) {
    return (
      <div className="mx-auto max-w-[1500px]">
        <Card title="「其他」门店尚未建立">
          <p className="text-[13px] text-slate-600">
            Stage 7.3 会把「有入职日期但不在三张当前在职表里」的历史员工归入一个叫「其他」的门店。
            当前数据库里还没有这个门店，说明还没执行那一步。
          </p>
        </Card>
      </div>
    );
  }

  const count = await prisma.employee.count({
    where: { storeId: other.id, deletedAt: null },
  });
  // 按原始门店名统计，看看这些人原本挂在哪
  const rawGroups = await prisma.employee.groupBy({
    by: ["storeNameRaw"],
    where: { storeId: other.id, deletedAt: null },
    _count: { _all: true },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/other"
      searchParams={sp}
      locked={{ storeId: String(other.id) }}
      title="其他员工"      hint="有真实入职日期、但不在「在职 / 南昌3店 / 运营部」三张当前在职表里、也不在离职表里的历史员工。"
      advanced
      deletable
      emptyText="「其他」门店下暂无员工"
      columns={[
        "name",
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
            这些员工有真实的入职日期（2019~2023 年），说明确实入职过，
            但新表的「在职 / 南昌3店 / 运营部」里都没有他们，「离职」表里也没有。
            Stage 7.3 先把他们统一归到「其他」门店，避免误标成离职。
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
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
                确认他们分别属于哪家现行门店后，直接在表格里改「门店」列即可；
                改完他们就会从本页移到对应门店的在职列表里。
              </p>
            </div>
          ) : null}
        </Card>
      }
    />
  );
}
