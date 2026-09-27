"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { HeadcountRow } from "@/lib/headcount-service";

/**
 * 满编单元格的行内编辑器（Stage 9.16）
 *
 * 背景：满编（客服/机修/美容/美容师傅/美容中小工）本来就是**人工设定的经营目标**，
 * 会随经营调整 —— 但之前的入口藏在「点击门店名」里，点击前毫无提示，
 * 用户完全不知道这 5 列可以改。
 *
 * 现在：**满编数字本身就是入口**
 *   - 常显「虚线下划线 + hover 变色」，一眼看出可编辑
 *   - 点击就地弹出编辑框（absolute 定位，**不撑开表格、不新增列**）
 *   - 一次提交全部 5 个字段（⚠️ 绝不能循环逐字段提交，
 *     配合后端全量覆盖会清空其余字段，见 Stage 9.15.2）
 *   - Esc 取消 / 外部点击取消 / 保存后自动关闭
 *
 * ⚠️ 只渲染单元格**内容**，绝不输出 `<td>` —— Excel 原表就是 22 列，
 *    任何多出的 td 都会让表头与表体列数不等、整表错位。
 */

export const FULL_FIELDS = [
  { key: "serviceManagerFull", label: "客服经理满编" },
  { key: "mechanicFull", label: "机修满编" },
  { key: "beautyFull", label: "美容满编" },
  { key: "beautyMasterFull", label: "美容师傅满编" },
  { key: "beautyJuniorFull", label: "美容中小工满编" },
] as const;

type FieldKey = (typeof FULL_FIELDS)[number]["key"];

const initialDraft = (row: HeadcountRow): Record<FieldKey, string> => ({
  serviceManagerFull: row.full.serviceManager === null ? "" : String(row.full.serviceManager),
  mechanicFull: row.full.mechanic === null ? "" : String(row.full.mechanic),
  beautyFull: row.full.beauty === null ? "" : String(row.full.beauty),
  beautyMasterFull: row.full.beautyMaster === null ? "" : String(row.full.beautyMaster),
  beautyJuniorFull: row.full.beautyJunior === null ? "" : String(row.full.beautyJunior),
});

export default function HeadcountFullCell({
  storeId,
  row,
  field,
  compact = false,
}: {
  storeId: number;
  row: HeadcountRow;
  field: FieldKey;
  /** 门店名旁的迷你「设」按钮（只做入口，不显示数字） */
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<FieldKey, string>>(initialDraft(row));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);

  const label = FULL_FIELDS.find((f) => f.key === field)!.label;
  const value = row.full[
    field === "serviceManagerFull" ? "serviceManager"
    : field === "mechanicFull" ? "mechanic"
    : field === "beautyFull" ? "beauty"
    : field === "beautyMasterFull" ? "beautyMaster"
    : "beautyJunior"
  ];

  // 外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 弹层位置：靠近右边界时改为右对齐，避免溢出屏幕
  const [align, setAlign] = useState<"center" | "right">("center");
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAlign(r.right > window.innerWidth - 12 ? "right" : "center");
  }, [open]);

  async function saveAll() {
    const body: Record<string, number | null> = {};
    for (const f of FULL_FIELDS) {
      const t = draft[f.key].trim();
      if (t !== "" && !/^\d+$/.test(t)) {
        setErr(`「${f.label}」只能填 0 或正整数；留空表示「不设该职位满编」`);
        return;
      }
      body[f.key] = t === "" ? null : Number(t);
    }
    setErr("");
    setSaving(true);
    try {
      const res = await fetch(`/api/headcount/${storeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `保存失败（HTTP ${res.status}）`);
      }
      startTransition(() => router.refresh());
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        title={`人工设置满编：点击修改${label}（5 个满编一起保存）`}
        onClick={() => {
          setDraft(initialDraft(row));
          setErr("");
          setOpen(true);
        }}
        className={
          compact
            ? "cursor-pointer rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-200"
            : `w-full cursor-pointer rounded px-1 py-0.5 text-center tabular-nums underline decoration-dotted underline-offset-2 transition-colors hover:bg-amber-100 hover:text-amber-900 ${
                value === null ? "text-slate-400" : "text-slate-700"
              }`
        }
      >
        {compact ? "设满编" : value === null ? "—" : value}
      </button>

      {open ? (
        <div
          ref={boxRef}
          className={`absolute top-full z-50 mt-1 w-[340px] rounded-lg border border-amber-300 bg-white p-3 shadow-xl ${
            align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 text-[12px] font-semibold text-slate-800">
            {row.storeName} · 人工设置满编
          </div>
          <div className="mb-2 text-[11px] leading-relaxed text-slate-500">
            满编是<strong className="text-amber-700">你自己设定的目标</strong>，随经营调整，
            改完立即重算缺编。<strong>留空 = 该职位不设满编</strong>，不参与缺编计算。
          </div>
          <div className="grid grid-cols-2 gap-2">
            {FULL_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-0.5 block text-[11px] text-slate-500">{f.label}</span>
                <input
                  autoFocus={f.key === field}
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveAll();
                    }
                  }}
                  inputMode="numeric"
                  className="h-7 w-full rounded border border-slate-300 bg-white px-1.5 text-[12px]"
                />
              </label>
            ))}
          </div>
          {err ? <div className="mt-1.5 text-[11.5px] text-rose-600">{err}</div> : null}
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={saveAll}
              disabled={saving}
              className="h-7 rounded bg-slate-900 px-3 text-[12px] text-white disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存满编"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 rounded border border-slate-300 bg-white px-2.5 text-[12px] text-slate-600"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
