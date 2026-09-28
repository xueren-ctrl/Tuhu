/**
 * 各「表」的列定义 + 状态 → 表 的映射（纯常量，客户端可安全引用）
 *
 * 这是 Stage 9 的核心约定文件。两条规则：
 *
 * ① **状态决定这个人出现在哪些表**（STATUS_SHEETS）：
 *      候选中 → 哪都不出现；已面试 → 招聘面试登记表；
 *      已入职 → 在职 + 招聘面试登记表 + 薪资表； 离职 → 离职 + 招聘面试登记表 + 薪资表；
 *      南昌3店 / 运营部 / 运营部离职 → 各自的表 + 招聘面试登记表 + 薪资表；
 *      其他 → 只出现在「其他」表。
 *    「数据库」表不受状态限制，包含全部员工。
 *
 * ② **每张表按自己的列清单渲染**（SHEET_COLUMNS）：
 *    列名与顺序与 Excel 该 Sheet 一致；同一份数据在不同表里列名可能不同
 *    （如「工资卡的开户银行支行」/「开户行」都指向 bankBranch），
 *    所以这里用 source 把「列」映射到员工字段。
 *    以 `__` 包裹的是**计算列**（序号 / 在职年限 / 是否满7天 …），不落库、实时算。
 */

import type { SensitiveKind } from "./sheet-service";

/**
 * 字段 → 敏感类型（决定打码方式）
 * 与 listEmployees 的脱敏口径一致：身份证 / 银行卡 / 电话 / 地址 / 薪资。
 */
const SENSITIVE_KIND: Record<string, SensitiveKind> = {
  idCardNo: "idcard",
  phone: "phone",
  workPhone: "phone",
  emergencyPhone1: "phone",
  emergencyPhone2: "phone",
  bankAccountNo: "bankcard",
  currentAddress: "address",
  householdAddress: "address",
  salaryTerms: "money",
  firstMonthGuarantee: "money",
  // 注意：socialInsurancePurchased（社保购买 / 是否买社保）是「是 / 否」字段，
  // 打码只会把它变成「··」看不出内容，不属于需要遮蔽的个人信息，故不打码。
};

/** 按来源字段自动补敏感标记 */
function col(label: string, source: string, excelColumn?: string): SheetColumnSpec {
  return { label, source, sensitive: SENSITIVE_KIND[source] ?? null, excelColumn };
}

/** 表名（与 Excel Sheet 一致，也是 /sheets/<key> 的路径） */
export const SHEET_KEYS = [
  "在职",
  "离职",
  "南昌3店",
  "运营部",
  "招聘面试登记表",
  "运营部离职",
  "薪资表",
  "数据库",
] as const;

export type SheetKey = (typeof SHEET_KEYS)[number];

/** 计算列标记 */
export const COMPUTED = {
  SEQ: "__seq__",
  STORE: "__storeName__",
  DEPARTMENT: "__departmentName__",
  POSITION: "__positionName__",
  AGE: "__age__",
  TENURE: "__tenure__", // 在职年限（未离职算到今天的在职年限）
  RESIGNED_TENURE: "__resignedTenure__", // 在职期限（离职时点）
  TENURE_ANY: "__tenureAny__", // 离职看离职时点，未离职看今天
  WORK_7DAYS: "__work7days__",
  WORK_2MONTHS: "__work2months__",
  STATUS: "__status__",
} as const;

export const COMPUTED_LABELS: Record<string, string> = {
  [COMPUTED.SEQ]: "序号",
  [COMPUTED.STORE]: "门店名称",
  [COMPUTED.DEPARTMENT]: "部门",
  [COMPUTED.POSITION]: "工种级别",
  [COMPUTED.AGE]: "年龄",
  [COMPUTED.TENURE]: "在职年限",
  [COMPUTED.RESIGNED_TENURE]: "在职期限",
  [COMPUTED.TENURE_ANY]: "在职年限",
  [COMPUTED.WORK_7DAYS]: "是否满7天",
  [COMPUTED.WORK_2MONTHS]: "是否入职满2个月",
  [COMPUTED.STATUS]: "状态",
};

export interface SheetColumnSpec {
  /** 表头文字（与 Excel 该 Sheet 一致） */
  label: string;
  /** 取值来源：员工字段名，或 COMPUTED 里的计算列标记 */
  source: string;
  /** 敏感列类型（null = 不打码） */
  sensitive?: SensitiveKind | null;
  /** 该列在原 Excel 里的列位（用于详情页/表单提示） */
  excelColumn?: string;
}

