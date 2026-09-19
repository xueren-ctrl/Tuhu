import Link from "next/link";
import { notFound } from "next/navigation";
import { getEmployeeById } from "@/lib/employee-service";
import { getSelectOptions } from "@/lib/settings-service";
import { Alert, Button } from "@/components/ui";
import EmployeeForm from "@/components/employees/EmployeeForm";

export const dynamic = "force-dynamic";

/** /employees/[id]/edit 编辑员工 */
export default async function EditEmployeePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) notFound();

  const [employee, options] = await Promise.all([
    getEmployeeById(numId),
    getSelectOptions(),
  ]);
  if (!employee) notFound();

  const e = employee as Record<string, unknown>;

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12.5px] text-slate-500">
          正在编辑：
          <span className="font-medium text-slate-800">{String(e.name)}</span>
          <span className="ml-2 font-mono text-[11.5px] text-slate-400">
            {String(e.employeeId)}
          </span>
        </div>
        <div className="flex gap-2">
          <Link href={`/employees/${numId}`}>
            <Button size="sm">← 返回详情</Button>
          </Link>
          <Link href="/employees">
            <Button size="sm" variant="ghost">
              员工档案列表
            </Button>
          </Link>
        </div>
      </div>

      {e.deletedAt ? (
        <Alert tone="warn">
          该员工档案已<strong>停用</strong>（软删除）。修改并保存不会自动恢复，
          如需恢复请到列表页点击「恢复」。
        </Alert>
      ) : null}

      <EmployeeForm
        mode="edit"
        stores={options.stores}
        departments={options.departments}
        positions={options.positions}
        initial={employee as unknown as Record<string, unknown>}
      />
    </div>
  );
}
