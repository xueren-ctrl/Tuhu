import ExcelJS from "exceljs";

/**
 * 公式格安全替换（Stage 9.39）
 *
 * ⚠️ 安全性（已实测两次）：
 *  - 单独把**普通公式**格（如 `SUMPRODUCT(...)`）替换成常量，写文件**不会崩**
 *  - 只有**破坏共享公式母格**（`shareType:"shared"`）才会抛
 *    `Shared Formula master must exist above and or left of clone for cell XX`
 *    ⚠️ 报错信息里的格号是**克隆格**（如 O5），母格是 O4 —— 很容易误判成"要修 O5"
 *
 * 正确做法：**整列跳过**共享公式区（母格 + 所有克隆格）。
 * 只判断 `cell.sharedFormula !== undefined` 是不够的 —— 那样只跳过克隆格，
 * 母格照写，照样崩。所以这里同时识别母格，并支持按列号整列排除。
 */

/** 共享公式的克隆格 */
export function isSharedClone(cell: ExcelJS.Cell): boolean {
  const v = cell.value as unknown;
  if (!v || typeof v !== "object") return false;
  return (v as Record<string, unknown>).sharedFormula !== undefined;
}

/** 共享公式的母格（有 shareType 且带自己的公式） */
export function isSharedMaster(cell: ExcelJS.Cell): boolean {
  const v = cell.value as unknown;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.formula !== undefined && o.shareType === "shared";
}

/**
 * 把一个格子替换成常量值。
 * @param skipCols 该表里**整列都不写**的列号（1-based），用于排除共享公式区
 * @returns 是否真的写入
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
  if (isSharedClone(cell) || isSharedMaster(cell)) return false;
  cell.value = (value instanceof Date ? value.toISOString().slice(0, 10) : value) as never;
  return true;
}