// ------------------------------------------------------------
// 各表列定义（顺序 = Excel 列顺序）
// ------------------------------------------------------------

/** 在职 / 南昌3店 共用的门店人员列（两者列名与顺序一致） */
const STORE_STAFF_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("在职年限", COMPUTED.TENURE),
  col("姓名", "name"),
  col("身份证号", "idCardNo"),
  col("联系电话", "phone"),
  col("工种级别", COMPUTED.POSITION),
  col("职位备注", "positionNote"),
  col("是否住宿舍", "dormitory"),
  col("社保购买", "socialInsurancePurchased"),
  col("紧急联系人1", "emergencyContact1"),
  col("紧急联系人电话", "emergencyPhone1"),
  col("紧急联系人2", "emergencyContact2"),
  col("联系人电话", "emergencyPhone2"),
  col("劳动合同", "laborContract"),
  col("社保协议", "socialInsuranceAgreement"),
  col("消防承诺书", "fireSafetyCommitment"),
  col("宿舍免责协议", "dormitoryWaiver"),
  col("入职体检", "onboardingMedical"),
  col("工资卡的开户银行支行", "bankBranch"),
  col("银行卡账号", "bankAccountNo"),
  col("薪资待遇", "salaryTerms"),
  col("现居住地址", "currentAddress"),
  col("招聘人", "recruiterName"),
];

const RESIGNED_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("在职年限", COMPUTED.RESIGNED_TENURE),
  col("姓名", "name"),
  col("身份证号", "idCardNo"),
  col("联系电话", "phone"),
  col("工种级别", COMPUTED.POSITION),
  col("职位备注", "positionNote"),
  col("是否住宿舍", "dormitory"),
  col("社保购买", "socialInsurancePurchased"),
  col("紧急联系人1", "emergencyContact1"),
  col("联系人电话", "emergencyPhone1"),
  col("紧急联系人2", "emergencyContact2"),
  col("联系人电话", "emergencyPhone2"),
  col("劳动合同", "laborContract"),
  col("社保协议", "socialInsuranceAgreement"),
  col("消防承诺书", "fireSafetyCommitment"),
  col("宿舍免责协议", "dormitoryWaiver"),
  col("入职体检", "onboardingMedical"),
  col("开户行", "bankBranch"),
  col("银行卡账号", "bankAccountNo"),
  col("居住地址", "currentAddress"),
  col("离职原因", "resignReason"),
  col("备注（离职日期）", "resignDate"),
  col("招聘人", "recruiterName"),
];

const RECRUIT_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("姓名", "name"),
  col("联系电话", "phone"),
  col("职位", COMPUTED.POSITION),
  col("年龄", COMPUTED.AGE),
  col("面试时间", "interviewDate"),
  col("面试地点", "interviewLocation"),
  col("面试结果", "interviewResult"),
  col("面试人", "interviewerName"),
  col("是否入职", "interviewHired"),
  col("入职日期", "hireDate"),
  col("薪资待遇", "salaryTerms"),
  col("简历表", "docResume"),
  col("面试评估表", "docInterviewEvaluation"),
  col("招聘人", "recruiterName"),
];

const OPS_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("在职年限", COMPUTED.TENURE),
  col("姓名", "name"),
  col("职位", COMPUTED.POSITION),
  col("是否住宿舍", "dormitory"),
  col("是否买社保", "socialInsurancePurchased"),
  // 原表这两列表头同名，实际一列是联系人、一列是电话，这里按实际含义命名
  col("紧急联系人", "emergencyContact1"),
  col("紧急联系人电话", "emergencyPhone1"),
  col("开户行", "bankBranch"),
  col("银行卡账号", "bankAccountNo"),
  col("身份证号", "idCardNo"),
  col("联系电话", "phone"),
  col("工作电话", "workPhone"),
  col("户籍地址", "householdAddress"),
];

const OPS_RESIGNED_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("在职期限", COMPUTED.RESIGNED_TENURE),
  col("姓名", "name"),
  col("职位", COMPUTED.POSITION),
  col("是否住宿舍", "dormitory"),
  col("是否买社保", "socialInsurancePurchased"),
  col("劳动合同", "laborContract"),
  col("备注（薪资）", "remark"),
  col("开户行", "bankBranch"),
  col("银行卡账号", "bankAccountNo"),
  col("身份证号", "idCardNo"),
  col("联系电话", "phone"),
  col("工作电话", "workPhone"),
  col("户籍地址", "householdAddress"),
  col("离职日期", "resignDate"),
  col("离职原因", "resignReason"),
];

