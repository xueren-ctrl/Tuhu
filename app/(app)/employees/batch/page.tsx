import { Alert } from "@/components/ui";
import BatchEditPanel from "@/components/employees/BatchEditPanel";
import { getSelectOptions } from "@/lib/settings-service";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * /employees/batch 批量编辑（第三阶段）
 *
 * 用法：先按条件筛出员工（部门为空 / 岗位为空 / 门店为空），
 * 再批量设置部门 / 岗位 / 门店。修改后所有人员视图立即同步
 * （它们都是实时查询，没有任何缓存或中间表）。
 */
export default async function BatchEditPage({ searchParams }: Props) {
  const sp = await searchParams;
  const preset = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const options = await getSelectOptions();

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="warn">
        批量修改影响面大，请<strong>先点「预览命中员工」确认名单</strong>再提交。
        <br />
        为了安全，本工具<strong>只能改门店 / 部门 / 岗位</strong>三个归属字段
        —— 在职状态、入职离职日期、身份证与银行卡信息都不参与批量修改。
        每一次修改都会逐条写入<strong>员工变更记录</strong>（含修改前 / 修改后 / 时间 / 操作人）。
      </Alert>
      <BatchEditPanel
        stores={options.stores}
        departments={options.departments}
        positions={options.positions}
        preset={preset}
      />
    </div>
  );
}
