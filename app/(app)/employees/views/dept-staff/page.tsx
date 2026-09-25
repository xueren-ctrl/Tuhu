import PersonnelListView from "@/components/employees/PersonnelListView";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/views/dept-staff —— 运营部（公司管理层）
 * 对应 Excel「运营部」Sheet（离职的在「运营部离职」Sheet）。
 *
 * 与门店员工不同：运营部是公司的人，不属于任何门店。
 * Stage 2 已把这 18 人从 Store 迁到了 Department。
 */
export default async function DeptStaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // 找「运营部」部门
  const dept = await prisma.department.findFirst({
    where: { name: "运营部" },
    select: { id: true, name: true },
  });

  if (!dept) {
    return (
      <div className="mx-auto max-w-[1500px]">
        <Card title="尚未建立「运营部」部门">
          <p className="text-[13px] text-slate-600">
            运营部人员属于公司管理层，不挂在任何门店下。数据库里还没有「运营部」这个部门。
          </p>
        </Card>
      </div>
    );
  }

  const activeCount = await prisma.employee.count({
    where: { departmentId: dept.id, status: "ACTIVE", deletedAt: null },
  });
  const resignedCount = await prisma.employee.count({
    where: { departmentId: dept.id, status: "RESIGNED", deletedAt: null },
  });

  return (
    <PersonnelListView
      basePath="/employees/views/dept-staff"
      searchParams={sp}
      locked={{ departmentId: String(dept.id) }}
      title="运营部（公司管理层）"
      hint="对应 Excel「运营部」Sheet —— 这批人是公司的人，不属于任何门店。"
      advanced
      deletable
      emptyText="运营部暂无人员"
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
          <StatCard label="运营部在职" value={activeCount} sub="公司管理层" tone="green" />
          <StatCard label="运营部离职" value={resignedCount} sub="历史" tone="slate" />
        </div>
      }
      footer={
        <Card title="运营部 vs 门店员工">
          <p className="text-[12.5px] leading-relaxed text-slate-600">
            按你的说明：
            <br />
            · <strong>「在职」+「南昌3店」</strong> 两张表里的人 ={" "}
            <strong>途虎门店职员</strong>
            <br />
            · <strong>「运营部」</strong> 里的人 ={" "}
            <strong>公司人员</strong>（相当于管理层面）
            <br />
            <br />
            所以运营部的人不挂门店，只挂部门。这里可以直接增删改查他们的资料。
          </p>
        </Card>
      }
    />
  );
}
