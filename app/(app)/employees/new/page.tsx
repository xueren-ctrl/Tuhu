import Link from "next/link";
import { getSelectOptions } from "@/lib/settings-service";
import { Alert, Button } from "@/components/ui";
import EmployeeForm from "@/components/employees/EmployeeForm";

export const dynamic = "force-dynamic";

/** /employees/new 新增员工 */
export default async function NewEmployeePage() {
  const options = await getSelectOptions();

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12.5px] text-slate-500">
          填写完成后保存，系统会：
          <span className="text-slate-700">
            ① 自动生成 employee_id　② 写入 SQLite　③ 员工列表立即显示　④ 后续页面可直接查询该员工
          </span>
        </div>
        <Link href="/employees">
          <Button size="sm">← 返回员工档案</Button>
        </Link>
      </div>

      <Alert tone="info">
        门店与职位优先从<strong>基础设置</strong>中选择；若 Excel 历史取值不在主数据中，
        可填写「Excel 原文」字段原样保留，不会被覆盖。
      </Alert>

      <EmployeeForm
        mode="create"
        stores={options.stores}
        departments={options.departments}
        positions={options.positions}
      />
    </div>
  );
}
