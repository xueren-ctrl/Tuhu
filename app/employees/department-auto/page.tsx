import { Alert } from "@/components/ui";
import DepartmentAutoPanel from "@/components/employees/DepartmentAutoPanel";
import { getSelectOptions } from "@/lib/settings-service";

export const dynamic = "force-dynamic";

/**
 * /employees/department-auto 部门自动归属（第四阶段）
 *
 * Excel 源数据里没有部门信息（1902 人空着），靠人一条条点不现实，
 * 所以按规则生成推荐 → 预览影响人数 → 确认后批量更新。
 */
export default async function DepartmentAutoPage() {
  const options = await getSelectOptions();

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        用规则把「什么样的人归到哪个部门」描述清楚，系统据此<strong>生成推荐</strong>
        —— 你可以先看会改多少人、改的是谁，确认后再批量写入。
        <br />
        <strong>规则不会自动生效</strong>，必须在本页点「确认批量更新部门」才会写入，
        且每一次修改都会进入员工的变更记录。
      </Alert>
      <Alert tone="warn">
        关于「员工类型」：源数据里<strong>没有独立的员工类型字段</strong>，
        因此这一维按「工种级别原文包含该文本」匹配（例如填「店长」可命中「技术店长」「副店长」）。
        如果确实需要独立的员工类型，需要先在源数据里补这一列。
      </Alert>
      <DepartmentAutoPanel
        stores={options.stores}
        departments={options.departments}
        positions={options.positions}
      />
    </div>
  );
}
