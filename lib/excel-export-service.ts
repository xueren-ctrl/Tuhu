/**
 * 导出 Excel（Stage 9.40 重写）
 *
 * ## 用户要求（2026-10-03）
 * > 「导出来的表就不要带公式了，我要纯数据」
 *
 * ## 做法：**先压平公式，再逐表写入实时值**
 *
 * 这份 Excel 12 张表里 **6 万多个格子全是公式**（XLOOKUP / COUNTIFS / SUMPRODUCT /
 * TEXTJOIN / LET）。此前导出的做法是「保留公式让 Excel 自己算」，出了两个致命问题：
 *
 * 1. **「在职」表满屏「没找到」**
 *    在职表的每一列都是 `XLOOKUP(1,(数据库!$E:$E=$E3)*(数据库!$C:$C=$C3),数据库!B:B,"没找到",0)`
 *    —— 靠 **姓名 + 入职时间** 去数据库表匹配。导出时数据库表的入职日期被写成**文本**
 *    `2021-03-22`，而原表 C 列是**日期类型**，文本 ≠ 日期 → 匹配全失败。
 *    而且在职表当时只写了姓名列（`SHEET_WRITE_MODE: nameOnly`），其余 21 列全是公式。
 *
 * 2. **共享公式区不能写**
 *    「门店人员编制」O 列是 `{formula:"M4-N4", shareType:"shared"}`，ExcelJS 覆盖母格就崩
 *    `Shared Formula master must exist above and or left of clone`。
 *
 * ## 现在的流程
 * ```
 * ① flattenFormulas(wb)   把 6 万个公式格全替换成各自的缓存结果值 → 工作簿 0 公式
 * ② 逐表写入               用软件里同一套计算服务算出值，直接写死
 * ③ 输出                   纯数据、纯样式，手机/手机秒开也能看
 * ```
 *
 * ⚠️ 顺序不可颠倒：必须先 flatten，否则写入时会撞上共享公式崩溃。
 * ⚠️ 原始 `途虎HR人员登记.xlsx` **只读**，永不写入。
 *
 * ## 口径一致性铁律
 * 流失率 / 人员分布 / 门店编制三张统计表**直接调用页面所用的同一个服务**
 * （`getAttrition` / `getDistribution` / `getStoreHeadcount`），
 * **绝不在导出里另写一套算法** —— 软件页面看到的数字与导出文件逐格一致。
 */
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { formatDate } from "./format";
import { renderTenureCn, hasCompletedTwoMonths } from "./tenure";
import { flattenFormulas, putCell, clearRange, unmergeCellsIn } from "./excel-export-helpers";
import { normalizeIdCard, looksIdCard, normalizePhoneKeepRaw } from "./excel-import/normalization";
import { EMPLOYEE_STATUS_LABEL } from "./constants";
// 统计表口径**直接复用页面所用的服务**，绝不在导出里另写一套算法
import { getStoreHeadcount } from "./headcount-service";
import { getAttrition, currentMonth, parseMonth } from "./attrition-service";
import { getDistribution, DISTRIBUTION_GRADES } from "./distribution-service";

/** 原始 Excel（只读，永不写） */
const SOURCE_XLSX = "途虎HR人员登记.xlsx";

/** 需要转成「中文显示」的日期字段（库里是 UTC 零点 Date，导出写 yyyy-MM-dd 文本） */
const DATE_FIELDS = new Set(["hireDate", "resignDate", "interviewDate", "insuredDate"]);

/** 表头文本 → 归一（去空格/全半角差异） */
function normTitle(s: string): string {
  return String(s).replace(/[\s　]/g, "").replace(/[(]/g, "(").replace(/[)]/g, ")").trim();
}

/** 任意单元格值 → 纯文本（用于读表头、读原表行序） */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellToText(o.result);
    return "";
  }
  return String(v).trim();
}

/**
 * 每张表的**表头行号 / 数据起始行 / 姓名列**（全部实测，绝不猜）
 *
 * ⚠️ Stage 9.40 修正了两处历史错误：
 *   · 「人员流失率」表头在**第 3 行**（R1 大标题 / R2 分组标题 / R3 才是字段名），
 *     之前写成 1 → 数据往上错位。
 *   · 「门店人员分布明细」表头在**第 2 行**（R1 是合并的大标题），之前也写成 1。
 */
interface SheetLayout {
  headerRow: number;
  dataStart: number;
  /** 姓名所在列（1-based）；-1 = 该表没有姓名列 */
  nameCol: number;
  /** 该表最后一列（1-based），用于清空残留 */
  lastCol: number;
}

const LAYOUT: Record<string, SheetLayout> = {
  在职: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 24 }, // ⚠️ 2026-11-24：原表 24 列（无薪资待遇）
  离职: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 26 },
  南昌3店: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 25 },
  运营部: { headerRow: 1, dataStart: 2, nameCol: 5, lastCol: 16 },
  运营部离职: { headerRow: 1, dataStart: 2, nameCol: 5, lastCol: 18 },
  招聘面试登记表: { headerRow: 3, dataStart: 4, nameCol: 2, lastCol: 14 }, // ⚠️ 2026-11-28：模板只有 14 列（O 列全空），lastCol 15 会把第 15 列整列清空却不回写
  薪资表: { headerRow: 1, dataStart: 2, nameCol: 4, lastCol: 15 },
  数据库: { headerRow: 2, dataStart: 3, nameCol: 5, lastCol: 45 }, // ⚠️ 2026-11-24：原表 45 列（无薪资待遇）
  社保总名单: { headerRow: 1, dataStart: 2, nameCol: 3, lastCol: 6 },
  门店人员编制: { headerRow: 3, dataStart: 4, nameCol: -1, lastCol: 22 },
  人员流失率: { headerRow: 3, dataStart: 4, nameCol: -1, lastCol: 10 },
  门店人员分布明细: { headerRow: 2, dataStart: 3, nameCol: -1, lastCol: 10 },
};

/**
 * 人员类表：**列号 → 员工字段**（按实测列序号写死，不靠表头名匹配）
 *
 * 为什么必须按列序号：这份 Excel 的表头名不可靠 ——
 *   · 「在职」表第 5 列表头是**空的**（但那列就是姓名）
 *   · 「在职」表第 13/15 列**都叫「联系人电话」**（一列紧急电话一列紧急联系人2电话）
 *   · 「运营部」表第 9/10 列**都叫「紧急联系人（电话）」**
 * 按表头名匹配必然串列，所以人员表一律按实测列序号。
 *
 * `null` = 该列在软件里没有对应数据，保持为空。
 */
