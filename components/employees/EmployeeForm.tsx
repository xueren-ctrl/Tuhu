"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";

/** Excel 原始字段（除核心字段外的全部 46 列）建在折叠分组里，确保不丢字段 */

type FormState = Record<string, string>;

export interface EmployeeFormProps {
  mode: "create" | "edit";
  stores: { id: number; name: string }[];
  positions: { id: number; name: string }[];
  initial?: Record<string, unknown> | null;
}

/** 把 Date / null 值转换成表单用的字符串（纯日期字段按 UTC 取值，避免串日） */
function toFormValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  // ISO 字符串转 yyyy-MM-dd
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

const TEXT_FIELDS: { key: string; label: string; excel: string; hint?: string }[] = [
  { key: "emergencyContact1", label: "紧急联系人1", excel: "L" },
  { key: "emergencyPhone1", label: "紧急联系人1电话", excel: "M" },
  { key: "emergencyContact2", label: "紧急联系人2", excel: "N" },
  { key: "emergencyPhone2", label: "紧急联系人2电话", excel: "O" },
  { key: "currentAddress", label: "现居住地址", excel: "X" },
  { key: "certificateLevel", label: "证书级别", excel: "AP" },
  { key: "positionNote", label: "职位备注", excel: "I" },
  { key: "dormitory", label: "是否住宿舍", excel: "J", hint: "Excel 原值：是 / ×" },
  { key: "mentorName", label: "带教人", excel: "AM" },
  { key: "onboardingMedical", label: "入职体检", excel: "T" },
  { key: "socialInsurancePurchased", label: "社保购买", excel: "K", hint: "Excel 原值：是 / ×" },
  { key: "salaryTerms", label: "薪资待遇", excel: "W" },
  { key: "firstMonthGuarantee", label: "首月保障", excel: "AK" },
  { key: "bankBranch", label: "工资卡开户银行支行", excel: "U" },
  { key: "bankAccountNo", label: "银行卡账号", excel: "V", hint: "按字符串存储，支持前导零，不会转成科学计数法" },
  { key: "laborContract", label: "劳动合同", excel: "P" },
  { key: "socialInsuranceAgreement", label: "社保协议", excel: "Q" },
  { key: "fireSafetyCommitment", label: "消防承诺书", excel: "R" },
  { key: "dormitoryWaiver", label: "宿舍免责协议", excel: "S" },
  { key: "docResume", label: "简历表", excel: "AH" },
  { key: "docInterviewEvaluation", label: "面试评估表", excel: "AI" },
  { key: "docOnboardingForm", label: "入职表", excel: "AN" },
  { key: "docInterviewEvaluation2", label: "面试评估表（重复列）", excel: "AO" },
  { key: "recruiterName", label: "招聘人", excel: "Y" },
  { key: "interviewLocation", label: "面试地点", excel: "AD" },
  { key: "interviewResult", label: "面试结果", excel: "AE" },
  { key: "interviewerName", label: "面试人", excel: "AF" },
  { key: "interviewHired", label: "是否入职", excel: "AG" },
  { key: "remark3", label: "备注（重复列）", excel: "AQ" },
  { key: "computed7Days", label: "是否满7天（快照）", excel: "AR" },
  { key: "computed2Months", label: "是否入职满2个月（快照）", excel: "AS" },
  { key: "tenureTextAtImport", label: "在职年限（导入快照）", excel: "D" },
  { key: "resignedTenureText", label: "在职年限-离职（导入快照）", excel: "AJ" },
  { key: "minorNote", label: "未成年备注", excel: "AT" },
];

const TEXT_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "联系方式补充",
    keys: ["emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2", "currentAddress"],
  },
  { title: "职位补充", keys: ["positionNote", "certificateLevel"] },
  { title: "入职信息补充", keys: ["dormitory", "mentorName", "onboardingMedical"] },
  { title: "社保（第一阶段仅保存字段）", keys: ["socialInsurancePurchased"] },
  {
    title: "薪资（第一阶段仅保存字段）",
    keys: ["salaryTerms", "firstMonthGuarantee", "bankBranch", "bankAccountNo"],
  },
  {
    title: "合同与入职资料",
    keys: [
      "laborContract",
      "socialInsuranceAgreement",
      "fireSafetyCommitment",
      "dormitoryWaiver",
      "docResume",
      "docInterviewEvaluation",
      "docOnboardingForm",
      "docInterviewEvaluation2",
    ],
  },
  {
    title: "招聘 / 面试（第一阶段仅保存字段）",
    keys: ["recruiterName", "interviewLocation", "interviewResult", "interviewerName", "interviewHired"],
  },
  {
    title: "其他字段与导入快照",
    keys: [
      "remark3",
      "computed7Days",
      "computed2Months",
      "tenureTextAtImport",
      "resignedTenureText",
      "minorNote",
    ],
  },
];

