"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import StorePicker from "@/components/common/StorePicker";
import { formatDate } from "@/lib/format";
import { EMPLOYEE_STATUS_LABEL } from "@/lib/constants";

/**
 * 社保参保名单客户端面板（Stage 9.37）
 *
 * 业务定位：**这是买社保时对着看的那份名单**。
 * 所以交互优先级从高到低是：① 停保/复保（一键）② 一眼看出谁还没关联档案 ③ 门店归属核对。
 */

// ---------- 类型 ----------
interface SiRow {
  id: number;
  sourceRowNo: number;
  name: string;
  seqNo: number | null;
  storeId: number | null;
  storeNameRaw: string | null;
  insuredDate: string | null; // ISO
  datePrecision: string;
  dateRaw: string | null;
  baseAmount: string | null;
  note: string | null;
  insured: boolean;
  /** 关联的员工 id（可能为 null） */
  employeeId: number | null;
  insuredChangedAt: string | null;
  insuredChangedBy: string | null;
  insuredNote: string | null;
  store: { id: number; name: string; status: string } | null;
  employee: {
    id: number;
    employeeId: string;
    name: string;
    status: string;
    store: { name: string } | null;
    resignDate: string | null;
  } | null;
}

interface SiStats {
  total: number;
  insured: number;
  notInsured: number;
  unlinked: number;
  linked: number;
  storeCount: number;
  pendingStoreCount: number;
  pendingStoreNames: string[];
  resignedStillInsured: { id: number; name: string; storeNameRaw: string | null; note: string | null }[];
  activeNotInsured: number;
  monthOnly: number;
}

interface StoreMapping {
  id: number;
  rawName: string;
  storeId: number | null;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  note: string | null;
  decidedBy: string | null;
  peopleCount: number;
  candidates: { id: number; name: string; status: string }[];
  store: { id: number; name: string } | null;
}