const STAFF_COLUMNS: Record<string, (string | null)[]> = {
  // 在职：R2 = 字段名，24 列（⚠️ 2026-11-24 修：原表在职表只有 24 列，没有「薪资待遇」列，
  //   旧版 25 列多写一列，导致第 25 列出现招聘人名/离职原因等串位内容）。
  // 南昌3店：R2 = 字段名，25 列（南昌3店表确有「薪资待遇」列 W，保留）。
  在职: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "currentAddress",
    "recruiterName",
  ],
  南昌3店: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "salaryTerms", "currentAddress",
    "recruiterName",
  ],
  // 运营部：R1 = 字段名，16 列（第 9/10 列都是「紧急联系人（电话）」，实为姓名+电话）
  运营部: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "jobGradeRaw", "dormitory",
    "socialInsurancePurchased", "emergencyContact1", "emergencyPhone1", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress",
  ],
  // 运营部离职：R1 = 字段名，18 列
  // ⚠️ 原表第 9/10 列虽然表头是「劳动合同」「备注（薪资）」，实际填的是
  //    **紧急联系人**和其电话（人工表就是这样记的）。这里按原表实际含义取值，
  //    避免把姓名/电话写进劳动合同与薪资字段，也不污染「数据库」表。
  运营部离职: [
    "__seq__", "storeId", "hireDate", "__resignedTenure__", "name", "jobGradeRaw", "dormitory",
    "socialInsurancePurchased", "emergencyContact1", "emergencyPhone1", "bankBranch",
    "bankAccountNo", "idCardNo", "phone", "workPhone", "householdAddress",
    "__resignDateOrRaw__", "resignReason",
  ],
  // 离职：R2 = 字段名，26 列（第 4 列「在职年限」= 离职时点的在职年限）
  // ⚠️ 第 25 列「备注（离职日期）」用 __resignDateOrRaw__：原表里有「9/30已离职」
  //    这类非日期文本，只写解析日期会丢（2026-11-24 实测少 48 格）。
  离职: [
    "__seq__", "storeId", "hireDate", "__resignedTenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "currentAddress",
    "resignReason", "__resignDateOrRaw__", "recruiterName",
  ],
  // 数据库：R2 = 字段名，45 列。R1 是一行示例数据（不是表头）
  // ⚠️ 2026-11-24 修：原表数据库表只有 45 列，没有「薪资待遇」列（旧版 46 列多写一列，
  //   导致导出多出第 46 列）。第 4 列「在职年限」原表公式是 DATEDIF(C,TODAY())——
  //   无论在职/离职都算到今天（实测刘家卓 3年8个月=到今天，非到离职日）。
  //   ⚠️ 2026-11-27 改（用户定）：离职员工的在职年限改为按入职日→离职日算，
  //   在职员工仍算到今天；__tenure__ 已按此口径实现，不再是纯“算到今天”。
  // ⚠️ 第 41 列也是「面试评估表」—— 原表的重复列。Stage 10.4 起改为按
  //    docInterviewEvaluation2 原样导出：原表这一列是有值的（部分行与第 35 列不同），
  //    早先「留空以保持与原表一致」的判断是错的，会导致 300+ 行内容丢失。
  数据库: [
    "__seq__", "storeId", "hireDate", "__tenure__", "name", "idCardNo", "phone",
    "jobGradeRaw", "positionNote", "dormitory", "socialInsurancePurchased",
    "emergencyContact1", "emergencyPhone1", "emergencyContact2", "emergencyPhone2",
    "laborContract", "socialInsuranceAgreement", "fireSafetyCommitment", "dormitoryWaiver",
    "onboardingMedical", "bankBranch", "bankAccountNo", "currentAddress",
    "recruiterName", "resignReason", "__resignDateOrRaw__", "__age__", "interviewDate",
    "interviewLocation", "interviewResult", "interviewerName", "interviewHired",
    "docResume", "docInterviewEvaluation", "__resignedTenure__", "firstMonthGuarantee",
    "remark", "mentorName", "docOnboardingForm", "docInterviewEvaluation2", "certificateLevel", "remark3",
    "__work7days__", "__work2months__", "minorNote",
  ],
};

/** 社保总名单列号 → 字段（R1 = 字段名，6 列）
 *  ⚠️ 第 1 列「序号」在原表里是**门店分组序号**（A2:A5 合并 = 1），
 *  *    不是逐人递增序号，所以不重写、只保留原样。 */
const SI_COLUMNS: (string | null)[] = [
  null, "store", "name", "insuredDate", "baseAmount", "note",
];

/** 各人员表对应的员工状态 */
const SHEET_STATUS: Record<string, string[]> = {
  在职: ["ACTIVE"],
  离职: ["RESIGNED"],
  南昌3店: ["NC3"],
  运营部: ["OPS"],
  运营部离职: ["OPS_RESIGNED"],
};

/** 各人员表在原表里的身份证列（1-based；与 STAFF_COLUMNS 一致） */
const SHEET_IDCARD_COL: Record<string, number> = {
  在职: 6,
  离职: 6,
  南昌3店: 6,
  运营部: 13,
  运营部离职: 13,
};

/** XLOOKUP 匹配失败时 Excel 写入的字面量，出现即代表「这条公式没取到值」 */
const NOT_FOUND = "没找到";

/** 一行员工 → 各字段的显示值（与软件页面 cellValue 口径完全一致） */
function employeeValues(
  e: Record<string, unknown>,
  storeNames: Map<number, string>,
  posNames: Map<number, string>,
  now: Date
): Record<string, string | number> {
  const s = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const t = String(v).trim();
    // ⚠️ 原表里 XLOOKUP 匹配失败会写入字面量「没找到」，它不是真实数据，
    //    导出时必须清掉（否则用户看到的是一句假话）。
    return t === NOT_FOUND ? "" : t;
  };
  const d = (v: unknown) => (v ? formatDate(v as Date) : "");

  const storeId = e.storeId as number | null;
  const positionId = e.positionId as number | null;

  return {
    // 门店：优先门店主数据；运营部的人没有 storeId，回退到部门名 / Excel 原文
    storeId: storeId
      ? (storeNames.get(storeId) ?? "")
      : (s(e.departmentNameRaw) || s(e.storeNameRaw)),
    name: s(e.name),
    idCardNo: s(e.idCardNo),
    phone: s(e.phone),
    workPhone: s(e.workPhone),
    jobGradeRaw: s(e.jobGradeRaw) || (positionId ? (posNames.get(positionId) ?? "") : ""),
    positionNote: s(e.positionNote),
    dormitory: s(e.dormitory),
    socialInsurancePurchased: s(e.socialInsurancePurchased),
    emergencyContact1: s(e.emergencyContact1),
    emergencyPhone1: s(e.emergencyPhone1),
    emergencyContact2: s(e.emergencyContact2),
    emergencyPhone2: s(e.emergencyPhone2),
    laborContract: s(e.laborContract),
    socialInsuranceAgreement: s(e.socialInsuranceAgreement),
    fireSafetyCommitment: s(e.fireSafetyCommitment),
    dormitoryWaiver: s(e.dormitoryWaiver),
    onboardingMedical: s(e.onboardingMedical),
    bankBranch: s(e.bankBranch),
    bankAccountNo: s(e.bankAccountNo),
    salaryTerms: s(e.salaryTerms),
    // 首月保障：原表是数字格（290 个数字），导出必须写数字不能写文本，
    // 否则 SUM 求和不到、逐格比对也会判类型不一致。纯数字才转数字，
    // 带文字的（如「首月保障8000，次月按提成」）保持文本。
    firstMonthGuarantee: (() => {
      const t = s(e.firstMonthGuarantee);
      return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
    })(),
    currentAddress: s(e.currentAddress),
    householdAddress: s(e.householdAddress),
    recruiterName: s(e.recruiterName),
    mentorName: s(e.mentorName),
    certificateLevel: s(e.certificateLevel),
    remark: s(e.remark),
    remark3: s(e.remark3),
    minorNote: s(e.minorNote),
    resignReason: s(e.resignReason),
    interviewDate: d(e.interviewDate),
    interviewLocation: s(e.interviewLocation),
    interviewResult: s(e.interviewResult),
    interviewerName: s(e.interviewerName),
    interviewHired: s(e.interviewHired),
    docResume: s(e.docResume),
    docInterviewEvaluation: s(e.docInterviewEvaluation),
    // 原表第 41 列的重复「面试评估表」—— 必须单独输出，否则该列整列丢失
    docInterviewEvaluation2: s(e.docInterviewEvaluation2),
    docOnboardingForm: s(e.docOnboardingForm),
    // 薪资表第 7 列「备注」：薪资说明在原表里可能记在「薪资待遇」列，也可能记在「备注」列
    __salaryNote__: s(e.salaryTerms) || s(e.remark),
    hireDate: d(e.hireDate),
    resignDate: d(e.resignDate),
    // 离职日期（带原文回退）：原表「备注（离职日期）」列里不全是日期，
    // 还有「9/30已离职」「已离职」这类文本。只写解析出的日期会丢掉这 80 处文本
    // （2026-11-24 实测离职表 C25 因此少 48 格）。有日期写日期，没日期写原文。
    __resignDateOrRaw__: (() => {
      const dd = d(e.resignDate);
      return dd || s(e.resignDateRaw);
    })(),

    // —— 计算列：与 lib/employee-sheet-service.ts 的 cellValue 同一套口径 ——
    // 在职年限（离职算到离职日，在职算到今天）
    // ⚠️ 2026-11-27 改（用户定）：原表数据库表第 4 列公式是 DATEDIF(C,TODAY())，
    //    无论在职/离职都算到今天；用户现改为离职员工按入职日→离职日算，
    //    在职员工仍算到今天。在职/南昌3店/运营部表只含在职员工，不受影响；
    //    实际变的是数据库表里离职行的第 4 列。离职表仍用 __resignedTenure__。
    __tenure__: safe(
      () => renderTenureCn(e.hireDate as Date | null, e.resignDate as Date | null, now),
      ""
    ),
    // 在职年限（离职算到离职日）
    // ⚠️ 2026-11-24 修：原表 C35 公式是 IF(OR(C="",Z=""),"",DATEDIF(C,Z,…))——
    //    没有离职日期（在职员工）时本列为空。旧版 renderTenureCn 在 resignDate 为空时
    //    回退到今天，导致在职员工的离职年限被算成到今天的年限，写进了「首月保障」列
    //    隔壁的 C35（配合列错位，C36 首月保障被 1799 格年限文本覆盖）。
    __resignedTenure__: safe(() => {
      if (!e.resignDate) return "";
      return renderTenureCn(e.hireDate as Date | null, e.resignDate as Date | null, now);
    }, ""),
    __age__: e.age !== null && e.age !== undefined ? String(e.age) : s(e.ageRaw),
    __work7days__: safe(() => {
      if (!e.hireDate) return "";
      const ref = (e.resignDate as Date | null) ?? now;
      const days = Math.floor((ref.getTime() - (e.hireDate as Date).getTime()) / 86_400_000);
      return days >= 7 ? "入职满7天" : "未达7天";
    }, ""),
    __work2months__: safe(() => {
      if (!e.hireDate) return "";
      const ref = (e.resignDate as Date | null) ?? now;
      const done = hasCompletedTwoMonths(e.hireDate as Date, ref);
      if (done === null) return "";
      return done ? "入职满2个月" : "未达2个月";
    }, ""),
  };
}

