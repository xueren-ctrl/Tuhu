"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";

/**
 * 统一人员筛选组件（第二阶段：封装公共组件，各页面不再重复实现）
 *
 * 所有筛选条件写入 URL，由服务端实时查询数据库；刷新 / 分享链接后结果一致。
 *
 * 用法：
 *   <EmployeeFilterPanel
 *     basePath="/employees/views/active"
 *     stores={...} departments={...} positions={...}
 *     fields={["keyword", "name", "phone", "storeId", "departmentId", "positionId", "status"]}
 *     locked={{ status: "ACTIVE" }}      // 锁定状态为在职（不在界面上暴露，但会写进 URL）
 *   />
 */

export type FilterField =
  | "keyword"
  | "name"
  | "phone"
  | "idCardNo"
  | "storeId"
  | "departmentId"
  | "positionId"
  | "status"
  | "includeDeleted";

export interface OptionItem {
  id: number;
  name: string;
}

export interface EmployeeFilterPanelProps {
  /** 提交目标路径，如 /employees、/employees/views/resigned */
  basePath: string;
  stores?: OptionItem[];
  departments?: OptionItem[];
  positions?: OptionItem[];
  /** 展示哪些筛选项，默认：keyword + storeId + departmentId + positionId + status */
  fields?: FilterField[];
  /** 锁定字段：固定值写入 URL，界面上不展示（例如在职人员视图固定 status=ACTIVE） */
  locked?: Partial<Record<FilterField, string>>;
  /** 是否提供「精确筛选」展开区（姓名/手机号/身份证单独搜索） */
  advanced?: boolean;
  /** 是否提供「包含已停用档案」开关 */
  deletable?: boolean;
  /** 表单左上角说明文字 */
  hint?: string;
}

const ALL_FIELDS: FilterField[] = ["keyword", "storeId", "departmentId", "positionId", "status"];

