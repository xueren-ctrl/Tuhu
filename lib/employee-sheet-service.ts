/**
 * 员工驱动的「表」数据服务（Stage 9）
 *
 * 各表（在职 / 离职 / 南昌3店 / 运营部 / 招聘面试登记表 / 运营部离职 / 薪资表 / 数据库）
 * 一律由 Employee 表实时生成：
 *   ① 按状态筛选（`STATUS_SHEETS` —— 状态决定出现在哪些表；「数据库」= 全部）；
 *   ② 按该表的列清单（`SHEET_COLUMNS`）逐格取值，计算列实时算、不落库；
 *   ③ 关键：列名可能因表而异（「工资卡的开户银行支行」/「开户行」都取 bankBranch），
 *      所以值是「按 source 字段」取的，不是按列名。
 *
 * 只读：不写任何数据。增删改一律走 employee-service。
 */
import { prisma } from "./prisma";
import { loadSheet } from "./sheet-service";
import { EMPLOYEE_STATUS_LABEL } from "./constants";
import { formatDate } from "./format";
import { hasCompletedTwoMonths, renderTenureCn } from "./tenure";
import type { SensitiveKind } from "./sheet-service";
import {
  COMPUTED,
  SHEET_COLUMNS,
  sheetBase,
  statusesForSheet,
  type SheetColumnSpec,
} from "./sheet-fields";

/**
 * 「Excel 原始名单」表里，软件新增员工的行号基准。
 * Excel 行号最大几千，Employee.id 当前一万多 —— 用一个高基数避开冲突，
 * 保证同一页里每行的 rowNo 唯一（抽屉的上/下一行、React key 都依赖它）。
 */
const NEW_ROW_BASE = 5_000_000;

export interface SheetColumn {
  index: number;
  label: string;
  /** 与 label 相同（保留字段以兼容 Sheet 数据表组件的列类型） */
  rawLabel: string;
  letter: string;
  source: string;
  sensitive: SensitiveKind | null;
  /** 计算列（不可直接编辑） */
  computed: boolean;
  filled: number;
  empty: boolean;
}

export interface SheetRowData {
  rowNo: number;
  employeeId: string;
  cells: string[];
}

export interface LoadedEmployeeSheet {
  sheet: string;
  columns: SheetColumn[];
  rows: SheetRowData[];
  /** 行数来源拆分：Excel 原始名单 vs 在软件里新增的员工（页面用来解释人数构成） */
  origin: { excel: number; employee: number };
}

function excelLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type EmployeeLite = {
  id: number;
  employeeId: string;
  status: string;
  name: string;
  storeNameRaw: string | null;
  departmentNameRaw: string | null;
  jobGradeRaw: string | null;
  store: { name: string } | null;
  department: { name: string } | null;
  position: { name: string } | null;
} & Record<string, unknown>;

const EMPLOYEE_SELECT = {
  id: true,
  employeeId: true,
  status: true,
  name: true,
  idCardNo: true,
  gender: true,
  age: true,
  ageRaw: true,
  minorNote: true,
  phone: true,
  workPhone: true,
  currentAddress: true,
  householdAddress: true,
  emergencyContact1: true,
  emergencyPhone1: true,
  emergencyContact2: true,
  emergencyPhone2: true,
  storeId: true,
  storeNameRaw: true,
  departmentId: true,
  departmentNameRaw: true,
  positionId: true,
  jobGradeRaw: true,
  positionNote: true,
  certificateLevel: true,
  hireDate: true,
  dormitory: true,
  mentorName: true,
  onboardingMedical: true,
  socialInsurancePurchased: true,
  salaryTerms: true,
  firstMonthGuarantee: true,
  bankBranch: true,
  bankAccountNo: true,
  laborContract: true,
  socialInsuranceAgreement: true,
  fireSafetyCommitment: true,
  dormitoryWaiver: true,
  docResume: true,
  docInterviewEvaluation: true,
  docOnboardingForm: true,
  docInterviewEvaluation2: true,
  resignDate: true,
  resignDateRaw: true,
  resignReason: true,
  recruiterName: true,
  interviewDate: true,
  interviewLocation: true,
  interviewResult: true,
  interviewerName: true,
  interviewHired: true,
  remark: true,
  remark3: true,
  computed7Days: true,
  computed2Months: true,
  tenureTextAtImport: true,
  resignedTenureText: true,
  store: { select: { name: true } },
  department: { select: { name: true } },
  position: { select: { name: true } },
} as const;