/** 计算列绝不让导出崩：算不出来就留空（并在报告里体现） */
function safe(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** 入职日期归一化为 yyyy-MM-dd（Date / "2025-07-13" / "2025/7/13" 都行），取不到为空串 */
function toHireIso(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return "";
}

/**
 * 读原表某列的姓名及其**原始行号**（保持用户手工排好的门店分组顺序）。
 *
 * ⚠️ 必须带行号：人工表的「数据库」Sheet 中间有空行/断行，
 * 如果紧凑写入就会整体错行（实测 1880 行错位）。行号用于"原位回填"。
 *
 * hireDateCol（可选）：同时读出该行的入职日期（归一化为 yyyy-MM-dd），
 * 供 alignToOriginalOrder 在同名多条记录时按「姓名 + 入职日期」精确定位
 * （2026-11-24 修：旧版只按姓名取第一条，全帅棋被配到另一家店的离职记录）。
 *
 * idCardCol（可选，2026-11-26 新增）：同时读出该行的身份证号（归一化：
 * 去分隔符、末位 X 大写），供 alignToOriginalOrder 在同名多条时按
 * 「姓名 + 身份证号」精确定位。模板行与候选记录身份证都非空且不同时，
 * 绝不取该记录（宁可留空）。各表身份证列：数据库/在职/离职/南昌3店 = 6，
 * 运营部/运营部离职 = 13（见 STAFF_COLUMNS）。
 *
 * ⚠️ 2026-11-26 补：身份证列本身也可能被填错——原文件有 101 行把手机号
 * 填在身份证列、身份证填在电话列（与 parser 3.1 同一类串位，如郭驰行 191）。
 * 这里读身份证列的同时读电话列（idCardCol + 1，各表都是相邻两列），
 * 与 parser 3.1 用同一条判断：身份证列不是身份证、电话列是身份证时，
 * 取电话列的值作身份证号。不做这一步，这 101 行会因「身份证冲突」整行
 * 留空（实测：数据库表 84 行、离职表 91 行被误判为空）。
 *
 * 同时读出电话列（phone，与身份证列相邻），供 alignToOriginalOrder 在
 * 「姓名+身份证+入职日期」三键都相同、无法区分时作最后一道区分
 * （如罗龙平行 192/198：同名、无身份证、同入职日期，只有电话不同）。
 */
function readOriginalOrder(
  ws: ExcelJS.Worksheet,
  nameCol: number,
  headerRow: number,
  hireDateCol?: number,
  idCardCol?: number
): { row: number; name: string; hireDate: string; idCard: string; phone: string }[] {
  const out: { row: number; name: string; hireDate: string; idCard: string; phone: string }[] = [];
  if (nameCol <= 0) return out;
  const readHire = hireDateCol !== undefined && hireDateCol > 0 && hireDateCol !== nameCol;
  const readId = idCardCol !== undefined && idCardCol > 0 && idCardCol !== nameCol;
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const nm = cellToText(ws.getRow(r).getCell(nameCol).value);
    if (nm) {
      let idCard = "";
      let phone = "";
      if (readId) {
        const idRaw = normalizeIdCard(cellToText(ws.getRow(r).getCell(idCardCol!).value));
        idCard = idRaw ?? "";
        // 身份证/电话互换行：身份证列不是身份证、电话列（下一列）是身份证时，
        // 取电话列的值（与 parser 3.1 同一判断，否则该行会被误判为身份证冲突而留空）。
        const phoneRaw = normalizePhoneKeepRaw(cellToText(ws.getRow(r).getCell(idCardCol! + 1).value));
        phone = phoneRaw ?? "";
        if (!looksIdCard(idRaw) && looksIdCard(normalizeIdCard(phoneRaw))) {
          idCard = normalizeIdCard(phoneRaw) ?? "";
        }
      }
      out.push({
        row: r,
        name: nm,
        hireDate: readHire ? toHireIso(ws.getRow(r).getCell(hireDateCol!).value) : "",
        idCard,
        phone,
      });
    }
  }
  return out;
}

