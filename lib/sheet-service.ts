/**
 * Sheet 数据服务 —— 把「Excel 各 Sheet 导入进来的数据」以软件数据表的方式提供出去
 *
 * 数据来源：SheetRow 表（导入时从 Excel 原样抓取，公式取缓存结果、日期格式化为 YYYY-MM-DD）。
 * 本文件只负责「读 + 检索 + 展示规则」，不做任何写入，也不改动原始数据。
 *
 * 展示规则（软件化，而非照搬 Excel）：
 * 1. 表头统一处理：空表头按 Excel 列字母命名，重复表头加序号区分，个别已知缺失表头做补全；
 * 2. 敏感列（身份证 / 银行卡 / 电话 / 地址 / 薪资）默认打码，页面可一键切换到完整值；
 * 3. 全空列默认折叠（可在页面上勾选「显示空白列」展开）；
 * 4. 支持全表关键词搜索、按列筛选（包含 / 等于 / 不为空 …）、点表头排序、分页。
 */
import { prisma } from "./prisma";

/** 1 → A, 27 → AA */
export function excelColumnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 已知的表头缺失/错位补全（只影响「显示的列名」，绝不改动底层数据）。
 * 在职 Sheet 第 5 列有整列姓名，但 Excel 里表头是空的（合并单元格导致）。
 */
const HEADER_FIXES: Record<string, Record<number, string>> = {
  在职: { 4: "姓名" },
};

export type SensitiveKind = "idcard" | "bankcard" | "phone" | "address" | "money";

const SENSITIVE_RULES: { kind: SensitiveKind; re: RegExp }[] = [
  { kind: "idcard", re: /身份证/ },
  { kind: "bankcard", re: /银行卡|银行账号|开户账号/ },
  { kind: "phone", re: /电话|手机/ },
  { kind: "address", re: /地址|居住地/ },
  { kind: "money", re: /薪资|待遇|首月保障|保障/ },
];

export function detectSensitive(label: string): SensitiveKind | null {
  for (const r of SENSITIVE_RULES) if (r.re.test(label)) return r.kind;
  return null;
}

/** 打码：保留可识别的头尾，中间用 * 代替 */
export function maskValue(kind: SensitiveKind, value: string): string {
  const v = value.trim();
  if (!v) return value;
  switch (kind) {
    case "idcard":
      return v.length > 10 ? v.slice(0, 6) + "*".repeat(Math.max(4, v.length - 10)) + v.slice(-4) : v[0] + "***";
    case "bankcard":
      return v.length > 4 ? "*".repeat(Math.max(4, v.length - 4)) + v.slice(-4) : "****";
    case "phone":
      return v.length >= 8 ? v.slice(0, 3) + "****" + v.slice(-4) : v.slice(0, 2) + "***";
    case "address":
      return v.length > 4 ? v.slice(0, 4) + "···" : "···";
    case "money":
      return v.length > 2 ? v.slice(0, 2) + "··" : "··";
    default:
      return v;
  }
}

export interface SheetColumn {
  /** 在 cells 数组里的下标 */
  index: number;
  /** 展示用列名（已去重 / 补全） */
  label: string;
  /** Excel 里的原始表头（可能为空） */
  rawLabel: string;
  /** Excel 列字母，如 A / AA */
  letter: string;
  /** 敏感类型（null = 普通列） */
  sensitive: SensitiveKind | null;
  /** 有值的行数 */
  filled: number;
  /** 是否整列为空 */
  empty: boolean;
  /**
   * 该列取自哪个员工字段（只有「由员工数据生成」的表才有值）。
   * 表格组件据此判断这一列能不能行内编辑。
   */
  source?: string;
}

export interface SheetRowData {
  /** 行内唯一标识 */
  rowNo: number;
  /** 员工业务编号（THHR…）—— 纯 Excel 镜像行没有 */
  employeeId?: string;
  /** 对应员工档案 id；null / 缺省 = 这一行在系统里没有对应档案 */
  employeeRef?: number | null;
  cells: string[];
}

export interface LoadedSheet {
  sheet: string;
  columns: SheetColumn[];
  rows: SheetRowData[];
}

const cache = new Map<string, { at: number; data: LoadedSheet }>();
const CACHE_TTL_MS = 15_000;

