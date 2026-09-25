"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { Badge, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import YesNoCell from "@/components/employees/YesNoCell";
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
  | "remark"
  // Stage 7.3：7 个「是否」字段（在职页直接展示 + 行内下拉编辑）
  | "dormitory"
  | "socialInsurancePurchased"
  | "laborContract"
  | "socialInsuranceAgreement"
  | "fireSafetyCommitment"
  | "dormitoryWaiver"
  | "onboardingMedical"
  // Stage 7.3.5：「数据库」全表视图 —— 完整原始字段
  | "storeNameRaw"
  | "departmentNameRaw"
  | "jobGradeRaw"
  | "ageRaw"
  | "currentAddress"
  | "emergencyContact1"
  | "emergencyPhone1"
  | "emergencyContact2"
  | "emergencyPhone2"
  | "mentorName"
  | "positionNote"
  | "certificateLevel"
  | "salaryTerms"
  | "firstMonthGuarantee"
  | "bankBranch"
  | "bankAccountNo"
  | "docResume"
  | "docInterviewEvaluation"
  | "docOnboardingForm"
  | "docInterviewEvaluation2"
  | "resignDateRaw"
  | "recruiterName"
  | "interviewDate"
  | "interviewLocation"
  | "interviewResult"
  | "interviewerName"
  | "interviewHired"
  | "remark3"
  | "sourceSheet"
  | "importBatch"
  | "sourceRowNo"
  | "dataFlags"
  | "createdAt";

/** Stage 7.3：可在列表里直接下拉编辑的「是否」字段 */
export const YES_NO_FIELDS = [
  "dormitory",
  "socialInsurancePurchased",
  "laborContract",
  "socialInsuranceAgreement",
  "fireSafetyCommitment",
  "dormitoryWaiver",
  "onboardingMedical",
] as const;