/**
 * 按原表顺序对齐。
 *
 * - 原表有、库中无 → null 占位（该行留空）
 * - 原表同名多行（人工表里的重复补录行）→ 默认复用同一条档案数据，避免出现"空行"
 *   （opts.reuseExhausted）
 * - 库中多出来的 → 按 opts.append 决定是否追加到末尾
 *   默认全部追加；迁移校验场景只追加「导入之后新增」的员工（importBatch 为空）
 *
 * ⚠️ 2026-11-24 修：同名多条档案时优先按「姓名 + 入职日期」匹配
 *    （原表行自带入职日期）。入职日期对不上的才回退到「取同名第一条」
 *    （旧行为）。实测：全帅棋在职行（入职 2026-03-07）旧版配到
 *    大朗富丽东路店的离职记录（入职 2025-07-13），修后配到
 *    大朗富华中路店的正确记录。
 *
 * ⚠️ 2026-11-26 修：同名多条时**身份证号优先于入职日期**。
 *    匹配顺序：⓪ 源行号相同（仅数据库表，模板行号 = 导入源行号，1:1 精确）→
 *    ① 身份证号相同 → ② 入职日期相同**且唯一**（且身份证不冲突；
 *    入职日期撞上多个候选时不抢 pick，留给电话区分，否则先到先得会
 *    把两个同名同入职的人写反，如罗龙平） →
 *    ②.5 电话相同且唯一（且身份证不冲突；三键都相同、只剩电话能区分时用，
 *    如罗龙平行 192/198） → ③ 第一条未使用且身份证不冲突的同名记录。
 *    模板行身份证与候选记录身份证**都非空且不同时，绝不取该记录**——
 *    宁可留空（并经 opts.onIdMismatch 回调记入导出 stats note），
 *    也不张冠李戴（实测：许颖行 1689/1693、颜泉行 1902/2008 的首月保障
 *    串位就是这么来的）。reuseExhausted 复用时同样受此约束。
 */
function alignToOriginalOrder(
  originalEntries: Array<{ row?: number; name: string; hireDate?: string; idCard?: string; phone?: string }>,
  rows: Record<string, unknown>[],
  opts: {
    append?: (r: Record<string, unknown>) => boolean;
    reuseExhausted?: boolean;
    /**
     * 仅数据库表传 true：模板就是导入源文件，模板行号 = 员工 sourceRowNo，
     * 可 1:1 精确直配。人员类表（在职/离职/运营部…）的行号与数据库源行号
     * 无关，绝不能传（行号巧合会对上另一个人）。
     */
    matchSourceRow?: boolean;
    /** 模板行身份证与全部候选记录身份证都非空且不同、被迫留空时调用 */
    onIdMismatch?: (ent: { name: string; hireDate?: string; idCard?: string }) => void;
  } = {}
): (Record<string, unknown> | null)[] {
  const { append = () => true, reuseExhausted = false, matchSourceRow = false, onIdMismatch } = opts;
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = String(r.name ?? "");
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(r);
  }
  /** 候选记录的身份证号（归一化；无此字段的记录视为空） */
  const recId = (r: Record<string, unknown>): string =>
    normalizeIdCard(
      r.idCardNo === null || r.idCardNo === undefined ? null : String(r.idCardNo)
    ) ?? "";
  /** 候选记录的电话（库里已是 normalizePhoneKeepRaw 后的值） */
  const recPhone = (r: Record<string, unknown>): string => {
    const p = r.phone;
    return p === null || p === undefined ? "" : String(p);
  };
  /** 两边身份证都非空且不同 → 绝不能取 */
  const idConflict = (entId: string, r: Record<string, unknown>): boolean => {
    const rid = recId(r);
    return entId !== "" && rid !== "" && entId !== rid;
  };
  const used = new Set<Record<string, unknown>>();
  const aligned: (Record<string, unknown> | null)[] = [];
  for (const ent of originalEntries) {
    const entId = ent.idCard ?? "";
    const bucket = byName.get(ent.name) ?? [];
    const unused = bucket.filter((r) => !used.has(r));
    let pick: Record<string, unknown> | undefined;
    // ⓪ 源行号相同（仅数据库表）：模板行号 = 导入源行号，精确直配
    if (!pick && matchSourceRow && ent.row !== undefined) {
      pick = unused.find((r) => r.sourceRowNo === ent.row);
    }
    // ① 身份证号相同的优先
    if (!pick && entId) {
      pick = unused.find((r) => recId(r) === entId);
    }
    // ② 入职日期相同且唯一、且身份证不冲突（撞上多个候选时不抢，留给电话区分）
    if (!pick && ent.hireDate) {
      const hireHits = unused.filter(
        (r) => toHireIso(r.hireDate) === ent.hireDate && !idConflict(entId, r)
      );
      if (hireHits.length === 1) pick = hireHits[0];
    }
    // ②.5 电话相同且唯一、且身份证不冲突（三键全同、只剩电话能区分时）
    if (!pick && ent.phone) {
      const phoneHits = unused.filter(
        (r) => recPhone(r) === ent.phone && !idConflict(entId, r)
      );
      if (phoneHits.length === 1) pick = phoneHits[0];
    }
    // ③ 第一条未使用且身份证不冲突的同名记录
    if (!pick) pick = unused.find((r) => !idConflict(entId, r));
    if (pick) {
      aligned.push(pick);
      used.add(pick);
    } else if (bucket.length > 0 && reuseExhausted) {
      // 同名多行但库里只有 1 条档案 → 复用第一条，保持行数与人工表一致；
      // 但身份证冲突时绝不复用（宁可留空）。
      const reuse = bucket.find((r) => !idConflict(entId, r)) ?? bucket[0];
      if (!idConflict(entId, reuse)) {
        aligned.push(reuse);
      } else {
        aligned.push(null);
        onIdMismatch?.(ent);
      }
    } else {
      aligned.push(null);
      // 模板行有身份证、库里同名记录全是不同身份证 → 记一笔（不是"库中已无此人"）
      if (entId && bucket.length > 0 && bucket.every((r) => idConflict(entId, r))) {
        onIdMismatch?.(ent);
      }
    }
  }
  for (const r of rows) {
    if (!append(r)) continue;
    if (!used.has(r)) aligned.push(r);
  }
  return aligned;
}

/** 某表最后一个有数据的行（用于清空残留） */
function lastDataRow(ws: ExcelJS.Worksheet, dataStart: number, lastCol: number): number {
  for (let r = ws.rowCount; r >= dataStart; r--) {
    for (let c = 1; c <= lastCol; c++) {
      if (cellToText(ws.getRow(r).getCell(c).value) !== "") return r;
    }
  }
  return dataStart - 1;
}

/**
 * 追加行套用上一行的格式（字体/边框/底纹/数字格式/对齐/行高）。
 * 用于「导入之后新增的员工」——原模板里没有这一行的样式，不复制就会是白板行。
 */
function cloneRowStyle(ws: ExcelJS.Worksheet, fromRow: number, toRow: number, lastCol: number): void {
  const src = ws.getRow(fromRow);
  const dst = ws.getRow(toRow);
  if (src.height != null) dst.height = src.height;
  for (let c = 1; c <= lastCol; c++) {
    const s = src.getCell(c).style;
    if (s) dst.getCell(c).style = JSON.parse(JSON.stringify(s));
  }
}

/** 导出前把整本工作簿的隐藏行、隐藏列全部取消（用户要求"不要带隐藏行列"） */
function unhideAll(wb: ExcelJS.Workbook): void {
  wb.eachSheet((ws) => {
    const rowCount = ws.rowCount;
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      if (row.hidden) row.hidden = false;
    }
    const colCount = ws.columnCount;
    for (let c = 1; c <= colCount; c++) {
      const col = ws.getColumn(c);
      if (col.hidden) col.hidden = false;
    }
  });
}

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  stats: { sheet: string; rows: number; written: number; note: string }[];
  /** 被压平的公式数量（用户要求「纯数据」的证据） */
  flattened: { total: number; bySheet: Record<string, number> };
}

/**
 * 导出 Excel —— 纯数据、零公式
 */