const SALARY_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("姓名", "name"),
  col("工种级别", COMPUTED.POSITION),
  col("首月保障", "firstMonthGuarantee"),
  // ⚠️ Stage 9.35：原「备注」列已并入「薪资待遇」（用户确认薪资表第一列备注=薪资待遇），不再重复显示
  col("招聘人", "recruiterName"),
  col("带教人", "mentorName"),
  col("入职表", "docOnboardingForm"),
  col("证书级别", "certificateLevel"),
  col("备注（重复列）", "remark3"),
  col("是否满7天", COMPUTED.WORK_7DAYS),
  col("是否入职满2个月", COMPUTED.WORK_2MONTHS),
];

const DATABASE_COLUMNS: SheetColumnSpec[] = [
  col("序号", COMPUTED.SEQ),
  col("门店名称", COMPUTED.STORE),
  col("入职时间", "hireDate"),
  col("在职年限", COMPUTED.TENURE_ANY),
  col("姓名", "name"),
  col("身份证号", "idCardNo"),
  col("联系电话", "phone"),
  col("工种级别", COMPUTED.POSITION),
  col("职位备注", "positionNote"),
  col("是否住宿舍", "dormitory"),
  col("社保购买", "socialInsurancePurchased"),
  col("紧急联系人1", "emergencyContact1"),
  col("联系人电话", "emergencyPhone1"),
  col("紧急联系人2", "emergencyContact2"),
  col("联系人电话", "emergencyPhone2"),
  col("劳动合同", "laborContract"),
  col("社保协议", "socialInsuranceAgreement"),
  col("消防承诺书", "fireSafetyCommitment"),
  col("宿舍免责协议", "dormitoryWaiver"),
  col("入职体检", "onboardingMedical"),
  col("工资卡的开户银行支行", "bankBranch"),
  col("银行卡账号", "bankAccountNo"),
  col("薪资待遇", "salaryTerms"),
  col("现居住地址", "currentAddress"),
  col("招聘人", "recruiterName"),
  col("离职原因", "resignReason"),
  col("备注（离职日期）", "resignDate"),
  col("年龄", COMPUTED.AGE),
  col("面试时间", "interviewDate"),
  col("面试地点", "interviewLocation"),
  col("面试结果", "interviewResult"),
  col("面试人", "interviewerName"),
  col("是否入职", "interviewHired"),
  col("简历表", "docResume"),
  col("面试评估表", "docInterviewEvaluation"),
  col("在职年限（离职）", COMPUTED.RESIGNED_TENURE),
  col("首月保障", "firstMonthGuarantee"),
  // ⚠️ Stage 9.35：同上，「备注」已并入「薪资待遇」
  col("带教人", "mentorName"),
  col("入职表", "docOnboardingForm"),
  col("证书级别", "certificateLevel"),
  col("备注（重复列）", "remark3"),
  col("是否满7天", COMPUTED.WORK_7DAYS),
  col("是否入职满2个月", COMPUTED.WORK_2MONTHS),
  col("未成年备注", "minorNote"),
];

/** 状态列：所有由员工数据生成的表都追加这一列（Excel 里没有，可用「列设置」隐藏） */
const STATUS_COLUMN: SheetColumnSpec = col("状态", COMPUTED.STATUS);

export const SHEET_COLUMNS: Record<SheetKey, SheetColumnSpec[]> = {
  在职: [...STORE_STAFF_COLUMNS, STATUS_COLUMN],
  离职: [...RESIGNED_COLUMNS, STATUS_COLUMN],
  南昌3店: [...STORE_STAFF_COLUMNS, STATUS_COLUMN],
  运营部: [...OPS_COLUMNS, STATUS_COLUMN],
  招聘面试登记表: [...RECRUIT_COLUMNS, STATUS_COLUMN],
  运营部离职: [...OPS_RESIGNED_COLUMNS, STATUS_COLUMN],
  薪资表: [...SALARY_COLUMNS, STATUS_COLUMN],
  数据库: [...DATABASE_COLUMNS, STATUS_COLUMN],
};

// ------------------------------------------------------------
// 状态 → 表 映射（用户 2026-09-26 确认，不可自行改动）
// ------------------------------------------------------------

