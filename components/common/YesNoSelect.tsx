"use client";

/**
 * 二选一选择器（是 / 否、通过 / 不通过…）—— Stage 9.33
 *
 * 为什么用按钮而不是下拉或输入框：
 *   这些字段的业务取值**只有两三个**（用户 2026-09-28 明确指定）：
 *     · 面试结果 = 通过 / 不通过
 *     · 简历表 / 面试评估表 / 入职表 = 是 / 否
 *   按钮一点即中，比打字和翻下拉都快，也从根本上杜绝了「√ / 0 / 未通过」这类脏值再进来。
 *
 * 三态设计：**是/否 二选一 + 可清空**（清空 = 留空 = 不知道，不是「否」）。
 *
 * ⚠️ 历史脏值不丢：若库里还有不在选项里的值（如旧的「未通过」），
 *    会以「历史值：xxx」的形式标出来并**保留**（可一键清除），
 *    与 PositionNoteSelect 同一套处理原则 —— 归一由脚本做，界面不静默改写。
 */
export default function YesNoSelect({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: string;
  /** 至少两个选项，如 ["是","否"] 或 ["通过","不通过"] */
  options: readonly string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const cur = (value ?? "").trim();
  const isOffList = cur !== "" && !options.includes(cur);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const active = cur === o;
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            onClick={() => onChange(active ? "" : o)}
            className={`h-9 rounded-md border px-3 text-[13px] transition-colors disabled:opacity-50 ${
              active
                ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
            }`}
          >
            {o}
          </button>
        );
      })}
      {cur ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("")}
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[11.5px] text-slate-500 hover:border-rose-300 hover:text-rose-600 disabled:opacity-50"
          title="清空（留空 = 未知，不是「否」）"
        >
          清除
        </button>
      ) : null}
      {isOffList ? (
        <span
          className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700"
          title="历史遗留的取值，可清除"
        >
          历史值：{cur}
        </span>
      ) : null}
    </div>
  );
}
