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
import StorePicker from "@/components/common/StorePicker";
import PositionPicker from "@/components/common/PositionPicker";
import PositionNoteSelect from "@/components/common/PositionNoteSelect";
import YesNoSelect from "@/components/common/YesNoSelect";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";

/** Excel 原始字段（除核心字段外的全部 46 列）建在折叠分组里，确保不丢字段 */

type FormState = Record<string, string>;

type ScopePos = { id: number; name: string; group: "store" | "ops"; hasNote: boolean };

/** Stage 9.33：受控选项（用户 2026-09-28 定）—— 面试结果 / 文档类字段只允许这几个值 */
const INTERVIEW_RESULT_OPTIONS = ["通过", "不通过"] as const;
const YES_NO_OPTIONS = ["是", "否"] as const;

export interface EmployeeFormProps {
  mode: "create" | "edit";
  stores: { id: number; name: string }[];
  /** 门店选择范围（Stage 9.30）：在职表 + 南昌3店 的门店及在职人数 */
  storeScopeRaw?: { id: number; name: string; activeCount: number }[];
  /** 职位选择范围（Stage 9.32）：门店 7 种 + 运营部 3 种 */
  positionScopeRaw?: { store: ScopePos[]; ops: ScopePos[] };
  departments: { id: number; name: string }[];
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

const TEXT_FIELDS: {
  key: string;
  label: string;
  excel: string;
  hint?: string;
  /** Stage 7.3：yesno = 该字段只允许 是 / 否 / 空，用下拉而不是自由文本 */
  type?: "yesno";
}[] = [
  { key: "emergencyContact1", label: "紧急联系人1", excel: "L" },
  { key: "emergencyPhone1", label: "紧急联系人1电话", excel: "M" },
  { key: "emergencyContact2", label: "紧急联系人2", excel: "N" },
  { key: "emergencyPhone2", label: "紧急联系人2电话", excel: "O" },
  { key: "currentAddress", label: "现居住地址", excel: "X" },
  { key: "certificateLevel", label: "证书级别", excel: "AP" },
  { key: "positionNote", label: "职位备注", excel: "I" },
  { key: "dormitory", label: "是否住宿舍", excel: "J", type: "yesno" },
  { key: "mentorName", label: "带教人", excel: "AM" },
  { key: "onboardingMedical", label: "入职体检", excel: "T", type: "yesno" },
  { key: "socialInsurancePurchased", label: "社保购买", excel: "K", type: "yesno" },
  { key: "salaryTerms", label: "薪资待遇", excel: "W" },
  { key: "firstMonthGuarantee", label: "首月保障", excel: "AK" },
  { key: "bankBranch", label: "工资卡开户银行支行", excel: "U" },
  { key: "bankAccountNo", label: "银行卡账号", excel: "V", hint: "按字符串存储，支持前导零，不会转成科学计数法" },
  { key: "laborContract", label: "劳动合同", excel: "P", type: "yesno" },
  { key: "socialInsuranceAgreement", label: "社保协议", excel: "Q", type: "yesno" },
  { key: "fireSafetyCommitment", label: "消防承诺书", excel: "R", type: "yesno" },
  { key: "dormitoryWaiver", label: "宿舍免责协议", excel: "S", type: "yesno" },
  { key: "docResume", label: "简历表", excel: "AH" },
  { key: "docInterviewEvaluation", label: "面试评估表", excel: "AI" },
  { key: "docOnboardingForm", label: "入职表", excel: "AN" },
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
  // ⚠️ Stage 9.32：positionNote 已从折叠分组移出（改为「职位」旁边的三选一按钮，
  //    且只有美容职位才显示），避免同一个字段出现两次。
  { title: "职位补充", keys: ["certificateLevel"] },
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
    ],
  },
  {
    title: "招聘 / 面试（第一阶段仅保存字段）",
    keys: ["recruiterName", "interviewerName", "interviewHired"],
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
  storeScopeRaw = [],
  positionScopeRaw = { store: [], ops: [] },
  departments,
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
      departmentId: "",
      departmentNameRaw: "",
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

  /**
   * 门店候选（Stage 9.30）：在职表 + 南昌3店 的 40 家。
   * ⚠️ **当前门店不在范围内时，通过 extraStores 额外带上并标「当前门店」**：
   *    已离职员工的门店往往不在 40 家内，如果下拉里选不到，
   *    用户只改个手机号就会把门店**悄悄换掉** = 丢数据。
   */
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
  /** 当前门店不在 40 家内时，在候选列表里加一条「当前门店」标记项 */
  const storeExtras = useMemo(() => {
    const cur = storeSelected;
    if (!cur) return [];
    if (storeScope.some((s) => s.id === cur.id)) return [];
    return [{ id: cur.id, name: cur.name, tag: "当前门店", tagTone: "amber" as const }];
  }, [storeSelected, storeScope]);

  /* ---------- 职位（Stage 9.32：搜索下拉，门店 7 种 + 运营部 3 种） ---------- */
  /** 范围内职位，按门店/运营部分组 */
  const positionItems = useMemo(
    () => [...positionScopeRaw.store, ...positionScopeRaw.ops].map((p) => ({ id: p.id, name: p.name, group: p.group })),
    [positionScopeRaw]
  );
  /** 全部职位（筛选/展开用） */
  const allPositionOptions = useMemo(
    () => positions.map((p) => ({ id: p.id, name: p.name })),
    [positions]
  );
  const positionSelected = useMemo(() => {
    const cur = String(form.positionId ?? "");
    if (!cur) return null;
    const id = Number(cur);
    const hit = positionItems.find((p) => p.id === id);
    return hit ?? { id, name: positions.find((p) => String(p.id) === cur)?.name ?? `职位#${cur}` };
  }, [positionItems, positions, form.positionId]);
  /** 当前职位不在 7+3 范围内（如离职人员的「青铜机修技师」）也必须可选，否则会丢数据 */
  const positionExtras = useMemo(() => {
    const cur = positionSelected;
    if (!cur) return [];
    if (positionItems.some((p) => p.id === cur.id)) return [];
    return [{ id: cur.id, name: cur.name, tag: "当前职位" }];
  }, [positionSelected, positionItems]);
  /** 只有「美容」职位有职位备注（师傅/中工/学徒） */
  const isBeautyPosition = positionSelected?.name === "美容";

  /* ---------- 面试地点（Stage 9.33）：就是门店 ---------- */
  /** 面试地点存的是**店名文本**，不是门店 id，所以回显要从全量门店里按名字找 */
  const allStoreOptions = useMemo(() => stores.map((s) => ({ id: s.id, name: s.name })), [stores]);
  const interviewStoreSelected = useMemo(() => {
    const v = (form.interviewLocation ?? "").trim();
    if (!v) return null;
    const hit = allStoreOptions.find((x) => x.name === v) ?? storeScope.find((x) => x.name === v);
    return hit ?? { id: -1, name: v };
  }, [form.interviewLocation, allStoreOptions, storeScope]);
  /** 面试地点写了简称（如「沙湖大道店」，库里实际是「塘厦沙湖大道店」）也必须能选回 */
  const interviewStoreExtras = useMemo(() => {
    const cur = (form.interviewLocation ?? "").trim();
    if (!cur) return [];
    const exact = allStoreOptions.some((x) => x.name === cur);
    return exact ? [] : [{ id: -1, name: cur, tag: "已填地点", tagTone: "slate" as const }];
  }, [form.interviewLocation, allStoreOptions]);

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

          <Field
            label="门店"
            excelColumn="B"
            hint="优先从门店主数据中选择（在职表 + 南昌3店 共 40 家；输入店名搜索）"
          >
            <StorePicker
              stores={storeScope}
              extraStores={storeExtras}
              value={storeSelected}
              onChange={(s) => set("storeId")(s ? String(s.id) : "")}
              placeholder="输入门店名，如：大坪"
              emptyLabel="未指定 / 保留 Excel 原文"
            />
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

          <Field
            label="职位 / 工种"
            excelColumn="H"
            hint="门店 7 种 + 运营部 3 种，输入即可搜索"
          >
            <PositionPicker
              items={positionItems}
              allPositions={allPositionOptions}
              extraItems={positionExtras}
              value={positionSelected}
              onChange={(p) => {
                const v = p ? String(p.id) : "";
                set("positionId")(v);
                // 同步「工种级别（职位原文）」——编制表/人员分布/流失率都按它判定工种，
                // 不同步会出现「改了职位但编制表不变」。仍允许用户手动改。
                if (p) set("jobGradeRaw")(p.name);
              }}
              placeholder="输入职位，如：机修"
              emptyLabel="未指定 / 保留 Excel 原文"
            />
          </Field>

          {/* 职位备注：只有「美容」才有（师傅/中工/学徒），决定编制表两列口径 */}
          {isBeautyPosition ? (
            <Field
              label="职位备注"
              excelColumn="I"
              hint="只有「美容」职位需要填：师傅 / 中工 / 学徒"
            >
              <PositionNoteSelect
                value={form.positionNote}
                onChange={(v) => set("positionNote")(v)}
              />
            </Field>
          ) : null}

          {/* ---------- 招聘 / 面试（Stage 9.33：受控选项，不再是自由文本） ---------- */}
          <Field
            label="面试地点"
            excelColumn="AD"
            hint="在哪家门店面试的，输入店名搜索"
          >
            <StorePicker
              stores={storeScope}
              allStores={allStoreOptions}
              extraStores={interviewStoreExtras}
              value={interviewStoreSelected}
              onChange={(s) => {
                set("interviewLocation")(s ? s.name : "");
                // 同步门店主数据：面试地点如果确实是一家在营门店，顺带把档案门店对齐
                // 不会自动改（可能面试店 ≠ 现门店），这里只写原文，不动 storeId。
              }}
              placeholder="输入门店名，如：大坪"
              emptyLabel="（未填写）"
            />
          </Field>

          <Field label="面试结果" excelColumn="AE" hint="通过 / 不通过，也可留空（未知）">
            <YesNoSelect
              value={form.interviewResult}
              options={INTERVIEW_RESULT_OPTIONS}
              onChange={(v) => set("interviewResult")(v)}
            />
          </Field>

          <Field label="简历表" excelColumn="AH" hint="是 / 否，也可留空">
            <YesNoSelect value={form.docResume} options={YES_NO_OPTIONS} onChange={(v) => set("docResume")(v)} />
          </Field>

          <Field
            label="面试评估表"
            excelColumn="AI"
            hint="是 / 否，也可留空。招聘面试登记表与薪资表原本是同名列，现已合并为一项"
          >
            <YesNoSelect
              value={form.docInterviewEvaluation}
              options={YES_NO_OPTIONS}
              onChange={(v) => set("docInterviewEvaluation")(v)}
            />
          </Field>

          <Field label="入职表" excelColumn="AN" hint="是 / 否，也可留空">
            <YesNoSelect
              value={form.docOnboardingForm}
              options={YES_NO_OPTIONS}
              onChange={(v) => set("docOnboardingForm")(v)}
            />
          </Field>

          <Field
            label="部门"
            hint="Excel 只提供了「运营部」的部门归属；门店员工可在此手动指定"
          >
            <Select
              value={form.departmentId}
              onChange={(e) => set("departmentId")(e.target.value)}
            >
              <option value="">未分配部门</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="部门（Excel 原文）"
            hint="迁移数据保留的原始部门名称，不会被覆盖"
          >
            <Input
              value={form.departmentNameRaw}
              onChange={(e) => set("departmentNameRaw")(e.target.value)}
              placeholder="留空则跟随所选部门"
            />
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
                      hint={
                        m.type === "yesno"
                          ? "只允许 是 / 否 / 留空"
                          : m.hint
                      }
                    >
                      {m.type === "yesno" ? (
                        // Stage 7.3：7 个「是否」字段改下拉。
                        // 历史第三态（如 在职 / 外宿 / 新增人员 / 实习 / 做不了）保留为额外选项，原样不丢。
                        <Select
                          value={
                            form[m.key] === "是" || form[m.key] === "否"
                              ? form[m.key]
                              : ""
                          }
                          onChange={(e) => set(m.key)(e.target.value)}
                        >
                          <option value="">（未填）</option>
                          <option value="是">是</option>
                          <option value="否">否</option>
                          {form[m.key] &&
                          form[m.key] !== "是" &&
                          form[m.key] !== "否" ? (
                            <option value={form[m.key]}>
                              历史值：{form[m.key]}（保持不变）
                            </option>
                          ) : null}
                        </Select>
                      ) : m.key === "salaryTerms" ? (
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