/** 单格取值：计算列实时算，普通列直取（日期统一 YYYY-MM-DD） */
function cellValue(emp: EmployeeLite, source: string, now: Date): string {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

  switch (source) {
    case COMPUTED.STORE:
      return emp.store?.name ?? emp.department?.name ?? s(emp.storeNameRaw) ?? "";
    case COMPUTED.DEPARTMENT:
      return emp.department?.name ?? s(emp.departmentNameRaw) ?? "";
    case COMPUTED.POSITION:
      return s(emp.jobGradeRaw) || (emp.position?.name ?? "");
    case COMPUTED.AGE:
      return emp.age !== null && emp.age !== undefined ? String(emp.age) : s(emp.ageRaw);
    case COMPUTED.STATUS:
      return EMPLOYEE_STATUS_LABEL[emp.status] ?? emp.status;
    case COMPUTED.TENURE:
      return renderTenureCn(emp.hireDate as Date | null, null, now);
    case COMPUTED.RESIGNED_TENURE:
    case COMPUTED.TENURE_ANY:
      return renderTenureCn(emp.hireDate as Date | null, emp.resignDate as Date | null, now);
    case COMPUTED.WORK_7DAYS: {
      if (!emp.hireDate) return "";
      const ref = (emp.resignDate as Date | null) ?? now;
      const days = Math.floor((ref.getTime() - (emp.hireDate as Date).getTime()) / 86_400_000);
      return days >= 7 ? "入职满7天" : "未满7天";
    }
    case COMPUTED.WORK_2MONTHS: {
      if (!emp.hireDate) return "";
      // 与 lib/tenure.ts 同口径：自然月加法；离职的以离职日为参考日
      const ref = (emp.resignDate as Date | null) ?? now;
      const done = hasCompletedTwoMonths(emp.hireDate as Date, ref);
      if (done === null) return "";
      return done ? "入职满2个月" : "未满2个月";
    }
    case COMPUTED.SEQ:
      return "";
    default:
      break;
  }

  const raw = emp[source];
  if (raw === null || raw === undefined) return "";
  if (source === "hireDate" || source === "resignDate" || source === "interviewDate") {
    return formatDate(raw as Date);
  }
  return s(raw);
}

/** 读取一张表（全部行，未分页）。返回 null 表示不认识的表名。 */
export async function loadEmployeeSheet(sheet: string): Promise<LoadedEmployeeSheet | null> {
  const specs: SheetColumnSpec[] | undefined = SHEET_COLUMNS[sheet as keyof typeof SHEET_COLUMNS];
  if (!specs) return null;

  const statuses = statusesForSheet(sheet);
  const now = new Date();
  const base = sheetBase(sheet);

  // 员工驱动：按状态取人，逐格取值
  const loadEmployees = (where: Record<string, unknown>) =>
    prisma.employee.findMany({
      where: { deletedAt: null, ...where } as never,
      select: EMPLOYEE_SELECT,
      orderBy: { employeeId: "asc" },
    }) as Promise<unknown[]>;

  const cellRow = (e: unknown): SheetRowData => {
    const emp = e as EmployeeLite;
    return {
      rowNo: emp.id,
      employeeId: emp.employeeId,
      cells: specs.map((c) => cellValue(emp, c.source, now)),
    };
  };

  let rows: SheetRowData[];
  const origin = { excel: 0, employee: 0 };

  if (base === "excel") {
    // 以导入时的 Excel 原始名单为准（人数与原来完全一致），再追加软件新增的人
    const mirror = await loadSheet(sheet);
    const dataCols = specs.length - 1; // 最后一列是系统加的「状态」，原始行没有
    const mirrorRows: SheetRowData[] = (mirror?.rows ?? []).map((r) => ({
      rowNo: r.rowNo,
      employeeId: "",
      cells: [...r.cells.slice(0, dataCols), ...new Array(Math.max(0, specs.length - r.cells.length)).fill(""), ""],
    }));
    // 只追加「在软件里新建的员工」：状态符合规则才进表，历史数据不补
    const added = await loadEmployees({
      sourceSheet: null,
      ...(statuses ? { status: { in: statuses } } : {}),
    });
    rows = [...mirrorRows, ...added.map((e) => ({ ...cellRow(e), rowNo: NEW_ROW_BASE + (e as EmployeeLite).id }))];
    origin.excel = mirrorRows.length;
    origin.employee = added.length;
  } else {
    const employees = await loadEmployees(statuses ? { status: { in: statuses } } : {});
    rows = employees.map(cellRow);
    origin.employee = rows.length;
  }

  const columns: SheetColumn[] = specs.map((c, i) => {
    let filled = 0;
    for (const r of rows) if ((r.cells[i] ?? "").trim() !== "") filled++;
    return {
      index: i,
      label: c.label,
      rawLabel: c.label,
      letter: excelLetter(i + 1),
      source: c.source,
      sensitive: c.sensitive ?? null,
      computed: c.source.startsWith("__"),
      filled,
      empty: filled === 0,
    };
  });

  return { sheet, columns, rows, origin };
}
