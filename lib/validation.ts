import { z } from "zod";
import { EMPLOYEE_FIELDS } from "./constants";
import {
  normalizeBankAccount,
  normalizeIdCard,
  normalizeName,
  normalizePhone,
  toDateOnly,
  toNullableInt,
  toNullableText,
} from "./format";

/** 可空文本：空串统一转 null */
const nullableText = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => toNullableText(v));

/**
 * 7 个「是否」字段的写库校验（Stage 7.3 立、Stage 10.1 修订）。
 *
 * **2026-10-22 修订**：Excel 历史写法 `×`、`/`（语义都是「否」）改为**原样放行**。
 *   原因：从人工表全量导入后，这两个写法分布很广（住宿舍 832 人、社保购买 1101 人、
 *   宿舍免责协议 80 人、其余零星，合计约 2000 处）。旧规则「禁止再写入」会让几乎
 *   每个员工一进编辑页、什么都不改、点保存就报错，而用户明确要求历史数据保持原样。
 *   界面侧这 7 个字段仍是「是 / 否 / 空」下拉，不会因放行而让新数据继续用旧写法。
 * 历史第三态（在职 / 外宿 / 新增人员 / 实习 / 做不了 等）同样原样放行，
 *   避免详情页保存时把老值误清掉。
 */
const yesNoField = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = toNullableText(v);
    if (s === null) return null;
    const t = s.trim();
    if (t === "") return null;
    // 是 / 否 / × / / / 历史第三态：一律原样保存，不做改写
    return t;
  });

/** 可空日期：接受 yyyy-MM-dd / ISO / 空串，统一转为 UTC 零点的「纯日期」 */
const nullableDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = toNullableText(v);
    if (s === null) return null;
    // yyyy-MM-dd（前端 <input type="date"> 的标准输出）
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return toDateOnly(Number(m[1]), Number(m[2]), Number(m[3]));
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return toDateOnly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  });

/** 可空整数 */
const nullableInt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => toNullableInt(v));

/** 可空外键 id */
const nullableId = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    const n = toNullableInt(v);
    return n === null || n <= 0 ? null : n;
  });

/** 身份证号：规范化为字符串，绝不转数字 */
const idCardField = nullableText.transform((v) => {
  const n = normalizeIdCard(v);
  return n;
});

const phoneField = nullableText.transform((v) => normalizePhone(v));
const bankField = nullableText.transform((v) => normalizeBankAccount(v));

export const employeeCreateSchema = z.object({
  name: z
    .string({ required_error: "姓名必填" })
    .transform((v) => normalizeName(v) ?? "")
    .refine((v) => v.length > 0, { message: "姓名必填" })
    .refine((v) => v.length <= 50, { message: "姓名过长" }),

  idCardNo: idCardField.optional().nullable(),
  phone: phoneField.optional().nullable(),

  storeId: nullableId.optional(),
  storeNameRaw: nullableText.optional(),
  departmentId: nullableId.optional(),
  departmentNameRaw: nullableText.optional(),
  positionId: nullableId.optional(),
  jobGradeRaw: nullableText.optional(),
  positionNote: nullableText.optional(),

  hireDate: nullableDate.optional(),
  // 状态取值与 lib/constants.ts 的 EMPLOYEE_STATUS 保持一致（决定出现在哪些表）
  status: z
    .enum([
      "CANDIDATE",
      "INTERVIEWED",
      "ACTIVE",
      "RESIGNED",
      "NC3",
      "OPS",
      "OPS_RESIGNED",
      "OTHER",
    ])
    .default("ACTIVE"),
  resignDate: nullableDate.optional(),
  resignDateRaw: nullableText.optional(),
  resignReason: nullableText.optional(),
  remark: nullableText.optional(),

  // 其余 Excel 字段（可选，全部保留）
  gender: nullableText.optional(),
  age: nullableInt.optional(),
  ageRaw: nullableText.optional(),
  minorNote: nullableText.optional(),
  currentAddress: nullableText.optional(),
  workPhone: phoneField.optional().nullable(),
  householdAddress: nullableText.optional(),
  emergencyContact1: nullableText.optional(),
  emergencyPhone1: nullableText.optional(),
  emergencyContact2: nullableText.optional(),
  emergencyPhone2: nullableText.optional(),
  certificateLevel: nullableText.optional(),
  dormitory: yesNoField.optional(),
  mentorName: nullableText.optional(),
  onboardingMedical: yesNoField.optional(),
  socialInsurancePurchased: yesNoField.optional(),
  salaryTerms: nullableText.optional(),
  firstMonthGuarantee: nullableText.optional(),
  bankBranch: nullableText.optional(),
  bankAccountNo: bankField.optional(),
  laborContract: yesNoField.optional(),
  socialInsuranceAgreement: yesNoField.optional(),
  fireSafetyCommitment: yesNoField.optional(),
  dormitoryWaiver: yesNoField.optional(),
  docResume: nullableText.optional(),
  docInterviewEvaluation: nullableText.optional(),
  docOnboardingForm: nullableText.optional(),
  docInterviewEvaluation2: nullableText.optional(),
  recruiterName: nullableText.optional(),
  interviewDate: nullableDate.optional(),
  interviewLocation: nullableText.optional(),
  interviewResult: nullableText.optional(),
  interviewerName: nullableText.optional(),
  interviewHired: nullableText.optional(),
  remark3: nullableText.optional(),
  computed7Days: nullableText.optional(),
  computed2Months: nullableText.optional(),
  tenureTextAtImport: nullableText.optional(),
  resignedTenureText: nullableText.optional(),
});

