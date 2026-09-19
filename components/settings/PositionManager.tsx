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

interface PositionRow {
  id: number;
  name: string;
  category: string | null;
  level: string | null;
  sortOrder: number;
  status: string;
  remark: string | null;
  employeeCount: number;
}

const EMPTY = {
  name: "",
  category: "",
  level: "",
  sortOrder: "0",
  status: "ACTIVE",
  remark: "",
};

const CATEGORY_OPTIONS = ["技术", "服务", "管理", "职能", "其他"];
const LEVEL_OPTIONS = ["学徒", "青铜", "白银", "黄金", "铂金", "钻石"];

/** 职位管理：新增 / 编辑 / 停用 */
export default function PositionManager() {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PositionRow | null>(null);
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
      const res = await fetch(`/api/positions?${params.toString()}`, {
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

  const openEdit = (r: PositionRow) => {
    setEditing(r);
    setForm({
      name: r.name,
      category: r.category ?? "",
      level: r.level ?? "",
      sortOrder: String(r.sortOrder ?? 0),
      status: r.status,
      remark: r.remark ?? "",
    });
    setError("");
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("职位名称必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = { ...form };
      for (const k of Object.keys(payload)) if (payload[k] === "") payload[k] = null;
      payload.status = form.status;
      payload.sortOrder = Number(form.sortOrder) || 0;

      const res = await fetch(
        editing ? `/api/positions/${editing.id}` : "/api/positions",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "保存失败");
      setOpen(false);
      setMsg(editing ? "职位已更新" : "职位已新增");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (r: PositionRow) => {
    const next = r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    if (
      !window.confirm(
        next === "INACTIVE"
          ? `确认停用职位「${r.name}」？\n停用后不影响已关联的 ${r.employeeCount} 名员工档案。`
          : `确认启用职位「${r.name}」？`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/positions/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      setMsg(next === "ACTIVE" ? "职位已启用" : "职位已停用");
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
        title={`职位管理（${rows.length}）`}
        extra={
          <div className="flex items-center gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索职位名称 / 大类 / 级别"
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
              ＋ 新增职位
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="px-4 py-12 text-center text-[13px] text-slate-400">加载中…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="暂无职位数据"
            desc="可以手动新增职位，或先执行 Excel 导入以自动带出历史工种。"
            action={
              <Button variant="primary" onClick={openCreate}>
                ＋ 新增职位
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium">排序</th>
                  <th className="px-3 py-2.5 font-medium">职位 / 工种名称</th>
                  <th className="px-3 py-2.5 font-medium">大类</th>
                  <th className="px-3 py-2.5 font-medium">级别</th>
                  <th className="px-3 py-2.5 font-medium">关联员工</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">备注</th>
                  <th className="px-4 py-2.5 font-medium w-[150px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="text-[12.5px]">
                    <td className="px-4 py-2 tabular-nums text-slate-400">{r.sortOrder}</td>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-slate-600">{r.category ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{r.level ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">
                      <Link
                        href={`/employees?positionId=${r.id}`}
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
        title={editing ? `编辑职位：${editing.name}` : "新增职位"}
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
          <Field label="职位 / 工种名称" required className="sm:col-span-2">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：机修、店长、前台"
            />
          </Field>
          <Field label="大类">
            <Select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            >
              <option value="">未分类</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="级别">
            <Select
              value={form.level}
              onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}
            >
              <option value="">未分级</option>
              {LEVEL_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
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
