"use client";

/**
 * 职位备注选择器（Stage 9.32）
 *
 * 业务规则（用户 2026-09-28 定）：**只有「美容」职位有职位备注**，分为 师傅 / 中工 / 学徒 三种。
 * 这个字段直接决定「门店人员编制」里「现有美容师傅 / 美容中小工」两列的口径
 * （见 MEMORY.md「门店人员编制」：判据是 positionNote，绝不能用 position.name）。
 *
 * 为什么用三选一按钮而不是搜索框：只有 3 个值，按钮比打字快，也不会打错。
 *
 * ⚠️ 存量异常必须能显示：李小虎（已面试·美容）的 positionNote 是「贴膜」（Excel 脏值）。
 *    这种值**原样显示 + 可清除**，不静默改成空，也不阻止保存。
 */

export const POSITION_NOTE_VALUES = ["师傅", "中工", "学徒"] as const;

export default function PositionNoteSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const cur = value?.trim() ?? "";
  const isOffList = cur !== "" && !POSITION_NOTE_VALUES.includes(cur as (typeof POSITION_NOTE_VALUES)[number]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {POSITION_NOTE_VALUES.map((v) => {
        const active = cur === v;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(active ? "" : v)}
            className={`h-9 rounded-md border px-3 text-[13px] transition-colors disabled:opacity-50 ${
              active
                ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
            }`}
          >
            {v}
          </button>
        );
      })}
      {cur ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("")}
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[11.5px] text-slate-500 hover:border-rose-300 hover:text-rose-600 disabled:opacity-50"
          title="清空职位备注"
        >
          清除
        </button>
      ) : null}
      {isOffList ? (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700" title="历史遗留的取值，可清除">
          历史值：{cur}
        </span>
      ) : null}
    </div>
  );
}