export async function exportExcel(opts: { month?: string } = {}): Promise<ExportResult> {
  const month = opts.month?.trim() || currentMonth();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE_XLSX);

  // ---------- ① flatten：把 6 万个公式格全压成常量（必须在所有写入之前） ----------
  const flattened = flattenFormulas(wb);

  // ---------- 预取参照数据 ----------
  const [stores, positions, employees, siEntries] = await Promise.all([
    prisma.store.findMany({ select: { id: true, name: true } }),
    prisma.position.findMany({ select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { deletedAt: null } }),
    prisma.socialInsuranceEntry.findMany({ orderBy: { sourceRowNo: "asc" } }),
  ]);
  const storeNames = new Map(stores.map((s) => [s.id, s.name]));
  const posNames = new Map(positions.map((p) => [p.id, p.name]));
  const now = new Date();

  const stats: ExportResult["stats"] = [];

  // ---------- ② 人员类表：逐格写实时值 ----------
  for (const [sheet, statuses] of Object.entries(SHEET_STATUS)) {
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }
    const cols = STAFF_COLUMNS[sheet];
    // ⚠️ 同名可能有多个档案（同一人的多段任职/重复补录行）。
    // 必须让"本表状态"的档案排在前面，否则「在职」表里同名的人可能配到已离职那条，
    // 出现入职日期/工种全错（实测 29 行）。
    const allRows = (employees as unknown as Record<string, unknown>[])
      .slice()
      .sort((a, b) => {
        const sa = statuses.includes(String(a.status)) ? 0 : 1;
        const sb = statuses.includes(String(b.status)) ? 0 : 1;
        return sa - sb;
      });
    const entries = readOriginalOrder(ws, layout.nameCol, layout.headerRow, 3, SHEET_IDCARD_COL[sheet]);
    // 迁移校验口径：行集合 = 原表行（顺序、行数不变）；
    // 同名多行复用同一条档案；只有「导入之后新增」的员工才追加到末尾
    let idMismatch = 0;
    const aligned = alignToOriginalOrder(entries, allRows, {
      reuseExhausted: true,
      append: (r) => !r.importBatch && statuses.includes(String(r.status)),
      onIdMismatch: () => {
        idMismatch++;
      },
    });

    // 写入的物理行号：原有行按原行号回填，追加的新员工接在最后一行之后
    const tplLast = lastDataRow(ws, layout.dataStart, layout.lastCol);
    const lastOriginalRow = entries.length ? entries[entries.length - 1].row : layout.dataStart - 1;
    const targets: number[] = entries.map((e) => e.row);
    for (let i = entries.length; i < aligned.length; i++) {
      targets.push(lastOriginalRow + (i - entries.length) + 1);
    }

    // 原表的「序号」不能重算：人工表里有跳号/重复号，重算会整列错开。
    // 先快照再回填，只有追加出来的新行才给新序号。
    const seqBefore = new Map<number, string>();
    for (const t of targets) {
      const v = cellToText(ws.getRow(t).getCell(1).value);
      if (v) seqBefore.set(t, v);
    }

    // 先把整块数据区清空（原表残留值一律不留），再逐行写
    const clearTo = Math.max(tplLast, ...targets, layout.dataStart - 1);
    clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

    let written = 0;
    for (let i = 0; i < aligned.length; i++) {
      const target = targets[i];
      const rec = aligned[i];
      if (!rec) continue; // 库中已无此人 → 保持清空
      // 超出原模板数据区的行（追加的新员工）→ 沿用上一行格式
      if (target > tplLast) cloneRowStyle(ws, target - 1, target, layout.lastCol);
      const vals = employeeValues(rec, storeNames, posNames, now);
      vals.__seq__ = seqBefore.get(target) ?? String(i + 1); // 原有行沿用原序号，新行才编号
      for (let c = 1; c <= cols.length; c++) {
        const field = cols[c - 1];
        if (!field) continue;
        if (putCell(ws, target, c, vals[field] ?? "")) written++;
      }
    }

    const missing = aligned.filter((r) => r === null).length;
    stats.push({
      sheet,
      rows: aligned.length,
      written,
      note:
        `按原表顺序写 ${aligned.length} 行 × ${cols.filter(Boolean).length} 列实值（0 公式）` +
        (missing ? `；其中 ${missing} 行原表有、库中已无，保持空白` : "") +
        (idMismatch
          ? `；其中 ${idMismatch} 行因身份证号与库中同名记录不一致而留空（宁可空着也不张冠李戴）`
          : ""),
    });
  }

  // ---------- ③ 数据库表：全部员工档案（45 列实值） ----------
  {
    const sheet = "数据库";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (ws && layout) {
      const cols = STAFF_COLUMNS[sheet];
      const rows = employees as unknown as Record<string, unknown>[];
      const entries = readOriginalOrder(ws, layout.nameCol, layout.headerRow, 3, 6);
      // 同 ②：行集合 = 原表行；只追加导入之后新增的员工
      let idMismatch = 0;
      const aligned = alignToOriginalOrder(entries, rows, {
        reuseExhausted: true,
        // 数据库表模板 = 导入源文件：模板行号 = 员工 sourceRowNo，1:1 精确直配
        matchSourceRow: true,
        append: (r) => !r.importBatch,
        onIdMismatch: () => {
          idMismatch++;
        },
      });
      const tplLast = lastDataRow(ws, layout.dataStart, layout.lastCol);
      const lastOriginalRow = entries.length ? entries[entries.length - 1].row : layout.dataStart - 1;
      const targets: number[] = entries.map((e) => e.row);
      for (let i = entries.length; i < aligned.length; i++) {
        targets.push(lastOriginalRow + (i - entries.length) + 1);
      }
      const clearTo = Math.max(tplLast, ...targets, layout.dataStart - 1);
      // 序号沿用原表（人工表里有跳号），只给追加出来的新行编号
      const seqBefore = new Map<number, string>();
      for (const t of targets) {
        const v = cellToText(ws.getRow(t).getCell(1).value);
        if (v) seqBefore.set(t, v);
      }
      clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

      let written = 0;
      for (let i = 0; i < aligned.length; i++) {
        const target = targets[i];
        const rec = aligned[i];
        if (!rec) continue;
        if (target > tplLast) cloneRowStyle(ws, target - 1, target, layout.lastCol);
        const vals = employeeValues(rec, storeNames, posNames, now);
        vals.__seq__ = seqBefore.get(target) ?? String(i + 1);
        for (let c = 1; c <= cols.length; c++) {
          const field = cols[c - 1];
          if (!field) continue;
          if (putCell(ws, target, c, vals[field] ?? "")) written++;
        }
      }
      stats.push({
        sheet,
        rows: aligned.length,
        written,
        note:
          `全部 ${rows.length} 名员工 × ${cols.filter(Boolean).length} 列实值（不受状态限制，0 公式）` +
          (idMismatch
            ? `；其中 ${idMismatch} 行因身份证号与库中同名记录不一致而留空（宁可空着也不张冠李戴）`
            : ""),
      });
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ④ 社保总名单 ----------
  {
    const sheet = "社保总名单";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (ws && layout) {
      const entries = siEntries as unknown as Record<string, unknown>[];
      // ⚠️ 2026-11-24 修：社保名单为空时不清空、保留原模板内容。
      //    社保参保日期/缴费基数系统里根本没有（SocialInsuranceEntry 0 行，
      //    导入只读了数据库表），旧版先清空再写 0 行，导出一张空表。
      if (entries.length === 0) {
        stats.push({
          sheet,
          rows: 0,
          written: 0,
          note: "系统里没有社保名单数据（SocialInsuranceEntry 未导入），保留原模板内容未清空",
        });
      } else {
      const aligned = alignToOriginalOrder(
        readOriginalOrder(ws, layout.nameCol, layout.headerRow),
        entries
      );
      const clearTo = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), layout.dataStart + aligned.length - 1);
      // 第 1 列「序号」是原表的分组序号（合并单元格），不能重写也不能清空
      const seqBefore = new Map<number, string>();
      for (let i = 0; i < aligned.length; i++) {
        const t = layout.dataStart + i;
        const v = cellToText(ws.getRow(t).getCell(1).value);
        if (v) seqBefore.set(t, v);
      }
      clearRange(ws, layout.dataStart, clearTo, 1, layout.lastCol);

      let written = 0;
      for (let i = 0; i < aligned.length; i++) {
        const target = layout.dataStart + i;
        const rec = aligned[i];
        if (!rec) continue;
        const storeId = rec.storeId as number | null;
        const vals: Record<string, string> = {
          store: storeId ? (storeNames.get(storeId) ?? String(rec.storeNameRaw ?? "")) : String(rec.storeNameRaw ?? ""),
          name: String(rec.name ?? ""),
          insuredDate: rec.insuredDate ? formatDate(rec.insuredDate as Date) : "",
          baseAmount: rec.baseAmount === null || rec.baseAmount === undefined ? "" : String(rec.baseAmount),
          note: rec.note === null || rec.note === undefined ? "" : String(rec.note),
        };
        for (let c = 1; c <= SI_COLUMNS.length; c++) {
          const field = SI_COLUMNS[c - 1];
          if (!field) {
            // 序号列：把原值写回去（清除后需要恢复）
            const seq = seqBefore.get(target);
            if (seq) putCell(ws, target, c, seq);
            continue;
          }
          if (putCell(ws, target, c, vals[field] ?? "")) written++;
        }
      }
      stats.push({
        sheet,
        rows: aligned.length,
        written,
        note: `名单 ${entries.length} 人 × 5 列实值（原表本来就没公式）`,
      });
      } // 社保 0 行保护的 else
    } else {
      stats.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    }
  }

  // ---------- ⑤ 招聘面试登记表 / 薪资表：Excel 原始名单 + 回填最新档案 ----------
  stats.push(...(await writeRecruitAndSalarySheets(wb, storeNames, now)));

  // ---------- ⑥ 统计类表：实时计算写入（复用页面同一服务） ----------
  stats.push(...(await writeStatSheets(wb, month)));

  // ---------- ⑦ 取消全部隐藏行 / 隐藏列（原模板里离职表 F~O 列是隐藏的） ----------
  unhideAll(wb);

  const out = await wb.xlsx.writeBuffer();
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    buffer: Buffer.from(out),
    filename: `途虎HR人员登记（导出于${stamp}）.xlsx`,
    stats,
    flattened,
  };
}

