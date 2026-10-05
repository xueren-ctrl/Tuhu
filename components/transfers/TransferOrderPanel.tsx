"use client";

import { useMemo, useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import StorePicker from "@/components/common/StorePicker";

/**
 * 调店单操作区（Stage 9.28 / 9.29）
 *
 * 两个入口：
 *  - 「登记调店」：手动输入员工姓名/工号 → 联想选中 → 显示**当前所在门店** → 选目标门店
 *  - 「作废 / 撤销」：待生效单作废（档案不动）；已生效单撤销（门店自动回退）
 *
 * ⚠️ 交互原则：作废/撤销**必须填原因**（行业惯例：审计要留 why），
 *    确认框里明确写出「会发生什么」，避免误点。
 *
 * ⚠️ Stage 9.29：员工从 500 项下拉改为**手动输入 + 联想搜索**。
 *    门店下拉同理（67 家也不适合翻）。
 *    选人后必须显示**当前所在门店**——否则不知道这个人现在属于哪家店，
 *    也就无法判断该不该调、调去哪里。
 */

/** 联想搜索返回的员工（与 /api/employees 的 rows 形状一致，只取需要的字段） */
type EmpHit = {
  id: number;
  employeeId: string;
  name: string;
  storeName: string | null;
  jobGradeRaw: string | null;
  status: string;
};

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

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "在职",
  RESIGNED: "离职",
  OTHER: "其他",
  CANDIDATE: "候选人",
};

