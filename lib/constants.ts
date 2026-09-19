/**
 * 全局常量 —— 状态、字段分组、脱敏、分页等统一口径
 */

// ---------- 员工状态（SQLite 无 enum，用常量约束）----------
export const EMPLOYEE_STATUS = {
  ACTIVE: "ACTIVE",
  RESIGNED: "RESIGNED",
  CANDIDATE: "CANDIDATE",
} as const;

export type EmployeeStatus =
  (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];

export const EMPLOYEE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "在职",
  RESIGNED: "离职",
  CANDIDATE: "候选人",
};

export const EMPLOYEE_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "在职" },
  { value: "RESIGNED", label: "离职" },
  { value: "CANDIDATE", label: "候选人" },
];

// ---------- 通用启用状态 ----------
export const RECORD_STATUS = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;

export const RECORD_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "启用",
  INACTIVE: "停用",
};

/**
 * 筛选「未分配」的哨兵值。
 * 用于门店 / 部门 / 职位筛选中表达「未指定该字段」，例如：
 *   /employees/views/departments?departmentId=__none__
 */
export const UNASSIGNED = "__none__";
export const UNASSIGNED_LABEL = "未分配";

// ---------- 用户角色（第一阶段预留）----------
export const USER_ROLE = { ADMIN: "ADMIN", HR: "HR" } as const;
export const USER_ROLE_LABEL: Record<string, string> = {
  ADMIN: "管理员",
  HR: "HR普通用户",
};

// ---------- 敏感字段（需要脱敏 / 权限控制）----------
export const SENSITIVE_FIELDS = [
  "idCardNo",
  "phone",
  "bankAccountNo",
  "currentAddress",
  "salaryTerms",
  "firstMonthGuarantee",
  "socialInsurancePurchased",
  "emergencyPhone1",
  "emergencyPhone2",
] as const;

// ---------- 分页 ----------
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// ---------- 排序白名单（防注入）----------
export const SORTABLE_FIELDS = [
  "employeeId",
  "name",
  "hireDate",
  "resignDate",
  "status",
  "createdAt",
  "updatedAt",
] as const;

export type SortableField = (typeof SORTABLE_FIELDS)[number];

// ---------- 员工档案分组（详情页 Tab 用）----------
export const EMPLOYEE_GROUPS = [
  { key: "basic", label: "基本信息" },
  { key: "contact", label: "联系方式" },
  { key: "org", label: "门店 / 部门" },
  { key: "position", label: "职位信息" },
  { key: "onboard", label: "入职信息" },
  { key: "social", label: "社保" },
  { key: "salary", label: "薪资" },
  { key: "contract", label: "合同与资料" },
  { key: "recruit", label: "招聘面试" },
  { key: "resign", label: "离职信息" },
  { key: "other", label: "其他字段" },
  { key: "system", label: "系统信息" },
] as const;

export type EmployeeGroupKey = (typeof EMPLOYEE_GROUPS)[number]["key"];

/**
 * 字段元数据：中文标签 + 所属分组 + 是否敏感
 * 供详情页 / 表单 / 列表列共用，避免各处重复定义。
 */
export interface FieldMeta {
  key: string;
  label: string;
  group: EmployeeGroupKey;
  sensitive?: boolean;
  /** 表单控件类型 */
  control?: "text" | "textarea" | "date" | "number" | "select";
  /** Excel 原始列（便于对照 docs/excel-analysis.md） */
  excelColumn?: string;
}

