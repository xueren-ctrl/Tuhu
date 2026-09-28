"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 职位选择器 —— 手动输入 + 联想搜索，按「门店职位 / 运营部职位」分组
 *
 * 为什么不用 `<select>`：Position 字典有 52 条，从里面翻 10 个常用职位是灾难。
 * 范围见 `lib/position-scope-service.ts`（用户 2026-09-28 定的 7+3）。
 *
 * 与 `StorePicker` 同样的两个安全设计：
 *  1. `extraItems`：**当前职位不在范围内也永远可选**（标「当前职位」）。
 *     离职人员的历史细分职位（青铜机修技师 405 人等）必须能选回，
 *     否则用户只改个手机号就会把职位悄悄改掉。
 *  2. `allPositions` + 「更多职位」：筛离职人员时要能按历史职位查。
 *
 * ⚠️ Hook 铁律：条件 return 必须在所有 Hook 之后（MEMORY.md 坑 27）。
 *    改这里务必跑 `npm run check:hooks`。
 */

export interface PositionItem {
  id: number;
  name: string;
  /** store=门店职位 / ops=运营部职位，仅用于分组显示 */
  group?: "store" | "ops";
  /** 伪选项专用：写入表单/URL 的原始值（如「未分配岗位」= `__none__`，非真实职位 id） */
  raw?: string;
}

export interface PositionExtra {
  id: number;
  name: string;
  tag?: string;
}

export default function PositionPicker({
  items,
  value,
  onChange,
  allPositions = null,
  extraItems = [],
  /** 伪选项：非真实职位的特殊值（未分配/清空），选中后按 raw 回传 */
  pseudoItems = [],
  placeholder = "输入职位，如：机修",
  emptyLabel = null,
  className = "",
  autoFocus = false,
  onOpenChange,
}: {
  items: PositionItem[];
  value: PositionItem | null;
  onChange: (p: PositionItem | null) => void;
  /** 全部职位，供「更多职位」展开（筛选场景） */
  allPositions?: { id: number; name: string }[] | null;
  /** 范围外的当前职位，保证可选 */
  extraItems?: PositionExtra[];
  pseudoItems?: PositionItem[];
  placeholder?: string;
  emptyLabel?: string | null;
  className?: string;
  autoFocus?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [kw, setKw] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /** 分组后的候选：伪选项 → 范围外当前职位 → 门店 → 运营部（或展开后的全部） */
  const groups = useMemo(() => {
    const s = kw.trim();
    const match = (n: string) => !s || n.includes(s);
    const extras: PositionItem[] = extraItems
      .filter((e) => e.id !== value?.id)
      .map((e) => ({ id: e.id, name: e.name }));
    const pseudo = pseudoItems.filter((p) => match(p.name));
    if (allPositions && showAll) {
      return [{ title: "全部职位", list: allPositions.filter((p) => match(p.name)) }];
    }
    const store = items.filter((i) => i.group === "store" && match(i.name));
    const ops = items.filter((i) => i.group === "ops" && match(i.name));
    const out: { title: string; list: PositionItem[] }[] = [];
    if (pseudo.length) out.push({ title: "", list: pseudo });
    if (extras.length) out.push({ title: "", list: extras });
    if (store.length) out.push({ title: "门店职位", list: store });
    if (ops.length) out.push({ title: "运营部职位", list: ops });
    return out;
  }, [kw, items, allPositions, showAll, extraItems, pseudoItems, value?.id]);

  /** 扁平化后的可选项（键盘上下键按这个顺序走） */
  const flat = useMemo(() => groups.flatMap((g) => g.list), [groups]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onOpenChange]);

  // ---- 以下才可以写条件 return ----
  if (value) {
    return (
      <div
        className={`flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 ${className}`}
      >
        <span className="truncate text-[13px] text-slate-800">{value.name}</span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="ml-auto shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-500 hover:border-rose-300 hover:text-rose-600"
          title="清除选择"
        >
          清除
        </button>
      </div>
    );
  }

  const setOpenBoth = (v: boolean) => {
    setOpen(v);
    onOpenChange?.(v);
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <input
        value={kw}
        autoFocus={autoFocus}
        onChange={(e) => {
          setKw(e.target.value);
          setHi(0);
          setShowAll(false);
          setOpenBoth(true);
        }}
        onFocus={() => setOpenBoth(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpenBoth(false);
            return;
          }
          if (!open || flat.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => (h + 1) % flat.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h - 1 + flat.length) % flat.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const picked = flat[hi];
            if (picked) {
              onChange(picked);
              setKw("");
              setOpenBoth(false);
            }
          }
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-brand-500"
      />

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-0.5 max-h-[320px] w-full min-w-[240px] overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
          {emptyLabel ? (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setKw("");
                setOpenBoth(false);
              }}
              className="block w-full border-b border-slate-100 px-2.5 py-1.5 text-left text-[12.5px] text-slate-500 hover:bg-slate-50"
            >
              {emptyLabel}
            </button>
          ) : null}

          {flat.length === 0 ? (
            <div className="px-2.5 py-2 text-[12.5px] text-slate-400">
              没有匹配的职位{allPositions && !showAll ? "（可展开「更多职位」查找）" : ""}
            </div>
          ) : (
            <>
              {groups.map((g, gi) => (
                <div key={`${g.title}-${gi}`}>
                  {g.title ? (
                    <div className="bg-slate-50 px-2.5 py-1 text-[10.5px] font-medium text-slate-400">
                      {g.title}
                    </div>
                  ) : null}
                  {g.list.map((p) => {
                    const idx = flat.indexOf(p);
                    const extra = extraItems.find((e) => e.id === p.id);
                    return (
                      <button
                        key={`${g.title}-${p.id}`}
                        type="button"
                        onMouseEnter={() => setHi(idx)}
                        onClick={() => {
                          onChange(p);
                          setKw("");
                          setOpenBoth(false);
                        }}
                        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] ${
                          idx === hi ? "bg-brand-50" : ""
                        }`}
                      >
                        <span className="truncate text-slate-800">{p.name}</span>
                        {extra?.tag ? (
                          <span className="shrink-0 rounded bg-amber-50 px-1 text-[10.5px] text-amber-700">
                            {extra.tag}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}

              {allPositions && !showAll ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowAll(true);
                    setHi(0);
                  }}
                  className="w-full border-t border-slate-100 px-2.5 py-1.5 text-left text-[11.5px] text-brand-700 hover:bg-brand-50"
                >
                  更多职位（历史细分，共 {allPositions.length} 种）⌄
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