export const STATUS_SHEETS: Record<string, string[]> = {
  CANDIDATE: [],
  INTERVIEWED: ["招聘面试登记表"],
  ACTIVE: ["在职", "招聘面试登记表", "薪资表"],
  RESIGNED: ["离职", "招聘面试登记表", "薪资表"],
  NC3: ["南昌3店", "招聘面试登记表", "薪资表"],
  OPS: ["运营部", "招聘面试登记表", "薪资表"],
  OPS_RESIGNED: ["运营部离职", "招聘面试登记表", "薪资表"],
  OTHER: ["其他"],
};

/** 某张表应该包含哪些状态的人（「数据库」= 全部） */
export function statusesForSheet(sheet: string): string[] | null {
  if (sheet === "数据库") return null; // null = 不限状态
  return Object.entries(STATUS_SHEETS)
    .filter(([, sheets]) => sheets.includes(sheet))
    .map(([status]) => status);
}

/**
 * 表的数据底座（用户 2026-09-26 确认）：
 *   employee —— 完全由员工数据生成（新增/改状态会立刻反映）
 *   excel    —— **以导入时的 Excel 原始名单为准**（人数与原来完全一致），
 *               只把「在软件里新增的员工」按状态规则追加在后面。
 *
 * 「招聘面试登记表」与「薪资表」用 excel 底座：
 * 这两张表本来就是「2026 年的名单」，历史上有的人面试 / 薪资数据已经找不到了，
 * 用户明确要求「不补了」——所以名单不动，只让以后新增的人进来。
 */
export type SheetBase = "employee" | "excel";

export const SHEET_BASE: Record<string, SheetBase> = {
  在职: "employee",
  离职: "employee",
  南昌3店: "employee",
  运营部: "employee",
  运营部离职: "employee",
  招聘面试登记表: "excel",
  薪资表: "excel",
  数据库: "employee",
};

export function sheetBase(sheet: string): SheetBase {
  return SHEET_BASE[sheet] ?? "employee";
}

/** 该状态的人会出现在哪些表（给「改状态」页面做影响预览） */
export function sheetsForStatus(status: string): string[] {
  return STATUS_SHEETS[status] ?? [];
}

/** 表 → 中文说明（导航与标题共用） */
export const SHEET_LABEL: Record<string, string> = {
  在职: "在职",
  离职: "离职",
  南昌3店: "南昌3店",
  运营部: "运营部",
  招聘面试登记表: "招聘面试登记表",
  运营部离职: "运营部离职",
  薪资表: "薪资表",
  数据库: "数据库",
  其他: "其他",
};

// ------------------------------------------------------------
// 新增员工表单：两类字段（对应三张表的列名去重合并）
// ------------------------------------------------------------

export interface FormFieldSpec {
  /** 提交的字段名（Employee 字段，或 storeId / departmentId 这类外键） */
  key: string;
  label: string;
  section: string;
  control: "text" | "textarea" | "date" | "number" | "select";
  /** select 的固定选项；为空则用系统下拉（门店 / 职位） */
  options?: string[];
  sensitive?: boolean;
  hint?: string;
  required?: boolean;
  /** 该字段来自哪几张表（去重后合并的依据） */
  from: string[];
}

/** 计算列 → 可填写的表单字段（外键下拉） */
const COMPUTED_TO_FIELD: Record<string, { key: string; label: string; section: string }> = {
  [COMPUTED.STORE]: { key: "storeId", label: "门店名称", section: "① 基本信息" },
  [COMPUTED.POSITION]: { key: "positionId", label: "职位 / 工种级别", section: "③ 入职与岗位" },
  [COMPUTED.DEPARTMENT]: { key: "departmentId", label: "部门", section: "① 基本信息" },
  [COMPUTED.AGE]: { key: "age", label: "年龄", section: "① 基本信息" },
};

/** 合并「三张表的列」→ 表单字段（同一份数据只出现一次，列名取第一次出现的写法） */
function mergeColumns(sheets: SheetKey[], sectionOf: (source: string) => string): FormFieldSpec[] {
  const seen = new Map<string, FormFieldSpec>();
  for (const sheet of sheets) {
    for (const c of SHEET_COLUMNS[sheet]) {
      const src = c.source;
      if (src === "storeNameRaw") continue;
      const mapped = COMPUTED_TO_FIELD[src];
      // 其余计算列（序号 / 在职年限 / 状态 / 是否满7天 …）不进表单
      if (src.startsWith("__") && !mapped) continue;

      const key = mapped ? mapped.key : src;
      const label = mapped ? mapped.label : c.label;
      const section = mapped ? mapped.section : sectionOf(src);

      const exist = seen.get(key);
      if (exist) {
        if (!exist.from.includes(sheet)) exist.from.push(sheet);
        continue;
      }
      seen.set(key, {
        key,
        label,
        section,
        control: mapped ? "select" : controlOf(src),
        options: mapped ? undefined : optionsOf(src),
        sensitive: c.sensitive ? true : undefined,
        hint: c.excelColumn,
        from: [sheet],
      });
    }
  }
  return [...seen.values()];
}

