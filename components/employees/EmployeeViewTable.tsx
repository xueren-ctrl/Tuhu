"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { Badge, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { EmployeeListRow } from "@/lib/employee-service";

/**
 * 人员视图通用表格（第二阶段）
 * 各视图只传「要显示哪些列」，不重复写表格结构。
 */

export type ViewColumnKey =
  | "employeeId"
  | "name"
  | "gender"
  | "age"
  | "store"
  | "department"
  | "position"
  | "hireDate"
  | "phone"
  | "idCardNo"
  | "status"
  | "resignDate"
  | "resignReason"
  | "remark";

interface ColumnDef {
  key: ViewColumnKey;
  label: string;
  className?: string;
  sortable?: boolean;
  /** 对应的排序字段名（与 employeeQuerySchema.sortBy 对齐） */
  sortKey?: string;
}

const COLUMNS: Record<ViewColumnKey, ColumnDef> = {
  employeeId: { key: "employeeId", label: "员工编号", className: "w-[136px]", sortable: true, sortKey: "employeeId" },
  name: { key: "name", label: "姓名", className: "w-[92px]", sortable: true, sortKey: "name" },
  gender: { key: "gender", label: "性别", className: "w-[62px]" },
  age: { key: "age", label: "年龄", className: "w-[62px]" },
  store: { key: "store", label: "门店", className: "min-w-[150px]" },
  department: { key: "department", label: "部门", className: "w-[110px]" },
  position: { key: "position", label: "职位", className: "min-w-[130px]" },
  hireDate: { key: "hireDate", label: "入职日期", className: "w-[104px]", sortable: true, sortKey: "hireDate" },
  phone: { key: "phone", label: "手机号", className: "w-[120px]" },
  idCardNo: { key: "idCardNo", label: "身份证号", className: "w-[168px]" },
  status: { key: "status", label: "状态", className: "w-[74px]", sortable: true, sortKey: "status" },
  resignDate: { key: "resignDate", label: "离职日期", className: "w-[104px]", sortable: true, sortKey: "resignDate" },
  resignReason: { key: "resignReason", label: "离职原因", className: "min-w-[110px]" },
  remark: { key: "remark", label: "备注", className: "min-w-[130px]" },
};

export default function EmployeeViewTable({
  rows,
  columns,
  basePath,
  /** 门店/部门视图下，门店列标题可自定义（如「原门店」） */
  labelOverrides,
  emptyText = "没有符合条件的员工",
}: {
  rows: EmployeeListRow[];
  columns: ViewColumnKey[];
  basePath: string;
  labelOverrides?: Partial<Record<ViewColumnKey, string>>;
  emptyText?: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const sortBy = sp.get("sortBy") ?? "employeeId";
  const sortOrder = sp.get("sortOrder") ?? "asc";

  const toggleSort = (sortKey?: string) => {
    if (!sortKey) return;
    const params = new URLSearchParams(sp.toString());
    if (sortBy === sortKey) {
      params.set("sortOrder", sortOrder === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", sortKey);
      params.set("sortOrder", "asc");
    }
    router.push(`${basePath}?${params.toString()}`);
  };

  const cell = (r: EmployeeListRow, key: ViewColumnKey): React.ReactNode => {
    switch (key) {
      case "employeeId":
        return (
          <Link
            href={`/employees/${r.id}`}
            className="font-mono text-[11.5px] text-slate-600 hover:text-brand-600 hover:underline"
          >
            {r.employeeId}
          </Link>
        );
      case "name":
        return (
          <Link href={`/employees/${r.id}`} className="font-medium hover:text-brand-600 hover:underline">
            {r.name}
          </Link>
        );
      case "gender":
        return r.gender || "—";
      case "age":
        return r.age ?? "—";
      case "store":
        return r.storeName ? (
          <span className="text-slate-700">{r.storeName}</span>
        ) : r.storeNameRaw ? (
          <span className="text-slate-500">
            {r.storeNameRaw}
            <span className="ml-1 text-[10px] text-amber-600" title="仅存在于 Excel 历史原文">
              历史
            </span>
          </span>
        ) : (
          <span className="text-[11.5px] text-slate-300">未分配</span>
        );
      case "department":
        return r.departmentName ? (
          <span className="text-slate-700">{r.departmentName}</span>
        ) : r.departmentNameRaw ? (
          <span className="text-slate-500">{r.departmentNameRaw}</span>
        ) : (
          <span className="text-[11.5px] text-slate-300">未分配</span>
        );
      case "position":
        return r.positionName ? (
          <span className="text-slate-600">{r.positionName}</span>
        ) : r.jobGradeRaw ? (
          <span className="text-slate-500">{r.jobGradeRaw}</span>
        ) : (
          <span className="text-[11.5px] text-slate-300">未分配</span>
        );
      case "hireDate":
        return <span className="text-slate-600">{formatDate(r.hireDate) || "—"}</span>;
      case "phone":
        return <span className="font-mono text-[11.5px] text-slate-600">{r.phone || "—"}</span>;
      case "idCardNo":
        return <span className="font-mono text-[11.5px] text-slate-500">{r.idCardNo || "—"}</span>;
      case "status":
        return <StatusBadge status={r.status} />;
      case "resignDate":
        return <span className="text-slate-600">{formatDate(r.resignDate) || "—"}</span>;
      case "resignReason":
        return r.resignReason ? (
          <span className="text-slate-600">{r.resignReason}</span>
        ) : (
          <span className="text-slate-300">—</span>
        );
      case "remark":
        return r.remark ? (
          <span className="text-slate-500">{r.remark}</span>
        ) : (
          <span className="text-slate-300">—</span>
        );
      default:
        return "—";
    }
  };

  if (rows.length === 0) {
    return (
      <div className="px-4 py-14 text-center text-[13px] text-slate-400">{emptyText}</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="grid-table">
        <thead>
          <tr className="text-left text-[11.5px] text-slate-500">
            {columns.map((k) => {
              const def = COLUMNS[k];
              const label = labelOverrides?.[k] ?? def.label;
              return (
                <th key={k} className={`px-3 py-2.5 font-medium ${def.className ?? ""}`}>
                  {def.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(def.sortKey)}
                      className="inline-flex items-center gap-1 hover:text-brand-600"
                    >
                      {label}
                      <span className="text-[9px] text-slate-400">
                        {sortBy === def.sortKey ? (sortOrder === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={"text-[12.5px] " + (r.deletedAt ? "opacity-55" : "")}>
              {columns.map((k, i) => (
                <td key={k} className={`px-3 py-2 ${i === 0 ? "pl-4" : ""}`}>
                  {cell(r, k)}
                  {k === "name" && r.deletedAt ? (
                    <Badge tone="slate" className="ml-1.5">
                      已停用
                    </Badge>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
