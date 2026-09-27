"use client";

import { useRouter, useSearchParams } from "next/navigation";

/** 月份选择器（流失率等按月统计的页面共用） */
export default function MonthPicker({
  options,
  current,
}: {
  options: { value: string; label: string }[];
  current: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  return (
    <form
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        const params = new URLSearchParams(sp.toString());
        params.set("month", v);
        router.push(`?${params.toString()}`);
      }}
      className="flex items-center gap-1.5"
    >
      <label htmlFor="month-picker" className="text-[12px] text-slate-500">
        统计月份
      </label>
      <select
        id="month-picker"
        name="month"
        defaultValue={current}
        className="h-7 rounded border border-slate-300 bg-white px-2 text-[12.5px] text-slate-700"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}
