"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "@/components/ui";

interface DepartmentRow {
  id: number;
  name: string;
  code: string | null;
  deptType: string | null;
  managerName: string | null;
  sortOrder: number;
  status: string;
  remark: string | null;
  employeeCount: number;
}

const EMPTY = {
  name: "",
  code: "",
  deptType: "",
  managerName: "",
  sortOrder: "0",
  status: "ACTIVE",
  remark: "",
};

const TYPE_OPTIONS = ["运营", "职能", "技术", "门店支持", "其他"];

/** 部门管理：新增 / 编辑 / 停用 */
export default function DepartmentManager() {
  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (keyword.trim()) params.set("keyword", keyword.trim());
      if (statusFilter) params.set("status", statusFilter);
      params.set("includeInactive", "true");
      const res = await fetch(`/api/departments?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setRows(json.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [keyword, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY });
    setError("");
    setOpen(true);
  };

  const openEdit = (r: DepartmentRow) => {
    setEditing(r);
    setForm({
      name: r.name,
      code: r.code ?? "",
      deptType: r.deptType ?? "",
      managerName: r.managerName ?? "",
      sortOrder: String(r.sortOrder ?? 0),
      status: r.status,
      remark: r.remark ?? "",
    });
    setError("");
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("部门名称必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = { ...form };
      for (const k of Object.keys(payload)) if (payload[k] === "") payload[k] = null;
      payload.status = form.status;
      payload.sortOrder = Number(form.sortOrder) || 0;

      const res = await fetch(editing ? `/api/departments/${editing.id}` : "/api/departments", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "保存失败");
      setOpen(false);
      setMsg(editing ? "部门已更新" : "部门已新增");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (r: DepartmentRow) => {
    const next = r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    if (
      !window.confirm(
        next === "INACTIVE"
          ? `确认停用部门「${r.name}」？\n停用后不影响已关联的 ${r.employeeCount} 名员工档案，只是不再出现在新表单的下拉选项中。`
          : `确认启用部门「${r.name}」？`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/departments/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      setMsg(next === "ACTIVE" ? "部门已启用" : "部门已停用");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && !open ? <Alert tone="error">{error}</Alert> : null}
      {msg ? <Alert tone="success">{msg}</Alert> : null}

      <Card
        title={`部门管理（${rows.length}）`}
        extra={
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索部门名称 / 编码 / 类型"
              className="h-8 w-[230px] text-[12px]"
            />
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 w-[110px] text-[12px]"
            >
              <option value="">全部状态</option>
              <option value="ACTIVE">启用</option>
              <option value="INACTIVE">停用</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              刷新
            </Button>
            <Button size="sm" variant="primary" onClick={openCreate}>
              ＋ 新增部门
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="px-4 py-12 text-center text-[13px] text-slate-400">加载中…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="暂无部门数据"
            desc="可以手动新增部门，或先执行 npx tsx scripts/migrate-departments.ts 从 Excel 带出部门。"
            action={
              <Button variant="primary" onClick={openCreate}>
                ＋ 新增部门
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium w-[64px]">排序</th>
                  <th className="px-3 py-2.5 font-medium">部门名称</th>
                  <th className="px-3 py-2.5 font-medium w-[90px]">编码</th>
                  <th className="px-3 py-2.5 font-medium w-[100px]">类型</th>
                  <th className="px-3 py-2.5 font-medium w-[100px]">负责人</th>
                  <th className="px-3 py-2.5 font-medium w-[90px]">部门人数</th>
                  <th className="px-3 py-2.5 font-medium w-[80px]">状态</th>
                  <th className="px-3 py-2.5 font-medium max-w-[200px]">备注</th>
                  <th className="px-4 py-2.5 font-medium w-[150px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="text-[12.5px]">
                    <td className="px-4 py-2 tabular-nums text-slate-400">{r.sortOrder}</td>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-slate-500">{r.code ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.deptType ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.managerName ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">
                      <Link
                        href={`/employees/views/departments?departmentId=${r.id}`}
                        className="text-brand-600 hover:underline"
                      >
                        {r.employeeCount}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "ACTIVE" ? (
                        <Badge tone="green">启用</Badge>
                      ) : (
                        <Badge tone="slate">停用</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[200px] truncate text-slate-500" title={r.remark ?? ""}>
                      {r.remark ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className={r.status === "ACTIVE" ? "text-red-600" : "text-emerald-600"}
                          onClick={() => void toggleStatus(r)}
                          disabled={busy}
                        >
                          {r.status === "ACTIVE" ? "停用" : "启用"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑部门：${editing.name}` : "新增部门"}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={save} loading={busy}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
          <Field label="部门名称" required className="sm:col-span-2">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：运营部"
            />
          </Field>
          <Field label="部门编码">
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </Field>
          <Field label="部门类型">
            <Select
              value={form.deptType}
              onChange={(e) => setForm((f) => ({ ...f, deptType: e.target.value }))}
            >
              <option value="">未分类</option>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="部门负责人">
            <Input
              value={form.managerName}
              onChange={(e) => setForm((f) => ({ ...f, managerName: e.target.value }))}
            />
          </Field>
          <Field label="排序值" hint="数字越小越靠前">
            <Input
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
            />
          </Field>
          <Field label="状态">
            <Select
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="ACTIVE">启用</option>
              <option value="INACTIVE">停用</option>
            </Select>
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <Textarea
              value={form.remark}
              onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
            />
          </Field>
        </div>
        {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}
      </Modal>
    </div>
  );
}
