"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FILTER_OP_LABEL, type FilterOp, type SheetColumn, type SheetRowData } from "@/lib/sheet-service";
import YesNoCell from "@/components/employees/YesNoCell";

/** 支持「行内下拉直接改」的字段（7 个「是否」字段） */
const INLINE_EDIT_FIELDS = new Set([
  "dormitory",
  "socialInsurancePurchased",
  "laborContract",
  "socialInsuranceAgreement",
  "fireSafetyCommitment",
  "dormitoryWaiver",
  "onboardingMedical",
]);

/**
 * Sheet 数据表（客户端组件）
 *
 * 用软件的方式展示 Excel 导入进来的数据：
 * 工具栏（搜索 / 按列筛选 / 排序 / 每页条数 / 列设置 / 敏感信息开关）
 * + 数据表格（粘性表头、点行查看详情）
 * + 手机端自动切换成卡片列表。
 *
 * 检索与排序由服务端完成（条件写在 URL 上，可直接分享 / 刷新保持）；
 * 列的显示与隐藏属于纯展示偏好，存在浏览器本地；
 * 「显示完整信息」由服务端控制 —— 未勾选时下发的数据本身就已打码。
 */

type Query = {
  q: string;
  col: string;
  op: FilterOp;
  val: string;
  sort: string;
  dir: "asc" | "desc";
};

