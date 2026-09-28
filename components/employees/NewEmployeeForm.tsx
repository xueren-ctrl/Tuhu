"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import StorePicker from "@/components/common/StorePicker";
import PositionPicker from "@/components/common/PositionPicker";
import PositionNoteSelect from "@/components/common/PositionNoteSelect";
import YesNoSelect from "@/components/common/YesNoSelect";
import MarkSelect from "@/components/common/MarkSelect";
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

type ScopePos = { id: number; name: string; group: "store" | "ops"; hasNote: boolean };

/** Stage 9.36：面试结果固定选项（用户 2026-09-29 定：通过 / 不通过 / 留空） */
const INTERVIEW_RESULT_OPTIONS = ["通过", "不通过"] as const;

export default function NewEmployeeForm({
  kind,
  fields,
  defaultStatus,
  stores,
  storeScopeRaw = [],
  positionScopeRaw = { store: [], ops: [] },
  departments,
  positions,
  opsDepartmentId,
}: {
  kind: NewEmployeeKind;
  fields: FormFieldSpec[];
  defaultStatus: string;
  stores: { id: number; name: string }[];
  /** 门店选择范围（Stage 9.30）：在职表 + 南昌3店 的门店及在职人数 */
  storeScopeRaw?: { id: number; name: string; activeCount: number }[];
  /** 职位选择范围（Stage 9.32）：门店 7 种 + 运营部 3 种 */
  positionScopeRaw?: { store: ScopePos[]; ops: ScopePos[] };
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

  /** 门店候选（Stage 9.30）：只在 40 家（在职 37 + 南昌3店 3）里选 */
  const storeScope = useMemo(
    () => storeScopeRaw.map((s) => ({ id: s.id, name: s.name, activeCount: s.activeCount })),
    [storeScopeRaw]
  );
  const storeSelected = useMemo(() => {
    const cur = String(form.storeId ?? "");
    if (!cur) return null;
    const id = Number(cur);
    const hit = storeScope.find((s) => s.id === id);
    return hit ?? { id, name: stores.find((s) => String(s.id) === cur)?.name ?? `门店#${cur}` };
  }, [storeScope, stores, form.storeId]);
  /* ---------- 职位（Stage 9.32） ---------- */
  const positionItems = useMemo(
    () => [...positionScopeRaw.store, ...positionScopeRaw.ops].map((p) => ({ id: p.id, name: p.name, group: p.group })),
    [positionScopeRaw]
  );
  const positionSelected = useMemo(() => {
    const cur = String(form.positionId ?? "");
    if (!cur) return null;
    const id = Number(cur);
    const hit = positionItems.find((p) => p.id === id);
    return hit ?? { id, name: positions.find((p) => String(p.id) === cur)?.name ?? `职位#${cur}` };
  }, [positionItems, positions, form.positionId]);
  /** 只有「美容」职位显示职位备注（师傅/中工/学徒） */
  const isBeautyPosition = positionSelected?.name === "美容";

  /** 新员工不该挂到范围外的历史门店，但回显仍要兜住（不静默丢用户已选的值） */
  const storeExtras = useMemo(() => {
    const cur = storeSelected;
    if (!cur) return [];
    if (storeScope.some((s) => s.id === cur.id)) return [];
    return [{ id: cur.id, name: cur.name, tag: "当前选择", tagTone: "amber" as const }];
  }, [storeSelected, storeScope]);

  // 运营部员工不需要选门店（固定挂在运营部）
  const visibleFields = useMemo(
    () => (kind === "OPS" ? fields.filter((f) => f.key !== "storeId") : fields),
    [fields, kind]
  );

  /* ---------- 面试地点（Stage 9.36）----------
   * 面试地点存的是**店名文本**（不是门店 id），所以回显要从门店名反查。
   * 范围与「门店」一致：在职 36 家 + 南昌3店 3 家 = 39 家。
   */
  const interviewLocationSelected = useMemo(() => {
    const v = (form.interviewLocation ?? "").trim();
    if (!v) return null;
    const hit = storeScope.find((s) => s.name === v);
    return hit ?? { id: -1, name: v };
  }, [form.interviewLocation, storeScope]);
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
                  <StorePicker
                    stores={storeScope}
                    extraStores={storeExtras}
                    value={storeSelected}
                    onChange={(s) => set("storeId", s ? String(s.id) : "")}
                    placeholder="输入门店名，如：大坪"
                    emptyLabel="（暂不指定）"
                  />
                ) : f.key === "positionId" ? (
                  <PositionPicker
                    items={positionItems}
                    value={positionSelected}
                    onChange={(p) => {
                      set("positionId", p ? String(p.id) : "");
                      // 同步职位原文（编制表/人员分布/流失率都按它判定工种）
                      if (p) set("jobGradeRaw", p.name);
                    }}
                    placeholder="输入职位，如：机修"
                    emptyLabel="（不指定，可稍后补）"
                  />
                ) : f.key === "positionNote" ? (
                  // 职位备注：只有「美容」才有意义，其余职位不显示
                  isBeautyPosition ? (
                    <PositionNoteSelect
                      value={form.positionNote ?? ""}
                      onChange={(v) => set("positionNote", v)}
                    />
                  ) : (
                    <div className="flex h-9 items-center text-[12.5px] text-slate-400">
                      只有「美容」职位需要填备注
                    </div>
                  )
                ) : f.control === "storeSearch" || f.key === "interviewLocation" ? (
                  /* ---------- 面试地点（Stage 9.36）：门店搜索，范围=在职 36 + 南昌3店 3 ---------- */
                  <StorePicker
                    stores={storeScope}
                    value={interviewLocationSelected}
                    onChange={(s) => set("interviewLocation", s ? s.name : "")}
                    placeholder="输入门店名，如：大坪"
                    emptyLabel="（未填写）"
                  />
                ) : f.control === "passfail" || f.key === "interviewResult" ? (
                  /* ---------- 面试结果（Stage 9.36）：通过 / 不通过 / 留空 ---------- */
                  <YesNoSelect
                    value={form[f.key] ?? ""}
                    options={INTERVIEW_RESULT_OPTIONS}
                    onChange={(v) => set(f.key, v)}
                  />
                ) : f.control === "tick" ||
                  f.key === "docResume" ||
                  f.key === "docInterviewEvaluation" ||
                  f.key === "docOnboardingForm" ? (
                  /* ---------- 材料三字段（Stage 9.36）：√ / 留空 ---------- */
                  <MarkSelect value={form[f.key] ?? ""} onChange={(v) => set(f.key, v)} label="已交" />
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