export default function EmployeeFilterPanel({
  basePath,
  stores = [],
  departments = [],
  positions = [],
  fields = ALL_FIELDS,
  locked = {},
  advanced = false,
  deletable = false,
  hint,
}: EmployeeFilterPanelProps) {
  const router = useRouter();
  const sp = useSearchParams();

  /** 未分配哨兵值，与服务端 UNASSIGNED 保持一致 */
  const UNASSIGNED = "__none__";

  const readFromUrl = useCallback(
    () => ({
      keyword: sp.get("keyword") ?? "",
      name: sp.get("name") ?? "",
      phone: sp.get("phone") ?? "",
      idCardNo: sp.get("idCardNo") ?? "",
      storeId: sp.get("storeId") ?? "",
      departmentId: sp.get("departmentId") ?? "",
      positionId: sp.get("positionId") ?? "",
      status: sp.get("status") ?? "",
      includeDeleted: sp.get("includeDeleted") ?? "",
    }),
    [sp]
  );

  const [form, setForm] = useState(readFromUrl);
  const [showAdvanced, setShowAdvanced] = useState(
    () => Boolean(sp.get("name") || sp.get("phone") || sp.get("idCardNo"))
  );

  // URL 变化时同步（例如从侧边栏直接跳转带参链接）
  useEffect(() => {
    setForm(readFromUrl());
  }, [readFromUrl]);

  const set = (k: keyof ReturnType<typeof readFromUrl>) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const apply = useCallback(
    (patch?: Partial<ReturnType<typeof readFromUrl>>) => {
      const next = { ...form, ...patch };
      const params = new URLSearchParams();

      // 保留分页大小，重置页码
      const pageSize = sp.get("pageSize");
      if (pageSize) params.set("pageSize", pageSize);

      // 锁定字段（不在表单里展示，但必须带上）
      for (const [k, v] of Object.entries(locked)) {
        if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
      }

      // 表单字段
      for (const f of Object.keys(next) as (keyof typeof next)[]) {
        const v = next[f];
        if (v === "" || v === undefined) continue;
        if (f === "includeDeleted" && v !== "true") continue;
        if (locked[f as FilterField] !== undefined) continue; // 锁定字段以 locked 为准
        params.set(f, String(v));
      }

      router.push(`${basePath}?${params.toString()}`);
    },
    [form, router, basePath, locked, sp]
  );

  const reset = () => {
    const params = new URLSearchParams();
    const pageSize = sp.get("pageSize");
    if (pageSize) params.set("pageSize", pageSize);
    for (const [k, v] of Object.entries(locked)) {
      if (v) params.set(k, String(v));
    }
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  };

  const visible = (f: FilterField) => fields.includes(f) && locked[f] === undefined;

  const activeCount = useMemo(() => {
    let n = 0;
    for (const f of fields) {
      if (locked[f] !== undefined) continue;
      const v = form[f as keyof typeof form];
      if (f === "includeDeleted") {
        if (v === "true") n++;
      } else if (v) n++;
    }
    return n;
  }, [fields, form, locked]);

  const showKeyword = visible("keyword");

  return (
    <div className="panel p-3.5">
      {hint ? <p className="mb-3 text-[12px] text-slate-500">{hint}</p> : null}

      {/* ---- 主筛选行 ---- */}
      <div className="flex flex-wrap items-end gap-2.5">
        {showKeyword ? (
          <Field
            label="关键词搜索"
            className="w-[240px]"
            hint="姓名 / 手机号 / 身份证 / 员工编号 / 门店 / 职位"
          >
            <Input
              value={form.keyword}
              placeholder="输入后回车搜索"
              onChange={(e) => set("keyword")(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
            />
          </Field>
        ) : null}

        {visible("storeId") ? (
          <Field label="门店" className="w-[190px]">
            <Select
              value={form.storeId}
              onChange={(e) => {
                set("storeId")(e.target.value);
                apply({ storeId: e.target.value });
              }}
            >
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value={UNASSIGNED}>未分配门店</option>
            </Select>
          </Field>
        ) : null}

        {visible("departmentId") ? (
          <Field label="部门" className="w-[170px]">
            <Select
              value={form.departmentId}
              onChange={(e) => {
                set("departmentId")(e.target.value);
                apply({ departmentId: e.target.value });
              }}
            >
              <option value="">全部部门</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value={UNASSIGNED}>未分配部门</option>
            </Select>
          </Field>
        ) : null}

        {visible("positionId") ? (
          <Field label="职位" className="w-[180px]">
            <Select
              value={form.positionId}
              onChange={(e) => {
                set("positionId")(e.target.value);
                apply({ positionId: e.target.value });
              }}
            >
              <option value="">全部职位</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={UNASSIGNED}>未分配职位</option>
            </Select>
          </Field>
        ) : null}

        {visible("status") ? (
          <Field label="在职状态" className="w-[130px]">
            <Select
              value={form.status}
              onChange={(e) => {
                set("status")(e.target.value);
                apply({ status: e.target.value });
              }}
            >
              <option value="">全部状态</option>
              {EMPLOYEE_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div className="flex items-center gap-2 pb-0.5">
          <Button variant="primary" onClick={() => apply()}>
            查询
          </Button>
          <Button onClick={reset}>重置</Button>
          {advanced ? (
            <Button variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "收起精确筛选 ▲" : "精确筛选 ▼"}
            </Button>
          ) : null}
        </div>
      </div>

      {/* ---- 精确筛选（姓名 / 手机号 / 身份证分别搜索）---- */}
      {advanced && showAdvanced ? (
        <div className="mt-3.5 flex flex-wrap items-end gap-2.5 border-t border-[var(--hr-border)] pt-3.5">
          {visible("name") || fields.includes("name") ? (
            <Field label="按姓名搜索" className="w-[170px]">
              <Input
                value={form.name}
                onChange={(e) => set("name")(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                placeholder="如：张三"
              />
            </Field>
          ) : null}
          {fields.includes("phone") ? (
            <Field label="按手机号搜索" className="w-[190px]" hint="仅比较数字部分">
              <Input
                value={form.phone}
                onChange={(e) => set("phone")(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                placeholder="如：13800138000"
              />
            </Field>
          ) : null}
          {fields.includes("idCardNo") ? (
            <Field label="按身份证搜索" className="w-[230px]">
              <Input
                value={form.idCardNo}
                onChange={(e) => set("idCardNo")(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                placeholder="支持部分匹配"
              />
            </Field>
          ) : null}
          <div className="pb-0.5">
            <Button variant="primary" onClick={() => apply()}>
              精确查询
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- 已停用档案开关 ---- */}
      {deletable ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hr-border)] pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-600">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--hr-primary)]"
              checked={form.includeDeleted === "true"}
              onChange={(e) => {
                const v = e.target.checked ? "true" : "";
                set("includeDeleted")(v);
                apply({ includeDeleted: v });
              }}
            />
            包含已停用档案（软删除，数据仍在库中）
          </label>
          <div className="text-[11.5px] text-slate-400">
            {activeCount > 0 ? `已启用 ${activeCount} 个筛选条件` : "未使用筛选条件"}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end border-t border-[var(--hr-border)] pt-3 text-[11.5px] text-slate-400">
          {activeCount > 0 ? `已启用 ${activeCount} 个筛选条件` : "未使用筛选条件"}
        </div>
      )}
    </div>
  );
}
