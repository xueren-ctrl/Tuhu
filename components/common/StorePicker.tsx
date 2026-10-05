"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 门店选择器 —— 手动输入 + 联想搜索（Stage 9.30）
 *
 * 为什么不用原生 `<select>`：
 *   门店有 40 家（在职 37 + 南昌3店 3），原生下拉只能靠滚动找人，
 *   用户明确要求「就像登记调店里输入员工一样，输入关键词出候选」。
 *
 * 交互（与调店面板的 `EmpSearch` 保持一致，用户已经习惯）：
 *   输入关键词 → 250ms 防抖（这里 40 条直接本地过滤，无需请求后端）
 *   ↑ ↓ 选择 · Enter 选中 · Esc 关闭 · 点外部关闭 · 空输入时列出全部
 *
 * 两个关键安全设计：
 * 1. **extraOptions（额外的门店）永远可选**。
 *    场景：编辑一名已离职员工（门店早已不在 40 家范围内），
 *    如果下拉里没有他原来的门店，用户一改别的字段就会**被迫换店 = 丢数据**。
 *    所以「当前值 / 该员工现有门店」会额外出现在候选里。
 * 2. **showAllStores（显示全部门店）只给筛选类场景用**。
 *    筛离职人员时要能按历史门店查；录入场景不给，避免误选老店。
 *
 * ⚠️ Hook 铁律：所有 useState/useEffect 必须在条件 return 之前，
 *    否则「已选中」时会少跑 Hook → React 崩（见 MEMORY.md 坑 27）。
 *    改这里务必跑 `npm run check:hooks`。
 */

export interface PickerStore {
  id: number;
  name: string;
  /** 在职人数，仅用于列表里区分同名门店，可缺省 */
  activeCount?: number;
  /**
   * 分层（Stage 9.41 v2）：
   * - `inScope` = 在职表/南昌3店里有人的门店 —— 排在最前，带「在职 N 人」
   * - `manual`  = 用户手动新建的门店 —— 排在后面，必须能选到（否则新店录不进第一个人）
   * - `legacy`  = Excel 导入但从没人用过的 —— 服务层已过滤，不该出现在这里
   */
  tier?: "inScope" | "manual" | "legacy";
  /** 该店历史总人数（含离职），用于给「无人店」提示 */
  historyCount?: number;
  /**
   * 伪选项专用：写入 URL/表单的原始值。
   * 例：「未分配门店」不是真实门店，原始值是字符串 `__none__` 而不是数字 id。
   * 调用方取值用 `s?.raw ?? String(s?.id)`。
   */
  raw?: string;
}

export interface StoreExtra {
  id: number;
  name: string;
  /** 该项在列表里显示的小标签，例如「当前门店」「历史门店」 */
  tag?: string;
  tagTone?: "amber" | "slate";
}