export default function SheetDataTable({
  sheet,
  columns,
  rows,
  reveal,
  hasSensitiveColumns,
  totalRows,
  filtered,
  page,
  pageSize,
  totalPages,
  query,
  rowLinkBase,
  toolbarExtra,
}: {
  sheet: string;
  columns: SheetColumn[];
  rows: SheetRowData[];
  reveal: boolean;
  hasSensitiveColumns: boolean;
  totalRows: number;
  filtered: number;
  page: number;
  pageSize: number;
  totalPages: number;
  query: Query;
  /** 传了就表示「每行对应一条员工记录」，详情抽屉里给出打开档案的链接 */
  rowLinkBase?: string;
  /** 工具栏右侧的自定义按钮区（新增员工 / 批量改状态 等） */
  toolbarExtra?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [keyword, setKeyword] = useState(query.q);
  const [filterVal, setFilterVal] = useState(query.val);
  const [showEmpty, setShowEmpty] = useState(false);
  const [hidden, setHidden] = useState<number[]>([]);
  const [colsOpen, setColsOpen] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [toast, setToast] = useState("");

  const prefsKey = `tuhu-sheet-prefs:${sheet}`;

  // ---- 展示偏好：列显隐 / 是否折叠空白列（本地保存） ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(prefsKey);
      if (!raw) return;
      const p = JSON.parse(raw) as { hidden?: number[]; showEmpty?: boolean };
      setHidden(Array.isArray(p.hidden) ? p.hidden : []);
      setShowEmpty(Boolean(p.showEmpty));
    } catch {
      /* 忽略损坏的本地偏好 */
    }
  }, [prefsKey]);

  useEffect(() => {
    try {
      localStorage.setItem(prefsKey, JSON.stringify({ hidden, showEmpty }));
    } catch {
      /* 隐私模式下 localStorage 可能不可用 */
    }
  }, [prefsKey, hidden, showEmpty]);

  useEffect(() => setKeyword(query.q), [query.q]);
  useEffect(() => setFilterVal(query.val), [query.val]);

  const visibleCols = useMemo(
    () => columns.filter((c) => (showEmpty || !c.empty) && !hidden.includes(c.index)),
    [columns, hidden, showEmpty]
  );
  const hiddenCount = columns.filter((c) => c.empty).length;

  function goto(patch: Record<string, string | null>, keepPage = false) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") params.delete(k);
      else params.set(k, v);
    }
    if (!keepPage) params.delete("page");
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1600);
  }

  const filterCol = query.col === "" ? null : Number(query.col);
  const sortCol = query.sort === "" ? null : Number(query.sort);
  const activeFilter =
    filterCol !== null && (query.op === "empty" || query.op === "notEmpty" || query.val !== "");

  const currentRow = openRow === null ? null : rows.find((r) => r.rowNo === openRow) ?? null;
  const currentIdx = currentRow ? rows.findIndex((r) => r.rowNo === currentRow.rowNo) : -1;

  const cellText = (_col: SheetColumn, raw: string) => raw ?? "";

  return (
    <div className="space-y-3">
      {/* ============ 工具栏 ============ */}
      <div className="panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* 搜索 */}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              goto({ q: keyword.trim() });
            }}
          >
            <div className="relative">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索这张表的全部内容"
                className="h-8 w-[220px] rounded-md border border-slate-300 pl-7 pr-2 text-[12.5px] text-slate-800 placeholder:text-slate-400 focus:border-[var(--hr-primary)]"
              />
              <span className="pointer-events-none absolute left-2 top-1.5 text-[13px] text-slate-400">⌕</span>
            </div>
            <button
              type="submit"
              className="h-8 rounded-md bg-brand-600 px-3 text-[12.5px] font-medium text-white hover:bg-brand-700"
            >
              搜索
            </button>
          </form>

          {/* 按列筛选 */}
          <div className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1">
            <span className="text-[11.5px] text-slate-500">筛选</span>
            <select
              value={query.col}
              onChange={(e) => goto({ col: e.target.value })}
              className="h-7 max-w-[130px] rounded border border-slate-300 bg-white px-1.5 text-[12px]"
            >
              <option value="">选择一列…</option>
              {columns.map((c) => (
                <option key={c.index} value={c.index}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={query.op}
              onChange={(e) => goto({ op: e.target.value === "contains" ? null : e.target.value })}
              className="h-7 rounded border border-slate-300 bg-white px-1.5 text-[12px]"
            >
              {(Object.keys(FILTER_OP_LABEL) as FilterOp[]).map((op) => (
                <option key={op} value={op}>
                  {FILTER_OP_LABEL[op]}
                </option>
              ))}
            </select>
            {query.op === "empty" || query.op === "notEmpty" ? null : (
              <input
                value={filterVal}
                onChange={(e) => setFilterVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goto({ val: filterVal.trim() });
                }}
                placeholder="值"
                className="h-7 w-[110px] rounded border border-slate-300 bg-white px-1.5 text-[12px]"
              />
            )}
            {query.col !== "" ? (
              <button
                type="button"
                onClick={() => goto({ col: null, op: null, val: null })}
                className="h-7 rounded border border-transparent px-1.5 text-[12px] text-slate-500 hover:bg-white"
              >
                清除
              </button>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {toolbarExtra}
            {hasSensitiveColumns ? (
              <label className="flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5 text-[11.5px] text-slate-600">
                <input
                  type="checkbox"
                  checked={reveal}
                  onChange={(e) => goto({ reveal: e.target.checked ? "1" : null })}
                  className="h-3.5 w-3.5"
                />
                显示完整信息
                <span className="hidden text-[10.5px] text-slate-400 sm:inline">
                  {reveal ? "（完整值已下发）" : "（已打码）"}
                </span>
              </label>
            ) : null}

            {/* 列设置 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setColsOpen((v) => !v)}
                className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-[12.5px] text-slate-600 hover:bg-slate-50"
              >
                列（{visibleCols.length}/{columns.length}）▾
              </button>
              {colsOpen ? (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setColsOpen(false)} />
                  <div className="absolute right-0 z-30 mt-1 w-[280px] rounded-lg border border-[var(--hr-border)] bg-white p-2 shadow-xl">
                    <label className="mb-1.5 flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={showEmpty}
                        onChange={(e) => setShowEmpty(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      显示空白列（{hiddenCount} 列整列为空）
                    </label>
                    <div className="mb-1 flex items-center justify-between border-t border-slate-100 px-2 pt-1.5 text-[11.5px]">
                      <button
                        type="button"
                        className="text-brand-600 hover:underline"
                        onClick={() => setHidden([])}
                      >
                        全部显示
                      </button>
                      <button
                        type="button"
                        className="text-slate-500 hover:underline"
                        onClick={() => setHidden(columns.map((c) => c.index))}
                      >
                        全部隐藏
                      </button>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto">
                      {columns.map((c) => (
                        <label
                          key={c.index}
                          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            checked={!hidden.includes(c.index)}
                            onChange={(e) =>
                              setHidden((h) =>
                                e.target.checked ? h.filter((x) => x !== c.index) : [...h, c.index]
                              )
                            }
                            className="h-3.5 w-3.5"
                          />
                          <span className="flex-1 truncate">{c.label}</span>
                          <span className="text-[10.5px] text-slate-400">{c.filled}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* 当前条件行 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11.5px] text-slate-500">
          <span>
            共 <strong className="text-slate-700">{totalRows}</strong> 行
            {filtered !== totalRows ? (
              <>
                ，命中 <strong className="text-brand-700">{filtered}</strong> 行
              </>
            ) : null}
          </span>
          {query.q ? (
            <Chip label={`关键词「${query.q}」`} onClear={() => goto({ q: null })} />
          ) : null}
          {query.col !== "" ? (
            <Chip
              label={`${columns.find((c) => String(c.index) === query.col)?.label ?? "?"} ${
                FILTER_OP_LABEL[query.op]
              }${query.op === "empty" || query.op === "notEmpty" ? "" : `「${query.val}」`}`}
              onClear={() => goto({ col: null, op: null, val: null })}
            />
          ) : null}
          {sortCol !== null ? (
            <Chip
              label={`按「${columns.find((c) => c.index === sortCol)?.label ?? "?"}」${query.dir === "asc" ? "升序" : "降序"}`}
              onClear={() => goto({ sort: null, dir: null })}
            />
          ) : null}
          {activeFilter && filtered === 0 ? (
            <span className="text-amber-600">没有匹配的行，试试放宽条件</span>
          ) : null}
          {pending ? <span className="text-brand-600">查询中…</span> : null}
          <span className="ml-auto">点击任意一行可查看完整字段</span>
        </div>
      </div>

      {/* ============ 桌面：表格 ============ */}
      <div className="panel hidden overflow-hidden p-0 md:block">
        <div className="max-h-[calc(100vh-330px)] overflow-auto">
          <table className="grid-table w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] font-medium text-slate-500">
                <th className="sticky left-0 top-0 z-20 w-[52px] border-b border-r border-[var(--hr-border)] bg-[#f7f9fc] px-2 py-2 text-center">
                  行
                </th>
                {visibleCols.map((c) => (
                  <th
                    key={c.index}
                    onClick={() => {
                      if (query.sort === String(c.index)) {
                        goto({ sort: String(c.index), dir: query.dir === "asc" ? "desc" : "asc" });
                      } else {
                        goto({ sort: String(c.index), dir: "asc" });
                      }
                    }}
                    className="cursor-pointer whitespace-nowrap border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2 hover:bg-slate-100"
                    title={`${c.label}（Excel ${c.letter} 列）· 点击排序`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {c.sensitive ? (
                        <span className="text-[10px] text-amber-500" title="敏感列，默认打码">
                          ●
                        </span>
                      ) : null}
                      {sortCol === c.index ? (
                        <span className="text-brand-600">{query.dir === "asc" ? "↑" : "↓"}</span>
                      ) : (
                        <span className="text-slate-300">↕</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={visibleCols.length + 1} className="px-4 py-16 text-center text-[13px] text-slate-400">
                    没有符合条件的记录
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr
                    key={r.rowNo}
                    onClick={() => setOpenRow(r.rowNo)}
                    className={`cursor-pointer ${i % 2 ? "bg-slate-50/50" : "bg-white"} hover:bg-brand-50/60`}
                  >
                    <td className="sticky left-0 z-10 border-b border-r border-slate-100 bg-inherit px-2 py-1.5 text-center font-mono text-[11px] text-slate-400">
                      {(page - 1) * pageSize + i + 1}
                    </td>
                    {visibleCols.map((c) => {
                      const raw = r.cells[c.index] ?? "";
                      const txt = cellText(c, raw);
                      // 7 个「是否」字段：已建档的行支持行内下拉直接改（改完即时生效）
                      if (r.employeeRef && c.source && INLINE_EDIT_FIELDS.has(c.source)) {
                        return (
                          <td key={c.index} className="border-b border-slate-100 px-3 py-1.5">
                            <YesNoCell employeeId={r.employeeRef} field={c.source} value={txt || null} />
                          </td>
                        );
                      }
                      return (
                        <td key={c.index} className="border-b border-slate-100 px-3 py-1.5 text-slate-700">
                          {txt ? (
                            <span className="block max-w-[240px] truncate" title={txt}>
                              {txt}
                            </span>
                          ) : (
                            <span className="text-slate-200">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============ 手机：卡片列表 ============ */}
      <div className="space-y-2 md:hidden">
        {rows.length === 0 ? (
          <div className="panel px-4 py-12 text-center text-[13px] text-slate-400">没有符合条件的记录</div>
        ) : (
          rows.map((r, i) => {
            const head = visibleCols[0];
            const titleCol = visibleCols.find((c) => /姓名|^姓名/.test(c.label)) ?? visibleCols[1] ?? head;
            const title = titleCol ? r.cells[titleCol.index] || "（未填姓名）" : `第 ${i + 1} 行`;
            const others = visibleCols.filter((c) => c.index !== titleCol?.index).slice(0, 3);
            return (
              <button
                key={r.rowNo}
                type="button"
                onClick={() => setOpenRow(r.rowNo)}
                className="panel block w-full px-3.5 py-3 text-left"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-semibold text-slate-800">{title}</span>
                  <span className="font-mono text-[11px] text-slate-400">
                    #{(page - 1) * pageSize + i + 1}
                  </span>
                </div>
                <dl className="mt-1.5 space-y-1">
                  {others.map((c) => {
                    const txt = cellText(c, r.cells[c.index] ?? "");
                    return (
                      <div key={c.index} className="flex gap-2 text-[12px]">
                        <dt className="w-[84px] shrink-0 truncate text-slate-400">{c.label}</dt>
                        <dd className="min-w-0 flex-1 truncate text-slate-700">{txt || "—"}</dd>
                      </div>
                    );
                  })}
                </dl>
                <div className="mt-2 text-[11.5px] text-brand-600">查看全部 {columns.length} 项 ›</div>
              </button>
            );
          })
        )}
      </div>

      {/* ============ 分页 ============ */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] text-slate-600">
        <div className="flex items-center gap-3">
          <span>
            第 <strong className="text-slate-800">{page}</strong> / {totalPages} 页 · 本页 {rows.length} 行
          </span>
          <label className="flex items-center gap-1.5">
            每页
            <select
              value={pageSize}
              onChange={(e) => goto({ size: e.target.value }, true)}
              className="h-7 rounded border border-slate-300 bg-white px-1.5 text-[12px]"
            >
              {[20, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1 || pending}
            onClick={() => goto({ page: String(page - 1) }, true)}
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages || pending}
            onClick={() => goto({ page: String(page + 1) }, true)}
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>

      {/* ============ 行详情 ============ */}
      {currentRow ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={() => setOpenRow(null)}>
          <div
            className="flex h-full w-full flex-col bg-white shadow-2xl sm:w-[440px]"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-[var(--hr-border)] px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-slate-800">
                  {(() => {
                    const nc = columns.find((c) => c.label === "姓名");
                    return (nc ? currentRow.cells[nc.index] : "") || "行详情";
                  })()}
                </div>
                <div className="text-[11px] text-slate-400">
                  Excel 第 {currentRow.rowNo} 行 · 本页第 {currentIdx + 1} / {rows.length} 行
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpenRow(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="关闭"
              >
                ✕
              </button>
            </header>

            {rowLinkBase && currentRow.employeeRef ? (
              <div className="border-b border-slate-100 px-4 py-2">
                <a
                  href={`${rowLinkBase}/${currentRow.employeeRef}`}
                  className="text-[12.5px] font-medium text-brand-600 hover:underline"
                >
                  打开该员工的完整档案 / 修改资料 ›
                </a>
              </div>
            ) : null}
            {rowLinkBase && !currentRow.employeeRef ? (
              <div className="border-b border-slate-100 bg-amber-50/60 px-4 py-2 text-[12px] text-amber-800">
                这一行来自 Excel 原始名单，系统里<strong>没有对应的员工档案</strong>
                （常见于只来面试没有入职、或历史数据没录入的人），所以无法打开档案。
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto px-4 py-3">
              <dl className="divide-y divide-slate-100">
                {columns.map((c) => {
                  const raw = currentRow.cells[c.index] ?? "";
                  const txt = cellText(c, raw);
                  return (
                    <div key={c.index} className="grid grid-cols-[110px_1fr] gap-2 py-2">
                      <dt className="text-[12px] text-slate-400">
                        {c.label}
                        <span className="ml-1 text-[10px] text-slate-300">{c.letter}</span>
                      </dt>
                      <dd className="break-words text-[13px] text-slate-800">
                        {txt || <span className="text-slate-300">—</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-[var(--hr-border)] px-4 py-3">
              <button
                type="button"
                disabled={currentIdx <= 0}
                onClick={() => setOpenRow(rows[currentIdx - 1]?.rowNo ?? null)}
                className="h-8 rounded-md border border-slate-300 px-3 text-[12.5px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                ↑ 上一行
              </button>
              <button
                type="button"
                onClick={async () => {
                  const text = columns
                    .map((c) => `${c.label}：${currentRow.cells[c.index] ?? ""}`)
                    .join("\n");
                  try {
                    await navigator.clipboard.writeText(text);
                    showToast("已复制整行内容");
                  } catch {
                    showToast("浏览器不允许复制，请手动选择");
                  }
                }}
                className="h-8 rounded-md border border-slate-300 px-3 text-[12.5px] text-slate-600 hover:bg-slate-50"
              >
                复制整行
              </button>
              <button
                type="button"
                disabled={currentIdx < 0 || currentIdx >= rows.length - 1}
                onClick={() => setOpenRow(rows[currentIdx + 1]?.rowNo ?? null)}
                className="h-8 rounded-md border border-slate-300 px-3 text-[12.5px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                下一行 ↓
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md bg-slate-900/90 px-3.5 py-2 text-[12.5px] text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11.5px] text-brand-700">
      {label}
      <button type="button" onClick={onClear} className="text-brand-500 hover:text-brand-800" aria-label="清除条件">
        ✕
      </button>
    </span>
  );
}
