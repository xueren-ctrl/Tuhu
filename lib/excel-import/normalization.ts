/**
 * 取值与归一化（第五阶段 · 共享底座）
 *
 * 这一层是「正式导入」与「导入预览」共用的唯一实现。
 * 历史教训：曾经两套实现各自演化，预览漏掉了「离职名册交叉比对」和
 * 「合并单元格防护」，导致 Diff 把 171 名离职员工误判成在职、把分节标题读成假员工。
 * 只要存在两份实现就一定会漂移 —— 所以归一化必须只有这一份。
 */
import type { Cell, CellValue, Worksheet } from "exceljs";
import type { FieldKind } from "./types";
import { SPEC_BY_FIELD } from "./field-mapping";

// ------------------------------------------------------------
// 单元格读取
// ------------------------------------------------------------

/**
 * 合并单元格安全读取。
 *
 * ExcelJS 会把「合并主格」的值回传给区域内**每一格**，于是
 * 「南昌3店」「运营部」这类整行合并的分节标题会被读成
 * 姓名=门店=身份证=「南昌3店」的假员工。
 * 判据：非主格的合并单元格一律视为空。
 */
export function isSlaveMergedCell(cell: Cell): boolean {
  try {
    const m = cell.master as unknown as { address?: string } | undefined;
    if (cell.isMerged && m?.address && m.address !== cell.address) return true;
  } catch {
    /* 某些版本没有 master，按普通单元格处理 */
  }
  return false;
}

/** 从工作表安全取单元格（从属合并格返回 null） */
export function cellSafe(ws: Worksheet, row: number, col: number): CellValue {
  const c = ws.getCell(row, col);
  return isSlaveMergedCell(c) ? null : c.value;
}

/** 把 Date 转成 yyyy-MM-dd（统一按 UTC 取值，避免时区串日） */
export function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 单元格 → 字符串。
 * 关键：数字超过 JS 安全整数时标记精度风险；日期统一 yyyy-MM-dd；去全角空格。
 */
export function readCellValue(
  v: CellValue,
  displayText?: string,
  onPrecisionRisk?: (raw: string, value: unknown) => void
): string | null {
  if (v === null || v === undefined) return null;

  // 公式单元格：取计算结果
  if (typeof v === "object" && !(v instanceof Date) && "result" in v) {
    const r = (v as { result?: unknown }).result;
    if (r === null || r === undefined) return null;
    if (r instanceof Date) return isoDate(r);
    if (typeof r === "object") return null; // #N/A 等错误值
    return String(r).replace(/\u3000/g, " ").trim() || null;
  }
  // 富文本
  if (typeof v === "object" && !(v instanceof Date) && "richText" in v) {
    const t = (v as { richText?: { text: string }[] })
      .richText?.map((p) => p.text)
      .join("");
    return (t ?? "").replace(/\u3000/g, " ").trim() || null;
  }
  // 超链接
  if (typeof v === "object" && !(v instanceof Date) && "text" in v) {
    const t = String((v as { text?: unknown }).text ?? "");
    return t.replace(/\u3000/g, " ").trim() || null;
  }

  if (v instanceof Date) return isoDate(v);

  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) && Number.isInteger(v)) {
      onPrecisionRisk?.(String(v), v);
    }
    // 优先使用 Excel 显示文本，避免 6.2E+18 这种科学计数法
    if (displayText && displayText.trim() && !/[eE][+-]?\d+$/.test(displayText.trim())) {
      return displayText.replace(/\u3000/g, " ").trim();
    }
    // Excel 日期序列（1900 日期系统）：约 20000~60000 对应 1954~2064
    if (Number.isSafeInteger(v) && v > 20000 && v < 80000) {
      return isoDate(new Date(Date.UTC(1899, 11, 30) + v * 86400000));
    }
    return String(v);
  }

  const s = String(v).replace(/\u3000/g, " ").trim();
  return s === "" ? null : s;
}

// ------------------------------------------------------------
// 身份证 / 手机 / 银行卡
// ------------------------------------------------------------

/** 身份证：去分隔符，末位 X 大写（不校验长度，长度问题另行标记） */
export function normalizeIdCard(v: string | null): string | null {
  if (!v) return null;
  const d = v.replace(/[^\dXx]/g, "").toUpperCase();
  return d === "" ? null : d;
}

