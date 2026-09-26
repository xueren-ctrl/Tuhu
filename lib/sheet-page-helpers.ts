/**
 * 「表」页面的公共服务端逻辑（Stage 9）
 *
 * 页面解析出来的查询条件在这里统一做「筛选 → 排序 → 分页 → 打码」：
 *   /sheets/<表> —— 由员工数据实时生成（可增删改）
 *
 * ⚠️ 「招聘面试登记表」「薪资表」的表体来自 Excel 原始名单（SheetRow），
 * 读取入口是 lib/sheet-service.ts 的 loadSheet() —— **那份数据是这两张表的底座，不能删**。
 */
import {
  filterRows,
  maskRows,
  paginate,
  sortRows,
  type FilterOp,
  type SheetRowData,
} from "./sheet-service";

export const SHEET_PAGE_SIZES = [20, 50, 100, 200];
export const SHEET_PAGE_DEFAULT_SIZE = 50;

const FILTER_OPS: FilterOp[] = ["contains", "equals", "neq", "empty", "notEmpty"];

export interface SheetPageQuery {
  keyword: string;
  colRaw: string;
  col: number | null;
  op: FilterOp;
  val: string;
  sortRaw: string;
  sort: number | null;
  dir: "asc" | "desc";
  size: number;
  page: number;
  reveal: boolean;
}

type SP = Record<string, string | string[] | undefined>;

function pick(sp: SP, key: string): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return (s ?? "").toString();
}

export function parseSheetQuery(
  sp: SP,
  columnCount: number
): SheetPageQuery {
  const colRaw = pick(sp, "col").trim();
  const colNum = colRaw === "" ? null : Number(colRaw);
  const opRaw = pick(sp, "op").trim() as FilterOp;
  const sortRaw = pick(sp, "sort").trim();
  const sortNum = sortRaw === "" ? null : Number(sortRaw);
  const sizeRaw = Number(pick(sp, "size"));

  const inRange = (n: number | null) =>
    n !== null && Number.isFinite(n) && n >= 0 && n < columnCount ? n : null;

  return {
    keyword: pick(sp, "q").trim(),
    colRaw,
    col: inRange(colNum),
    op: FILTER_OPS.includes(opRaw) ? opRaw : "contains",
    val: pick(sp, "val"),
    sortRaw,
    sort: inRange(sortNum),
    dir: pick(sp, "dir") === "desc" ? "desc" : "asc",
    size: SHEET_PAGE_SIZES.includes(sizeRaw) ? sizeRaw : SHEET_PAGE_DEFAULT_SIZE,
    page: Math.max(1, Number(pick(sp, "page")) || 1),
    reveal: pick(sp, "reveal") === "1",
  };
}

export interface PreparedSheet {
  /** 命中行数（筛选后） */
  matchedCount: number;
  /** 当前页（已打码或未打码） */
  rows: SheetRowData[];
  page: number;
  pageSize: number;
  totalPages: number;
  /** 本页第一行在结果里的序号偏移 */
  offset: number;
}

export function prepareSheetRows(
  rows: SheetRowData[],
  columns: { index: number; sensitive: import("./sheet-service").SensitiveKind | null }[],
  q: SheetPageQuery
): PreparedSheet {
  let matched = filterRows(rows, { q: q.keyword, col: q.col, op: q.op, val: q.val });
  matched = sortRows(matched, q.sort, q.dir);
  // 序号列（Excel「序号」）按「当前筛选+排序后的顺序」重新编号
  const seqIndex = columns.findIndex((c) => (c as { source?: string }).source === "__seq__");
  if (seqIndex >= 0) {
    matched = matched.map((r, i) => {
      const cells = [...r.cells];
      cells[seqIndex] = String(i + 1);
      return { ...r, cells };
    });
  }
  const pager = paginate(matched, q.page, q.size);
  const sliced = q.reveal ? pager.slice : maskRows(pager.slice, columns);
  return {
    matchedCount: matched.length,
    rows: sliced,
    page: pager.page,
    pageSize: pager.pageSize,
    totalPages: pager.totalPages,
    offset: pager.offset,
  };
}

/** 拼 URL 查询串（保留现有条件） */
export function buildSheetHref(
  basePath: string,
  current: URLSearchParams,
  patch: Record<string, string | null>,
  keepPage = false
): string {
  const params = new URLSearchParams(current.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") params.delete(k);
    else params.set(k, v);
  }
  if (!keepPage) params.delete("page");
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
