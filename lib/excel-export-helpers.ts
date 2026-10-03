import ExcelJS from "exceljs";

/**
 * 导出辅助（Stage 9.40 重写）
 *
 * ## 为什么要「先把公式全压成常量」
 *
 * 这份 Excel 里 **全部 12 张表、6 万多个格子都是公式**：
 *   · 人员类表（在职 / 离职 / 南昌3店 / 运营部 / 运营部离职）→ XLOOKUP 去「数据库」表取值
 *   · 招聘面试登记表 / 薪资表 → XLOOKUP（按 姓名+入职时间 或 姓名+面试时间 匹配）
 *   · 门店人员编制 / 人员流失率 / 门店人员分布明细 → COUNTIFS / SUMPRODUCT / TEXTJOIN / LET
 *
 * 用户要求「**导出来的表不要带公式，要纯数据**」。而且此前踩过一个致命的坑：
 * 「在职」表的 XLOOKUP 靠 `数据库!$E:$E=$E3` （姓名）`数据库!$C:$C=$C3`（入职时间）匹配，
 * 导出时数据库表的日期被写成文本 `2021-03-22`，而原表 C 列是日期类型 ——
 * **文本 ≠ 日期 → 匹配全失败 → 满屏「没找到」**（用户 2026-10-03 报的）。
 *
 * 所以做法改成两步（顺序不能颠倒）：
 *   ① **先 flatten** —— 遍历所有单元格，凡有公式的（含共享公式母格与克隆格）
 *      一律替换成它自己的**缓存结果**（即 Excel 上次打开算出来的结果）。
 *      此刻整个工作簿里 **0 个公式**，共享公式结构也一并消失。
 *   ② **再逐表写入** —— 此时写入的都是普通单元格，随便写都不会触发
 *      `Shared Formula master must exist above and or left of clone` 那个崩溃。
 *
 * 共享公式（`shareType:"shared"`）是 ExcelJS 的雷区：
 *   母格 O4 + 克隆格 O5..O15。只覆盖母格 → 克隆格找不到母格 → 写文件直接抛错，
 *   而且报错信息里报的是**克隆格**格号，极易误判成"要修克隆格"。
 *   flatten 阶段把整组一起替换掉，问题彻底消失。
 */

/** 单元格值里是否带公式（含共享公式的母格与克隆格） */
export function isFormulaValue(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.formula !== undefined || o.sharedFormula !== undefined;
}

/** 该格是否公式格（兼容传 Cell 或传 value 两种用法） */
export function isFormulaCell(cell: ExcelJS.Cell): boolean {
  return isFormulaValue(cell.value as unknown);
}

/** 公式格的缓存结果 → 可直接写入的字面量（错误值 / 富文本 / 空 都归一为普通值） */
export function literalOfResult(result: unknown): string | number | boolean | Date | null {
  if (result === null || result === undefined) return null;
  if (result instanceof Date) return Number.isFinite(result.getTime()) ? result : null;
  const t = typeof result;
  if (t === "number" || t === "boolean") return result as number | boolean;
  if (t === "string") return result as string;
  if (t === "object") {
    const o = result as Record<string, unknown>;
    // Excel 错误值（#N/A / #VALUE! / #REF! …）→ 空
    if (o.error !== undefined) return null;
    if (Array.isArray(o.richText)) {
      return (o.richText as { text: string }[]).map((t2) => t2.text).join("");
    }
    if (o.text !== undefined) return String(o.text);
    return null;
  }
  return String(result);
}

/**
 * 把一个格子替换成常量值（跳过共享公式格）。
 * @deprecated  flattenFormulas 之后已无公式格，此函数仅保留给统计表做防御
 */
export function setCellValue(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: unknown,
  skipCols?: ReadonlySet<number>
): boolean {
  if (skipCols?.has(col)) return false;
  const cell = ws.getCell(row, col);
  if (isFormulaCell(cell)) return false;
  cell.value = (value instanceof Date ? value.toISOString().slice(0, 10) : value) as never;
  return true;
}

/**
 * 合并单元格的**从格**判断（写入时必须跳过，否则会写坏合并显示 / 抛错）。
 * 主格本身返回 false。
 */
export function isMergeSlave(cell: ExcelJS.Cell): boolean {
  const anyCell = cell as unknown as { master?: ExcelJS.Cell; type?: number };
  if (anyCell.type !== ExcelJS.ValueType.Merge) return false;
  const master = anyCell.master;
  return !!master && master.address !== cell.address;
}

/**
 * ① flatten：把整个工作簿的公式全部替换成缓存结果值。
 *
 * 返回 { total, bySheet } —— 便于在导出报告里告诉用户「压掉了多少个公式」。
 * ⚠️ 必须在所有写入动作**之前**调用。
 */
export function flattenFormulas(wb: ExcelJS.Workbook): {
  total: number;
  bySheet: Record<string, number>;
} {
  const bySheet: Record<string, number> = {};
  let total = 0;

  for (const ws of wb.worksheets) {
    let n = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        // 合并从格与主格共享同一个 value，主格会处理，这里跳过避免重复计数
        if (isMergeSlave(cell)) return;
        const v = cell.value as unknown;
        if (!isFormulaValue(v)) return;
        const literal = literalOfResult((v as Record<string, unknown>).result);
        // ⚠️ 不能传 undefined（ExcelJS 会当删除），统一给 null = 空
        cell.value = (literal === null ? null : literal) as never;
        n++;
      });
    });
    if (n > 0) bySheet[ws.name] = n;
    total += n;
  }

  return { total, bySheet };
}

/**
 * 写入一个数据格（自动跳过合并从格）。
 * 值为 null / undefined / 空串时写入 **null（清空该格）**，而不是「跳过不动」——
 * 这是「数据必须与软件一致」的保证：软件里清空了的字段，导出也必须是空。
 */
export function putCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: string | number | boolean | Date | null | undefined
): boolean {
  if (row < 1 || col < 1) return false;
  const cell = ws.getCell(row, col);
  if (isMergeSlave(cell)) return false;
  if (value === null || value === undefined || value === "") {
    cell.value = null as never;
    return true;
  }
  cell.value = (value instanceof Date ? value : value) as never;
  return true;
}

/** 清空一块矩形区域的数据格（跳过合并从格） */
export function clearRange(
  ws: ExcelJS.Worksheet,
  r1: number,
  r2: number,
  c1: number,
  c2: number
): void {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) putCell(ws, r, c, null);
  }
}