/** 只保留数字（手机号 / 银行卡） */
export function digitsOnly(v: string | null): string | null {
  if (!v) return null;
  const d = v.replace(/[^\d]/g, "");
  return d === "" ? null : d;
}

export const RE_ID18 = /^\d{17}[\dX]$/;
const RE_MOBILE = /^1\d{10}$/;
const RE_BCARD = /^\d{12,19}$/;

export function looksIdCard(v: string | null): boolean {
  return !!v && RE_ID18.test(v);
}
export function looksMobile(v: string | null): boolean {
  return !!v && RE_MOBILE.test(digitsOnly(v) ?? "");
}
export function looksBankCard(v: string | null): boolean {
  return !!v && RE_BCARD.test(digitsOnly(v) ?? "");
}
export function looksBankName(v: string | null): boolean {
  if (!v) return false;
  return /银行|支行|储蓄|信用社|信用合作|农信|农商|邮储|分理处/.test(v);
}

/** GB 11643-1999 校验位，仅用于标记，不用于丢弃数据 */
export function isValidIdChecksum(id: string | null): boolean {
  if (!id || !RE_ID18.test(id)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  let s = 0;
  for (let i = 0; i < 17; i++) s += Number(id[i]) * w[i];
  return c[s % 11] === id[17];
}

export function genderFromIdCard(id: string | null): string | null {
  if (!id || id.length !== 18) return null;
  const n = Number(id[16]);
  if (!Number.isFinite(n)) return null;
  return n % 2 === 1 ? "男" : "女";
}

// ------------------------------------------------------------
// 日期
// ------------------------------------------------------------

/** 构造纯日期（UTC 零点），非法返回 null */
export function safeDate(y: number, mo: number, d: number): Date | null {
  if (!Number.isFinite(y) || y < 1900 || y > 2200) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return dt;
}

/** 解析多种写法的日期 → yyyy-MM-dd */
export function parseDateIso(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m: RegExpExecArray | null;

  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return isoOf(safeDate(Number(m[1]), Number(m[2]), Number(m[3])));

  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (m) return isoOf(safeDate(Number(m[1]), Number(m[2]), Number(m[3])));

  m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return isoOf(safeDate(Number(m[1]), Number(m[2]), 1));

  // 文本中夹带日期的情况（如「2023-05-01离职」）
  m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return isoOf(safeDate(Number(m[1]), Number(m[2]), Number(m[3])));

  return null;
}

function isoOf(d: Date | null): string | null {
  return d ? isoDate(d) : null;
}

/** ISO 日期字符串 → Date（UTC 零点），与库内存储口径一致 */
export function dateFromIso(iso: string | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return safeDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

// ------------------------------------------------------------
// 离职语义
// ------------------------------------------------------------

/**
 * 文本是否表达「已离职」。
 * 注意「重新入职 / 又入职 / 回归 / 再入职」**不算**离职 ——
 * 那是一段新的任职，误判会丢掉在职员工。
 */
export function textMeansResigned(raw: string | null): {
  yes: boolean;
  rehire: boolean;
} {
  if (!raw) return { yes: false, rehire: false };
  const rehire = /重新入职|又入职|回归|再入职/.test(raw);
  if (rehire) return { yes: false, rehire: true };
  if (/离职|辞职|自离|已离|被辞|劝退|开除/.test(raw)) return { yes: true, rehire: false };
  return { yes: false, rehire: false };
}

// ------------------------------------------------------------
// Diff 比较用归一化
// ------------------------------------------------------------

/**
 * 比较前的归一化：库里的值与 Excel 解析值必须走同一套清洗，
 * 否则「大小写 / 分隔符 / 空格」会制造大量假差异。
 *
 * 注意：这里归一化的结果**就是写库的值**（与正式导入完全一致），
 * 脱敏只在展示层发生。
 */
export function normalizeForCompare(field: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const kind: FieldKind = SPEC_BY_FIELD.get(field)?.kind ?? "text";
  let s: string;
  if (v instanceof Date) s = isoDate(v);
  else s = String(v);
  s = s.trim();
  if (s === "") return null;

  switch (kind) {
    case "idcard":
      return normalizeIdCard(s);
    case "digits":
      return digitsOnly(s);
    case "date":
      return parseDateIso(s) ?? s.slice(0, 10);
    case "int": {
      const n = Number(s.replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? String(Math.trunc(n)) : s;
    }
    default:
      return s;
  }
}
