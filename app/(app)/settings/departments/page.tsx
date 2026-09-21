import { Alert } from "@/components/ui";
import DepartmentManager from "@/components/settings/DepartmentManager";

export const dynamic = "force-dynamic";

/** /settings/departments 部门管理 */
export default function DepartmentsPage() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        部门的初始数据来自 Excel 的「运营部」「运营部离职」Sheet —— 这两个表描述的是
        <b>部门</b>而非门店，因此第二阶段把它们从门店中独立出来（原来「运营部」被误当成一家门店）。
        门店员工的部门归属在 Excel 源数据中不存在，系统<b>不会用 mock 数据填充</b>，
        可在员工编辑页逐个指定。
      </Alert>
      <DepartmentManager />
    </div>
  );
}
