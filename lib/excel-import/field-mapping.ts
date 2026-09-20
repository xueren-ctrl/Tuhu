/**
 * Excel「数据库」Sheet —— 46 列字段映射（第五阶段）
 *
 * 这是**唯一**的列定义来源。正式导入与导入预览都从这里取列号、
 * 取值方式与字段中文名，任何一方都不得再写一份 COL。
 *
 * 列顺序被改动会导致身份证号写进银行卡列，因此在解析前会先校验关键列的表头文字。
 */
import type { FieldSpec } from "./types";

/** 纯定位用、不入库的列（序号） */
export const SEQ_COL = 1;

/**
 * 全部字段规格。
 * 说明：col 为 0 表示**派生字段**（不由单元格直接读取，而是由其它列推导）。
 * 同一列允许出现多条规格（例：第 27 列既产出 resignDate 又产出 resignDateRaw）。
 */
export const FIELD_SPECS: FieldSpec[] = [
  { col: 1, field: "seqNo", label: "序号", kind: "text", sensitive: false, header: "序号", comparable: false },

  { col: 2, field: "storeNameRaw", label: "门店", kind: "text", sensitive: false, header: "门店名称", comparable: true },
  { col: 3, field: "hireDate", label: "入职日期", kind: "date", sensitive: false, header: "入职时间", comparable: true },
  { col: 4, field: "tenureTextAtImport", label: "在职年限（导入快照）", kind: "text", sensitive: false, header: "在职年限", comparable: true },
  { col: 5, field: "name", label: "姓名", kind: "text", sensitive: false, header: "姓名", comparable: true },
  { col: 6, field: "idCardNo", label: "身份证号", kind: "idcard", sensitive: true, header: "身份证号", comparable: true },
  { col: 7, field: "phone", label: "手机号", kind: "digits", sensitive: true, header: "联系电话", comparable: true },
  { col: 8, field: "jobGradeRaw", label: "工种级别", kind: "text", sensitive: false, header: "工种级别", comparable: true },
  { col: 9, field: "positionNote", label: "职位备注", kind: "text", sensitive: false, header: "职位备注", comparable: true },
  { col: 10, field: "dormitory", label: "是否住宿舍", kind: "text", sensitive: false, header: "是否住宿舍", comparable: true },
  { col: 11, field: "socialInsurancePurchased", label: "社保购买", kind: "text", sensitive: false, header: "社保购买", comparable: true },
  { col: 12, field: "emergencyContact1", label: "紧急联系人1", kind: "text", sensitive: false, header: "紧急联系人1", comparable: true },
  { col: 13, field: "emergencyPhone1", label: "紧急联系人电话1", kind: "digits", sensitive: true, header: "紧急联系人电话1", comparable: true },
  { col: 14, field: "emergencyContact2", label: "紧急联系人2", kind: "text", sensitive: false, header: "紧急联系人2", comparable: true },
  { col: 15, field: "emergencyPhone2", label: "紧急联系人电话2", kind: "digits", sensitive: true, header: "紧急联系人电话2", comparable: true },
  { col: 16, field: "laborContract", label: "劳动合同", kind: "text", sensitive: false, header: "劳动合同", comparable: true },
  { col: 17, field: "socialInsuranceAgreement", label: "社保协议", kind: "text", sensitive: false, header: "社保协议", comparable: true },
  { col: 18, field: "fireSafetyCommitment", label: "消防承诺书", kind: "text", sensitive: false, header: "消防承诺书", comparable: true },
  { col: 19, field: "dormitoryWaiver", label: "宿舍免责协议", kind: "text", sensitive: false, header: "宿舍免责协议", comparable: true },
  { col: 20, field: "onboardingMedical", label: "入职体检", kind: "text", sensitive: false, header: "入职体检", comparable: true },
  { col: 21, field: "bankBranch", label: "开户行", kind: "text", sensitive: false, header: "工资卡的开户银行支行", comparable: true },
  { col: 22, field: "bankAccountNo", label: "银行卡账号", kind: "digits", sensitive: true, header: "银行卡账号", comparable: true },
  { col: 23, field: "salaryTerms", label: "薪资待遇", kind: "text", sensitive: true, header: "薪资待遇", comparable: true },
  { col: 24, field: "currentAddress", label: "现居住地址", kind: "text", sensitive: true, header: "现居住地址", comparable: true },
  { col: 25, field: "recruiterName", label: "招聘人", kind: "text", sensitive: false, header: "招聘人", comparable: true },
  { col: 26, field: "resignReason", label: "离职原因", kind: "text", sensitive: false, header: "离职原因", comparable: true },
  { col: 27, field: "resignDateRaw", label: "备注（离职日期原文）", kind: "raw", sensitive: false, header: "备注", comparable: true },
  { col: 27, field: "resignDate", label: "离职日期", kind: "date", sensitive: false, header: "备注", comparable: true },
  { col: 28, field: "ageRaw", label: "年龄（原文）", kind: "raw", sensitive: false, header: "年龄", comparable: true },
  { col: 28, field: "age", label: "年龄", kind: "int", sensitive: false, header: "年龄", comparable: true },
  { col: 29, field: "interviewDate", label: "面试时间", kind: "date", sensitive: false, header: "面试时间", comparable: true },
  { col: 30, field: "interviewLocation", label: "面试地点", kind: "text", sensitive: false, header: "面试地点", comparable: true },
  { col: 31, field: "interviewResult", label: "面试结果", kind: "text", sensitive: false, header: "面试结果", comparable: true },
  { col: 32, field: "interviewerName", label: "面试人", kind: "text", sensitive: false, header: "面试人", comparable: true },
  { col: 33, field: "interviewHired", label: "是否入职", kind: "text", sensitive: false, header: "是否入职", comparable: true },
  { col: 34, field: "docResume", label: "简历表", kind: "text", sensitive: false, header: "简历表", comparable: true },
  { col: 35, field: "docInterviewEvaluation", label: "面试评估表", kind: "text", sensitive: false, header: "面试评估表", comparable: true },
  { col: 36, field: "resignedTenureText", label: "在职年限（离职）", kind: "text", sensitive: false, header: "在职年限", comparable: true },
  { col: 37, field: "firstMonthGuarantee", label: "首月保障", kind: "text", sensitive: true, header: "首月保障", comparable: true },
  { col: 38, field: "remark", label: "备注", kind: "text", sensitive: false, header: "备注", comparable: true },
  { col: 39, field: "mentorName", label: "带教人", kind: "text", sensitive: false, header: "带教人", comparable: true },
  { col: 40, field: "docOnboardingForm", label: "入职表", kind: "text", sensitive: false, header: "入职表", comparable: true },
  { col: 41, field: "docInterviewEvaluation2", label: "面试评估表（重复列）", kind: "text", sensitive: false, header: "面试评估表", comparable: true },
  { col: 42, field: "certificateLevel", label: "证书级别", kind: "text", sensitive: false, header: "证书级别", comparable: true },
  { col: 43, field: "remark3", label: "备注（重复列）", kind: "text", sensitive: false, header: "备注", comparable: true },
  { col: 44, field: "computed7Days", label: "是否满7天", kind: "text", sensitive: false, header: "是否满7天", comparable: true },
  { col: 45, field: "computed2Months", label: "是否满2个月", kind: "text", sensitive: false, header: "是否入职满2个月", comparable: true },
  { col: 46, field: "minorNote", label: "未成年备注", kind: "text", sensitive: false, header: "未成年备注", comparable: true },

  // ---- 派生字段（col = 0）----
  { col: 0, field: "gender", label: "性别", kind: "text", sensitive: false, header: "（由身份证推导）", comparable: true },
  { col: 0, field: "status", label: "状态", kind: "text", sensitive: false, header: "（由离职信号推导）", comparable: true },
];

