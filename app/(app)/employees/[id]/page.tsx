import { notFound } from "next/navigation";
import { getEmployeeById } from "@/lib/employee-service";
import { listEmployeeHistory } from "@/lib/history-service";
import { Alert } from "@/components/ui";
import EmployeeDetail from "@/components/employees/EmployeeDetail";

export const dynamic = "force-dynamic";

/** /employees/[id] 员工详情 */
export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) notFound();

  const employee = await getEmployeeById(numId);
  if (!employee) notFound();

  // 变更记录（第三阶段）：每次修改自动留痕
  const history = await listEmployeeHistory(numId);

  return (
    <div className="mx-auto max-w-[1300px] space-y-4">
      {saved === "1" ? (
        <Alert tone="success">
          员工已成功写入数据库，员工编号已自动生成。下方数据来自数据库实时查询。
        </Alert>
      ) : null}
      <EmployeeDetail
        employee={employee as unknown as Record<string, unknown>}
        history={history}
      />
    </div>
  );
}