/**
 * 招聘面试登记表 / 薪资表 —— **Excel 原始名单口径 + 回填最新档案数据**
 *
 * 这两张表在软件里的口径是「以 Excel 原始名单为准」（招聘面试 478 人、薪资 290 人，
 * 见 Stage 9 的约定），所以**不能按员工状态重新筛人** —— 那会把口径改掉。
 * 正确做法：
 *   ① 行集合 = `SheetRow` 镜像（原名单顺序、人数完全不变）
 *   ② 每行按 `SheetRowEmployeeLink.employeeId` 找到员工档案，**把最新值写回**
 *   ③ 没建档的行（只来面试没入职）→ 保留 SheetRow 里的原始名单值
 *
 * ⚠️ `SheetRowEmployeeLink.employeeId` 是**员工档案 id（Int）**，不是 THHR 工号。
 * ⚠️ `SheetRow.rowNo` 就是 **Excel 原始行号**（导入时 `rows.push({ rowNo: r })` 就是 Excel 行号）。
 */
async function writeRecruitAndSalarySheets(
  wb: ExcelJS.Workbook,
  storeNames: Map<number, string>,
  now: Date
): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];

  /** 列号 → 字段（招聘面试登记表 R3 实测；第 5 列「年龄」由 age 计算） */
  // ⚠️ 模板只有 14 列：不要加 salaryTerms——第 12 列起会全部错位一位（2026-11-27 实测：简历表/面试评估表/招聘人全丢）
  const RECRUIT_COLUMNS: (string | null)[] = [
    "__seq__", "name", "phone", "jobGradeRaw", "__age__", "interviewDate", "interviewLocation",
    "interviewResult", "interviewerName", "interviewHired", "hireDate",
    "docResume", "docInterviewEvaluation", "recruiterName",
  ];
  /** 列号 → 字段（薪资表 R1 实测；第 6 列表头是合并的「首月保障」跨两列） */
  const SALARY_COLUMNS: (string | null)[] = [
    "__seq__", "storeId", "hireDate", "name", "jobGradeRaw", "firstMonthGuarantee",
    // 第 7 列「备注」：原表这里记的是薪资说明，系统里可能落在 salaryTerms 或 remark
    "__salaryNote__", "recruiterName", "mentorName", "docOnboardingForm",
    "docInterviewEvaluation", "certificateLevel", "remark3", "__work7days__", "__work2months__",
  ];

  const spec: { sheet: string; cols: (string | null)[] }[] = [
    { sheet: "招聘面试登记表", cols: RECRUIT_COLUMNS },
    { sheet: "薪资表", cols: SALARY_COLUMNS },
  ];

  for (const sp of spec) {
    const ws = wb.getWorksheet(sp.sheet);
    const layout = LAYOUT[sp.sheet];
    if (!ws || !layout) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
      continue;
    }

    // ① 行集合 = SheetRow 原始镜像（保持原名单口径与顺序）
    const mirror = await prisma.sheetRow.findMany({
      where: { sheet: sp.sheet },
      orderBy: { rowNo: "asc" },
    });
    if (mirror.length === 0) {
      out.push({ sheet: sp.sheet, rows: 0, written: 0, note: "SheetRow 镜像为空（是否还没导入？）" });
      continue;
    }

    // ② 整块清空，然后逐行写：先写原始名单值，再对已建档的行回填最新档案
    const maxRow = Math.max(lastDataRow(ws, layout.dataStart, layout.lastCol), ...mirror.map((m) => m.rowNo));
    clearRange(ws, layout.dataStart, maxRow, 1, layout.lastCol);

    const links = await prisma.sheetRowEmployeeLink.findMany({ where: { sheet: sp.sheet } });
    const empIdByRow = new Map<number, number>(links.map((l) => [l.rowNo, l.employeeId]));
    const empIds = [...new Set(empIdByRow.values())];
    const emps = empIds.length
      ? await prisma.employee.findMany({ where: { id: { in: empIds }, deletedAt: null } })
      : [];
    const empMap = new Map<number, Record<string, unknown>>(
      (emps as unknown as Record<string, unknown>[]).map((e) => [e.id as number, e])
    );

    let written = 0;
    let matched = 0;
    for (let i = 0; i < mirror.length; i++) {
      const row = mirror[i];
      const cells = safeParseCells(row.cellsJson);
      const empId = empIdByRow.get(row.rowNo);
      const e = empId !== undefined ? empMap.get(empId) : undefined;

      let vals: Record<string, string | number>;
      if (e) {
        matched++;
        // 已建档 → 用最新档案算出的值（软件里改过，这里立刻反映）
        vals = employeeValues(e, storeNames, new Map(), now);
        vals.__seq__ = String(i + 1);
      } else {
        // 未建档 → 保留导入时的原始名单值（cellsJson 数组，下标 = 列号-1）
        vals = {};
        for (let c = 1; c <= sp.cols.length; c++) {
          // ⚠️ 原始名单里也可能存着 XLOOKUP 匹配失败留下的「没找到」，同样要清掉
          const raw = cells[c - 1] ?? "";
          vals[`c${c}`] = raw.trim() === NOT_FOUND ? "" : raw;
        }
      }

      for (let c = 1; c <= sp.cols.length; c++) {
        const field = sp.cols[c - 1];
        let v: string | number;
        if (e) {
          if (!field) continue;
          v = vals[field] ?? "";
          // ⚠️ 档案里这一项是空的 → 退回原名单的值。
          //    否则「已建档」的行会被空值覆盖（实测面试地点 16 处、招聘人 7 处丢失）。
          if (v === "") {
            const raw = String(cells[c - 1] ?? "").trim();
            if (raw && raw !== NOT_FOUND) v = raw;
          }
        } else {
          v = vals[`c${c}`] ?? "";
        }
        if (putCell(ws, row.rowNo, c, v)) written++;
      }
    }

    out.push({
      sheet: sp.sheet,
      rows: mirror.length,
      written,
      note:
        `名单沿用 Excel 原始行（${mirror.length} 人不变），` +
        `其中 ${matched} 人已建档并回填最新档案数据，其余保留原始名单值；0 公式`,
    });
  }

  return out;
}

