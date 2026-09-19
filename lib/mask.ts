/**
 * 敏感字段脱敏工具。
 *
 * 安全约定：
 *  - 控制台日志、列表接口默认输出脱敏值；
 *  - 绝不把完整身份证号 / 银行卡号 / 手机号写入日志或导入报告。
 */

/** 手机号：138****8888 */
export function maskPhone(v?: string | null): string {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length < 7) return "***";
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 身份证：4308**********1234 */
export function maskIdCard(v?: string | null): string {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length < 8) return "***";
  return `${s.slice(0, 4)}${"*".repeat(Math.max(0, s.length - 8))}${s.slice(-4)}`;
}

/** 银行卡：**** **** **** 1234 */
export function maskBankAccount(v?: string | null): string {
  if (!v) return "";
  const s = String(v).replace(/\s/g, "");
  if (s.length < 6) return "***";
  return `**** **** **** ${s.slice(-4)}`;
}

/** 住址：只保留前 6 个字符 */
export function maskAddress(v?: string | null): string {
  if (!v) return "";
  const s = String(v).trim();
  if (s.length <= 6) return "***";
  return `${s.slice(0, 6)}***`;
}

/** 金额/薪资文本：仅保留首字符提示存在 */
export function maskAmountText(v?: string | null): string {
  if (!v) return "";
  return "***";
}

/**
 * 按字段名自动脱敏。
 * 用于列表接口 / 日志，避免各处手写。
 */
export function maskByField(field: string, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return value;
  const s = String(value);
  switch (field) {
    case "idCardNo":
      return maskIdCard(s);
    case "phone":
    case "emergencyPhone1":
    case "emergencyPhone2":
      return maskPhone(s);
    case "bankAccountNo":
      return maskBankAccount(s);
    case "currentAddress":
      return maskAddress(s);
    case "salaryTerms":
    case "firstMonthGuarantee":
      return maskAmountText(s);
    default:
      return value;
  }
}

const SENSITIVE_SET = new Set([
  "idCardNo",
  "phone",
  "emergencyPhone1",
  "emergencyPhone2",
  "bankAccountNo",
  "currentAddress",
  "salaryTerms",
  "firstMonthGuarantee",
]);

/** 对象级脱敏：仅对敏感字段生效 */
export function maskObject<T extends object>(obj: T, fields?: string[]): T {
  const target = fields
    ? new Set(fields.filter((f) => SENSITIVE_SET.has(f)))
    : SENSITIVE_SET;
  const out = { ...obj } as Record<string, unknown>;
  for (const f of target) {
    if (f in out) out[f] = maskByField(f, out[f]);
  }
  return out as T;
}

/** 生成安全日志用摘要，绝不包含完整敏感信息 */
export function safeLogObject<T extends object>(obj: T): string {
  const masked = maskObject(obj);
  return JSON.stringify(masked);
}
