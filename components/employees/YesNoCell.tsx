"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 「是否」字段的行内快速编辑（Stage 7.3）
 *
 * 直接在人员列表的下拉里改 是 / 否 / 留空，省去进详情页的步骤。
 * 规则：
 *   - 新写入只允许 是 / 否 / 空（空 = 未填）
 *   - 历史第三态（如 在职 / 外宿 / 新增人员 / 实习 / 做不了）**原样保留**，
 *     作为一个额外的只读选项显示，但不会被自动选中或清掉
 *   - 写库统一走 PATCH /api/employees/[id]（内部走 lib/employee-service 唯一入口）
 */

const FIELD_LABELS: Record<string, string> = {
  dormitory: "是否住宿舍",
  socialInsurancePurchased: "社保购买",
  laborContract: "劳动合同",
  socialInsuranceAgreement: "社保协议",
  fireSafetyCommitment: "消防承诺书",
  dormitoryWaiver: "宿舍免责协议",
  onboardingMedical: "入职体检",
};

export default function YesNoCell({
  employeeId,
  field,
  value,
}: {
  employeeId: number;
  field: string;
  value: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const label = FIELD_LABELS[field] ?? field;
  // 是 / 否 之外的都视为「历史第三态」或空
  const isLegacy = value != null && value !== "" && value !== "是" && value !== "否";

  async function save(next: string) {
    if (next === (value ?? "")) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next === "" ? null : next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `保存失败（HTTP ${res.status}）`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const tone =
    value === "是"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : value === "否"
        ? "bg-slate-100 text-slate-600 border-slate-300"
        : isLegacy
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-white text-slate-400 border-slate-200";

  return (
    <div className="relative">
      <select
        value={value ?? ""}
        disabled={saving || pending}
        onChange={(e) => save(e.target.value)}
        title={
          isLegacy
            ? `历史值「${value}」（非是/否，保留原样）—— 可改为 是/否/留空`
            : label
        }
        className={
          "w-full cursor-pointer rounded border px-1.5 py-1 text-[12px] outline-none transition-colors " +
          tone +
          (saving || pending ? " opacity-50" : "") +
          " focus:ring-2 focus:ring-brand-300"
        }
      >
        <option value="">（空）</option>
        <option value="是">是</option>
        <option value="否">否</option>
        {isLegacy ? <option value={value as string}>历史：{value}</option> : null}
      </select>
      {err ? (
        <span
          title={err}
          className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white"
        >
          !
        </span>
      ) : null}
    </div>
  );
}
