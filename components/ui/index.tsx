"use client";

import React from "react";

/* ============================================================
 * 统一基础组件（保证全站表单/表格/弹窗外观一致）
 * ============================================================ */

// ---------------------------- Button ----------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md";

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white border border-brand-600 hover:bg-brand-700 disabled:bg-brand-300 disabled:border-brand-300",
  secondary:
    "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  ghost:
    "bg-transparent text-slate-600 border border-transparent hover:bg-slate-100",
  danger:
    "bg-white text-red-600 border border-red-300 hover:bg-red-50 disabled:text-red-300",
  subtle:
    "bg-slate-100 text-slate-700 border border-transparent hover:bg-slate-200",
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] rounded-md",
  md: "h-9 px-3.5 text-[13px] rounded-md",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  loading = false,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:cursor-not-allowed ${BTN_VARIANT[variant]} ${BTN_SIZE[size]} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

// ---------------------------- 表单控件 ----------------------------

const controlBase =
  "h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-[13px] text-slate-800 placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-500";

export function Input({
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${controlBase} ${className}`} />;
}

export function Textarea({
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={`min-h-[72px] w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-[13px] text-slate-800 placeholder:text-slate-400 ${className}`}
    />
  );
}

export function Select({
  className = "",
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${controlBase} pr-1.5 ${className}`}>
      {children}
    </select>
  );
}

/** 表单字段包装：标签 + 说明 + 错误 + 自定义内容 */
export function Field({
  label,
  hint,
  error,
  required,
  excelColumn,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  excelColumn?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline gap-1.5">
        <label className="text-[12.5px] font-medium text-slate-700">
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </label>
        {excelColumn ? (
          <span className="text-[10.5px] text-slate-400">Excel: {excelColumn}</span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-slate-400">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11px] text-red-600">{error}</p> : null}
    </div>
  );
}

// ---------------------------- 容器 / 展示 ----------------------------

export function Card({
  title,
  extra,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || extra ? (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--hr-border)] px-4 py-3">
          <h2 className="text-[13.5px] font-semibold text-slate-800">{title}</h2>
          {extra}
        </header>
      ) : null}
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

type BadgeTone = "gray" | "green" | "red" | "blue" | "amber" | "slate";

const BADGE_TONE: Record<BadgeTone, string> = {
  gray: "bg-slate-100 text-slate-600",
  slate: "bg-slate-100 text-slate-600",
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-600",
  blue: "bg-brand-50 text-brand-700",
  amber: "bg-amber-50 text-amber-700",
};

export function Badge({
  children,
  tone = "gray",
  className = "",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11.5px] font-medium ${BADGE_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** 状态徽标：在职 / 离职 / 候选人 */
export function StatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") return <Badge tone="green">在职</Badge>;
  if (status === "RESIGNED") return <Badge tone="red">离职</Badge>;
  if (status === "CANDIDATE") return <Badge tone="amber">候选人</Badge>;
  return <Badge>{status}</Badge>;
}

export function StatCard({
  label,
  value,
  sub,
  tone = "blue",
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "blue" | "green" | "red" | "slate" | "amber";
}) {
  const bar: Record<string, string> = {
    blue: "bg-brand-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
    slate: "bg-slate-400",
    amber: "bg-amber-500",
  };
  return (
    <div className="panel relative overflow-hidden px-4 py-3.5">
      <span
        className={`absolute left-0 top-0 h-full w-[3px] ${bar[tone]}`}
        aria-hidden
      />
      <div className="text-[12px] text-sub">{label}</div>
      <div className="mt-1 text-[26px] font-semibold leading-none tabular-nums">
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[11px] text-slate-400">{sub}</div> : null}
    </div>
  );
}

export function EmptyState({
  title = "暂无数据",
  desc,
  action,
}: {
  title?: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="text-[15px] font-medium text-slate-500">{title}</div>
      {desc ? <div className="max-w-md text-[12.5px] text-slate-400">{desc}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
  className = "",
}: {
  tone?: "info" | "warn" | "error" | "success";
  children: React.ReactNode;
  className?: string;
}) {
  const map = {
    info: "border-brand-200 bg-brand-50 text-brand-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    error: "border-red-200 bg-red-50 text-red-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  } as const;
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[12.5px] leading-relaxed ${map[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------- Modal ----------------------------

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = "w-[560px]",
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-4 sm:p-8">
      <div
        className={`mt-6 w-full ${width} max-w-full rounded-lg bg-white shadow-xl`}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between border-b border-[var(--hr-border)] px-4 py-3">
          <h3 className="text-[14px] font-semibold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--hr-border)] px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------- 分页 ----------------------------

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange?: (n: number) => void;
  pageSizeOptions?: number[];
}) {
  const pages: (number | "…")[] = [];
  const push = (v: number | "…") => pages.push(v);
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) push(i);
  } else {
    push(1);
    if (page > 3) push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++)
      push(i);
    if (page < totalPages - 2) push("…");
    push(totalPages);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hr-border)] px-4 py-2.5">
      <div className="text-[12px] text-sub">
        共 <span className="font-medium text-slate-700">{total}</span> 条
        {onPageSizeChange ? (
          <span className="ml-3 inline-flex items-center gap-1.5">
            每页
            <Select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-7 w-[68px] text-[12px]"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <Button size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          上一页
        </Button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-[12px] text-slate-400">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              className={
                "h-7 min-w-7 rounded-md border px-2 text-[12px] font-medium transition-colors " +
                (p === page
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
              }
            >
              {p}
            </button>
          )
        )}
        <Button
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

// ---------------------------- 描述列表 ----------------------------

export function DescGrid({
  items,
  columns = 3,
}: {
  items: { label: string; value: React.ReactNode; hint?: string }[];
  columns?: 1 | 2 | 3 | 4;
}) {
  const colCls =
    columns === 1
      ? "grid-cols-1"
      : columns === 2
        ? "grid-cols-1 sm:grid-cols-2"
        : columns === 3
          ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";
  return (
    <dl className={`grid gap-x-6 gap-y-3.5 ${colCls}`}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-[11.5px] text-slate-400">{it.label}</dt>
          <dd className="mt-0.5 break-words text-[13px] text-slate-800">
            {it.value === null || it.value === undefined || it.value === "" ? (
              <span className="text-slate-300">—</span>
            ) : (
              it.value
            )}
          </dd>
          {it.hint ? (
            <div className="mt-0.5 text-[10.5px] text-slate-400">{it.hint}</div>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
