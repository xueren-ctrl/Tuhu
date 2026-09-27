"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 调店单操作区（Stage 9.28）
 *
 * 两个入口：
 *  - 「登记调店」：填员工 + 目标门店 + 生效日期（留空 = 立即生效）+ 原因
 *  - 「作废 / 撤销」：待生效单作废（档案不动）；已生效单撤销（门店自动回退）
 *
 * ⚠️ 交互原则：作废/撤销**必须填原因**（行业惯例：审计要留 why），
 *    确认框里明确写出「会发生什么」，避免误点。
 */

type Order = {
  id: number;
  status: "PENDING" | "EFFECTED" | "CANCELLED" | "REVERSED";
  statusLabel: string;
  employee: { id: number; name: string; code: string | null };
  fromStore: { id: number; name: string };
  toStore: { id: number; name: string };
  effectiveDate: string;
  reason: string | null;
  voidReason: string | null;
  createdBy: string | null;
  voidedBy?: string | null;
  reversedBy?: string | null;
};

export default function TransferOrderPanel({
  orders,
  employees,
  stores,
}: {
  orders: Order[];
  employees: { id: number; name: string; code: string | null; storeId: number | null; storeName: string | null }[];
  stores: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 登记表单
  const [empId, setEmpId] = useState("");
  const [toStore, setToStore] = useState("");
  const [effDate, setEffDate] = useState("");
  const [reason, setReason] = useState("");

  // 作废/撤销弹窗
  const [act, setAct] = useState<{ order: Order; kind: "cancel" | "reverse" } | null>(null);
  const [actReason, setActReason] = useState("");

  const reload = () => startTransition(() => router.refresh());

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!empId || !toStore) {
      setMsg({ kind: "err", text: "请选择员工和目标门店" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: Number(empId),
          toStoreId: Number(toStore),
          effectiveDate: effDate || null,
          reason: reason || null,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j?.error ?? `保存失败（HTTP ${res.status}）` });
      } else {
        const label = j.data.status === "EFFECTED" ? "已立即生效" : "已登记为待生效";
        setMsg({ kind: "ok", text: `${label}（单号 #${j.data.orderId}）` });
        setEmpId(""); setToStore(""); setEffDate(""); setReason("");
        reload();
      }
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!act) return;
    if (!actReason.trim()) {
      setMsg({ kind: "err", text: "必须填写原因（审计需要）" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transfers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act.kind, orderId: act.order.id, voidReason: actReason }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j?.error ?? `操作失败（HTTP ${res.status}）` });
      } else {
        setMsg({
          kind: "ok",
          text:
            act.kind === "cancel"
              ? `单 #${act.order.id} 已作废。该员工门店未变动。`
              : `单 #${act.order.id} 已撤销，${act.order.employee.name} 的门店已回退到「${act.order.fromStore.name}」。`,
        });
        setAct(null);
        setActReason("");
        reload();
      }
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const pending = orders.filter((o) => o.status === "PENDING");
  const effected = orders.filter((o) => o.status === "EFFECTED");
  const closed = orders.filter((o) => o.status === "CANCELLED" || o.status === "REVERSED");

  const badge = (s: Order["status"]) =>
    s === "PENDING"
      ? "bg-amber-50 text-amber-700"
      : s === "EFFECTED"
        ? "bg-emerald-50 text-emerald-700"
        : "bg-slate-100 text-slate-500";

  return (
    <div className="space-y-2.5">
      {msg ? (
        <div
          className={`rounded border px-2.5 py-1.5 text-[12px] ${
            msg.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      {/* 登记调店 */}
      <form onSubmit={submitCreate} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
        <div className="mb-2 text-[12px] font-medium text-slate-600">登记调店</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">员工</label>
            <select
              value={empId}
              onChange={(e) => {
                setEmpId(e.target.value);
                const emp = employees.find((x) => String(x.id) === e.target.value);
                // 默认建议目标门店 = 其他某家店，减少一次点击
                if (emp?.storeId) {
                  const alt = stores.find((s) => s.id !== emp.storeId);
                  setToStore(alt ? String(alt.id) : "");
                }
              }}
              className="w-[190px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
            >
              <option value="">请选择…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.storeName ? `（${e.storeName}）` : "（未挂门店）"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">调往门店</label>
            <select
              value={toStore}
              onChange={(e) => setToStore(e.target.value)}
              className="w-[190px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
            >
              <option value="">请选择…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">生效日期（留空 = 立即生效）</label>
            <input
              type="date"
              value={effDate}
              onChange={(e) => setEffDate(e.target.value)}
              className="w-[150px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">原因</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：店长告知调去支援"
              className="w-[200px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-brand-600 px-3 py-1 text-[12.5px] text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "处理中…" : "登记"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
          填了生效日期 = 先挂着不动，到期当天由系统自动改门店；中途店长改口，在下面「待生效」里点「作废」即可，
          <strong>不用再改回门店</strong>。留空 = 当场生效。
        </p>
      </form>

      {/* 待生效 */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/40">
        <div className="border-b border-amber-200 px-3 py-1.5 text-[12px] font-medium text-amber-900">
          待生效调店单（{pending.length}）
        </div>
        {pending.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-slate-400">没有待生效的调店单</div>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-[11px] text-slate-500">
                <th className="px-2 py-1 text-left font-medium">员工</th>
                <th className="px-2 py-1 text-left font-medium">调动</th>
                <th className="w-[90px] px-2 py-1 text-center font-medium">生效日</th>
                <th className="px-2 py-1 text-left font-medium">原因</th>
                <th className="w-[120px] px-2 py-1 text-left font-medium">登记人</th>
                <th className="w-[70px] px-2 py-1 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((o) => (
                <tr key={o.id} className="border-t border-amber-200/70">
                  <td className="px-2 py-1.5">
                    {o.employee.name}
                    <span className="ml-1 text-[11px] text-slate-400">{o.employee.code}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-700">
                    {o.fromStore.name} → <span className="font-medium">{o.toStore.name}</span>
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-slate-600">{o.effectiveDate}</td>
                  <td className="px-2 py-1.5 text-slate-500">{o.reason || "—"}</td>
                  <td className="px-2 py-1.5 text-slate-500">{o.createdBy || "—"}</td>
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setAct({ order: o, kind: "cancel" });
                        setActReason("");
                        setMsg(null);
                      }}
                      className="rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[11.5px] text-amber-800 hover:bg-amber-100"
                    >
                      作废
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 已生效 */}
      {effected.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600">
            已生效（{effected.length}）—— 发现不对可撤销，门店会自动回退
          </div>
          <table className="w-full border-collapse text-[12.5px]">
            <tbody>
              {effected.map((o) => (
                <tr key={o.id} className="border-b border-slate-100 last:border-0">
                  <td className="w-[140px] px-2 py-1.5">
                    {o.employee.name}
                    <span className="ml-1 text-[11px] text-slate-400">{o.employee.code}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-700">
                    {o.fromStore.name} → <span className="font-medium">{o.toStore.name}</span>
                  </td>
                  <td className="w-[90px] px-2 py-1.5 text-center tabular-nums text-slate-500">
                    {o.effectiveDate}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{o.reason || "—"}</td>
                  <td className="w-[70px] px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setAct({ order: o, kind: "reverse" });
                        setActReason("");
                        setMsg(null);
                      }}
                      className="rounded border border-slate-300 px-1.5 py-0.5 text-[11.5px] text-slate-700 hover:bg-slate-100"
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* 已作废 / 已撤销 */}
      {closed.length > 0 ? (
        <details className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-medium text-slate-500">
            已作废 / 已撤销（{closed.length}）—— 点击展开
          </summary>
          <table className="w-full border-collapse text-[12.5px]">
            <tbody>
              {closed.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="w-[140px] px-2 py-1.5 text-slate-600">{o.employee.name}</td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {o.fromStore.name} → {o.toStore.name}
                  </td>
                  <td className="w-[80px] px-2 py-1.5 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge(o.status)}`}>{o.statusLabel}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {o.voidReason || "—"}
                    {o.voidReason ? <span className="ml-1 text-[11px] text-slate-400">（{o.reversedBy ? o.voidedBy : o.reversedBy}）</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      {/* 作废/撤销 确认弹窗 */}
      {act ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <form onSubmit={submitAction} className="w-[420px] rounded-lg bg-white p-4 shadow-xl">
            <div className="text-[14px] font-medium text-slate-800">
              {act.kind === "cancel" ? "作废待生效调店单" : "撤销已生效的调店"}
            </div>
            <div className="mt-2 rounded bg-slate-50 px-2.5 py-2 text-[12px] leading-relaxed text-slate-600">
              {act.kind === "cancel" ? (
                <>
                  <strong>{act.order.employee.name}</strong> 调往「{act.order.toStore.name}」的单
                  （{act.order.effectiveDate} 生效）将被作废。
                  <br />
                  <span className="text-slate-500">该员工门店<strong>不会发生任何变动</strong>，因为还没生效过。</span>
                </>
              ) : (
                <>
                  <strong>{act.order.employee.name}</strong> 的门店将从「{act.order.toStore.name}」
                  <strong>回退到「{act.order.fromStore.name}」</strong>。
                  <br />
                  <span className="text-slate-500">
                    会同时写一条变更记录。如果该员工在生效后又被别人改过门店，系统会拒绝并提示。
                  </span>
                </>
              )}
            </div>
            <div className="mt-2.5 flex flex-col gap-1">
              <label className="text-[11.5px] text-slate-500">
                原因（必填，会记入审计）
              </label>
              <input
                value={actReason}
                onChange={(e) => setActReason(e.target.value)}
                placeholder={act.kind === "cancel" ? "如：店长说不去了，撤回" : "如：登记错门店"}
                className="rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
              />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAct(null)}
                className="rounded border border-slate-300 px-3 py-1 text-[12.5px] text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy}
                className={`rounded px-3 py-1 text-[12.5px] text-white disabled:opacity-50 ${
                  act.kind === "cancel" ? "bg-amber-600 hover:bg-amber-700" : "bg-rose-600 hover:bg-rose-700"
                }`}
              >
                {busy ? "处理中…" : act.kind === "cancel" ? "确认作废" : "确认撤销并回退"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
