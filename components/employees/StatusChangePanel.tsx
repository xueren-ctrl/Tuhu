"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Select } from "@/components/ui";
import {
  EMPLOYEE_STATUS_LABEL,
  EMPLOYEE_STATUS_OPTIONS,
  EMPLOYEE_STATUS_TONE,
} from "@/lib/constants";
import { STATUS_SHEETS, SHEET_LABEL } from "@/lib/sheet-fields";

/**
 * 更改员工状态（客户端交互）
 *
 * 勾选员工 → 选目标状态 → 实时显示「会从哪些表消失 / 会出现在哪些表」→ 确认执行。
 * 执行后自动刷新页面（表格与各「表」的人数都会跟着变）。
 */

export interface StatusRow {
  id: number;
  employeeId: string;
  name: string;
  status: string;
  storeName: string | null;
  positionName: string | null;
  hireDate: string | null;
}

const sheetNames = (status: string) =>
  (STATUS_SHEETS[status] ?? []).map((s) => SHEET_LABEL[s] ?? s);

export default function StatusChangePanel({ rows }: { rows: StatusRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "warn"; text: string } | null>(null);

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  const impact = useMemo(() => {
    if (!target || selected.length === 0) return null;
    const leave = new Map<string, number>();
    const join = new Map<string, number>();
    for (const r of rows) {
      if (!selected.includes(r.id)) continue;
      if (r.status === target) continue;
      const from = new Set(STATUS_SHEETS[r.status] ?? []);
      const to = new Set(STATUS_SHEETS[target] ?? []);
      for (const s of from) if (!to.has(s)) leave.set(s, (leave.get(s) ?? 0) + 1);
      for (const s of to) if (!from.has(s)) join.set(s, (join.get(s) ?? 0) + 1);
    }
    return { leave: [...leave.entries()], join: [...join.entries()] };
  }, [rows, selected, target]);

  const willChange = rows.filter((r) => selected.includes(r.id) && r.status !== target).length;

  async function apply() {
    if (!target) return setMsg({ tone: "warn", text: "请先选择要改成什么状态" });
    if (selected.length === 0) return setMsg({ tone: "warn", text: "请先勾选要改状态的员工" });
    if (willChange === 0) return setMsg({ tone: "warn", text: "所选员工的状态已经是目标状态，无需修改" });
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/employees/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected, status: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setMsg({ tone: "error", text: data.error ?? `执行失败（HTTP ${res.status}）` });
        return;
      }
      const failed = (data.failed ?? []) as { id: number; error: string }[];
      setMsg({
        tone: failed.length ? "warn" : "success",
        text: `已把 ${data.changed} 人的状态改为「${EMPLOYEE_STATUS_LABEL[target]}」，跳过 ${data.skipped} 人${
          failed.length ? `，失败 ${failed.length} 人：${failed[0].error}` : ""
        }。`,
      });
      setSelected([]);
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: "执行失败：" + (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}

      {/* 操作条 */}
      <div className="panel sticky top-0 z-10 flex flex-wrap items-center gap-3 px-3.5 py-3">
        <span className="text-[12.5px] text-slate-600">
          已选 <strong className="text-slate-800">{selected.length}</strong> 人
          {willChange > 0 ? <span className="text-slate-400">（其中 {willChange} 人需要改动）</span> : null}
        </span>
        <span className="text-[12.5px] text-slate-500">改为</span>
        <Select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="h-8 w-[170px]"
        >
          <option value="">选择目标状态…</option>
          {EMPLOYEE_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {target ? (
          <span className="text-[12px] text-slate-500">
            改后出现在：<strong className="text-slate-700">{sheetNames(target).join(" / ") || "不出现在任何表"}</strong>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setSelected([])} disabled={busy || selected.length === 0}>
            清空选择
          </Button>
          <Button size="sm" variant="primary" onClick={apply} loading={busy} disabled={selected.length === 0 || !target}>
            确认更改
          </Button>
        </div>
      </div>

      {/* 影响预览 */}
      {impact ? (
        <div className="panel px-3.5 py-3 text-[12.5px] leading-relaxed">
          <div className="mb-1 font-medium text-slate-700">执行后会有这些变化</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-600">
            <span>
              从表里移出：
              {impact.leave.length === 0 ? (
                <span className="text-slate-400">无</span>
              ) : (
                impact.leave.map(([s, n]) => (
                  <span key={s} className="mr-2">
                    {SHEET_LABEL[s] ?? s} <span className="text-red-600">-{n}</span>
                  </span>
                ))
              )}
            </span>
            <span>
              进入表：
              {impact.join.length === 0 ? (
                <span className="text-slate-400">无</span>
              ) : (
                impact.join.map(([s, n]) => (
                  <span key={s} className="mr-2">
                    {SHEET_LABEL[s] ?? s} <span className="text-emerald-600">+{n}</span>
                  </span>
                ))
              )}
            </span>
          </div>
          <div className="mt-1 text-[11.5px] text-slate-400">
            「数据库」表包含全部员工，不受状态影响；「招聘面试登记表」「薪资表」包含所有已入职/离职类人员。
          </div>
        </div>
      ) : null}

      {/* 员工列表 */}
      <div className="panel overflow-hidden p-0">
        <div className="max-h-[calc(100vh-330px)] overflow-auto">
          <table className="grid-table w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] font-medium text-slate-500">
                <th className="sticky left-0 top-0 z-20 w-[42px] border-b border-[var(--hr-border)] bg-[#f7f9fc] px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? rows.map((r) => r.id) : [])
                    }
                    className="h-3.5 w-3.5"
                  />
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  员工编号
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  姓名
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  当前状态
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  现在出现在
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  门店
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  职位
                </th>
                <th className="sticky top-0 z-10 border-b border-[var(--hr-border)] bg-[#f7f9fc] px-3 py-2">
                  入职日期
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-[13px] text-slate-400">
                    没有符合条件的员工
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const checked = selected.includes(r.id);
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelected((s) => (checked ? s.filter((x) => x !== r.id) : [...s, r.id]))}
                      className={`cursor-pointer ${i % 2 ? "bg-slate-50/50" : "bg-white"} ${
                        checked ? "bg-brand-50" : "hover:bg-brand-50/60"
                      }`}
                    >
                      <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {}}
                          className="h-3.5 w-3.5"
                        />
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 font-mono text-[11.5px] text-slate-500">
                        {r.employeeId}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-800">
                        {r.name}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5">
                        <Badge tone={EMPLOYEE_STATUS_TONE[r.status] ?? "gray"}>
                          {EMPLOYEE_STATUS_LABEL[r.status] ?? r.status}
                        </Badge>
                      </td>
                      <td className="border-b border-slate-100 px-3 py-1.5 text-[12px] text-slate-500">
                        {sheetNames(r.status).join(" / ") || "（不出现在任何表）"}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-600">
                        {r.storeName || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-600">
                        {r.positionName || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-500">
                        {r.hireDate || <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
