"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  StatusBadge,
} from "@/components/ui";
import { EMPLOYEE_STATUS_OPTIONS, UNASSIGNED, UNASSIGNED_LABEL } from "@/lib/constants";

interface Option {
  id: number;
  name: string;
}

interface Props {
  stores: Option[];
  departments: Option[];
  positions: Option[];
  preset?: string;
}

interface Row {
  id: number;
  employeeId: string;
  name: string;
  status: string;
  storeName: string | null;
  storeNameRaw: string | null;
  positionName: string | null;
  sourceRowNo: number | null;
}

const PRESETS: { key: string; label: string; query: Record<string, string> }[] = [
  { key: "no-department", label: "部门为空", query: { departmentId: UNASSIGNED } },
  { key: "no-position", label: "岗位为空", query: { positionId: UNASSIGNED } },
  { key: "no-store", label: "门店为空", query: { storeId: UNASSIGNED } },
];

/**
 * 批量编辑面板
 *
 * 关键行为（对应验收要求「修改后立即影响所有人员视图」）：
 * 1. 预览与提交用的是**同一套筛选参数**，且直接查数据库，没有任何本地缓存；
 * 2. 提交后调用 router.refresh()，服务端组件重新查库 → 所有视图立刻同步；
 * 3. 只能改门店 / 部门 / 岗位三个归属字段，状态与身份信息不参与批量修改。
 */
