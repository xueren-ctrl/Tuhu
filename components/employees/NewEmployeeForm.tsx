"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";
import type { FormFieldSpec, NewEmployeeKind } from "@/lib/sheet-fields";

/**
 * 新增员工表单（按类型动态生成字段）
 *
 *   门店员工   → 在职 ∪ 招聘面试登记表 ∪ 薪资表 的列名，合并去重
 *   运营部员工 → 运营部 ∪ 招聘面试登记表 ∪ 薪资表 的列名，合并去重
 *
 * 同一份数据在多张表里只是列名不同（例如「工资卡的开户银行支行」与「开户行」都是 bankBranch），
 * 表单里只出现一次，省去重复填写。
 * 保存后按所选「员工状态」自动出现在对应表里（状态 → 表 的映射见 lib/sheet-fields.ts）。
 */

export default function NewEmployeeForm({
  kind,
  fields,
  defaultStatus,
  stores,
  departments,
  positions,
  opsDepartmentId,
}: {
  kind: NewEmployeeKind;
  fields: FormFieldSpec[];
  defaultStatus: string;
  stores: { id: number; name: string }[];
  departments: { id: number; name: string }[];
  positions: { id: number; name: string }[];
  opsDepartmentId: number | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>({
    status: defaultStatus,
    hireDate: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 运营部员工不需要选门店（固定挂在运营部）
  const visibleFields = useMemo(
    () => (kind === "OPS" ? fields.filter((f) => f.key !== "storeId") : fields),
    [fields, kind]
  );

  const sections = useMemo(() => {
    const map = new Map<string, FormFieldSpec[]>();
    for (const f of visibleFields) {
      if (!map.has(f.section)) map.set(f.section, []);
      map.get(f.section)!.push(f);
    }
    // 分组标题带 ①②③ 序号，排序后即为期望的填写顺序
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
  }, [visibleFields]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    setError("");
    if (!(form.name ?? "").trim()) {
      setError("姓名必填");
      return;
    }
    if (kind === "STORE" && !form.storeId) {
      setError("请选择门店");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { ...form };
      // 运营部员工自动挂到运营部
      if (kind === "OPS" && opsDepartmentId) payload.departmentId = String(opsDepartmentId);
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      router.push(`/employees/${data.data?.id ?? ""}`);
      router.refresh();
    } catch (e) {
      setError("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const statusOptions = EMPLOYEE_STATUS_OPTIONS;

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card title="① 员工状态（决定这个人出现在哪些表）">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={form.status ?? defaultStatus}
            onChange={(e) => set("status", e.target.value)}
            className="h-9 w-[190px]"
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <span className="text-[12.5px] text-slate-500">
            将出现在：
            <strong className="text-slate-700">
              {statusOptions.find((o) => o.value === (form.status ?? defaultStatus))?.hint ?? "—"}
            </strong>
          </span>
        </div>
      </Card>

      {sections.map(([section, list]) => (
        <Card key={section} title={section}>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((f) => (
              <Field
                key={f.key}
                label={f.label + (f.key === "name" ? " *" : "")}
                hint={
                  f.from.length > 1
                    ? `${f.from.join(" / ")} 共用此字段`
                    : f.from[0]
                      ? `来自「${f.from[0]}」表`
                      : undefined
                }
                className={f.control === "textarea" ? "sm:col-span-2 lg:col-span-3" : ""}
              >
                {f.control === "select" && f.options ? (
                  <Select value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">（空）</option>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : f.key === "storeId" ? (
                  <Select value={form.storeId ?? ""} onChange={(e) => set("storeId", e.target.value)}>
                    <option value="">请选择门店…</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                ) : f.key === "positionId" ? (
                  <Select
                    value={form.positionId ?? ""}
                    onChange={(e) => set("positionId", e.target.value)}
                  >
                    <option value="">（不指定，可稍后补）</option>
                    {positions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                ) : f.control === "textarea" ? (
                  <Textarea
                    value={form[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    rows={2}
                  />
                ) : (
                  <Input
                    type={f.control === "date" ? "date" : f.control === "number" ? "number" : "text"}
                    value={form[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    inputMode={
                      ["idCardNo", "phone", "workPhone", "bankAccountNo", "emergencyPhone1", "emergencyPhone2"].includes(
                        f.key
                      )
                        ? "numeric"
                        : undefined
                    }
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
      ))}

      <div className="flex items-center justify-end gap-3">
        <span className="text-[12px] text-slate-500">
          保存后自动生成员工编号（THHR…），并按状态出现在对应表里
        </span>
        <Button variant="secondary" onClick={() => router.back()} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" onClick={submit} loading={saving}>
          保存员工
        </Button>
      </div>
    </div>
  );
}
