import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard, Alert } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/nc3 —— 南昌3店
 * 对应 Excel「南昌3店」Sheet。
 *
 * 该 Sheet 覆盖 3 家门店：南昌抚河中路店 / 南昌崇仁人民大道店 / 抚州乐安新二中店
 * （都属于南昌 / 抚州片区，合称「南昌3店」）。
 *
 * ⚠️ 注意：新表「南昌3店」Sheet 从第 20 列起**整列右移了一格**
 * （「入职体检」列实际存的是开户银行名、「开户银行支行」列实际存的是银行卡号）。
 * 软件读的是数据库（数据库的值是对的），不受这个错位影响。
 */
const NC3_STORES = ["南昌抚河中路店", "南昌崇仁人民大道店", "抚州乐安新二中店"];

export default async function Nc3Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const stores = await prisma.store.findMany({
    where: { name: { in: NC3_STORES } },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });

  // 统计这 3 家门店的在职人数
  const counts: Record<string, number> = {};
  for (const s of stores) {
    counts[s.name] = await prisma.employee.count({
      where: { storeId: s.id, status: "ACTIVE", deletedAt: null },
    });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PersonnelListView
        basePath="/employees/views/nc3"
        searchParams={sp}
        locked={{ status: "ACTIVE", storeIds: stores.map((s) => s.id).join(",") }}
        title="南昌3店（在职）"
        hint="对应 Excel「南昌3店」Sheet —— 覆盖南昌抚河中路店 / 南昌崇仁人民大道店 / 抚州乐安新二中店三家门店的在职人员。"
        advanced
        deletable
        emptyText="这三家门店暂无在职人员"
        columns={[
          "name",
          "store",
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
            <StatCard label="南昌3店在职" value={total} sub="三家门店合计" tone="green" />
            {stores.slice(0, 3).map((s) => (
              <StatCard
                key={s.id}
                label={s.name}
                value={counts[s.name] ?? 0}
                sub="在职人数"
                tone="blue"
              />
            ))}
          </div>
        }
        footer={
          <Card title="关于这张表">
            <p className="mb-2 text-[12.5px] leading-relaxed text-slate-600">
              这里显示的是<strong>三家门店的全部在职人员</strong>。如果你只想看其中一家，
              用上方的「门店」筛选器选一下即可。
            </p>
            <Alert tone="info">
              <p className="mb-1 text-[12px] font-medium">
                新表「南昌3店」的列错位（已规避）
              </p>
              <p className="text-[12px] leading-relaxed">
                原始 Excel 的「南昌3店」Sheet 从第 20 列起整列右移了一格 ——
                「入职体检」列里存的是<strong>开户银行名</strong>，
                「工资卡的开户银行支行」列里存的是<strong>银行卡号</strong>。
                <br />
                Stage 7.3 修正那 7 位员工时已经避开这个错位（只用 10~19 列）。
                软件读的是数据库，值本身是对的，不受影响。
              </p>
            </Alert>
          </Card>
        }
      />
    </>
  );
}
