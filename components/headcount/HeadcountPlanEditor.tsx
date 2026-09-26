"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HeadcountRow } from "@/lib/headcount-service";

/**
 * 满编目标的行内编辑器
 *
 * 只有「满编」这几列可改（人工定的经营目标）；
 * 「现有」「缺编」全部是实时算出来的，不提供编辑 —— 改它们应该去改员工资料。
 */

const FIELDS = [
  { key: "serviceManagerFull", label: "客服经理满编", short: "serviceManager" },
  { key: "mechanicFull", label: "机修满编", short: "mechanic" },
  { key: "beautyFull", label: "美容满编", short: "beauty" },
  { key: "beautyMasterFull", label: "美容师傅满编", short: "beautyMaster" },
  { key: "beautyJuniorFull", label: "美容中小工满编", short: "beautyJunior" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

export default function HeadcountPlanEditor({
  storeId,
  row,
}: {
  storeId: number;
  row: HeadcountRow;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<FieldKey | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Record<FieldKey, string>>({
    serviceManagerFull: row.full.serviceManager === null ? "" : String(row.full.serviceManager),
    mechanicFull: row.full.mechanic === null ? "" : String(row.full.mechanic),
    beautyFull: row.full.beauty === null ? "" : String(row.full.beauty),
    beautyMasterFull: row.full.beautyMaster === null ? "" : String(row.full.beautyMaster),
    beautyJuniorFull: row.full.beautyJunior === null ? "" : String(row.full.beautyJunior),
  });

  async function save(key: FieldKey, raw: string) {
    const t = raw.trim();
    if (t !== "" && !/^\d+$/.test(t)) {
      setErr("只能填 0 或正整数；留空表示「不设该职位满编」");
      return;
    }
    const value = t === "" ? null : Number(t);
    setErr("");
    setSaving(key);
    try {
      const res = await fetch(`/api/headcount/${storeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `保存失败（HTTP ${res.status}）`);
      }
      startTransition(() => {
        router.refresh();
        setOpen(false);
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <td className="border-b border-slate-100 px-2 py-1.5 text-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11.5px] text-slate-600 hover:bg-slate-50"
        >
          调整
        </button>
      </td>
      {open ? (
        <tr className="bg-amber-50/60">
          <td colSpan={22} className="border-y border-amber-200 px-3 py-2.5">
            <div className="flex flex-wrap items-end gap-2">
              <span className="text-[12px] font-medium text-slate-700">
                {row.storeName} · 满编目标（留空 = 不设该职位）
              </span>
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-0.5 block text-[11px] text-slate-500">{f.label}</span>
                  <input
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    onBlur={(e) => {
                      // 失焦即保存
                      const current = String(row.full[f.short] ?? "");
                      if (e.target.value !== current) void save(f.key, e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void save(f.key, draft[f.key]);
                      }
                    }}
                    inputMode="numeric"
                    className="h-7 w-[74px] rounded border border-slate-300 bg-white px-1.5 text-[12px]"
                  />
                </label>
              ))}
              {err ? <span className="text-[11.5px] text-rose-600">{err}</span> : null}
              {pending ? <span className="text-[11.5px] text-slate-400">保存中…</span> : null}
              <button
                type="button"
                onClick={() => {
                  void save("serviceManagerFull", draft.serviceManagerFull);
                  void save("mechanicFull", draft.mechanicFull);
                  void save("beautyFull", draft.beautyFull);
                  void save("beautyMasterFull", draft.beautyMasterFull);
                  void save("beautyJuniorFull", draft.beautyJuniorFull);
                }}
                disabled={Boolean(saving) || pending}
                className="h-7 rounded bg-slate-900 px-3 text-[12px] text-white disabled:opacity-50"
              >
                全部保存
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-7 rounded border border-slate-300 bg-white px-2.5 text-[12px] text-slate-600"
              >
                关闭
              </button>
            </div>
            {saving ? <span className="mt-1 block text-[11px] text-slate-400">正在保存 {saving}…</span> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