export default function EmployeeForm({
  mode,
  stores,
  positions,
  initial,
}: EmployeeFormProps) {
  const router = useRouter();

  const init = useMemo<FormState>(() => {
    const base: FormState = {
      name: "",
      idCardNo: "",
      phone: "",
      storeId: "",
      storeNameRaw: "",
      positionId: "",
      jobGradeRaw: "",
      hireDate: "",
      status: "ACTIVE",
      resignDate: "",
      resignDateRaw: "",
      resignReason: "",
      remark: "",
      gender: "",
      age: "",
      ageRaw: "",
      interviewDate: "",
    };
    for (const f of TEXT_FIELDS) base[f.key] = "";
    if (initial) {
      for (const k of Object.keys(base)) {
        if (k in initial) base[k] = toFormValue(initial[k]);
      }
    }
    return base;
  }, [initial]);

  const [form, setForm] = useState<FormState>(init);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const isResigned = form.status === "RESIGNED";

  const submit = async () => {
    setError("");
    setSaved("");

    if (!form.name.trim()) {
      setError("姓名必填");
      return;
    }
    if (form.idCardNo && !/^\d{17}[\dXx]$/.test(form.idCardNo.trim())) {
      // 只提示，不阻断：原始 Excel 中存在 17 位等不完整数据，必须允许保留
      const ok = window.confirm(
        "身份证号不是标准 18 位格式，仍要保存吗？\n（Excel 历史数据中存在不完整身份证号，系统允许原样保留）"
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...form };
      // 空串统一交给后端转 null
      for (const k of Object.keys(payload)) {
        if (payload[k] === "") payload[k] = null;
      }
      if (!isResigned) {
        payload.resignDate = null;
        payload.resignReason = null;
        payload.resignDateRaw = null;
      }

      const url =
        mode === "create" ? "/api/employees" : `/api/employees/${initial?.id}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "保存失败");

      if (mode === "create") {
        const id = json.data?.id;
        router.push(id ? `/employees/${id}?saved=1` : "/employees");
      } else {
        setSaved("保存成功，数据已写入数据库。");
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (t: string) => setOpen((o) => ({ ...o, [t]: !o[t] }));

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      {error ? <Alert tone="error">保存失败：{error}</Alert> : null}
      {saved ? <Alert tone="success">{saved}</Alert> : null}

      {/* ---------------- 核心字段 ---------------- */}
      <Card title={mode === "create" ? "核心字段（新增员工）" : "核心字段"}>
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="姓名" required excelColumn="E">
            <Input
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              placeholder="如：张三"
              maxLength={50}
            />
          </Field>

          <Field
            label="身份证号"
            excelColumn="F"
            hint="按字符串存储，支持末位 X / 前导零，不会被转成数字"
          >
            <Input
              value={form.idCardNo}
              onChange={(e) => set("idCardNo")(e.target.value)}
              placeholder="18 位身份证号"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              disabled={mode === "edit" && initial?.idCardNo ? false : undefined}
            />
          </Field>

          <Field label="联系电话" excelColumn="G" hint="按字符串存储，不会丢失前导零">
            <Input
              value={form.phone}
              onChange={(e) => set("phone")(e.target.value)}
              placeholder="11 位手机号"
              inputMode="tel"
              autoComplete="off"
              className="font-mono"
            />
          </Field>

          <Field label="门店" excelColumn="B" hint="优先从门店主数据中选择">
            <Select value={form.storeId} onChange={(e) => set("storeId")(e.target.value)}>
              <option value="">未指定 / 保留 Excel 原文</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="门店（Excel 原文）"
            excelColumn="B"
            hint="迁移数据保留的历史门店名称，不会被覆盖"
          >
            <Input
              value={form.storeNameRaw}
              onChange={(e) => set("storeNameRaw")(e.target.value)}
              placeholder="留空则跟随所选门店"
            />
          </Field>

          <Field label="职位 / 工种" excelColumn="H" hint="优先从职位主数据中选择">
            <Select
              value={form.positionId}
              onChange={(e) => set("positionId")(e.target.value)}
            >
              <option value="">未指定 / 保留 Excel 原文</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="工种级别（Excel 原文）"
            excelColumn="H"
            hint="如「青铜机修技师」，历史取值完整保留"
          >
            <Input
              value={form.jobGradeRaw}
              onChange={(e) => set("jobGradeRaw")(e.target.value)}
              placeholder="留空则跟随所选职位"
            />
          </Field>

          <Field label="入职日期" excelColumn="C">
            <Input
              type="date"
              value={form.hireDate}
              onChange={(e) => set("hireDate")(e.target.value)}
            />
          </Field>

          <Field label="状态" hint="离职时必须填写离职日期或离职原因">
            <Select value={form.status} onChange={(e) => set("status")(e.target.value)}>
              {EMPLOYEE_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}（{o.value}）
                </option>
              ))}
            </Select>
          </Field>

          {isResigned ? (
            <>
              <Field label="离职日期" excelColumn="AA">
                <Input
                  type="date"
                  value={form.resignDate}
                  onChange={(e) => set("resignDate")(e.target.value)}
                />
              </Field>
              <Field label="离职日期（Excel 原文）" excelColumn="AA" hint="如「9/30已离职」等非标准写法">
                <Input
                  value={form.resignDateRaw}
                  onChange={(e) => set("resignDateRaw")(e.target.value)}
                />
              </Field>
              <Field label="离职原因" excelColumn="Z">
                <Input
                  value={form.resignReason}
                  onChange={(e) => set("resignReason")(e.target.value)}
                  placeholder="如：自离 / 辞职"
                />
              </Field>
            </>
          ) : null}

          <Field label="备注" excelColumn="AL" className="sm:col-span-2 lg:col-span-3">
            <Textarea
              value={form.remark}
              onChange={(e) => set("remark")(e.target.value)}
              placeholder="补充说明"
            />
          </Field>

          {/* 只读系统字段 */}
          {mode === "edit" ? (
            <>
              <Field label="员工编号（不可修改）" hint="系统生成，永久唯一">
                <Input value={toFormValue(initial?.employeeId)} readOnly disabled />
              </Field>
              <Field label="创建时间（不可修改）">
                <Input value={toFormValue(initial?.createdAt)} readOnly disabled />
              </Field>
              <Field label="更新时间（保存后自动更新）">
                <Input value={toFormValue(initial?.updatedAt)} readOnly disabled />
              </Field>
            </>
          ) : (
            <Field label="员工编号" hint="保存后自动生成：THHR + 年份 + 6 位流水号">
              <Input value="保存后自动生成" readOnly disabled />
            </Field>
          )}
        </div>
      </Card>

      {/* ---------------- Excel 其余字段（折叠，保证不丢字段） ---------------- */}
      <Card
        title="Excel 其余字段（全部保留，可折叠）"
        extra={
          <span className="text-[11.5px] text-slate-400">
            共 {TEXT_FIELDS.length} 个非核心字段
          </span>
        }
      >
        <div className="mb-3 rounded-md border border-[var(--hr-border)] bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-500">
          这些字段来自 Excel「数据库」Sheet 的第 4~46 列。第一阶段不做业务逻辑，
          但<strong>全部原样落库、可查询、可编辑</strong>，后续再拆分为招聘 / 社保 / 薪资 / 合同 / 离职等子模块。
        </div>

        {TEXT_GROUPS.map((g) => {
          const isOpen = open[g.title] ?? false;
          const metas = g.keys
            .map((k) => TEXT_FIELDS.find((f) => f.key === k))
            .filter(Boolean) as typeof TEXT_FIELDS;
          return (
            <div key={g.title} className="mb-2 border border-[var(--hr-border)] rounded-md">
              <button
                type="button"
                onClick={() => toggle(g.title)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
              >
                <span>
                  {isOpen ? "▾" : "▸"} {g.title}
                  <span className="ml-2 text-[11px] font-normal text-slate-400">
                    {metas.length} 个字段
                  </span>
                </span>
                <span className="text-[11px] text-slate-400">
                  {metas.filter((m) => form[m.key]).length} 个已填
                </span>
              </button>
              {isOpen ? (
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 border-t border-[var(--hr-border)] p-3.5 sm:grid-cols-2 lg:grid-cols-3">
                  {metas.map((m) => (
                    <Field
                      key={m.key}
                      label={m.label}
                      excelColumn={m.excel}
                      hint={m.hint}
                    >
                      {m.key === "salaryTerms" ? (
                        <Textarea
                          value={form[m.key]}
                          onChange={(e) => set(m.key)(e.target.value)}
                        />
                      ) : (
                        <Input
                          value={form[m.key]}
                          onChange={(e) => set(m.key)(e.target.value)}
                          className={
                            m.key === "bankAccountNo" ? "font-mono" : undefined
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>

      {/* ---------------- 提交 ---------------- */}
      <div className="sticky bottom-0 -mx-5 flex items-center justify-between gap-3 border-t border-[var(--hr-border)] bg-white/95 px-5 py-3 backdrop-blur">
        <div className="text-[12px] text-slate-500">
          {mode === "create"
            ? "保存后自动生成员工编号并写入 SQLite，员工列表会立即显示该记录。"
            : "员工编号与创建时间不可修改；更新时间由系统自动维护。"}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => router.back()} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {mode === "create" ? "保存并生成员工编号" : "保存修改"}
          </Button>
        </div>
      </div>
    </div>
  );
}
