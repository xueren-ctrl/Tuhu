"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { HeadcountRow } from "@/lib/headcount-service";

/**
 * 满编目标的行内编辑器
 *
 * ⚠️ 只渲染**门店名单元格的内容**，不输出 `<td>`（Stage 9.14.1 修）：
 *     之前它自己渲染一个「调整」列的 <td>，而 Excel 原表里没有这一列，
 *     导致表头（22 列）与表体（23 个 td）列数不等、整张表错位 ——
 *     「客服经理」列下面显示的竟是「具体缺编明细」。
 *
 * 交互：点击门店名展开编辑区（与 Excel 的列完全一致，不新增列）。
 * 只有「满编」这几列可改（人工定的经营目标）；
 * 「现有」「缺编」全部实时算出来，不提供编辑 —— 改它们应该去改员工资料。
 */

const FIELDS = [
  { key: "serviceManagerFull", label: "客服经理满编" },
  { key: "mechanicFull", label: "机修满编" },
  { key: "beautyFull", label: "美容满编" },
  { key: "beautyMasterFull", label: "美容师傅满编" },
  { key: "beautyJuniorFull", label: "美容中小工满编" },
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

  /**
   * 「全部保存」必须**一次请求带上全部 5 个字段**。
   *
   * ⚠️ 之前是 for 循环逐个调 save()（每次只带 1 个字段），
   *    而后端曾用 `data.x ?? null` 全量覆盖 → 每点一次就把另外 4 个字段抹成空，
   *    实际把多家门店的满编值清空了。现已改为一次 PUT 全量提交。
   *
   * 也因此**去掉了失焦自动保存**：失焦时草稿可能与其它字段不同步，
   * 统一由「全部保存」/ 回车 一次性提交，语义清晰、不会误改。
   */
  async function saveAll() {
    const body: Record<string, number | null> = {};
    for (const f of FIELDS) {
      const t = draft[f.key].trim();
      if (t !== "" && !/^\d+$/.test(t)) {
        setErr(`「${f.label}」只能填 0 或正整数；留空表示「不设该职位满编」`);
        return;
      }
      body[f.key] = t === "" ? null : Number(t);
    }
    setErr("");
    setSaving("serviceManagerFull");
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
      setSaving(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="点击调整该门店的满编目标"
        className="text-left hover:text-brand-700 hover:underline"
      >
        {row.storeName}
      </button>

      {open ? (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-slate-700">
            {row.storeName} · 满编目标（留空 = 不设该职位）
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-0.5 block text-[11px] text-slate-500">{f.label}</span>
                <input
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveAll();
                    }
                  }}
                  inputMode="numeric"
                  className="h-7 w-[74px] rounded border border-slate-300 bg-white px-1.5 text-[12px]"
                />
              </label>
            ))}
            <button
              type="button"
              onClick={saveAll}
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
          {err ? <div className="mt-1 text-[11.5px] text-rose-600">{err}</div> : null}
          {saving ? <div className="mt-1 text-[11px] text-slate-400">正在保存…</div> : null}
          {pending ? <div className="mt-1 text-[11px] text-slate-400">刷新中…</div> : null}
        </div>
      ) : null}
    </>
  );
}