/** 员工联想输入框（手动输入 + 防抖搜索 + 键盘选择） */
function EmpSearch({
  value,
  onPick,
  autoFocus,
}: {
  value: EmpHit | null;
  onPick: (e: EmpHit | null) => void;
  autoFocus?: boolean;
}) {
  const [kw, setKw] = useState("");
  const [hits, setHits] = useState<EmpHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖搜索（Hook 区：以下所有 Hook 必须无条件执行，禁止在它们之前 return）
  useEffect(() => {
    const s = kw.trim();
    if (!s || value) {
      // 已选中员工时输入框是隐藏的，没必要再发请求
      if (!s) setHits([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/employees?keyword=${encodeURIComponent(s)}&pageSize=12&sortBy=name&sortOrder=asc`
        );
        const j = await r.json();
        if (j?.ok) setHits(j.data ?? []);
        else setHits([]);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [kw]);

  // 点外部关闭
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // ---- ⚠️ Hook 区结束，下面才可以写条件 return ----
  // ⚠️⚠️ 这个 return 必须留在**所有 Hook 之后**。
  //     曾经它被写在 useState 之后、useEffect 之前，结果选中员工的瞬间
  //     本次渲染少跑 2 个 Hook → React 抛 "Rendered fewer hooks than expected"
  //     → 整页 Application error。改动此处请跑：npm run check:hooks
  if (value) {
    return (
      // 已选中：两行分层显示，避免「姓名 工号 当前门店」挤成一团
      //   第 1 行：姓名（粗） · 工号（等宽小字） · 职位/状态标签
      //   第 2 行：「当前门店」小标签 + 店名（绿色，超长省略号）
      <div className="flex w-[300px] items-center gap-2 rounded border border-slate-300 bg-slate-50 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 leading-tight">
            <span className="truncate text-[13px] font-medium text-slate-800">{value.name}</span>
            <span className="shrink-0 rounded bg-white px-1 font-mono text-[10.5px] text-slate-500">
              {value.employeeId}
            </span>
            {value.jobGradeRaw ? (
              <span className="shrink-0 text-[11px] text-slate-400">{value.jobGradeRaw}</span>
            ) : null}
            {value.status !== "ACTIVE" ? (
              <span className="shrink-0 rounded bg-slate-200 px-1 text-[10.5px] text-slate-600">
                {STATUS_TEXT[value.status] ?? value.status}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5 leading-tight">
            <span className="shrink-0 text-[11px] text-slate-400">当前门店</span>
            <span
              className={`truncate text-[11.5px] font-medium ${
                value.storeName ? "text-emerald-700" : "text-slate-400"
              }`}
              title={value.storeName ?? "未挂门店"}
            >
              {value.storeName ?? "未挂门店"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onPick(null);
            setKw("");
            setHits([]);
          }}
          className="shrink-0 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 hover:border-rose-300 hover:text-rose-600"
          title="重新选择"
        >
          更换
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative w-[300px]">
      <input
        value={kw}
        autoFocus={autoFocus}
        onChange={(e) => {
          setKw(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || hits.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => (h + 1) % hits.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h - 1 + hits.length) % hits.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            onPick(hits[hi]);
            setKw("");
            setHits([]);
            setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="输入姓名或工号，如：龚峰"
        className="h-[30px] w-full rounded border border-slate-300 px-2 text-[12.5px] outline-none focus:border-brand-500"
      />
      {open && kw.trim() ? (
        <div className="absolute left-0 top-full z-40 mt-0.5 max-h-[260px] w-[340px] overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
          {loading ? (
            <div className="px-2 py-2 text-[12px] text-slate-400">搜索中…</div>
          ) : hits.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-slate-400">没有匹配的员工</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.id}
                type="button"
                onMouseEnter={() => setHi(i)}
                onClick={() => {
                  onPick(h);
                  setKw("");
                  setHits([]);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12.5px] ${
                  i === hi ? "bg-brand-50" : ""
                }`}
              >
                <span className="shrink-0 font-medium text-slate-800">{h.name}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-slate-400">{h.employeeId}</span>
                {h.jobGradeRaw ? (
                  <span className="shrink-0 text-[11px] text-slate-400">{h.jobGradeRaw}</span>
                ) : null}
                {h.status !== "ACTIVE" ? (
                  <span className="shrink-0 rounded bg-slate-100 px-1 text-[10.5px] text-slate-500">
                    {STATUS_TEXT[h.status] ?? h.status}
                  </span>
                ) : null}
                {/* 门店单独做成右侧标签，与姓名/工号在视觉上分开 */}
                <span
                  className={`ml-auto max-w-[150px] shrink-0 truncate rounded px-1.5 py-px text-[11px] ${
                    h.storeName
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-400"
                  }`}
                  title={h.storeName ?? "未挂门店"}
                >
                  {h.storeName ?? "未挂门店"}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function TransferOrderPanel({
  orders,
  stores,
  storeScopeRaw = [],
}: {
  orders: Order[];
  stores: { id: number; name: string }[];
  /** 门店选择范围（Stage 9.30）：在职表 + 南昌3店 的门店及在职人数 */
  storeScopeRaw?: {
    id: number;
    name: string;
    activeCount: number;
    tier?: "inScope" | "manual" | "legacy";
    historyCount?: number;
  }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 登记表单
  const [emp, setEmp] = useState<EmpHit | null>(null);
  const [toStore, setToStore] = useState<{ id: number; name: string } | null>(null);
  const [effDate, setEffDate] = useState("");
  const [reason, setReason] = useState("");

  // 作废/撤销弹窗
  const [act, setAct] = useState<{ order: Order; kind: "cancel" | "reverse" } | null>(null);
  const [actReason, setActReason] = useState("");

  /**
   * 调往门店的候选（Stage 9.30）。
   * ⚠️ 调去一家**只有离职人员**的老店是合法业务（如接手遗留人员），
   *    所以额外提供「更多门店」入口；但默认只给在职 37 + 南昌3店 3 家。
   */
  const storeScope = useMemo(
    () =>
      storeScopeRaw.map((s) => ({
        id: s.id,
        name: s.name,
        activeCount: s.activeCount,
        tier: s.tier,
        historyCount: s.historyCount,
      })),
    [storeScopeRaw]
  );

  const reload = () => startTransition(() => router.refresh());

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!emp) {
      setMsg({ kind: "err", text: "请先搜索并选择员工" });
      return;
    }
    if (!toStore) {
      setMsg({ kind: "err", text: "请选择调往的门店" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: emp.id,
          toStoreId: toStore.id,
          effectiveDate: effDate || null,
          reason: reason || null,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j?.error ?? `保存失败（HTTP ${res.status}）` });
      } else {
        const label = j.data.status === "EFFECTED" ? "已立即生效" : "已登记为待生效";
        setMsg({ kind: "ok", text: `${emp.name}（${emp.storeName ?? "未挂门店"} → ${toStore.name}）${label}，单号 #${j.data.orderId}` });
        setEmp(null); setToStore(null); setEffDate(""); setReason("");
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
              ? `单 #${act.order.id} 已作废，${act.order.employee.name} 的门店未发生任何变动。`
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
            <label className="text-[11px] text-slate-500">员工（输入姓名或工号）</label>
            <EmpSearch
              value={emp}
              onPick={(e) => {
                setEmp(e);
                setToStore(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">
              调往门店（当前：{emp?.storeName ?? "—"}）
            </label>
            <StorePicker
              stores={storeScope}
              allStores={stores}
              value={toStore}
              onChange={setToStore}
              placeholder="输入门店名，如：大坪"
              className="w-[240px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">生效日期（留空 = 立即生效）</label>
            <input
              type="date"
              value={effDate}
              onChange={(e) => setEffDate(e.target.value)}
              className="h-[30px] w-[140px] rounded border border-slate-300 px-2 text-[12.5px] outline-none focus:border-brand-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">原因</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：店长告知调去支援"
              className="h-[30px] w-[180px] rounded border border-slate-300 px-2 text-[12.5px] outline-none focus:border-brand-500"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="h-[30px] rounded bg-brand-600 px-3 text-[12.5px] text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "处理中…" : "登记"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
          搜索框支持姓名或工号，回车或点选即可。选中后会显示该员工<strong>当前所在门店</strong>。
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
                    {o.voidReason ? (
                      <span className="ml-1 text-[11px] text-slate-400">
                        （{o.status === "REVERSED" ? o.reversedBy : o.voidedBy}）
                      </span>
                    ) : null}
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
              <label className="text-[11.5px] text-slate-500">原因（必填，会记入审计）</label>
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
