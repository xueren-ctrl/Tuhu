import { Alert } from "@/components/ui";
import StoreMergePanel from "@/components/stores/StoreMergePanel";
import { findMergeClusters } from "@/lib/store-merge-service";

export const dynamic = "force-dynamic";

/**
 * /stores/merge 门店合并（第四阶段）
 *
 * 把疑似同一家店的多条门店记录合并到一条主门店名下。
 * 四条底线：只改 Employee.storeId / 不删员工 / 保留别名 / 生成变更记录。
 */
export default async function StoreMergePage() {
  const clusters = await findMergeClusters();

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="warn">
        合并会改变员工的门店归属，属于<strong>影响面较大的操作</strong>，请逐组确认后再执行。
        <br />
        合并的<strong>四条底线</strong>：① 只修改员工的门店外键（其它字段一个不动）；
        ② 员工数据一条都不删；③ 被合并的门店名称登记为<strong>别名保留</strong>，历史写法不丢；
        ④ 每一名被迁移的员工都会生成<strong>变更记录</strong>（含修改前 / 修改后）。
        被合并的门店记录本身也只停用、不删除，随时可回退。
      </Alert>
      <StoreMergePanel clusters={clusters} />
    </div>
  );
}
