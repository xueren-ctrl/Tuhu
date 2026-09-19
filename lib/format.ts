/**
 * 通用格式化 / 规范化工具
 */

/**
 * Date -> yyyy-MM-dd
 *
 * 「纯日期」字段（入职/离职/面试日期）统一以 UTC 零点存储，
 * 因此这里用 UTC 取值，保证在任何时区下都不会出现日期串日。
 * 时间戳（createdAt/updatedAt）请使用 formatDateTime。
 */
export function formatDate(v?: Date | string | null): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 时间戳 -> yyyy-MM-dd HH:mm（本地时区，用于 created/updated 等时刻） */
export function formatDateTime(v?: Date | string | null): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/** 纯日期 -> UTC 零点 Date（入库前统一转换，避免时区偏移） */
export function toDateOnly(y: number, mo: number, d: number): Date | null {
  if (!Number.isFinite(y) || y < 1900 || y > 2200) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return dt;
}

/** 文本 -> null（空串、纯空白、全角空格都视为空） */
export function toNullableText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\u3000/g, " ").trim();
  return s === "" ? null : s;
}

/** 文本 -> 整数（失败返回 null） */
export function toNullableInt(v: unknown): number | null {
  const s = toNullableText(v);
  if (s === null) return null;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** 手机号规范化：去掉空格、横线、括号、+86 前缀 */
export function normalizePhone(v: unknown): string | null {
  const s = toNullableText(v);
  if (s === null) return null;
  let d = s.replace(/[^\d]/g, "");
  if (d.startsWith("0086")) d = d.slice(4);
  if (d.startsWith("86") && d.length === 13) d = d.slice(2);
  return d === "" ? null : d;
}

/**
 * 身份证号规范化：
 *  - 去掉空格与不可见字符
 *  - 末位 x 统一为大写 X
 *  - 严格按字符串处理，绝不转数字（防止前导零丢失 / 科学计数法）
 */
export function normalizeIdCard(v: unknown): string | null {
  const s = toNullableText(v);
  if (s === null) return null;
  const d = s.replace(/[^\dXx]/g, "").toUpperCase();
  return d === "" ? null : d;
}

/** 银行卡号规范化：只保留数字，严格按字符串处理 */
export function normalizeBankAccount(v: unknown): string | null {
  const s = toNullableText(v);
  if (s === null) return null;
  const d = s.replace(/[^\d]/g, "");
  return d === "" ? null : d;
}

/** 数字字符串补前导零（Excel 丢失前导零时按目标长度补齐） */
export function padLeadingZero(v: unknown, width: number): string | null {
  const s = normalizeBankAccount(v);
  if (s === null) return null;
  return s.padStart(width, "0");
}

/** 由身份证号推导性别（第 17 位奇男偶女） */
export function genderFromIdCard(idCard?: string | null): string | null {
  if (!idCard) return null;
  const s = String(idCard).replace(/[^\dXx]/g, "");
  if (s.length !== 18) return null;
  const n = Number(s.charAt(16));
  if (!Number.isFinite(n)) return null;
  return n % 2 === 1 ? "男" : "女";
}

/** 由身份证号推导出生日期 yyyy-MM-dd */
export function birthDateFromIdCard(idCard?: string | null): string | null {
  if (!idCard) return null;
  const s = String(idCard).replace(/[^\dXx]/g, "");
  if (s.length !== 18) return null;
  const y = s.slice(6, 10);
  const m = s.slice(10, 12);
  const d = s.slice(12, 14);
  const date = new Date(`${y}-${m}-${d}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return `${y}-${m}-${d}`;
}

/**
 * 身份证号 18 位校验（GB 11643-1999 加权因子校验位）。
 * 注意：仅做「格式 + 校验位」校验，不作为主键，不因此丢弃原始数据。
 */
export function isValidIdCard18(v?: string | null): boolean {
  if (!v) return false;
  const s = String(v).replace(/[^\dXx]/g, "").toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * weights[i];
  return checks[sum % 11] === s[17];
}

/** 手机号粗校验：11 位且以 1 开头 */
export function looksLikeMobile(v?: string | null): boolean {
  if (!v) return false;
  const s = String(v).replace(/[^\d]/g, "");
  return /^1\d{10}$/.test(s);
}

/** 银行卡号粗校验：12~19 位纯数字 */
export function looksLikeBankCard(v?: string | null): boolean {
  if (!v) return false;
  const s = String(v).replace(/[^\d]/g, "");
  return /^\d{12,19}$/.test(s);
}

/** 文本是否像身份证号（17位数字+数字/X） */
export function looksLikeIdCard(v?: string | null): boolean {
  if (!v) return false;
  const s = String(v).replace(/[^\dXx]/g, "").toUpperCase();
  return /^\d{17}[\dX]$/.test(s);
}

/** 岗位名称规范化（去首尾空格、全角空格，保留原始中文） */
export function normalizeName(v: unknown): string | null {
  const s = toNullableText(v);
  if (s === null) return null;
  return s.replace(/\s+/g, " ");
}
