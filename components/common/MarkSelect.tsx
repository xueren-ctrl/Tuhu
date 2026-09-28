"use client";

/**
 * 打勾选择器（√ / 留空）—— Stage 9.33 更正口径
 *
 * 适用字段：**简历表 / 面试评估表 / 入职表**（用户 2026-09-28 明确更正）。
 * 这三个字段表达的是「这份材料有没有」，业务上只有两种状态：
 *   · 有 → 打「√」
 *   · 没有 / 不知道 → **留空**（不是「否」）
 *
 * ⚠️ 为什么不用「是 / 否」两按钮：
 *   用户最初说「是、否」，随后更正为「√ 或留空」—— 材料类字段用「否」会让人
 *   误以为是"确认没有"，而实际多数情况是"还没交 / 不知道"。留空语义更准确。
 *   （面试结果仍是「通过 / 不通过 / 留空」，那个字段是真的有结论与否。）
 *
 * 界面：一个 √ 按钮（再点一次取消）+ 清除按钮；范围外历史值原样标出可清除，
 * 与 PositionNoteSelect / YesNoSelect 同一套「不静默改写」原则。
 */

export default function MarkSelect({
  value,
  onChange,
  mark = "√",
  disabled = false,
  label = "已交",
}: {
  value: string;
  onChange: (v: string) => void;
  /** 打勾符号，默认 √（Excel 原文用的就是这个） */
  mark?: string;
  disabled?: boolean;
  /** 按钮上的说明文字，避免只看到一个 √ 不知含义 */
  label?: string;
}) {
  const cur = (value ?? "").trim();
  const active = cur === mark;
  const isOffList = cur !== "" && cur !== mark;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(active ? "" : mark)}
        title={active ? "点一下取消（变为留空）" : `标记为「${label}」`}
        className={`flex h-9 items-center gap-1.5 rounded-md border px-3.5 text-[13px] transition-colors disabled:opacity-50 ${
          active
            ? "border-emerald-500 bg-emerald-50 font-medium text-emerald-700"
            : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
        }`}
      >
        <span className="text-[15px] leading-none">{mark}</span>
        <span>{label}</span>
      </button>
      {cur ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange("")}
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[11.5px] text-slate-500 hover:border-rose-300 hover:text-rose-600 disabled:opacity-50"
          title="清空（留空 = 没有或不知道）"
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
      {!cur ? (
        <span className="text-[11.5px] text-slate-400">（留空 = 没有或还没交）</span>
      ) : null}
    </div>
  );
}