export type YesNoField = (typeof YES_NO_FIELDS)[number];

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
  // Stage 7.3
  dormitory: { key: "dormitory", label: "是否住宿舍", className: "w-[104px]" },
  socialInsurancePurchased: { key: "socialInsurancePurchased", label: "社保购买", className: "w-[92px]" },
  laborContract: { key: "laborContract", label: "劳动合同", className: "w-[92px]" },
  socialInsuranceAgreement: { key: "socialInsuranceAgreement", label: "社保协议", className: "w-[92px]" },
  fireSafetyCommitment: { key: "fireSafetyCommitment", label: "消防承诺书", className: "w-[104px]" },
  dormitoryWaiver: { key: "dormitoryWaiver", label: "宿舍免责协议", className: "w-[116px]" },
  onboardingMedical: { key: "onboardingMedical", label: "入职体检", className: "w-[92px]" },
  // Stage 7.3.5：「数据库」全表 —— 完整原始字段
  storeNameRaw: { key: "storeNameRaw", label: "门店(原文)", className: "min-w-[140px]" },
  departmentNameRaw: { key: "departmentNameRaw", label: "部门(原文)", className: "min-w-[110px]" },
  jobGradeRaw: { key: "jobGradeRaw", label: "工种(原文)", className: "min-w-[120px]" },
  ageRaw: { key: "ageRaw", label: "年龄(原文)", className: "w-[92px]" },
  currentAddress: { key: "currentAddress", label: "现居住地址", className: "min-w-[160px]" },
  emergencyContact1: { key: "emergencyContact1", label: "紧急联系人1", className: "w-[92px]" },
  emergencyPhone1: { key: "emergencyPhone1", label: "联系人电话1", className: "w-[116px]" },
  emergencyContact2: { key: "emergencyContact2", label: "紧急联系人2", className: "w-[92px]" },
  emergencyPhone2: { key: "emergencyPhone2", label: "联系人电话2", className: "w-[116px]" },
  mentorName: { key: "mentorName", label: "带教人", className: "w-[84px]" },
  positionNote: { key: "positionNote", label: "职位备注", className: "min-w-[110px]" },
  certificateLevel: { key: "certificateLevel", label: "证书等级", className: "w-[92px]" },
  salaryTerms: { key: "salaryTerms", label: "薪资待遇", className: "min-w-[180px]" },
  firstMonthGuarantee: { key: "firstMonthGuarantee", label: "首月保障", className: "min-w-[130px]" },
  bankBranch: { key: "bankBranch", label: "开户银行", className: "min-w-[150px]" },
  bankAccountNo: { key: "bankAccountNo", label: "银行卡账号", className: "w-[170px] font-mono" },
  docResume: { key: "docResume", label: "简历", className: "w-[62px]" },
  docInterviewEvaluation: { key: "docInterviewEvaluation", label: "面试评价", className: "w-[84px]" },
  docOnboardingForm: { key: "docOnboardingForm", label: "入职表", className: "w-[72px]" },
  docInterviewEvaluation2: { key: "docInterviewEvaluation2", label: "面试评价2", className: "w-[84px]" },
  resignDateRaw: { key: "resignDateRaw", label: "离职日期(原文)", className: "w-[116px]" },
  recruiterName: { key: "recruiterName", label: "招聘人", className: "w-[84px]" },
  interviewDate: { key: "interviewDate", label: "面试日期", className: "w-[104px]" },
  interviewLocation: { key: "interviewLocation", label: "面试地点", className: "min-w-[110px]" },
  interviewResult: { key: "interviewResult", label: "面试结果", className: "w-[92px]" },
  interviewerName: { key: "interviewerName", label: "面试官", className: "w-[84px]" },
  interviewHired: { key: "interviewHired", label: "是否入职", className: "w-[84px]" },
  remark3: { key: "remark3", label: "备注3", className: "min-w-[130px]" },
  sourceSheet: { key: "sourceSheet", label: "来源Sheet", className: "w-[104px]" },
  importBatch: { key: "importBatch", label: "导入批次", className: "w-[130px]" },
  sourceRowNo: { key: "sourceRowNo", label: "源行号", className: "w-[74px]" },
  dataFlags: { key: "dataFlags", label: "数据标记", className: "min-w-[120px]" },
  createdAt: { key: "createdAt", label: "建档时间", className: "w-[150px]" },
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
      // Stage 7.3：7 个「是否」字段支持行内下拉直接改
      case "dormitory":
      case "socialInsurancePurchased":
      case "laborContract":
      case "socialInsuranceAgreement":
      case "fireSafetyCommitment":
      case "dormitoryWaiver":
      case "onboardingMedical":
        return (
          <YesNoCell
            employeeId={r.id}
            field={key}
            value={(r as unknown as Record<string, string | null>)[key]}
          />
        );
      // Stage 7.3.5：「数据库」全表的日期 / 数字 / 文本字段
      case "hireDate":
      case "resignDate":
      case "createdAt":
        break; // 上面已处理
      default: {
        const v = (r as unknown as Record<string, unknown>)[key];
        if (v === null || v === undefined || v === "") {
          return <span className="text-slate-300">—</span>;
        }
        if (key === "interviewDate") {
          return <span className="text-slate-600">{formatDate(v as string) || "—"}</span>;
        }
        if (key === "sourceRowNo") {
          return <span className="font-mono text-[11.5px] text-slate-500">{String(v)}</span>;
        }
        if (key === "bankAccountNo" || key === "emergencyPhone1" || key === "emergencyPhone2") {
          return <span className="font-mono text-[11.5px] text-slate-600">{String(v)}</span>;
        }
        if (key === "interviewHired" || key === "docResume" || key === "docInterviewEvaluation" || key === "docOnboardingForm" || key === "docInterviewEvaluation2") {
          const s = String(v);
          if (s === "是") return <span className="text-emerald-600">是</span>;
          if (s === "否") return <span className="text-slate-400">否</span>;
          if (s === "×" || s === "/") return <span className="text-amber-600">{s}</span>;
          return <span className="text-slate-600">{s}</span>;
        }
        return <span className="text-slate-600">{String(v)}</span>;
      }
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