export default function StorePicker({
  stores,
  value,
  onChange,
  placeholder = "输入门店名，如：大坪",
  /** 空值项的文案；传 null 则不允许清空 */
  emptyLabel = null,
  /** 额外的必选门店（如当前值），保证已离职/历史门店不会被清掉 */
  extraStores = [],
  /** 伪选项：不是真实门店的特殊值（如「未分配门店」），选中后按 raw 回传 */
  pseudoStores = [],
  /** 展开「全部历史门店」分组（筛选场景用） */
  allStores = null,
  className = "",
  autoFocus = false,
  onOpenChange,
}: {
  stores: PickerStore[];
  value: PickerStore | null;
  onChange: (s: PickerStore | null) => void;
  placeholder?: string;
  emptyLabel?: string | null;
  extraStores?: StoreExtra[];
  pseudoStores?: PickerStore[];
  allStores?: { id: number; name: string }[] | null;
  className?: string;
  autoFocus?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [kw, setKw] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /**
   * 候选列表（扁平，供键盘上下键走）= 伪选项 + 额外必选项 + 范围内门店
   * Stage 9.41：门店候选已包含「ACTIVE 但无人的门店」（新建的店），
   * 由 `lib/store-scope-service.ts` 排序保证有人的在前。
   */
  const list = useMemo<PickerStore[]>(() => {
    const s = kw.trim();
    const match = (n: string) => !s || n.includes(s);
    const pool: PickerStore[] = allStores && showAll ? allStores : stores;
    const base = pool.filter((x) => match(x.name));
    const extras: PickerStore[] = extraStores
      .filter((e) => e.id !== value?.id)
      .map((e) => ({ id: e.id, name: e.name }));
    const pseudo = pseudoStores.filter((p) => match(p.name));
    return [...pseudo, ...extras, ...base];
  }, [kw, stores, allStores, showAll, extraStores, pseudoStores, value?.id]);

  /**
   * 渲染用的分组结构（Stage 9.41 v2）
   * 「在职门店」与「我新建的门店」分成两段 ——
   * 服务层已把「导入但从没人用过」的历史门店过滤掉了，这里只分两段。
   */
  const sections = useMemo(() => {
    const s = kw.trim();
    const pseudo = list.filter((x) => x.raw !== undefined);
    const extras = list.filter((x) => extraStores.some((e) => e.id === x.id));
    const real = list.filter((x) => x.raw === undefined && !extras.some((e) => e.id === x.id));
    const out: { title: string; hint?: string; list: PickerStore[] }[] = [];
    if (pseudo.length) out.push({ title: "", list: pseudo });
    if (extras.length) out.push({ title: "", list: extras });
    // 有关键词时不再分组（搜索结果混在一起更好用）
    if (s) {
      if (real.length) out.push({ title: "", list: real });
      return out;
    }
    const inScope = real.filter((x) => (x.tier ?? "inScope") === "inScope");
    const manual = real.filter((x) => x.tier === "manual");
    if (inScope.length) {
      out.push({ title: `在职门店（${inScope.length} 家）`, list: inScope });
    }
    if (manual.length) {
      out.push({
        title: `我新建的门店（${manual.length} 家）`,
        hint: "录第一个人时在这里选它",
        list: manual,
      });
    }
    return out;
  }, [list, extraStores]);

  // 点外部关闭
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
          if (!open || list.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => (h + 1) % list.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h - 1 + list.length) % list.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const picked = list[hi];
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
        <div className="absolute left-0 top-full z-40 mt-0.5 max-h-[300px] w-full min-w-[240px] overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
          {emptyLabel ? (
            <button
              type="button"
              onMouseEnter={() => setHi(-1)}
              onClick={() => {
                onChange(null);
                setKw("");
                setOpenBoth(false);
              }}
              className={`block w-full border-b border-slate-100 px-2.5 py-1.5 text-left text-[12.5px] text-slate-500 hover:bg-slate-50 ${
                hi === -1 ? "bg-slate-50" : ""
              }`}
            >
              {emptyLabel}
            </button>
          ) : null}

          {list.length === 0 ? (
            <div className="px-2.5 py-2 text-[12.5px] text-slate-400">
              没有匹配的门店
              {allStores && !showAll ? "（可展开「更多门店」查找）" : ""}
            </div>
          ) : (
            <>
              {sections.map((sec, si) => (
                <div key={`sec-${si}`}>
                  {sec.title ? (
                    <div className="flex items-baseline gap-1.5 bg-slate-50 px-2.5 py-1 text-[10.5px] font-medium text-slate-400">
                      {sec.title}
                      {sec.hint ? (
                        <span className="font-normal text-emerald-600">{sec.hint}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {sec.list.map((s) => {
                    const i = list.indexOf(s);
                    const extra: StoreExtra | undefined = extraStores.find((e) => e.id === s.id);
                    const cnt: number | undefined = stores.find((x) => x.id === s.id)?.activeCount;
                    const isManual = s.tier === "manual";
                    return (
                      <button
                        key={`${s.id}-${si}`}
                        type="button"
                        onMouseEnter={() => setHi(i)}
                        onClick={() => {
                          onChange(s);
                          setKw("");
                          setOpenBoth(false);
                        }}
                        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] ${
                          i === hi ? "bg-brand-50" : ""
                        }`}
                      >
                        <span className={`truncate ${isManual ? "text-slate-500" : "text-slate-800"}`}>
                          {s.name}
                        </span>
                        {extra?.tag ? (
                          <span
                            className={`shrink-0 rounded px-1 text-[10.5px] ${
                              extra.tagTone === "slate"
                                ? "bg-slate-100 text-slate-500"
                                : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {extra.tag}
                          </span>
                        ) : isManual ? (
                          <span className="shrink-0 text-[11px] text-slate-400">
                            {s.historyCount && s.historyCount > 0
                              ? `历史 ${s.historyCount} 人`
                              : "新开门店"}
                          </span>
                        ) : cnt !== undefined ? (
                          <span className="shrink-0 text-[11px] text-slate-400">在职 {cnt} 人</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}

              {allStores && !showAll ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowAll(true);
                    setHi(0);
                  }}
                  className="w-full border-t border-slate-100 px-2.5 py-1.5 text-left text-[11.5px] text-brand-700 hover:bg-brand-50"
                >
                  更多门店（含已停用，共 {allStores.length} 家）⌄
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
