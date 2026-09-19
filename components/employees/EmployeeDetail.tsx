"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, DescGrid, Modal, StatusBadge } from "@/components/ui";
import { EMPLOYEE_FIELDS, EMPLOYEE_GROUPS } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/format";

/** 员工详情：字段按分组 / Tab 展示，避免 40+ 字段堆在一页 */

type Emp = Record<string, unknown>;

export default function EmployeeDetail({ employee }: { employee: Emp }) {
  const [tab, setTab] = useState<string>("basic");
  const [showAll, setShowAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const groupsWithData = useMemo(() => {
    return EMPLOYEE_GROUPS.map((g) => {
      const fields = EMPLOYEE_FIELDS.filter((f) => f.group === g.key);
      const filled = fields.filter((f) => {
        const v = employee[f.key];
        return v !== null && v !== undefined && v !== "";
      });
      return { ...g, fields, filledCount: filled.length };
    });
  }, [employee]);

  const act = async (mode: "delete" | "restore") => {
    setBusy(true);
    try {
      const url =
        mode === "restore"
          ? `/api/employees/${employee.id}?restore=1`
          : `/api/employees/${employee.id}`;
      const res = await fetch(url, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      window.location.href = "/employees";
    } catch (e) {
      alert("操作失败：" + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const raw = (key: string) => employee[key];
  const text = (key: string) => {
    const v = employee[key];
    if (v === null || v === undefined || v === "") return null;
    return String(v);
  };
  const date = (key: string) => {
    const v = employee[key];
    if (!v) return null;
    return formatDate(String(v));
  };

  const dataFlags: string[] = useMemo(() => {
    const s = employee.dataFlags;
    if (typeof s !== "string" || !s) return [];
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [s];
    }
  }, [employee.dataFlags]);

  const renderValue = (key: string): React.ReactNode => {
    switch (key) {
      case "status":
        return <StatusBadge status={String(employee.status ?? "")} />;
      case "employeeId":
        return <span className="font-mono">{String(employee.employeeId ?? "")}</span>;
      case "storeName":
        return text("storeName") ?? text("storeNameRaw") ?? null;
      case "positionName":
        return text("positionName") ?? text("jobGradeRaw") ?? null;
      case "hireDate":
      case "resignDate":
      case "interviewDate":
        return date(key);
      case "createdAt":
      case "updatedAt":
      case "deletedAt":
        return formatDateTime(String(employee[key] ?? "")) || null;
      case "storeNameRaw":
      case "jobGradeRaw":
        return text(key);
      case "idCardNo":
      case "phone":
      case "bankAccountNo":
        // 详情页展示完整值，但明确提示属敏感数据
        return text(key);
      default:
        return text(key);
    }
  };

  const current = groupsWithData.find((g) => g.key === tab) ?? groupsWithData[0];

  return (
    <div className="space-y-4">
      {/* 已保存提示 */}
      {/* 头部摘要 */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[20px] font-semibold text-brand-700">
              {String(employee.name ?? "").slice(0, 1) || "?"}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[18px] font-semibold">{String(employee.name ?? "")}</h2>
                <StatusBadge status={String(employee.status ?? "")} />
                {employee.deletedAt ? <Badge tone="slate">已停用</Badge> : null}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-slate-600">
                <span>
                  员工编号：
                  <span className="font-mono text-slate-800">
                    {String(employee.employeeId ?? "")}
                  </span>
                </span>
                <span>
                  门店：{text("storeName") ?? text("storeNameRaw") ?? "—"}
                </span>
                <span>
                  职位：{text("positionName") ?? text("jobGradeRaw") ?? "—"}
                </span>
                <span>入职：{date("hireDate") ?? "—"}</span>
                {employee.status === "RESIGNED" ? (
                  <span className="text-red-600">离职：{date("resignDate") ?? "未填写"}</span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link href={`/employees/${employee.id}/edit`}>
              <Button variant="primary" size="sm">
                编辑档案
              </Button>
            </Link>
            <Link href="/employees">
              <Button size="sm">员工列表</Button>
            </Link>
            {employee.deletedAt ? (
              <Button
                size="sm"
                variant="secondary"
                className="text-emerald-600"
                onClick={() => setRestoreOpen(true)}
              >
                恢复档案
              </Button>
            ) : (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmOpen(true)}
              >
                停用档案
              </Button>
            )}
          </div>
        </div>

        {dataFlags.length ? (
          <Alert tone="warn" className="mt-4">
            <strong>数据异常标记（导入时自动识别，原始值均完整保留）：</strong>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {dataFlags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {employee.status === "RESIGNED" && !employee.resignDate ? (
          <Alert tone="warn" className="mt-4">
            该员工状态为「离职」，但数据库中<strong>没有可解析的离职日期</strong>。
            原因：Excel「备注（离职日期）」为空或其内容为非标准文本（如「9/30已离职」）。
            原文已保留在「离职信息」分组中，后续可人工补录。
          </Alert>
        ) : null}
      </Card>

      {/* 分组 Tab */}
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap gap-1 border-b border-[var(--hr-border)] px-3 pt-3">
          {groupsWithData.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setTab(g.key)}
              className={
                "rounded-t-md border-b-2 px-3 py-2 text-[12.5px] transition-colors " +
                (tab === g.key
                  ? "border-brand-600 font-medium text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-800")
              }
            >
              {g.label}
              <span className="ml-1.5 text-[10.5px] text-slate-400">
                {g.filledCount}/{g.fields.length}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4">
          <DescGrid
            columns={3}
            items={current.fields.map((f) => ({
              label: f.label,
              value: renderValue(f.key),
              hint: f.excelColumn,
            }))}
          />

          <p className="mt-4 border-t border-[var(--hr-border)] pt-3 text-[11.5px] text-slate-400">
            标注的「Excel: X」为该字段在原始 Excel「数据库」Sheet 中的列位置。
            空值显示为「—」，表示 Excel 中该字段本身为空（已按 null 处理，未做猜测填充）。
          </p>
        </div>
      </Card>

      {/* 全部字段一览（排查用） */}
      <Card
        title="全部字段一览（46 列完整对照）"
        extra={
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "收起 ▲" : "展开 ▼"}
          </Button>
        }
      >
        {showAll ? (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">字段</th>
                  <th className="px-3 py-2 font-medium">Excel 列</th>
                  <th className="px-3 py-2 font-medium">数据库值</th>
                </tr>
              </thead>
              <tbody>
                {EMPLOYEE_FIELDS.map((f, i) => {
                  const v = renderValue(f.key);
                  const empty =
                    v === null || v === undefined || v === "";
                  return (
                    <tr key={f.key} className="text-[12.5px]">
                      <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                      <td className="px-3 py-1.5 text-slate-700">{f.label}</td>
                      <td className="px-3 py-1.5 text-[11.5px] text-slate-400">
                        {f.excelColumn}
                      </td>
                      <td className={"px-3 py-1.5 " + (empty ? "text-slate-300" : "text-slate-800")}>
                        {empty ? "—" : (v as React.ReactNode)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[12.5px] text-slate-500">
            点击「展开」可查看该员工在数据库中全部 {EMPLOYEE_FIELDS.length} 个字段的实际取值，
            用于核对 Excel 迁移是否完整。
          </p>
        )}
      </Card>

      {/* 停用确认（软删除） */}
      <Modal
        open={confirmOpen}
        title="停用员工档案"
        onClose={() => setConfirmOpen(false)}
        width="w-[480px]"
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => act("delete")}>
              确认停用
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px]">
          <p>
            员工：<strong>{String(employee.name ?? "")}</strong>
          </p>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800">
            第一阶段<strong>不做物理删除</strong>。确认后仅标记为「已停用」（软删除），
            历史档案与所有字段完整保留，可在列表页勾选「包含已停用档案」后恢复。
          </div>
        </div>
      </Modal>

      {/* 恢复确认 */}
      <Modal
        open={restoreOpen}
        title="恢复员工档案"
        onClose={() => setRestoreOpen(false)}
        width="w-[420px]"
        footer={
          <>
            <Button onClick={() => setRestoreOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => act("restore")}>
              确认恢复
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-slate-600">
          恢复后「{String(employee.name ?? "")}」将重新出现在默认员工档案列表中。
        </p>
      </Modal>
    </div>
  );
}