/** 更新：employee_id / createdAt 一律不允许被普通编辑修改 */
export const employeeUpdateSchema = employeeCreateSchema
  .partial()
  .omit({ name: true })
  .extend({
    name: z
      .string()
      .transform((v) => normalizeName(v) ?? "")
      .refine((v) => v.length > 0, { message: "姓名必填" })
      .optional(),
  });

export const storeSchema = z.object({
  name: z
    .string({ required_error: "门店名称必填" })
    .transform((v) => normalizeName(v) ?? "")
    .refine((v) => v.length > 0, { message: "门店名称必填" })
    .refine((v) => v.length <= 100, { message: "门店名称过长" }),
  code: nullableText.optional(),
  region: nullableText.optional(),
  address: nullableText.optional(),
  plannedHeadcount: nullableInt.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  remark: nullableText.optional(),
});

export const departmentSchema = z.object({
  name: z
    .string({ required_error: "部门名称必填" })
    .transform((v) => normalizeName(v) ?? "")
    .refine((v) => v.length > 0, { message: "部门名称必填" })
    .refine((v) => v.length <= 60, { message: "部门名称过长" }),
  code: nullableText.optional(),
  deptType: nullableText.optional(),
  managerName: nullableText.optional(),
  sortOrder: nullableInt.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  remark: nullableText.optional(),
});

export const positionSchema = z.object({  name: z
    .string({ required_error: "职位名称必填" })
    .transform((v) => normalizeName(v) ?? "")
    .refine((v) => v.length > 0, { message: "职位名称必填" })
    .refine((v) => v.length <= 50, { message: "职位名称过长" }),
  category: nullableText.optional(),
  level: nullableText.optional(),
  sortOrder: nullableInt.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  remark: nullableText.optional(),
});

export const employeeQuerySchema = z.object({
  keyword: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  idCardNo: z.string().optional(),
  storeId: z.string().optional(),
  /**
   * Stage 7.3.8：限定某几个门店（逗号分隔的 id）。
   * 用于「南昌3店」页 —— 一个页面覆盖三家门店。
   */
  storeIds: z.string().optional(),
  /**
   * Stage 7.3.1：排除某个门店（逗号分隔的多个 id）。
   * 用于「在职员工」页排除「其他」门店与「南昌3店」三家门店 ——
   * 他们各有自己的页面，不该混在正常在职列表里。
   */
  excludeStoreIds: z.string().optional(),
  departmentId: z.string().optional(),
  positionId: z.string().optional(),
  status: z
    .enum([
      "CANDIDATE",
      "INTERVIEWED",
      "ACTIVE",
      "RESIGNED",
      "NC3",
      "OPS",
      "OPS_RESIGNED",
      "OTHER",
      "",
    ])
    .optional(),
  /** Stage 9：一次限定多个状态（逗号分隔），如「在职类」= ACTIVE,NC3,OPS */
  statuses: z.string().optional(),
  includeDeleted: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
  page: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => Math.max(1, toNullableInt(v) ?? 1)),
  pageSize: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      const n = toNullableInt(v) ?? 20;
      return Math.min(200, Math.max(1, n));
    }),
  sortBy: z
    .enum([
      "employeeId",
      "name",
      "hireDate",
      "resignDate",
      "status",
      "createdAt",
      "updatedAt",
    ])
    .optional()
    .default("employeeId"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
});

export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;
export type EmployeeQueryInput = z.infer<typeof employeeQuerySchema>;
export type StoreInput = z.infer<typeof storeSchema>;
export type DepartmentInput = z.infer<typeof departmentSchema>;
export type PositionInput = z.infer<typeof positionSchema>;

/**
 * 字段 key → 中文名（错误提示用中文，避免出现「dormitory：…」这种看不懂的字段名）
 * 懒加载：只有真正报错时才构建，平时零成本。
 */
let fieldLabelCache: Record<string, string> | null = null;
function fieldLabels(): Record<string, string> {
  if (!fieldLabelCache) {
    fieldLabelCache = Object.fromEntries(EMPLOYEE_FIELDS.map((f) => [f.key, f.label]));
  }
  return fieldLabelCache;
}

/** 把 zod 错误整理成前端可直接展示的中文提示：`中文字段名（字段key）：说明` */
export function formatZodError(err: z.ZodError): string {
  return err.errors
    .map((e) => {
      const key = e.path.join(".");
      const label = key ? fieldLabels()[key] : "";
      const where = !key ? "表单" : label && label !== key ? `${label}（${key}）` : key;
      return `${where}：${e.message}`;
    })
    .join("；");
}
