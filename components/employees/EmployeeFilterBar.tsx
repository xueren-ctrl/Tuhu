"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";

/**
 * 员工列表筛选栏。
 * 所有筛选条件写入 URL，由服务端实时查询数据库（刷新/分享链接后结果一致）。
 */
export default function EmployeeFilterBar({
  stores,
  positions,
}: {
  stores: { id: number; name: string }[];
  positions: { id: number; name: string }[];
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const [form, setForm] = useState({
    keyword: sp.get("keyword") ?? "",
    name: sp.get("name") ?? "",
    phone: sp.get("phone") ?? "",
    idCardNo: sp.get("idCardNo") ?? "",
    storeId: sp.get("storeId") ?? "",
    positionId: sp.get("positionId") ?? "",
    status: sp.get("status") ?? "",
    includeDeleted: sp.get("includeDeleted") ?? "",
  });
  const [advanced, setAdvanced] = useState(
    Boolean(sp.get("name") || sp.get("phone") || sp.get("idCardNo"))
  );

  // URL 变化时同步表单（例如点导航里的「已停用档案」）
  useEffect(() => {
    setForm({
      keyword: sp.get("keyword") ?? "",
      name: sp.get("name") ?? "",
      phone: sp.get("phone") ?? "",
      idCardNo: sp.get("idCardNo") ?? "",
      storeId: sp.get("storeId") ?? "",
      positionId: sp.get("positionId") ?? "",
      status: sp.get("status") ?? "",
      includeDeleted: sp.get("includeDeleted") ?? "",
    });
  }, [sp]);

  const activeCount = useMemo(
    () =>
      Object.entries(form).filter(([k, v]) => {
        if (!v) return false;
        if (k === "includeDeleted") return v === "true";
        return true;
      }).length,
    [form]
  );

  const apply = useCallback(
    (patch?: Partial<typeof form>) => {
      const next = { ...form, ...patch };
      const params = new URLSearchParams();
      Object.entries(next).forEach(([k, v]) => {
        if (v === "" || v === undefined || v === null) return;
        if (k === "includeDeleted" && v !== "true") return;
        params.set(k, String(v));
      });
      // 筛选变化时回到第一页
      params.delete("page");
      router.push(`/employees?${params.toString()}`);
    },
    [form, router]
  );

  const reset = () => {
    const keep = form.includeDeleted === "true" ? "?includeDeleted=true" : "";
    router.push(`/employees${keep}`);
  };

  const set = (k: keyof typeof form) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="panel p-3.5">
      {/* 主筛选行 */}
      <div className="flex flex-wrap items-end gap-2.5">
        <Field label="关键词搜索" className="w-[240px]" hint="姓名 / 手机号 / 身份证 / 员工编号 / 门店 / 职位">
          <Input
            value={form.keyword}
            placeholder="输入后回车搜索"
            onChange={(e) => set("keyword")(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
            }}
          />
        </Field>

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
          </Select>
        </Field>

        <Field label="职位" className="w-[170px]">
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
          </Select>
        </Field>

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

        <div className="flex items-center gap-2 pb-0.5">
          <Button variant="primary" onClick={() => apply()}>
            查询
          </Button>
          <Button onClick={reset}>重置</Button>
          <Button variant="ghost" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "收起精确筛选 ▲" : "精确筛选 ▼"}
          </Button>
        </div>
      </div>

      {/* 精确筛选（姓名 / 手机号 / 身份证号 分别搜索） */}
      {advanced ? (
        <div className="mt-3.5 flex flex-wrap items-end gap-2.5 border-t border-[var(--hr-border)] pt-3.5">
          <Field label="按姓名搜索" className="w-[170px]">
            <Input
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder="如：张三"
            />
          </Field>
          <Field label="按手机号搜索" className="w-[190px]" hint="仅比较数字部分">
            <Input
              value={form.phone}
              onChange={(e) => set("phone")(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder="如：13800138000"
            />
          </Field>
          <Field label="按身份证搜索" className="w-[230px]">
            <Input
              value={form.idCardNo}
              onChange={(e) => set("idCardNo")(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder="支持部分匹配"
            />
          </Field>
          <div className="pb-0.5">
            <Button variant="primary" onClick={() => apply()}>
              精确查询
            </Button>
          </div>
        </div>
      ) : null}

      {/* 已停用档案开关 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hr-border)] pt-3">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-600">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--hr-primary)]"
            checked={form.includeDeleted === "true"}
            onChange={(e) => {
              set("includeDeleted")(e.target.checked ? "true" : "");
              apply({ includeDeleted: e.target.checked ? "true" : "" });
            }}
          />
          包含已停用档案（软删除，数据仍在库中）
        </label>
        <div className="text-[11.5px] text-slate-400">
          {activeCount > 0 ? `已启用 ${activeCount} 个筛选条件` : "未使用筛选条件"}
        </div>
      </div>
    </div>
  );
}