export const EMPLOYEE_FIELDS: FieldMeta[] = [
  // ① 基本信息
  { key: "name", label: "姓名", group: "basic", control: "text", excelColumn: "E 姓名" },
  { key: "idCardNo", label: "身份证号", group: "basic", sensitive: true, control: "text", excelColumn: "F 身份证号" },
  { key: "gender", label: "性别", group: "basic", control: "select", excelColumn: "（由身份证号推导）" },
  { key: "age", label: "年龄", group: "basic", control: "number", excelColumn: "AB 年龄" },
  { key: "ageRaw", label: "年龄（原文）", group: "basic", control: "text", excelColumn: "AB 年龄" },
  { key: "minorNote", label: "未成年备注", group: "basic", control: "text", excelColumn: "AT 未成年备注" },

  // ② 联系方式
  { key: "phone", label: "联系电话", group: "contact", sensitive: true, control: "text", excelColumn: "G 联系电话" },
  { key: "currentAddress", label: "现居住地址", group: "contact", sensitive: true, control: "text", excelColumn: "X 现居住地址" },
  { key: "emergencyContact1", label: "紧急联系人1", group: "contact", control: "text", excelColumn: "L 紧急联系人1" },
  { key: "emergencyPhone1", label: "紧急联系人1电话", group: "contact", sensitive: true, control: "text", excelColumn: "M 联系人电话" },
  { key: "emergencyContact2", label: "紧急联系人2", group: "contact", control: "text", excelColumn: "N 紧急联系人2" },
  { key: "emergencyPhone2", label: "紧急联系人2电话", group: "contact", sensitive: true, control: "text", excelColumn: "O 联系人电话" },

  // ③ 门店 / 部门
  { key: "storeName", label: "门店", group: "org", control: "select", excelColumn: "B 门店名称" },
  { key: "storeNameRaw", label: "门店（Excel原文）", group: "org", control: "text", excelColumn: "B 门店名称" },
  { key: "departmentName", label: "部门", group: "org", control: "select", excelColumn: "（来自「运营部」等 Sheet）" },
  { key: "departmentNameRaw", label: "部门（Excel原文）", group: "org", control: "text", excelColumn: "（来自「运营部」等 Sheet）" },

  // ④ 职位信息
  { key: "positionName", label: "职位／工种", group: "position", control: "select", excelColumn: "H 工种级别" },
  { key: "jobGradeRaw", label: "工种级别（Excel原文）", group: "position", control: "text", excelColumn: "H 工种级别" },
  { key: "positionNote", label: "职位备注", group: "position", control: "text", excelColumn: "I 职位备注" },
  { key: "certificateLevel", label: "证书级别", group: "position", control: "text", excelColumn: "AP 证书级别" },

  // ⑤ 入职信息
  { key: "hireDate", label: "入职日期", group: "onboard", control: "date", excelColumn: "C 入职时间" },
  { key: "dormitory", label: "是否住宿舍", group: "onboard", control: "text", excelColumn: "J 是否住宿舍" },
  { key: "mentorName", label: "带教人", group: "onboard", control: "text", excelColumn: "AM 带教人" },
  { key: "onboardingMedical", label: "入职体检", group: "onboard", control: "text", excelColumn: "T 入职体检" },

  // ⑥ 社保
  { key: "socialInsurancePurchased", label: "社保购买", group: "social", sensitive: true, control: "text", excelColumn: "K 社保购买" },

  // ⑦ 薪资
  { key: "salaryTerms", label: "薪资待遇", group: "salary", sensitive: true, control: "textarea", excelColumn: "W 薪资待遇" },
  { key: "firstMonthGuarantee", label: "首月保障", group: "salary", sensitive: true, control: "text", excelColumn: "AK 首月保障" },
  { key: "bankBranch", label: "工资卡开户银行支行", group: "salary", control: "text", excelColumn: "U 工资卡的开户银行支行" },
  { key: "bankAccountNo", label: "银行卡账号", group: "salary", sensitive: true, control: "text", excelColumn: "V 银行卡账号" },

  // ⑧ 合同与资料
  { key: "laborContract", label: "劳动合同", group: "contract", control: "text", excelColumn: "P 劳动合同" },
  { key: "socialInsuranceAgreement", label: "社保协议", group: "contract", control: "text", excelColumn: "Q 社保协议" },
  { key: "fireSafetyCommitment", label: "消防承诺书", group: "contract", control: "text", excelColumn: "R 消防承诺书" },
  { key: "dormitoryWaiver", label: "宿舍免责协议", group: "contract", control: "text", excelColumn: "S 宿舍免责协议" },
  { key: "docResume", label: "简历表", group: "contract", control: "text", excelColumn: "AH 简历表" },
  { key: "docInterviewEvaluation", label: "面试评估表", group: "contract", control: "text", excelColumn: "AI 面试评估表" },
  { key: "docOnboardingForm", label: "入职表", group: "contract", control: "text", excelColumn: "AN 入职表" },
  { key: "docInterviewEvaluation2", label: "面试评估表（重复列）", group: "contract", control: "text", excelColumn: "AO 面试评估表" },

  // ⑨ 招聘面试
  { key: "recruiterName", label: "招聘人", group: "recruit", control: "text", excelColumn: "Y 招聘人" },
  { key: "interviewDate", label: "面试时间", group: "recruit", control: "date", excelColumn: "AC 面试时间" },
  { key: "interviewLocation", label: "面试地点", group: "recruit", control: "text", excelColumn: "AD 面试地点" },
  { key: "interviewResult", label: "面试结果", group: "recruit", control: "text", excelColumn: "AE 面试结果" },
  { key: "interviewerName", label: "面试人", group: "recruit", control: "text", excelColumn: "AF 面试人" },
  { key: "interviewHired", label: "是否入职", group: "recruit", control: "text", excelColumn: "AG 是否入职" },

  // ⑩ 离职信息
  { key: "resignDate", label: "离职日期", group: "resign", control: "date", excelColumn: "AA 备注（离职日期）" },
  { key: "resignDateRaw", label: "离职日期（Excel原文）", group: "resign", control: "text", excelColumn: "AA 备注（离职日期）" },
  { key: "resignReason", label: "离职原因", group: "resign", control: "text", excelColumn: "Z 离职原因" },

  // ⑪ 其他字段
  { key: "remark", label: "备注", group: "other", control: "textarea", excelColumn: "AL 备注" },
  { key: "remark3", label: "备注（重复列）", group: "other", control: "text", excelColumn: "AQ 备注" },
  { key: "computed7Days", label: "是否满7天（快照）", group: "other", control: "text", excelColumn: "AR 是否满7天" },
  { key: "computed2Months", label: "是否入职满2个月（快照）", group: "other", control: "text", excelColumn: "AS 是否入职满2个月" },
  { key: "tenureTextAtImport", label: "在职年限（导入快照）", group: "other", control: "text", excelColumn: "D 在职年限" },
  { key: "resignedTenureText", label: "在职年限-离职（导入快照）", group: "other", control: "text", excelColumn: "AJ 在职年限（离职）" },

  // ⑫ 系统信息
  { key: "employeeId", label: "员工编号", group: "system", excelColumn: "（系统生成）" },
  { key: "status", label: "状态", group: "system", control: "select", excelColumn: "（由离职字段判定）" },
  { key: "sourceSheet", label: "来源Sheet", group: "system", excelColumn: "（系统记录）" },
  { key: "sourceRowNo", label: "来源行号", group: "system", excelColumn: "（系统记录）" },
  { key: "importBatch", label: "导入批次", group: "system", excelColumn: "（系统记录）" },
  { key: "dataFlags", label: "数据异常标记", group: "system", excelColumn: "（系统记录）" },
  { key: "deletedAt", label: "停用/删除时间", group: "system", excelColumn: "（系统记录）" },
  { key: "createdAt", label: "创建时间", group: "system", excelColumn: "（系统记录）" },
  { key: "updatedAt", label: "更新时间", group: "system", excelColumn: "（系统记录）" },
];

export const EMPLOYEE_FIELD_MAP: Record<string, FieldMeta> = Object.fromEntries(
  EMPLOYEE_FIELDS.map((f) => [f.key, f])
);

/** 字段过多，详情页默认只展示这些；其余按需展开 */
export const KEY_FIELD_KEYS = [
  "employeeId",
  "name",
  "idCardNo",
  "phone",
  "storeName",
  "positionName",
  "status",
  "hireDate",
  "resignDate",
  "resignReason",
  "remark",
];