function controlOf(source: string): FormFieldSpec["control"] {
  if (source === "hireDate" || source === "resignDate" || source === "interviewDate") return "date";
  if (source === "age") return "number";
  if (source === "salaryTerms" || source === "remark" || source === "remark3") return "textarea";
  if (
    [
      "dormitory",
      "socialInsurancePurchased",
      "laborContract",
      "socialInsuranceAgreement",
      "fireSafetyCommitment",
      "dormitoryWaiver",
      "onboardingMedical",
      "interviewHired",
    ].includes(source)
  )
    return "select";
  return "text";
}

function optionsOf(source: string): string[] | undefined {
  if (
    [
      "dormitory",
      "socialInsurancePurchased",
      "laborContract",
      "socialInsuranceAgreement",
      "fireSafetyCommitment",
      "dormitoryWaiver",
      "onboardingMedical",
    ].includes(source)
  )
    return ["是", "否"];
  if (source === "interviewHired") return ["是", "否"];
  if (source === "interviewResult") return ["通过", "未通过", "待定"];
  return undefined;
}

/** 字段 → 分组标题 */
const SECTION_RULES: { test: (src: string) => boolean; section: string }[] = [
  { test: (s) => ["name", "idCardNo", "age", "phone", "workPhone"].includes(s), section: "① 基本信息" },
  { test: (s) => ["emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2", "currentAddress", "householdAddress"].includes(s), section: "② 联系方式与紧急联系人" },
  { test: (s) => ["dormitory", "onboardingMedical", "mentorName", "certificateLevel", "positionNote", "hireDate"].includes(s), section: "③ 入职与岗位" },
  { test: (s) => ["socialInsurancePurchased", "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver"].includes(s), section: "④ 社保与合同证明" },
  { test: (s) => ["bankBranch", "bankAccountNo", "salaryTerms", "firstMonthGuarantee"].includes(s), section: "⑤ 银行卡与薪资" },
  { test: (s) => ["resignDate", "resignReason"].includes(s), section: "⑥ 离职信息" },
  { test: (s) => ["remark", "remark3", "minorNote"].includes(s), section: "⑦ 备注" },
  { test: (s) => true, section: "⑧ 招聘面试" },
];

const sectionOf = (src: string) => SECTION_RULES.find((r) => r.test(src))!.section;

/** 门店新员工：在职 ∪ 招聘面试登记表 ∪ 薪资表 */
export const STORE_NEW_FIELDS: FormFieldSpec[] = mergeColumns(
  ["在职", "招聘面试登记表", "薪资表"],
  sectionOf
);

/** 运营部新员工：运营部 ∪ 招聘面试登记表 ∪ 薪资表 */
export const OPS_NEW_FIELDS: FormFieldSpec[] = mergeColumns(
  ["运营部", "招聘面试登记表", "薪资表"],
  sectionOf
);

export type NewEmployeeKind = "STORE" | "OPS";

export const NEW_EMPLOYEE_KINDS: {
  kind: NewEmployeeKind;
  label: string;
  desc: string;
  fields: FormFieldSpec[];
  defaultStatus: string;
}[] = [
  {
    kind: "STORE",
    label: "门店员工",
    desc: "在职 / 南昌3店 / 离职 类人员（字段 = 在职 + 招聘面试登记表 + 薪资表 的列，合并去重）",
    fields: STORE_NEW_FIELDS,
    defaultStatus: "ACTIVE",
  },
  {
    kind: "OPS",
    label: "运营部员工",
    desc: "运营部 / 运营部离职 类人员（字段 = 运营部 + 招聘面试登记表 + 薪资表 的列，合并去重）",
    fields: OPS_NEW_FIELDS,
    defaultStatus: "OPS",
  },
];

export function formFieldsFor(kind: NewEmployeeKind): FormFieldSpec[] {
  return (NEW_EMPLOYEE_KINDS.find((k) => k.kind === kind) ?? NEW_EMPLOYEE_KINDS[0]).fields;
}