// ---------- 主面板 ----------
export default function SocialInsurancePanel({
  storeScope,
  initialStats,
}: {
  storeScope: {
    id: number;
    name: string;
    activeCount: number;
    tier?: "inScope" | "manual" | "legacy";
    historyCount?: number;
  }[];
  initialStats: SiStats;
}) {
  const router = useRouter();
  const [stats, setStats] = useState<SiStats>(initialStats);
  const [rows, setRows] = useState<SiRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // 筛选
  const [insured, setInsured] = useState<"all" | "yes" | "no">("all");
  const [storeFilter, setStoreFilter] = useState("");
  const [kw, setKw] = useState("");
  const [sort, setSort] = useState("insured");
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const [onlyResigned, setOnlyResigned] = useState(false);

  const [tab, setTab] = useState<"list" | "stores">("list");
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const p = new URLSearchParams();
      if (insured !== "all") p.set("insured", insured);
      if (storeFilter) p.set("storeId", storeFilter);
      if (kw.trim()) p.set("keyword", kw.trim());
      if (sort) p.set("sort", sort);
      if (onlyUnlinked) p.set("unlinked", "1");
      if (onlyResigned) p.set("needReview", "1");
      p.set("page", String(page));
      const [listRes, statRes] = await Promise.all([
        fetch(`/api/social-insurance?${p}`, { cache: "no-store" }),
        fetch("/api/social-insurance?stats=1", { cache: "no-store" }),
      ]);
      const listJson = await listRes.json();
      const statJson = await statRes.json();
      if (!listRes.ok || !listJson.ok) throw new Error(listJson.error ?? "读取失败");
      if (statJson.ok) setStats(statJson.data);
      setRows(listJson.data.items);
      setTotal(listJson.data.total);
      setPageCount(listJson.data.pageCount);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [insured, storeFilter, kw, sort, onlyUnlinked, onlyResigned, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = async () => {
    await load();
    router.refresh();
  };

  // ---------- 筛选快捷入口 ----------
  const jump = (next: Partial<{ insured: "all" | "yes" | "no"; onlyUnlinked: boolean; onlyResigned: boolean }>) => {
    setInsured(next.insured ?? "all");
    setOnlyUnlinked(next.onlyUnlinked ?? false);
    setOnlyResigned(next.onlyResigned ?? false);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* ---------- 需要处理 ---------- */}
      {(stats.unlinked > 0 || stats.resignedStillInsured.length > 0 || stats.pendingStoreCount > 0) && (
        <div className="grid gap-3 lg:grid-cols-3">
          {stats.resignedStillInsured.length > 0 ? (
            <Alert tone="warn" title={`${stats.resignedStillInsured.length} 人已离职但仍在参保名单里`}>
              <div className="mb-1 text-[11.5px] text-slate-600">
                这些人库中状态是「离职」。如果已经停保了，请点该行的「停保」。
              </div>
              <div className="flex flex-wrap gap-1">
                {stats.resignedStillInsured.slice(0, 12).map((r) => (
                  <Badge key={r.id} tone="amber">
                    {r.name}
                    {r.note ? `· ${r.note}` : ""}
                  </Badge>
                ))}
                {stats.resignedStillInsured.length > 12 ? (
                  <span className="text-[11px] text-slate-500">…等 {stats.resignedStillInsured.length} 人</span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => jump({ insured: "yes", onlyResigned: true })}
                className="mt-2 text-[11.5px] text-brand-600 underline hover:text-brand-700"
              >
                只看这批人 →
              </button>
            </Alert>
          ) : null}

          {stats.unlinked > 0 ? (
            <Alert tone="info" title={`${stats.unlinked} 人未关联到员工档案`}>
              <div className="mb-1 text-[11.5px] text-slate-600">
                名单上有、但员工库里查不到（可能是没建档，或不在本系统里）。买保险不受影响，只是查不到工号。
              </div>
              <button
                type="button"
                onClick={() => jump({ onlyUnlinked: true })}
                className="text-[11.5px] text-brand-600 underline hover:text-brand-700"
              >
                只看这批人 →
              </button>
            </Alert>
          ) : null}

          {stats.pendingStoreCount > 0 ? (
            <Alert tone="warn" title={`${stats.pendingStoreCount} 家门店名还没确认`}>
              <div className="mb-1 text-[11.5px] text-slate-600">
                名单里的店名和系统里的门店名有差异，确认后这些人才会归到正确门店。
              </div>
              <button
                type="button"
                onClick={() => setTab("stores")}
                className="text-[11.5px] text-brand-600 underline hover:text-brand-700"
              >
                去逐条确认 →
              </button>
            </Alert>
          ) : null}
        </div>
      )}

      {/* ---------- 统计卡 ---------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="名单总人数" value={stats.total} sub={`${stats.storeCount} 家门店`} />
        <StatTile
          label="参保中"
          value={stats.insured}
          tone="green"
          onClick={() => jump({ insured: "yes" })}
          active={insured === "yes"}
        />
        <StatTile
          label="已停保"
          value={stats.notInsured}
          tone="gray"
          onClick={() => jump({ insured: "no" })}
          active={insured === "no"}
        />
        <StatTile label="在职但停保" value={stats.activeNotInsured} tone={stats.activeNotInsured > 0 ? "amber" : "gray"} sub="在册没参保" />
        <StatTile label="已离职仍在保" value={stats.resignedStillInsured.length} tone={stats.resignedStillInsured.length > 0 ? "red" : "gray"} />
        <StatTile label="日期只到月" value={stats.monthOnly} tone={stats.monthOnly > 0 ? "amber" : "gray"} sub="精度待确认" />
      </div>

      {/* ---------- 标签页 ---------- */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        {([
          ["list", `参保名单（${stats.total}）`],
          ["stores", `门店名确认${stats.pendingStoreCount ? `（${stats.pendingStoreCount}）` : ""}`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === k
                ? "border-brand-600 font-medium text-brand-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "stores" ? (
        <StoreMappingPanel onDone={refreshAll} />
      ) : (
        <>
          {/* ---------- 筛选栏 ---------- */}
          <Card className="p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="关键词" className="w-[200px]">
                <Input
                  value={kw}
                  onChange={(e) => {
                    setKw(e.target.value);
                    setPage(1);
                  }}
                  placeholder="姓名 / 门店 / 备注 / 工号"
                />
              </Field>
              <Field label="门店" className="w-[220px]">
                <StorePicker
                  stores={storeScope}
                  value={storeFilter ? { id: Number(storeFilter), name: storeScope.find((s) => String(s.id) === storeFilter)?.name ?? "" } : null}
                  onChange={(s) => {
                    setStoreFilter(s ? String(s.id) : "");
                    setPage(1);
                  }}
                  placeholder="全部门店"
                  emptyLabel="全部门店"
                />
              </Field>
              <Field label="排序" className="w-[150px]">
                <Select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
                  <option value="insured">参保优先</option>
                  <option value="name">按姓名</option>
                  <option value="store">按门店</option>
                  <option value="date">按参保日期</option>
                  <option value="status">按员工状态</option>
                </Select>
              </Field>
              <label className="flex h-9 items-center gap-1.5 text-[12.5px] text-slate-700">
                <input
                  type="checkbox"
                  checked={onlyUnlinked}
                  onChange={(e) => { setOnlyUnlinked(e.target.checked); setPage(1); }}
                />
                只看未关联
              </label>
              <label className="flex h-9 items-center gap-1.5 text-[12.5px] text-slate-700">
                <input
                  type="checkbox"
                  checked={onlyResigned}
                  onChange={(e) => { setOnlyResigned(e.target.checked); setPage(1); }}
                />
                只看已离职仍参保
              </label>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => { setKw(""); setStoreFilter(""); setSort("insured"); setOnlyUnlinked(false); setOnlyResigned(false); setInsured("all"); setPage(1); }}>
                  重置
                </Button>
                <Button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "收起" : "+ 新增参保"}</Button>
              </div>
            </div>
          </Card>

          {showAdd ? <AddEntryForm storeScope={storeScope} onDone={async () => { setShowAdd(false); await refreshAll(); }} /> : null}

          {err ? <Alert tone="error" title="读取失败">{err}</Alert> : null}

          {/* ---------- 名单表格 ---------- */}
          <Card className="overflow-x-auto p-0">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11.5px] text-slate-500">
                  <th className="px-3 py-2 font-medium">参保</th>
                  <th className="px-3 py-2 font-medium">姓名</th>
                  <th className="px-3 py-2 font-medium">门店</th>
                  <th className="px-3 py-2 font-medium">参保日期</th>
                  <th className="px-3 py-2 font-medium">缴费基数</th>
                  <th className="px-3 py-2 font-medium">员工档案</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-3 py-2">
                      <InsuredToggle row={r} onDone={refreshAll} />
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                    <td className="px-3 py-2">
                      {r.store ? (
                        <span className="text-slate-700">{r.store.name}</span>
                      ) : (
                        <span className="text-amber-700" title="门店名与系统门店对不上，去「门店名确认」页签处理">
                          {r.storeNameRaw ?? "—"}
                          <span className="ml-1 text-[10.5px]">（待确认）</span>
                        </span>
                      )}
                      {r.store && r.storeNameRaw && r.store.name !== r.storeNameRaw ? (
                        <span className="ml-1 text-[10.5px] text-slate-400">原表：{r.storeNameRaw}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.insuredDate ? (
                        <span className="text-slate-700">
                          {formatDate(r.insuredDate)}
                          {r.datePrecision === "MONTH" ? (
                            <span className="ml-1 text-[10.5px] text-amber-700" title={`Excel 原文只写到月：${r.dateRaw ?? ""}`}>
                              仅到月
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.baseAmount ? <span className="font-mono text-slate-700">{r.baseAmount}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      {r.employee ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <a
                            href={`/employees/${r.employee.id}`}
                            className="text-brand-600 hover:underline"
                            title="打开员工档案"
                          >
                            {r.employee.employeeId}
                          </a>
                          <span className="text-slate-600">{r.employee.name}</span>
                          <Badge tone={r.employee.status === "RESIGNED" ? "red" : "green"}>
                            {EMPLOYEE_STATUS_LABEL[r.employee.status] ?? r.employee.status}
                          </Badge>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => jump({ onlyUnlinked: true })}
                          className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
                          title="员工库里查无此人，可手动关联或忽略"
                        >
                          未关联 ▸
                        </button>
                      )}
                    </td>
                    <td className="max-w-[180px] px-3 py-2 text-slate-600">
                      {r.note ? <span title={r.note}>{r.note}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <RowActions row={r} onDone={refreshAll} />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-[13px] text-slate-400">
                      没有符合条件的记录
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>

          {/* ---------- 分页 ---------- */}
          {pageCount > 1 ? (
            <div className="flex items-center justify-between text-[12px] text-slate-600">
              <span>
                共 {total} 人，第 {page} / {pageCount} 页
              </span>
              <div className="flex gap-1.5">
                <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(1)}>首页</Button>
                <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                <Button variant="ghost" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>下一页</Button>
                <Button variant="ghost" disabled={page >= pageCount} onClick={() => setPage(pageCount)}>末页</Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------- 统计小卡 ----------
function StatTile({
  label, value, sub, tone, onClick, active,
}: {
  label: string; value: number; sub?: string;
  tone?: "green" | "amber" | "red" | "gray";
  onClick?: () => void; active?: boolean;
}) {
  const toneCls =
    tone === "green" ? "text-emerald-600"
    : tone === "amber" ? "text-amber-600"
    : tone === "red" ? "text-rose-600"
    : "text-slate-400";
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={`rounded-lg border bg-white px-3 py-2.5 text-left transition-colors ${
        active ? "border-brand-500 ring-1 ring-brand-200" : "border-slate-200"
      } ${onClick ? "hover:border-brand-400" : ""}`}
    >
      <div className="text-[11.5px] text-slate-500">{label}</div>
      <div className={`text-[21px] font-semibold leading-tight ${toneCls}`}>{value}</div>
      {sub ? <div className="text-[10.5px] text-slate-400">{sub}</div> : null}
    </Comp>
  );
}

// ---------- 参保开关 ----------
function InsuredToggle({ row, onDone }: { row: SiRow; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const call = async (insured: boolean, reason: string | null) => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/social-insurance/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "insured", insured, note: reason }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? "操作失败");
      setAsking(false);
      setNote("");
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (asking) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-1">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="原因（必填）"
            className="h-7 w-[110px] rounded border border-slate-300 px-1.5 text-[11.5px]"
          />
          <Button disabled={busy} onClick={() => call(false, note.trim() || "手动停保")}>确认</Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>取消</Button>
        </div>
        {err ? <span className="text-[10.5px] text-rose-600">{err}</span> : null}
      </div>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => (row.insured ? setAsking(true) : call(true, null))}
          className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
            row.insured
              ? "border-emerald-500 bg-emerald-50 font-medium text-emerald-700"
              : "border-slate-200 bg-white text-slate-400 hover:border-slate-300"
          }`}
          title={row.insured ? "点击停保" : "点击复保"}
        >
          {row.insured ? "参保中" : "已停保"}
        </button>
      </span>
      {row.insuredChangedAt ? (
        <span
          className="text-[10px] text-slate-400"
          title={row.insuredNote ?? ""}
        >
          {row.insured ? row.insuredChangedBy && row.insuredNote ? `${row.insuredNote}` : "" : `停保：${row.insuredNote ?? ""}`}
        </span>
      ) : null}
      {err && !asking ? <span className="text-[10.5px] text-rose-600">{err}</span> : null}
    </span>
  );
}

// ---------- 行操作：改日期 / 关联员工 ----------
function RowActions({ row, onDone }: { row: SiRow; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<null | "date" | "emp">(null);
  const [dateStr, setDateStr] = useState(row.insuredDate ? formatDate(row.insuredDate) : "");
  const [precision, setPrecision] = useState<"DAY" | "MONTH">(row.datePrecision === "MONTH" ? "MONTH" : "DAY");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/social-insurance/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? "操作失败");
      setMode(null);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "date") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-1">
          <input
            type={precision === "MONTH" ? "month" : "date"}
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="h-7 w-[120px] rounded border border-slate-300 px-1.5 text-[11.5px]"
          />
          <select
            value={precision}
            onChange={(e) => setPrecision(e.target.value as "DAY" | "MONTH")}
            className="h-7 rounded border border-slate-300 px-1 text-[11.5px]"
          >
            <option value="DAY">具体到日</option>
            <option value="MONTH">只到月</option>
          </select>
          <Button disabled={busy} onClick={() => call({ action: "date", date: dateStr, precision })}>保存</Button>
          <Button variant="ghost" onClick={() => setMode(null)}>取消</Button>
        </div>
        {err ? <span className="text-[10.5px] text-rose-600">{err}</span> : null}
      </div>
    );
  }

  if (mode === "emp") {
    return (
      <EmployeeLinker
        row={row}
        busy={busy}
        err={err}
        onCancel={() => setMode(null)}
        onPick={(employeeId) => call({ action: "link-employee", employeeId })}
      />
    );
  }

  return (
    <span className="flex gap-1">
      <button type="button" onClick={() => setMode("date")} className="text-[11.5px] text-brand-600 hover:underline">
        改日期
      </button>
      <button type="button" onClick={() => setMode("emp")} className="text-[11.5px] text-brand-600 hover:underline">
        {row.employee ? "换关联" : "关联员工"}
      </button>
    </span>
  );
}

// ---------- 员工关联（手动输入联想） ----------
function EmployeeLinker({
  row, busy, err, onCancel, onPick,
}: {
  row: SiRow; busy: boolean; err: string;
  onCancel: () => void;
  onPick: (employeeId: number | null) => void;
}) {
  const [kw, setKw] = useState("");
  const [hits, setHits] = useState<{ id: number; name: string; employeeId: string; status: string; store: { name: string } | null }[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = kw.trim();
    if (!s) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/social-insurance/stores?search=${encodeURIComponent(s)}`, { cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      if (d.ok) {
        setHits(d.data);
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [kw]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <div ref={boxRef} className="relative">
          <input
            autoFocus
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="输入姓名/工号/手机号"
            className="h-7 w-[150px] rounded border border-slate-300 px-1.5 text-[11.5px]"
          />
          {open && hits.length > 0 ? (
            <div className="absolute left-0 top-8 z-20 max-h-[220px] w-[280px] overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(h.id)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11.5px] hover:bg-brand-50"
                >
                  <span className="font-medium text-slate-800">{h.name}</span>
                  <span className="font-mono text-[10.5px] text-slate-400">{h.employeeId}</span>
                  <span className="text-[10.5px] text-slate-500">{h.store?.name ?? "无门店"}</span>
                  <Badge tone={h.status === "RESIGNED" ? "red" : "green"} className="ml-auto">
                    {EMPLOYEE_STATUS_LABEL[h.status] ?? h.status}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        {row.employeeId ? (
          <Button variant="ghost" disabled={busy} onClick={() => onPick(null)} title="解除关联（不删除记录）">
            解除
          </Button>
        ) : null}
      </div>
      {row.employee ? (
        <span className="text-[10.5px] text-slate-400">
          当前：{row.employee.name}（{row.employee.employeeId}）
        </span>
      ) : (
        <span className="text-[10.5px] text-slate-400">找不到可直接跳过，不影响买保险</span>
      )}
      {err ? <span className="text-[10.5px] text-rose-600">{err}</span> : null}
    </div>
  );
}

// ---------- 门店名确认 ----------
function StoreMappingPanel({ onDone }: { onDone: () => Promise<void> }) {
  const [data, setData] = useState<{ items: StoreMapping[]; allStores: { id: number; name: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/social-insurance?stores=1", { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      setErr(d.error ?? "读取失败");
      return;
    }
    setData(d.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: number, storeId: number | null, status: "CONFIRMED" | "REJECTED", note: string) => {
    setBusyId(id);
    setErr("");
    try {
      const res = await fetch("/api/social-insurance/stores", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, storeId, status, note }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? "操作失败");
      await load();
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (!data) return <Card className="p-6 text-center text-[13px] text-slate-400">读取中…</Card>;

  const pending = data.items.filter((m) => m.status === "PENDING");
  const done = data.items.filter((m) => m.status !== "PENDING");

  return (
    <div className="space-y-3">
      <Alert tone="info" title="为什么要你逐条确认">
        名单里的店名和系统里的门店名有 15 家对不上（例如名单写「塘厦林村新阳店」、系统里是「塘厦林村新阳路店」）。
        挂错门店会导致你在人员统计里看到错的数据，但**不影响买保险**（保险是按人买的）。
        所以这里只做提示，确认后名单里这家的人才会在统计里归到正确门店。
      </Alert>
      {err ? <Alert tone="error" title="操作失败">{err}</Alert> : null}

      <Card className="p-0">
        <div className="border-b border-slate-200 px-3 py-2 text-[12.5px] font-medium text-slate-700">
          待确认 {pending.length} 家
        </div>
        <div className="divide-y divide-slate-100">
          {pending.map((m) => (
            <MappingRow key={m.id} m={m} allStores={data.allStores} busy={busyId === m.id} onDecide={decide} />
          ))}
          {pending.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-slate-400">全部确认完毕 ✓</div>
          ) : null}
        </div>
      </Card>

      {done.length > 0 ? (
        <Card className="p-0">
          <div className="border-b border-slate-200 px-3 py-2 text-[12.5px] font-medium text-slate-700">
            已确认 {done.length} 家（可点「改」重新选择）
          </div>
          <div className="divide-y divide-slate-100">
            {done.map((m) => (
              <MappingRow key={m.id} m={m} allStores={data.allStores} busy={busyId === m.id} onDecide={decide} />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function MappingRow({
  m, allStores, busy, onDecide,
}: {
  m: StoreMapping;
  allStores: { id: number; name: string }[];
  busy: boolean;
  onDecide: (id: number, storeId: number | null, status: "CONFIRMED" | "REJECTED", note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(m.storeId);
  const [note, setNote] = useState("");

  const suggested = useMemo(
    () => m.candidates[0]?.id ?? m.storeId ?? null,
    [m.candidates, m.storeId]
  );

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800">{m.rawName}</span>
        <Badge tone="gray">{m.peopleCount} 人</Badge>
        {m.status === "CONFIRMED" && m.store ? (
          <span className="text-[12px] text-emerald-700">→ {m.store.name}</span>
        ) : null}
        {m.status === "REJECTED" ? <span className="text-[12px] text-slate-400">不对应系统门店</span> : null}
        {m.status === "PENDING" && m.candidates.length > 0 ? (
          <span className="text-[11.5px] text-amber-700">
            候选：{m.candidates.map((c) => c.name).join(" / ")}
          </span>
        ) : null}
        {m.status === "PENDING" && m.candidates.length === 0 ? (
          <span className="text-[11.5px] text-slate-400">系统里找不到相近门店</span>
        ) : null}
        {m.decidedBy ? <span className="text-[11px] text-slate-400">（{m.decidedBy}）</span> : null}
        <div className="ml-auto flex gap-1.5">
          {m.status === "PENDING" && suggested ? (
            <Button
              disabled={busy}
              onClick={() => onDecide(m.id, suggested, "CONFIRMED", m.candidates[0] ? `确认对应「${m.candidates[0].name}」` : "")}
            >
              就是 {m.candidates[0]?.name ?? "这家"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => { setOpen((v) => !v); setPick(m.storeId ?? suggested); }}>
            {open ? "收起" : m.status === "PENDING" ? "自己选" : "改"}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-slate-50 p-2">
          <select
            value={pick ?? ""}
            onChange={(e) => setPick(e.target.value ? Number(e.target.value) : null)}
            className="h-8 min-w-[200px] rounded border border-slate-300 bg-white px-2 text-[12px]"
          >
            <option value="">（不对应任何门店）</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注原因（可选）"
            className="h-8 w-[180px] rounded border border-slate-300 bg-white px-2 text-[12px]"
          />
          <Button
            disabled={busy || !pick}
            onClick={() => onDecide(m.id, pick, "CONFIRMED", note)}
          >
            确认
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onDecide(m.id, null, "REJECTED", note || "该店不在系统门店主数据中")}
          >
            不对应门店
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- 新增参保 ----------
function AddEntryForm({
  storeScope,
  onDone,
}: {
  storeScope: {
    id: number;
    name: string;
    activeCount: number;
    tier?: "inScope" | "manual" | "legacy";
    historyCount?: number;
  }[];
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [store, setStore] = useState<{ id: number; name: string } | null>(null);
  const [dateStr, setDateStr] = useState("");
  const [precision, setPrecision] = useState<"DAY" | "MONTH">("DAY");
  const [base, setBase] = useState("5510");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim()) {
      setErr("姓名必填");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/social-insurance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          storeId: store?.id ?? null,
          storeNameRaw: store?.name ?? null,
          insuredDate: dateStr || null,
          datePrecision: precision,
          baseAmount: base || null,
          note: note || null,
          insured: true,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? "保存失败");
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-3">
      <div className="mb-2 text-[12.5px] font-medium text-slate-700">新增参保人员</div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="姓名" required className="w-[140px]">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="必填" />
        </Field>
        <Field label="门店" className="w-[220px]">
          <StorePicker
            stores={storeScope}
            value={store}
            onChange={setStore}
            placeholder="输入门店名"
            emptyLabel="（不指定）"
          />
        </Field>
        <Field label="参保日期" className="w-[150px]">
          <Input
            type={precision === "MONTH" ? "month" : "date"}
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </Field>
        <Field label="精度" className="w-[100px]">
          <Select value={precision} onChange={(e) => setPrecision(e.target.value as "DAY" | "MONTH")}>
            <option value="DAY">具体到日</option>
            <option value="MONTH">只到月</option>
          </Select>
        </Field>
        <Field label="缴费基数" className="w-[100px]">
          <Input value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
        <Field label="备注" className="w-[160px]">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
        </Field>
        <Button disabled={busy} onClick={submit}>{busy ? "保存中…" : "保存"}</Button>
      </div>
      {err ? <div className="mt-2 text-[12px] text-rose-600">{err}</div> : null}
    </Card>
  );
}
