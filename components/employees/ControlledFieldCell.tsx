"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 受控字段的行内快速编辑（Stage 9.36）
 *
 * 背景：用户 2026-09-29 第三次强调「编辑员工里那三个字段」要受控。
 * 实测发现**编辑表单**早已改好，但**列表页行内编辑**（双击单元格）仍是自由文本，
 * 用户换个地方改就会遇到「没改好」—— 所以这里补齐，让两处口径完全一致。
 *
 * 支持两种取值语义：
 *   · kind="passfail" → 通过 / 不通过 / 留空（面试结果）
 *   · kind="tick"     → √ / 留空（简历表 / 面试评估表 / 入职表）
 *
 * 规则与 YesNoCell 一致：
 *   - 新写入只允许白名单里的值
 *   - 范围外历史值**原样保留**并显示（不静默改写），用户可主动清除
 *   - 写库统一走 PUT /api/employees/[id]（内部 lib/employee-service 唯一入口）
 */

const FIELD_LABELS: Record<string, string> = {
  interviewResult: "面试结果",
  docResume: "简历表",
  docInterviewEvaluation: "面试评估表",
  docOnboardingForm: "入职表",
};

export default function ControlledFieldCell({
  employeeId,
  field,
  value,
  kind,
}: {
  employeeId: number;
  field: string;
  value: string | null;
  kind: "passfail" | "tick";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const label = FIELD_LABELS[field] ?? field;
  const options = kind === "passfail" ? ["通过", "不通过"] : ["√"];
  const cur = (value ?? "").trim();
  // 不在白名单里的非空值 = 历史遗留（如旧的「未通过」「是」）
  const isOffList = cur !== "" && !options.includes(cur);

  async function save(next: string) {
    if (next === cur) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/employees/${employeeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErr(d.error ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1" title={err ?? `编辑${label}`}>
        {options.map((o) => {
          const active = cur === o;
          return (
            <button
              key={o}
              type="button"
              disabled={saving || pending}
              onClick={() => save(active ? "" : o)}
              className={`rounded border px-1.5 py-0.5 text-[11.5px] leading-tight transition-colors disabled:opacity-50 ${
                active
                  ? "border-emerald-500 bg-emerald-50 font-medium text-emerald-700"
                  : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600"
              }`}
            >
              {o}
            </button>
          );
        })}
        {cur ? (
          <button
            type="button"
            disabled={saving || pending}
            onClick={() => save("")}
            className="rounded px-1 py-0.5 text-[11px] text-slate-400 hover:text-rose-600 disabled:opacity-50"
            title="清空（留空）"
          >
            清除
          </button>
        ) : null}
        {isOffList ? (
          <span
            className="rounded bg-amber-50 px-1 py-0.5 text-[10.5px] text-amber-700"
            title="历史遗留取值，可清除"
          >
            {cur}
          </span>
        ) : null}
      </span>
      {err ? <span className="text-[10.5px] text-rose-600">{err}</span> : null}
    </span>
  );
}
