"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Modal, StatusBadge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import type { EmployeeListRow } from "@/lib/employee-service";

/** 员工列表表格 + 排序 + 行操作（停用 / 恢复，均为软删除） */

const COLUMNS: { key: string; label: string; sortable?: boolean; className?: string }[] = [
  { key: "employeeId", label: "员工编号", sortable: true, className: "w-[136px]" },
  { key: "name", label: "姓名", sortable: true, className: "w-[92px]" },
  { key: "idCardNo", label: "身份证号", className: "w-[168px]" },
  { key: "phone", label: "联系电话", className: "w-[116px]" },
  { key: "store", label: "门店", className: "min-w-[150px]" },
  { key: "position", label: "职位", className: "w-[130px]" },
  { key: "hireDate", label: "入职日期", sortable: true, className: "w-[100px]" },
  { key: "status", label: "状态", sortable: true, className: "w-[74px]" },
  { key: "resignDate", label: "离职日期", sortable: true, className: "w-[100px]" },
  { key: "__actions", label: "操作", className: "w-[150px]" },
];

export default function EmployeeTable({ rows }: { rows: EmployeeListRow[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const sortBy = sp.get("sortBy") ?? "employeeId";
  const sortOrder = sp.get("sortOrder") ?? "asc";

  const [target, setTarget] = useState<EmployeeListRow | null>(null);
  const [mode, setMode] = useState<"delete" | "restore">("delete");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleSort = (key: string) => {
    const params = new URLSearchParams(sp.toString());
    if (sortBy === key) {
      params.set("sortOrder", sortOrder === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", key);
      params.set("sortOrder", "asc");
    }
    router.push(`/employees?${params.toString()}`);
  };

  const doAction = async () => {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const url =
        mode === "restore"
          ? `/api/employees/${target.id}?restore=1`
          : `/api/employees/${target.id}`;
      const res = await fetch(url, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "操作失败");
      setTarget(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="grid-table">
          <thead>
            <tr className="text-left text-[11.5px] text-slate-500">
              {COLUMNS.map((c) => (
                <th key={c.key} className={`px-3 py-2.5 font-medium ${c.className ?? ""}`}>
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-brand-600"
                    >
                      {c.label}
                      <span className="text-[9px] text-slate-400">
                        {sortBy === c.key ? (sortOrder === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={"text-[12.5px] " + (r.deletedAt ? "opacity-55" : "")}>
                <td className="px-3 py-2 font-mono text-[11.5px] text-slate-600">
                  <Link
                    href={`/employees/${r.id}`}
                    className="hover:text-brand-600 hover:underline"
                  >
                    {r.employeeId}
                  </Link>
                </td>
                <td className="px-3 py-2 font-medium">
                  <Link href={`/employees/${r.id}`} className="hover:text-brand-600 hover:underline">
                    {r.name}
                  </Link>
                  {r.deletedAt ? (
                    <Badge tone="slate" className="ml-1.5">
                      已停用
                    </Badge>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-slate-500">
                  {r.idCardNo || "—"}
                </td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-slate-600">
                  {r.phone || "—"}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {r.storeName || r.storeNameRaw || "—"}
                  {!r.storeName && r.storeNameRaw ? (
                    <span className="ml-1 text-[10px] text-amber-600" title="仅存在于 Excel 历史原文，未关联门店主数据">
                      历史
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {r.positionName || r.jobGradeRaw || "—"}
                </td>
                <td className="px-3 py-2 text-slate-600">{formatDate(r.hireDate) || "—"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-slate-600">{formatDate(r.resignDate) || "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Link href={`/employees/${r.id}`}>
                      <Button size="sm" variant="ghost">
                        详情
                      </Button>
                    </Link>
                    <Link href={`/employees/${r.id}/edit`}>
                      <Button size="sm" variant="ghost">
                        编辑
                      </Button>
                    </Link>
                    {r.deletedAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-emerald-600"
                        onClick={() => {
                          setMode("restore");
                          setTarget(r);
                        }}
                      >
                        恢复
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        onClick={() => {
                          setMode("delete");
                          setTarget(r);
                        }}
                      >
                        停用
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={Boolean(target)}
        title={mode === "delete" ? "停用员工档案" : "恢复员工档案"}
        onClose={() => setTarget(null)}
        width="w-[480px]"
        footer={
          <>
            <Button onClick={() => setTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant={mode === "delete" ? "danger" : "primary"}
              onClick={doAction}
              loading={busy}
            >
              {mode === "delete" ? "确认停用" : "确认恢复"}
            </Button>
          </>
        }
      >
        {target ? (
          <div className="space-y-3 text-[13px]">
            <p className="text-slate-700">
              员工：<strong>{target.name}</strong>
              <span className="ml-2 font-mono text-[11.5px] text-slate-500">
                {target.employeeId}
              </span>
            </p>
            {mode === "delete" ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800">
                第一阶段不做物理删除。确认后仅将该员工标记为「已停用」（软删除），
                <strong>历史档案与关联记录全部保留</strong>，可随时恢复。
              </div>
            ) : (
              <p className="text-[12.5px] text-slate-600">
                恢复后该员工重新出现在默认的员工档案列表中。
              </p>
            )}
            {target.updatedAt ? (
              <p className="text-[11.5px] text-slate-400">
                最后更新：{formatDateTime(target.updatedAt)}
              </p>
            ) : null}
            {error ? (
              <p className="text-[12.5px] text-red-600">操作失败：{error}</p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
