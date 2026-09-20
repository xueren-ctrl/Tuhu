/**
 * Excel 导入底座 —— 共享类型（第五阶段）
 *
 * 这里是「Excel → 数据库」链路的**唯一类型来源**。
 * 正式导入（scripts/import-excel.ts）与导入预览（lib/import-preview-service.ts）
 * 都只消费这里的类型，任何一边都不允许自定义一套行结构。
 */

/** 解析期问题类型（写 ImportIssue / 预览异常，均不静默丢弃） */
export type IssueType =
  | "MISSING_ID"
  | "INVALID_ID"
  | "FIELD_MISPLACED"
  | "INVALID_DATE"
  | "EMPTY_NAME"
  | "DUPLICATE_KEY"
  | "FALLBACK_MATCH"
  | "PRECISION_RISK"
  | "PRECISION_SUSPECT"
  | "STATUS_CONFLICT"
  | "RESIGN_DATE_MISSING"
  /** 源数据本身就没有提供该字段（如门店员工的「部门」），
   *  与「系统应该有但为空」是两回事，不能混为一谈 */
  | "SOURCE_MISSING"
  | "OTHER";

export interface ParseIssue {
  row: number | null;
  name: string | null;
  field: string | null;
  /** 已脱敏的原始值（敏感字段绝不写明文） */
  rawValue: string | null;
  type: IssueType;
  severity: "WARN" | "ERROR";
  message: string;
}

/** 员工状态 */
export type EmployeeStatus = "ACTIVE" | "RESIGNED" | "CANDIDATE";

/**
 * 标准化员工记录（解析产物）
 *
 * - `values` 以 **Prisma 字段名** 为键，覆盖 Excel「数据库」Sheet 的 46 列
 *   （除纯定位用的「序号」外全部入库），外加由身份证推导的 gender / age / status。
 * - 日期统一为 `YYYY-MM-DD` 字符串；是否转 Date 由调用方决定（预览不需要，写库才需要）。
 * - 长数字（身份证 / 银行卡 / 手机号）全程字符串，已做归一化但未做脱敏 ——
 *   脱敏只发生在「展示」环节，绝不发生在解析环节。
 */
export interface EmployeeRecord {
  /** Excel 行号（1-based，用于溯源与 Diff 定位） */
  rowNo: number;
  /** 序号（Excel 第 1 列，仅用于人工定位，不入库） */
  seqNo: number | null;
  name: string;
  /** 18 位规范身份证（可用于去重）；非 18 位时为 null */
  idCardKey: string | null;
  /** 门店原文（Excel 第 2 列） */
  storeNameRaw: string | null;
  /** 工种级别原文（Excel 第 8 列） */
  jobGradeRaw: string | null;
  /** 入职日期 ISO（YYYY-MM-DD） */
  hireDate: string | null;
  status: EmployeeStatus;
  /** 离职日期 ISO；无法解析时为 null */
  resignDate: string | null;
  phone: string | null;

  /** 全部业务字段，键为 Prisma 字段名 */
  values: Record<string, string | number | null>;
  /** 数据标记（列错位归位、重新入职、离职日期缺失等） */
  dataFlags: string[];
}

export interface ParseResult {
  ok: boolean;
  error?: string;
  sheetName: string;
  /** 数据区总行数 */
  totalRows: number;
  /** 有效业务行 */
  validRows: number;
  /** 跳过的行（整行为空 / 姓名为空 / 合并单元格从属格） */
  skippedRows: number;
  rows: EmployeeRecord[];
  issues: ParseIssue[];
  skipped: { row: number; reason: string }[];
  /** 「在职」名册的「姓名|入职日期」集合 */
  rosterActive: Set<string>;
  /** 「离职」名册的「姓名|入职日期」集合（判定离职的关键信号之一） */
  rosterResigned: Set<string>;
  /** 表头（列号 → 文字），供校验与审计 */
  headerMap: Map<number, string>;
}

/** 字段类别：决定如何归一化、如何比较、如何写库 */
export type FieldKind =
  | "text" // 原样字符串
  | "date" // YYYY-MM-DD
  | "digits" // 只保留数字（手机号 / 银行卡）
  | "idcard" // 身份证：去分隔符 + X 大写
  | "int" // 整数
  | "raw"; // 不做归一化的原文（如离职日期自由文本）

export interface FieldSpec {
  /** Excel 列号（1-based） */
  col: number;
  /** Prisma / Employee 字段名 */
  field: string;
  /** 中文名（界面展示） */
  label: string;
  kind: FieldKind;
  /** 是否敏感（展示需脱敏） */
  sensitive: boolean;
  /** Excel 表头文字（用于表头校验） */
  header: string;
  /** 是否参与「是否写入 Employee」以及 Diff 比较 */
  comparable: boolean;
}