/** 读取整张 Sheet（含列定义）。行数不大（最大 2000 行上下），一次性读入内存做检索。 */
export async function loadSheet(sheet: string): Promise<LoadedSheet | null> {
  const hit = cache.get(sheet);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const first = await prisma.sheetRow.findFirst({
    where: { sheet },
    orderBy: { rowNo: "asc" },
    select: { headersJson: true },
  });
  if (!first) return null;

  const rawHeaders: string[] = JSON.parse(first.headersJson);
  const records = await prisma.sheetRow.findMany({
    where: { sheet },
    orderBy: { rowNo: "asc" },
    select: { rowNo: true, cellsJson: true },
  });
  const rows: SheetRowData[] = records.map((r) => ({
    rowNo: r.rowNo,
    cells: JSON.parse(r.cellsJson) as string[],
  }));

  // 列宽 = 表头长度与数据长度取大者（有些 Sheet 数据比表头多列）
  const width = rows.reduce((m, r) => Math.max(m, r.cells.length), rawHeaders.length);

  const seen = new Map<string, number>();
  const columns: SheetColumn[] = [];
  for (let i = 0; i < width; i++) {
    const raw = (rawHeaders[i] ?? "").trim();
    const fix = HEADER_FIXES[sheet]?.[i];
    const base = fix ?? (raw || `第 ${excelColumnLetter(i + 1)} 列`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const label = n === 0 ? base : `${base}（${n + 1}）`;
    let filled = 0;
    for (const r of rows) if ((r.cells[i] ?? "").trim() !== "") filled++;
    columns.push({
      index: i,
      label,
      rawLabel: raw,
      letter: excelColumnLetter(i + 1),
      sensitive: detectSensitive(base),
      filled,
      empty: filled === 0,
    });
  }

  const data: LoadedSheet = { sheet, columns, rows };
  cache.set(sheet, { at: Date.now(), data });
  return data;
}

/** 让缓存立刻失效（手工改过数据后调用） */
export function invalidateSheetCache(sheet?: string) {
  if (sheet) cache.delete(sheet);
  else cache.clear();
}

/**
 * 服务端打码：把敏感列的值替换成掩码。
 *
 * ⚠️ 必须在**服务端**做，不能只在前端做 —— 前端打码只是视觉遮蔽，
 * 原始身份证 / 银行卡 / 电话仍会随页面数据一起下发到浏览器，
 * 在「页面源代码 / 网络请求」里能直接看到。这里在返回给浏览器之前就替换掉，
 * 用户勾选「显示完整信息」时才重新从服务端取一次完整值（?reveal=1）。
 */
export function maskRows(
  rows: SheetRowData[],
  columns: { index: number; sensitive: SensitiveKind | null }[]
): SheetRowData[] {
  const sensitive = columns.filter((c) => c.sensitive);
  if (sensitive.length === 0) return rows;
  return rows.map((r) => {
    const cells = [...r.cells];
    for (const c of sensitive) {
      const v = cells[c.index] ?? "";
      if (v.trim() !== "") cells[c.index] = maskValue(c.sensitive as SensitiveKind, v);
    }
    // 用展开而不是重建：保留 employeeId / employeeRef（行内编辑与跳转档案依赖它们）
    return { ...r, cells };
  });
}

// ------------------------------------------------------------
// 检索
// ------------------------------------------------------------

export type FilterOp = "contains" | "equals" | "neq" | "empty" | "notEmpty";

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  contains: "包含",
  equals: "等于",
  neq: "不等于",
  empty: "为空",
  notEmpty: "不为空",
};

export interface SheetQuery {
  /** 全表关键词（任一列包含） */
  q?: string;
  /** 按列筛选的列下标 */
  col?: number | null;
  op?: FilterOp;
  val?: string;
  /** 排序列下标 / 方向 */
  sort?: number | null;
  dir?: "asc" | "desc";
}

export function filterRows(rows: SheetRowData[], query: SheetQuery): SheetRowData[] {
  const q = (query.q ?? "").trim();
  const col = query.col ?? null;
  const op = query.op ?? "contains";
  const val = (query.val ?? "").trim();

  return rows.filter((r) => {
    if (q) {
      const hit = r.cells.some((c) => (c ?? "").includes(q));
      if (!hit) return false;
    }
    if (col !== null && col >= 0) {
      const cell = (r.cells[col] ?? "").trim();
      switch (op) {
        case "contains":
          // 没填值就不算生效（避免「选了列还没输入」把结果清成 0）
          if (val && !cell.includes(val)) return false;
          break;
        case "equals":
          if (val && cell !== val) return false;
          break;
        case "neq":
          if (val && cell === val) return false;
          break;
        case "empty":
          if (cell !== "") return false;
          break;
        case "notEmpty":
          if (cell === "") return false;
          break;
      }
    }
    return true;
  });
}

/** 数值感知比较：两值都是数字时按数字比，否则按本地化字符串比；空值恒排最后 */
export function sortRows(rows: SheetRowData[], sort: number | null, dir: "asc" | "desc"): SheetRowData[] {
  if (sort === null || sort < 0) return rows;
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = (a.cells[sort] ?? "").trim();
    const bv = (b.cells[sort] ?? "").trim();
    if (av === "" && bv === "") return a.rowNo - b.rowNo;
    if (av === "") return 1;
    if (bv === "") return -1;
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== "" && bv !== "") {
      if (an !== bn) return (an - bn) * sign;
      return a.rowNo - b.rowNo;
    }
    const c = av.localeCompare(bv, "zh-Hans-CN");
    if (c !== 0) return c * sign;
    return a.rowNo - b.rowNo;
  });
}

export function paginate<T>(rows: T[], page: number, size: number) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    total,
    page: safePage,
    pageSize: size,
    totalPages,
    slice: rows.slice((safePage - 1) * size, safePage * size),
    offset: (safePage - 1) * size,
  };
}