/** 参与 Diff / 写库的字段（去掉纯定位的 seqNo） */
export const COMPARABLE_SPECS = FIELD_SPECS.filter((s) => s.comparable);

/** 敏感字段集合：展示必须脱敏，写库必须用原始值 */
export const SENSITIVE_FIELDS = new Set(
  FIELD_SPECS.filter((s) => s.sensitive).map((s) => s.field)
);

/** 需要写入 Employee 表的字段（排除 seqNo） */
export const STORED_SPECS = FIELD_SPECS.filter((s) => s.field !== "seqNo");

/**
 * 表头校验用的关键列。
 * 只校验这 6 列：它们是「一旦错位就会造成身份信息写错字段」的高危列。
 */
export const EXPECTED_HEADER: Array<[number, string]> = [
  [2, "门店名称"],
  [3, "入职时间"],
  [5, "姓名"],
  [6, "身份证号"],
  [7, "联系电话"],
  [8, "工种级别"],
];

/** 列号 → 规格（同一列可能有多条，如第 27 列） */
export const SPECS_BY_COL = (() => {
  const m = new Map<number, FieldSpec[]>();
  for (const s of FIELD_SPECS) {
    if (s.col === 0) continue;
    const arr = m.get(s.col) ?? [];
    arr.push(s);
    m.set(s.col, arr);
  }
  return m;
})();

/** 字段名 → 规格 */
export const SPEC_BY_FIELD = new Map(FIELD_SPECS.map((s) => [s.field, s]));

/** 字段名 → 中文名（界面与 Diff 展示用） */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  FIELD_SPECS.map((s) => [s.field, s.label])
);

/** Excel 列号（1-based）→ A/B/C… 便于人工对照 */
export function colLetter(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
