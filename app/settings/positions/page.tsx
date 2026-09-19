import { Alert } from "@/components/ui";
import PositionManager from "@/components/settings/PositionManager";

export const dynamic = "force-dynamic";

/** /settings/positions 职位管理 */
export default function PositionsPage() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        员工的职位字段以后优先从这里选择。Excel 中「工种级别」的历史取值
        （如「青铜机修技师」）会完整保留在员工的 <code>jobGradeRaw</code> 字段中，
        不会被这里的标准职位名覆盖。
      </Alert>
      <PositionManager />
    </div>
  );
}
