"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import type { AutoPreview, RuleRow } from "@/lib/department-rule-service";

interface Option {
  id: number;
  name: string;
}

interface Props {
  stores: Option[];
  departments: Option[];
  positions: Option[];
}

/**
 * 部门自动归属工具
 *
 * 流程：配置规则 → 预览「将修改多少员工」→ 确认后批量更新。
 * 预览与执行走同一套规则匹配，且预览是只读的（可反复点）。
 */
export default function DepartmentAutoPanel({ stores, departments, positions }: Props) {
  const router = useRouter();
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [preview, setPreview] = useState<AutoPreview | null>(null);
  const [overrideExisting, setOverrideExisting] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState("");

  // 新增规则表单
  const [form, setForm] = useState({
    departmentId: "",
    storeId: "",
    positionId: "",
    employeeType: "",
    priority: "100",
    remark: "",
  });

  const loadRules = useCallback(async () => {
    const r = await fetch("/api/department-rules");
    const j = await r.json();
    if (j.ok) setRules(j.data as RuleRow[]);
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const refreshPreview = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/departments/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", overrideExisting }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setPreview(j.data as AutoPreview);
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [overrideExisting]);

  async function addRule() {
    if (!form.departmentId) {
      setMsg({ tone: "warn", text: "请选择要归属的部门" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/department-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentId: Number(form.departmentId),
          storeId: form.storeId ? Number(form.storeId) : null,
          positionId: form.positionId ? Number(form.positionId) : null,
          employeeType: form.employeeType || null,
          priority: Number(form.priority || 100),
          enabled: true,
          remark: form.remark || null,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "新增失败");
      setForm({
        departmentId: "",
        storeId: "",
        positionId: "",
        employeeType: "",
        priority: "100",
        remark: "",
      });
      await loadRules();
      await refreshPreview();
      setMsg({ tone: "ok", text: "规则已新增，下方预览已按新规则重新计算" });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: RuleRow) {
    setBusy(true);
    try {
      await fetch(`/api/department-rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await loadRules();
      await refreshPreview();
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: RuleRow) {
    if (!confirm(`确认删除规则「${rule.departmentName}」？`)) return;
    setBusy(true);
    try {
      await fetch(`/api/department-rules/${rule.id}`, { method: "DELETE" });
      await loadRules();
      await refreshPreview();
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview?.affected) {
      setMsg({ tone: "warn", text: "当前没有会受影响的员工" });
      return;
    }
    const detail = preview.byDepartment.map((d) => `${d.departmentName} ${d.count} 人`).join("；");
    if (
      !confirm(
        `确认批量更新？\n\n将修改 ${preview.affected} 名员工的部门：\n${detail}\n\n` +
          `每次修改都会写入员工变更记录。${overrideExisting ? "（含覆盖已有部门）" : ""}`
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/departments/auto", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "apply",
          overrideExisting,
          // 携带预览时冻结的版本快照 —— 服务端复核，库已变化则 409 要求重新预览
          snapshot: preview.snapshot,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (r.status === 409) {
          setMsg({
            tone: "warn",
            text: j.error + "已为你刷新最新预览，请确认后再次执行。",
          });
          await refreshPreview();
        } else {
          throw new Error(j.error ?? "执行失败");
        }
        return;
      }
      const d = j.data;
      setMsg({
        tone: "ok",
        text: `批量更新完成：匹配 ${d.matched} 人，实际修改 ${d.updated} 人，无变化 ${d.unchanged} 人。部门统计与人员视图已同步刷新。`,
      });
      await refreshPreview();
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {msg && (
        <Alert tone={msg.tone === "ok" ? "success" : msg.tone === "warn" ? "warn" : "error"}>
          {msg.text}
        </Alert>
      )}

      <Card title={`① 归属规则（${rules.length} 条）`}>
        {rules.length === 0 ? (
          <p className="text-[12.5px] text-slate-500">
            还没有规则。规则说明「什么样的人归到哪个部门」，例如「XX店 的 店长 → 运营部」。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-3 py-2 font-medium">优先级</th>
                  <th className="px-3 py-2 font-medium">归属部门</th>
                  <th className="px-3 py-2 font-medium">门店</th>
                  <th className="px-3 py-2 font-medium">岗位</th>
                  <th className="px-3 py-2 font-medium">员工类型（工种含）</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="px-3 py-2 tabular-nums">{r.priority}</td>
                    <td className="px-3 py-2 font-medium text-slate-800">{r.departmentName}</td>
                    <td className="px-3 py-2 text-slate-600">{r.storeName ?? "不限"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.positionName ?? "不限"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.employeeType ?? "不限"}</td>
                    <td className="px-3 py-2">
                      {r.enabled ? <Badge tone="green">启用</Badge> : <Badge tone="slate">停用</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggleRule(r)}>
                          {r.enabled ? "停用" : "启用"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void removeRule(r)}>
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-[12.5px] text-slate-600">
            新增规则：三个维度都可选，未填表示「不限」；已填的维度之间是「且」的关系。
            优先级数字越小越优先。
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            <Field label="归属部门">
              <Select
                value={form.departmentId}
                onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
              >
                <option value="">请选择</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="门店">
              <Select
                value={form.storeId}
                onChange={(e) => setForm((f) => ({ ...f, storeId: e.target.value }))}
              >
                <option value="">不限</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="岗位">
              <Select
                value={form.positionId}
                onChange={(e) => setForm((f) => ({ ...f, positionId: e.target.value }))}
              >
                <option value="">不限</option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="员工类型（工种含）" hint="源数据无独立员工类型字段，按工种原文包含匹配">
              <Input
                placeholder="如：店长"
                value={form.employeeType}
                onChange={(e) => setForm((f) => ({ ...f, employeeType: e.target.value }))}
              />
            </Field>
            <Field label="优先级">
              <Input
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="secondary" disabled={busy} onClick={() => void addRule()}>
              新增规则
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="② 预览：将修改多少员工"
        extra={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12.5px] text-slate-600">
              <input
                type="checkbox"
                checked={overrideExisting}
                onChange={(e) => {
                  setOverrideExisting(e.target.checked);
                  setTimeout(() => void refreshPreview(), 0);
                }}
              />
              同时覆盖已有部门的员工
            </label>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshPreview()}>
              {busy ? "计算中…" : "重新预览"}
            </Button>
          </div>
        }
      >
        {!preview ? (
          <p className="text-[12.5px] text-slate-400">点击「重新预览」查看将受影响的员工数量。</p>
        ) : preview.affected === 0 ? (
          <p className="text-[12.5px] text-slate-500">
            当前规则没有匹配到需要修改的员工（未命中规则 {preview.unmatched} 人）。
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-[13px]">
              <span>
                将修改 <strong className="text-[18px] text-slate-800">{preview.affected}</strong> 人
              </span>
              <span className="text-slate-500">未命中规则 {preview.unmatched} 人</span>
              {overrideExisting && <Badge tone="amber">含覆盖已有部门</Badge>}
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              {preview.byDepartment.map((d) => (
                <span
                  key={d.departmentId}
                  className="rounded bg-brand-50 px-2 py-1 text-[12.5px] text-brand-800"
                >
                  {d.departmentName}：{d.count} 人
                </span>
              ))}
            </div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="px-3 py-2 font-medium">员工编号</th>
                    <th className="px-3 py-2 font-medium">姓名</th>
                    <th className="px-3 py-2 font-medium">门店</th>
                    <th className="px-3 py-2 font-medium">岗位</th>
                    <th className="px-3 py-2 font-medium">建议部门</th>
                    <th className="px-3 py-2 font-medium">命中依据</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.slice(0, 50).map((it) => (
                    <tr key={it.employeeId} className="border-b border-slate-100">
                      <td className="px-3 py-2">{it.employeeCode}</td>
                      <td className="px-3 py-2 font-medium text-slate-800">{it.name}</td>
                      <td className="px-3 py-2 text-slate-600">{it.storeName ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-600">{it.positionName ?? "—"}</td>
                      <td className="px-3 py-2 text-brand-700">{it.departmentName}</td>
                      <td className="px-3 py-2 text-slate-500">{it.matchedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.items.length > 50 && (
                <p className="mt-2 text-[12px] text-slate-400">
                  仅显示前 50 条，共 {preview.affected} 人
                </p>
              )}
            </div>
          </>
        )}
      </Card>

      {preview && preview.affected > 0 && (
        <Card title="③ 确认执行">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="mt-3">
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>
                {busy ? "提交中…" : "确认批量更新部门"}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
