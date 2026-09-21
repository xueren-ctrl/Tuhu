import { Alert } from "@/components/ui";
import StoreManager from "@/components/settings/StoreManager";

export const dynamic = "force-dynamic";

/** /settings/stores 门店管理 */
export default function StoresPage() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        员工的门店字段以后优先从这里选择，避免普通用户随意输入大量自由文本。
        但 Excel 迁移进来的<strong>历史门店原文</strong>（storeNameRaw）不会被覆盖或清空，
        可在员工详情页「门店信息」分组中查看。
      </Alert>
      <StoreManager />
    </div>
  );
}
