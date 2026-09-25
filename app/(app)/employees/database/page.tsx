import PersonnelListView from "@/components/employees/PersonnelListView";
import type { ViewColumnKey } from "@/components/employees/EmployeeViewTable";
import { Card, StatCard } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/database —— 「数据库」全表
 *
 * 对应 Excel「数据库」Sheet：所有历史数据 + 全部字段，一行一条任职记录。
 * 这是整个系统最完整的一张表 —— 其他 Sheet（在职/离职/南昌3店/运营部…）都是它的子集视图。
 */

/** 「数据库」全表列：与 Excel「数据库」Sheet 的字段顺序一致 */
const DB_COLUMNS: ViewColumnKey[] = [
  "employeeId",
  "name",
  "storeNameRaw",
  "hireDate",
  "resignDateRaw",
  "jobGradeRaw",
  "gender",
  "ageRaw",
  "idCardNo",
  "phone",
  "status",
  "currentAddress",
  "emergencyContact1",
  "emergencyPhone1",
  "emergencyContact2",
  "emergencyPhone2",
  "mentorName",
  "dormitory",
  "socialInsurancePurchased",
  "salaryTerms",
  "firstMonthGuarantee",
  "bankBranch",
  "bankAccountNo",
  "laborContract",
  "socialInsuranceAgreement",
  "fireSafetyCommitment",
  "dormitoryWaiver",
  "onboardingMedical",
  "positionNote",
  "certificateLevel",
  "recruiterName",
  "resignReason",
  "remark",
  "remark3",
  "sourceRowNo",
  "createdAt",
];

export default async function DatabasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const [total, active, resigned, candidate, deleted] = await Promise.all([
    prisma.employee.count({ where: { deletedAt: null } }),
    prisma.employee.count({ where: { status: "ACTIVE", deletedAt: null } }),
    prisma.employee.count({ where: { status: "RESIGNED", deletedAt: null } }),
    prisma.employee.count({ where: { status: "CANDIDATE", deletedAt: null } }),
    prisma.employee.count({ where: { deletedAt: { not: null } } }),
  ]);

  return (
    <PersonnelListView
      basePath="/employees/database"
      searchParams={sp}
      title="数据库（全表）"
      hint="对应 Excel「数据库」Sheet —— 全部历史数据、全部字段，一行一条任职记录。其他表都是这张表的子集。"
      advanced
      deletable
      columns={DB_COLUMNS}
      header={
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="全部记录" value={total} sub="一行一条任职记录" />
          <StatCard label="在职" value={active} />
          <StatCard label="离职" value={resigned} />
          <StatCard label="候选人" value={candidate} sub="只面试未入职" />
          <StatCard label="已软删" value={deleted} sub="不在权威表内" />
        </div>
      }
      footer={
        <Card className="mt-3">
          <p className="text-[12px] leading-relaxed text-slate-500">
            <strong className="text-slate-700">说明：</strong>
            这张表是软件的数据源，与 Excel「数据库」Sheet 内容一致。
            其他表（在职 / 离职 / 南昌3店 / 运营部 / 其他 / 候选人）都是这张表按不同条件筛出来的视图。
            <br />
            点姓名或员工编号可以进入详情页修改；支持搜索、筛选、排序、软删除。
          </p>
        </Card>
      }
    />
  );
}
