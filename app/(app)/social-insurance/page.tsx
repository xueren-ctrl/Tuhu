import { getStoreScopeOptions } from "@/lib/store-scope-service";
import { socialInsuranceStats } from "@/lib/social-insurance-service";
import SocialInsurancePanel from "@/components/social-insurance/SocialInsurancePanel";

export const dynamic = "force-dynamic";

/**
 * /social-insurance —— 社保参保名单（Stage 9.37）
 *
 * 业务定位：按这份名单给职工买社保。入职/离职实时更新这里。
 * 「是否参保」与在职状态**解耦**（已离职可能仍在保，在职也可能停保）。
 */
export default async function SocialInsurancePage() {
  const [{ stores }, stats] = await Promise.all([getStoreScopeOptions(), socialInsuranceStats()]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[17px] font-semibold text-slate-800">社保参保名单</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          来自 Excel「社保总名单」。买保险按这份名单走；新入职要加、离职要停保，都在这里实时更新。
        </p>
      </header>

      <SocialInsurancePanel storeScope={stores} initialStats={stats} />
    </div>
  );
}