function safeParseCells(json: string): string[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.map((x) => (x === null || x === undefined ? "" : String(x))) : [];
  } catch {
    return [];
  }
}

/**
 * 统计类 Sheet —— **全部实时计算写入**
 *
 * ⚠️ 口径铁律：直接调用页面所用的同一个服务
 *   · 门店人员编制   → `getStoreHeadcount()`
 *   · 人员流失率     → `getAttrition({ month })`
 *   · 门店人员分布明细 → `getDistribution()`
 * 软件页面看到的数字与导出文件**逐格一致**，绝不各写一套算法。
 *
 * 之前这些格全是公式（COUNTIFS / SUMPRODUCT / TEXTJOIN / LET），手机上看是空的；
 * 现在全部写死为常量值。
 */
async function writeStatSheets(wb: ExcelJS.Workbook, month: string): Promise<ExportResult["stats"]> {
  const out: ExportResult["stats"] = [];
  

  const [hc, dist, attrition] = await Promise.all([
    getStoreHeadcount(),
    getDistribution(),
    getAttrition({ month }),
  ]);
  const hcByStore = new Map(hc.rows.map((r) => [r.storeName, r]));

  // ---------- ① 门店人员编制 ----------
  // 实测列序（R3）：1 序号 / 2 名称 / 3 店长 / 4 技术店长 / 5 副店长 / 6 客服经理 /
  //           7 机修现有 / 8 美容现有 / 9 后勤 / 10 当前合计人数 /
  //           11 客服经理满编 / 12 机修满编 / 13 美容满编 / 14 美容师傅满编 /
  //           15 美容中小工满编 / 16 现有美容师傅 / 17 现有美容中小工 /
  //           18 缺编汇总 / 19 机修缺编 / 20 美容缺编 / 21 客服经理缺编 / 22 具体缺编明细
  // ⚠️ 原表 R40 是「所有店铺合计」行，数据行只到 R39 —— 合计行要单独处理。
  {
    const sheet = "门店人员编制";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      // ⚠️ 2026-11-24 修：0 行时不清空、保留原模板内容（旧版先清空再写 0 行，
      //    导出一张空表）。编制表行来源已改为「计划 ∪ 有在职员工的门店」，
      //    正常情况下不会 0 行；这里是兜底。
      if (hc.rows.length === 0) {
        out.push({
          sheet,
          rows: 0,
          written: 0,
          note: "无编制计划且无在职员工，保留原模板内容未清空",
        });
      } else {
      // ⚠️ 合计行必须在**清空之前**探测：它的 A:B 是合并单元格，
      // 读 B 列拿到的是主格 A 的值；清空后就再也认不出哪行是合计行了。
      // ⚠️ 2026-11-24 修：按「合计」字样扫描探测，不按行数推算 —— 门店数变化时
      //    合计行位置会变（实测在职门店 40 家，原表编制表 36 家）。
      const tplLast = lastDataRow(ws, dataStart, layout.lastCol);
      let hasSumRow = false;
      for (let r = dataStart; r <= tplLast; r++) {
        if (
          cellToText(ws.getRow(r).getCell(1).value).includes("合计") ||
          cellToText(ws.getRow(r).getCell(2).value).includes("合计")
        ) {
          hasSumRow = true;
          break;
        }
      }
      const sumRow = dataStart + hc.rows.length; // 合计行写在新数据之后
      const lastRow = tplLast;
      clearRange(ws, dataStart, lastRow, 1, layout.lastCol);
      if (hasSumRow) putCell(ws, sumRow, 1, "所有店铺合计：");

      let written = 0;
      for (let i = 0; i < hc.rows.length; i++) {
        const r = hc.rows[i];
        const target = dataStart + i;
        const st = hcByStore.get(r.storeName);
        if (putCell(ws, target, 1, i + 1)) written++;
        if (putCell(ws, target, 2, r.storeName)) written++;
        const c = r.current;
        const live: (number | null)[] = [
          c.manager, c.techManager, c.deputyManager, c.serviceManager,
          c.mechanic, c.beauty, c.logistics, c.total,
        ];
        for (let k = 0; k < live.length; k++) if (putCell(ws, target, 3 + k, live[k])) written++;
        const full: (number | null)[] = [
          r.full.serviceManager, r.full.mechanic, r.full.beauty, r.full.beautyMaster, r.full.beautyJunior,
        ];
        for (let k = 0; k < full.length; k++) if (putCell(ws, target, 11 + k, full[k])) written++;
        // 16 现有美容师傅 / 17 现有美容中小工 / 18 缺编汇总 / 19 机修缺编 /
        // 20 美容缺编 / 21 客服经理缺编 / 22 具体缺编明细（负数=超编，原样显示）
        if (st) {
          const gap: (number | string)[] = [
            c.beautyMaster, c.beautyJunior, st.gap.total, st.gap.mechanic,
            st.gap.beauty, st.gap.serviceManager, st.gap.detail,
          ];
          for (let k = 0; k < gap.length; k++) if (putCell(ws, target, 16 + k, gap[k])) written++;
        }
      }

      // 合计行（先探测后写，见上）
      if (hasSumRow) {
        const colVals = (r: (typeof hc.rows)[number]): (number | null)[] => [
          r.current.manager, r.current.techManager, r.current.deputyManager,
          r.current.serviceManager, r.current.mechanic, r.current.beauty,
          r.current.logistics, r.current.total, r.full.serviceManager,
          r.full.mechanic, r.full.beauty, r.full.beautyMaster, r.full.beautyJunior,
          r.current.beautyMaster, r.current.beautyJunior,
        ];
        for (let c = 3; c <= 17; c++) {
          let s = 0;
          for (const r of hc.rows) {
            const v = colVals(r)[c - 3];
            if (typeof v === "number") s += v;
          }
          if (putCell(ws, sumRow, c, s)) written++;
        }
        // 18~21 缺编四列的合计：**只累加正数**（Excel 原表就是 SUMIF(">0")）。
        // ⚠️ 早先直接相加，超编门店的负数会抵消其它门店的缺口，合计出现 -9 / -8
        //    这种不可能的数字（人工表合计是 7 / 4）。
        for (let c = 18; c <= 21; c++) {
          let s = 0;
          for (const r of hc.rows) {
            const v =
              c === 18 ? r.gap.total : c === 19 ? r.gap.mechanic : c === 20 ? r.gap.beauty : r.gap.serviceManager;
            if (typeof v === "number" && v > 0) s += v;
          }
          if (putCell(ws, sumRow, c, s)) written++;
        }
      }

      out.push({
        sheet,
        rows: hc.rows.length,
        written,
        note:
          `实时计算（getStoreHeadcount）：${hc.rows.length} 家门店 22 列实值 + 合计行；` +
          `现有人数按在职表实时 COUNT，满编取人工设置值；0 公式`,
      });
      } // 0 行保护的 else
    }
  }

  // ---------- ② 门店人员分布明细 ----------
  // 实测列序（R2）：1 序号 / 2 门店 / 3 门店人数 / 4 店长 / 5 副店长 /
  //                6 技术店长 / 7 客服经理 / 8 后勤 / 9 机修 / 10 美容
  {
    const sheet = "门店人员分布明细";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      // ⚠️ 2026-11-24 修：0 行时不清空、保留原模板内容（见 ①）。
      if (dist.rows.length === 0) {
        out.push({
          sheet,
          rows: 0,
          written: 0,
          note: "无在职员工，保留原模板内容未清空",
        });
      } else {
      clearRange(ws, dataStart, lastDataRow(ws, dataStart, layout.lastCol), 1, layout.lastCol);
      let written = 0;
      for (let i = 0; i < dist.rows.length; i++) {
        const r = dist.rows[i];
        const target = dataStart + i;
        if (putCell(ws, target, 1, i + 1)) written++;
        if (putCell(ws, target, 2, r.storeName)) written++;
        if (putCell(ws, target, 3, r.headcount)) written++;
        for (let k = 0; k < DISTRIBUTION_GRADES.length; k++) {
          const names = r.people[DISTRIBUTION_GRADES[k].key] ?? [];
          if (putCell(ws, target, 4 + k, names.join("、"))) written++;
        }
      }
      out.push({
        sheet,
        rows: dist.rows.length,
        written,
        note: `实时计算（getDistribution）：${dist.rows.length} 家门店 × 8 列实值；与软件「人员分布明细」页同一服务；0 公式`,
      });
      } // 0 行保护的 else
    }
  }

  // ---------- ③ 人员流失率 ----------
  // 实测列序（R3）：1 序号 / 2 门店名称 / 3 店长 / 4 技术店长 / 5 副店长 /
  //                6 实时人数 / 7 当月离职 / 8 当月入职 / 9 流失率 / 10 邀约数量
  // ⚠️ 原表**一家门店占 1~2 行**（有副店长就多一行副店长行），A/B 列是合并单元格。
  //    导出时先取消数据区 A/B 列的旧合并（见下 unmergeCellsIn），否则旧合并会吞掉
  //    新门店的序号；真正占 2 行的门店，序号/店名只写在店长行，不再跨行合并。
  {
    const sheet = "人员流失率";
    const ws = wb.getWorksheet(sheet);
    const layout = LAYOUT[sheet];
    if (!ws || !layout) {
      out.push({ sheet, rows: 0, written: 0, note: "Excel 里没有这个 Sheet" });
    } else {
      const { dataStart } = layout;
      // ⚠️ 2026-11-24 改：流失率按原表旁边的文字定义从库里实时算，不再留模板。
      //    口径（用户确认）：流失率=(当月离职−当月入职)/月初人数；当月离职只算
      //    离职时入职满 3 个自然月的人；月初人数=入职日期<月初且无离职日期或
      //    离职日期≥月初（不要求满 3 个月）；门店按现门店计，调店归属新店。
      //    行来源 = 指标计划 ∪ 有在职/离职员工的门店（计划表 AttritionIndicator
      //    是空的，不能只靠它）；店长名按现门店在职员工的工种填
      //    （jobGradeRaw 原文匹配，与编制/分布一致）。
      //    0 行时不清空、不改标题，保留原模板内容（见 ①）—— 正常情况下不会
      //    0 行（只要库里有员工就有行）；这里是兜底。
      if (attrition.rows.length === 0) {
        out.push({
          sheet,
          rows: 0,
          written: 0,
          note: "系统里没有流失率指标数据（AttritionIndicator 未导入），保留原模板内容未清空",
        });
      } else {
      // ⚠️ 2026-11-24 修：先取消数据区 A/B 列的旧合并再写。原表 A4:A5、A11:A12 是
      //    旧门店“副店长行”留下的合并，行布局变了之后若不取消，会把新门店的序号
      //    （写进合并从格）吞掉——实测 2026-09 导出因此丢了 2 个序号（东城东宝路店、
      //    南昌崇仁人民大道店）。表头与右侧文字说明的合并在数据区之外，不受影响。
      //    真正有副店长、占 2 行的门店，序号和店名写在两行（原表是跨行合并，
      //    一个序号/店名属于整家店，两行共用；人数/离职/入职/流失率/邀约在原表
      //    里本来就是两行重复的）——数据正确，外观略有不同。
      const lastRow = lastDataRow(ws, dataStart, layout.lastCol);
      unmergeCellsIn(ws, dataStart, lastRow, 1, 2);
      clearRange(ws, dataStart, lastRow, 1, layout.lastCol);
      let written = 0;
      let rowNo = 0;
      for (const r of attrition.rows) {
        const target = dataStart + rowNo;
        if (putCell(ws, target, 2, r.storeName)) written++;
        // ⚠️ 序号 = 门店序号（sortOrder），店长行和副店长行都写——原表里一家
        //    占 2 行的门店序号是跨行合并的（一个序号属于整家店，两行共用）；
        //    只写店长行的话，独占副店长的门店（深圳茜坑天虹店）会让序号出现
        //    缺口（1..33、35..44，缺 34）。两行都写，序号连续 1..44。
        if (putCell(ws, target, 1, r.sortOrder)) written++;
        if (r.role === "STORE_MANAGER") {
          if (putCell(ws, target, 3, r.managers.storeManager ?? "")) written++;
          if (putCell(ws, target, 4, r.managers.techManager ?? "")) written++;
        } else {
          if (putCell(ws, target, 5, r.managers.deputyManager ?? "")) written++;
        }
        // ⚠️ 第 9 列「流失率」必须写**小数**（0.14），不能写百分数（14）。
        //   原表该列 numFmt 是 0%，写小数才会显示成 14%；写 14 会显示成 1400%。
        //   原 Excel 公式 `(G4-H4)/F4` 本身也是小数，两边一致。
        const vals: (number | string | null)[] = [
          r.monthStartHeadcount,
          r.monthResigned,
          r.monthHired,
          r.rate === null ? null : Number(r.rate.toFixed(6)),
          r.invites,
        ];
        for (let k = 0; k < vals.length; k++) if (putCell(ws, target, 6 + k, vals[k])) written++;
        rowNo++;
      }
      const { label } = parseMonth(month);
      // J1（R1 第 10 列）是「统计月份」单元格；A1:I1 是合并的大标题 —— 一起更新，
      // 否则标题写着「2026年8月」而数据是 9 月的，会误导看表的人。
      if (putCell(ws, 1, 10, `${month}-01`)) written++;
      if (putCell(ws, 1, 1, `${label}门店考核指标数据`)) written++;
      out.push({
        sheet,
        rows: attrition.rows.length,
        written,
        note:
          `实时计算（getAttrition，月份 ${label}）：${attrition.rows.length} 行 × 实值；` +
          `月初人数/当月离职/当月入职/流失率/邀约数量全部按当前数据重算；0 公式`,
      });
      } // 0 行保护的 else
    }
  }

  return out;
}

export { LAYOUT, cellToText, normTitle };



