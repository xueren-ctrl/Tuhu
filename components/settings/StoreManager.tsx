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
import { RECORD_STATUS_LABEL } from "@/lib/constants";

interface StoreRow {
  id: number;
  name: string;
  code: string | null;
  region: string | null;
  address: string | null;
  plannedHeadcount: number | null;
  status: string;
  remark: string | null;
  employeeCount: number;
}

const EMPTY = {
  name: "",
  code: "",
  region: "",
  address: "",
  plannedHeadcount: "",
  status: "ACTIVE",
  remark: "",
};

/** 门店管理：新增 / 编辑 / 停用 / 搜索 */
export default function StoreManager() {
  const [rows, setRows] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StoreRow | null>(null);
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
      if (includeInactive) params.set("includeInactive", "true");
      const res = await fetch(`/api/stores?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setRows(json.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [keyword, statusFilter, includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY });
    setError("");
    setOpen(true);
  };

  const openEdit = (r: StoreRow) => {
    setEditing(r);
    setForm({
      name: r.name,
      code: r.code ?? "",
      region: r.region ?? "",
      address: r.address ?? "",
      plannedHeadcount: r.plannedHeadcount === null ? "" : String(r.plannedHeadcount),
      status: r.status,
      remark: r.remark ?? "",
    });
    setError("");
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("门店名称必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = { ...form };
      for (const k of Object.keys(payload)) if (payload[k] === "") payload[k] = null;
      payload.status = form.status;

      const res = await fetch(
        editing ? `/api/stores/${editing.id}` : "/api/stores",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "保存失败");
      setOpen(false);
      setMsg(editing ? "门店已更新" : "门店已新增");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (r: StoreRow) => {
    const next = r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    if (
      !window.confirm(
        next === "INACTIVE"
          ? `确认停用门店「${r.name}」？\n停用后不影响已关联的 ${r.employeeCount} 名员工档案，只是不再出现在新表单的下拉选项中。`
          : `确认启用门店「${r.name}」？`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/stores/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      setMsg(next === "ACTIVE" ? "门店已启用" : "门店已停用");
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
        title={`门店管理（${rows.length}）`}
        extra={
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索门店名称 / 编码 / 区域"
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
              ＋ 新增门店
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="px-4 py-12 text-center text-[13px] text-slate-400">加载中…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="暂无门店数据"
            desc="可以手动新增门店，或先执行 Excel 导入以自动带出历史门店。"
            action={
              <Button variant="primary" onClick={openCreate}>
                ＋ 新增门店
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium">门店名称</th>
                  <th className="px-3 py-2.5 font-medium">编码</th>
                  <th className="px-3 py-2.5 font-medium">区域</th>
                  <th className="px-3 py-2.5 font-medium">地址</th>
                  <th className="px-3 py-2.5 font-medium">编制</th>
                  <th className="px-3 py-2.5 font-medium">在职员工</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">备注</th>
                  <th className="px-4 py-2.5 font-medium w-[150px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="text-[12.5px]">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-slate-500">{r.code ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.region ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-500">{r.address ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-600">
                      {r.plannedHeadcount ?? "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      <Link
                        href={`/employees?storeId=${r.id}`}
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
                    <td className="px-3 py-2 max-w-[220px] truncate text-slate-500" title={r.remark ?? ""}>
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
        title={editing ? `编辑门店：${editing.name}` : "新增门店"}
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
          <Field label="门店名称" required className="sm:col-span-2">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：XX路店"
            />
          </Field>
          <Field label="门店编码">
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </Field>
          <Field label="区域 / 城市">
            <Input
              value={form.region}
              onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
              placeholder="如：东莞"
            />
          </Field>
          <Field label="门店地址" className="sm:col-span-2">
            <Input
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </Field>
          <Field label="计划编制人数">
            <Input
              value={form.plannedHeadcount}
              onChange={(e) =>
                setForm((f) => ({ ...f, plannedHeadcount: e.target.value }))
              }
              placeholder="可留空"
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
