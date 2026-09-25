"use client";

import { useState } from "react";

/** 带复制按钮的地址栏（访问入口页用） */
export default function CopyField({
  value,
  label,
  mono = true,
  tone = "default",
}: {
  value: string;
  label?: string;
  mono?: boolean;
  tone?: "default" | "primary";
}) {
  const [done, setDone] = useState(false);

  return (
    <div className="flex items-stretch gap-2">
      <div
        className={
          "flex min-w-0 flex-1 items-center rounded-md border px-3 py-2 text-[13.5px] " +
          (tone === "primary"
            ? "border-brand-200 bg-brand-50 font-semibold text-brand-800"
            : "border-slate-200 bg-slate-50 text-slate-800") +
          (mono ? " font-mono" : "")
        }
      >
        <span className="truncate">{value}</span>
      </div>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            /* 部分浏览器在非 https 下禁用剪贴板，忽略即可 */
          }
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        }}
        className="shrink-0 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] text-slate-600 hover:bg-slate-50"
      >
        {done ? "已复制" : "复制"}
      </button>
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