export default function BatchEditPanel({ stores, departments, positions, preset }: Props) {
  const router = useRouter();
  const [filters, setFilters] = useState<Record<string, string>>(() => {
    const p = PRESETS.find((x) => x.key === preset);
    return p ? { ...p.query } : {};
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"all" | "picked">("all");
  const [patch, setPatch] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState("");

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    return qs.toString();
  }, [filters]);

  const preview = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/employees?${queryString}&page=1&pageSize=20`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "查询失败");
      setRows(j.data as Row[]);
      setTotal(j.total as number);
      setSelected(new Set());
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [queryString]);

  // 预置条件进来时自动预览一次
  useEffect(() => {
    if (preset) void preview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))
    );
  }

  async function apply() {
    const payloadPatch: Record<string, number | null> = {};
    for (const k of ["storeId", "departmentId", "positionId"]) {
      const v = patch[k];
      // "" = 不修改（字段不进 payload）；"__clear__" = 显式清空（字段进 payload 且为 null）
      if (v === undefined || v === "") continue;
      payloadPatch[k] = v === "__clear__" ? null : Number(v);
    }
    if (!Object.keys(payloadPatch).length) {
      setMsg({ tone: "warn", text: "请先选择要修改的内容（门店 / 部门 / 岗位）" });
      return;
    }
    const useAll = mode === "all";
    if (!useAll && selected.size === 0) {
      setMsg({ tone: "warn", text: "当前是「仅勾选的人」，但一条都没勾" });
      return;
    }
    const scope = useAll
      ? `按当前筛选条件命中的全部 ${total ?? 0} 人`
      : `勾选的 ${selected.size} 人`;
    const detail = Object.entries(payloadPatch)
      .map(([k, v]) => {
        const label = k === "storeId" ? "门店" : k === "departmentId" ? "部门" : "岗位";
        const name =
          k === "storeId"
            ? stores.find((s) => s.id === v)?.name
            : k === "departmentId"
              ? departments.find((d) => d.id === v)?.name
              : positions.find((p) => p.id === v)?.name;
        return `${label} → ${v === null ? "清空" : (name ?? v)}`;
      })
      .join("；");

    if (!confirm(`确认批量修改？\n\n范围：${scope}\n修改：${detail}\n\n修改会逐条写入员工变更记录，可在员工详情页查看。`))
      return;

    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { ...payloadPatch };
      if (useAll) {
        if (!queryString) {
          setMsg({ tone: "warn", text: "「全部命中」模式必须先设置至少一个筛选条件，避免误改全库" });
          setBusy(false);
          return;
        }
        body.filter = Object.fromEntries(
          Object.entries(filters).filter(([, v]) => v)
        );
      } else {
        body.ids = Array.from(selected);
      }
      if (operator.trim()) body.operator = operator.trim();

      const r = await fetch("/api/employees/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "批量修改失败");
      const d = j.data;
      setMsg({
        tone: "ok",
        text:
          `批量修改完成：匹配 ${d.matched} 人，实际修改 ${d.updated} 人，` +
          `无变化 ${d.unchanged} 人，失败 ${d.failed} 人。` +
          `已逐条写入员工变更记录（批次号 ${d.batchKey}）。所有人员视图已同步刷新。`,
      });
      setSelected(new Set());
      setPatch({});
      await preview();
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const presetKey = keyOf(filters);

  return (
    <div className="space-y-3">
      {msg && (
        <Alert tone={msg.tone === "ok" ? "success" : msg.tone === "warn" ? "warn" : "error"}>
          {msg.text}
        </Alert>
      )}

      <Card title="① 筛选要修改的员工">
        <div className="mb-3 flex flex-wrap gap-2">
          <span className="text-[12.5px] leading-8 text-slate-500">快捷条件：</span>
          {PRESETS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={presetKey === p.key ? "primary" : "secondary"}
              onClick={() => {
                setFilters({ ...p.query });
                setTimeout(() => void preview(), 0);
              }}
            >
              {p.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters({});
              setRows([]);
              setTotal(null);
            }}
          >
            清空条件
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <Field label="关键词">
            <Input
              placeholder="姓名 / 手机号 / 员工编号"
              value={filters.keyword ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, keyword: e.target.value }))}
            />
          </Field>
          <Field label="门店">
            <Select
              value={filters.storeId ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, storeId: e.target.value }))}
            >
              <option value="">不限</option>
              <option value={UNASSIGNED}>{UNASSIGNED_LABEL}（门店为空）</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="部门">
            <Select
              value={filters.departmentId ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, departmentId: e.target.value }))}
            >
              <option value="">不限</option>
              <option value={UNASSIGNED}>{UNASSIGNED_LABEL}（部门为空）</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="岗位">
            <Select
              value={filters.positionId ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, positionId: e.target.value }))}
            >
              <option value="">不限</option>
              <option value={UNASSIGNED}>{UNASSIGNED_LABEL}（岗位为空）</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button onClick={() => void preview()} disabled={busy} variant="secondary">
            {busy ? "查询中…" : "预览命中员工"}
          </Button>
          {total !== null && (
            <span className="text-[12.5px] text-slate-600">
              命中 <strong className="text-slate-800">{total}</strong> 人
              {total > rows.length && `（下表只显示前 ${rows.length} 人）`}
            </span>
          )}
        </div>
      </Card>

      {total !== null && (
        <>
          <Card
            title="② 选择范围"
            extra={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === "all" ? "primary" : "secondary"}
                  onClick={() => setMode("all")}
                >
                  全部命中（{total} 人）
                </Button>
                <Button
                  size="sm"
                  variant={mode === "picked" ? "primary" : "secondary"}
                  onClick={() => setMode("picked")}
                >
                  仅勾选（{selected.size} 人）
                </Button>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="w-10 px-3 py-2 font-medium">
                      <input
                        type="checkbox"
                        aria-label="全选本页"
                        checked={rows.length > 0 && selected.size === rows.length}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">员工编号</th>
                    <th className="px-3 py-2 font-medium">姓名</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">当前门店</th>
                    <th className="px-3 py-2 font-medium">岗位</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${r.name}`}
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/employees/${r.id}`} className="text-brand-700 hover:underline">
                          {r.employeeId}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {r.storeName ?? r.storeNameRaw ?? (
                          <Badge tone="amber">无门店</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.positionName ?? "—"}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                        没有命中的员工
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="③ 设置要改成什么（留空表示不修改该字段）">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="门店">
                <Select
                  value={patch.storeId ?? ""}
                  onChange={(e) => setPatch((p) => ({ ...p, storeId: e.target.value }))}
                >
                  <option value="">不修改</option>
                  <option value="__clear__">清空门店</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="部门">
                <Select
                  value={patch.departmentId ?? ""}
                  onChange={(e) => setPatch((p) => ({ ...p, departmentId: e.target.value }))}
                >
                  <option value="">不修改</option>
                  <option value="__clear__">清空部门</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="岗位">
                <Select
                  value={patch.positionId ?? ""}
                  onChange={(e) => setPatch((p) => ({ ...p, positionId: e.target.value }))}
                >
                  <option value="">不修改</option>
                  <option value="__clear__">清空岗位</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="操作人（可选）" hint="当前未启用登录，可手填姓名以便留痕">
                <Input
                  placeholder="如：HR-李四"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                />
              </Field>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" onClick={() => void apply()} disabled={busy}>
                {busy ? "提交中…" : "确认批量修改"}
              </Button>
              <span className="text-[12.5px] text-slate-500">
                只会修改门店 / 部门 / 岗位；状态与身份信息不参与批量修改。
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** 判断当前筛选是否恰好等于某个快捷条件（用于高亮按钮） */
function keyOf(filters: Record<string, string>): string | null {
  const keys = Object.keys(filters).filter((k) => filters[k]);
  if (keys.length !== 1) return null;
  const p = PRESETS.find((x) => x.query[keys[0]] === filters[keys[0]] && keys[0] in x.query);
  return p?.key ?? null;
}
