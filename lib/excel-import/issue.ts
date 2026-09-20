/**
 * 解析期问题收集（第五阶段 · 共享底座）
 *
 * 原则：**绝不静默处理异常**，也**绝不把敏感信息写进异常表**。
 * 任何写入 rawValue 的值都会先过一遍脱敏。
 */
import type { IssueType, ParseIssue } from "./types";
import { SENSITIVE_FIELDS } from "./field-mapping";
import { maskByField, maskIdCard, maskPhone } from "../mask";

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  MISSING_ID: "身份证缺失",
  INVALID_ID: "身份证异常",
  FIELD_MISPLACED: "列错位已归位",
  INVALID_DATE: "日期无法解析",
  EMPTY_NAME: "姓名为空",
  DUPLICATE_KEY: "重复/重新入职",
  FALLBACK_MATCH: "回退匹配",
  PRECISION_RISK: "数值精度风险",
  PRECISION_SUSPECT: "疑似精度丢失",
  STATUS_CONFLICT: "状态冲突",
  RESIGN_DATE_MISSING: "离职日期缺失",
  SOURCE_MISSING: "源数据未提供",
  OTHER: "其他",
};

/**
 * 把任意值转成**可安全落库/展示**的字符串。
 * - 字段名命中敏感集合 → 按字段脱敏；
 * - 字段不明但内容像身份证 / 手机号 → 兜底脱敏（防止写错字段名导致泄露）。
 */
export function safeRawValue(field: string | null, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let s = String(value);
  if (s === "") return null;

  if (field && SENSITIVE_FIELDS.has(field)) return String(maskByField(field, s));

  // 兜底：裸值里出现身份证/手机号形态也脱敏
  const idHit = /\d{17}[\dXx]/.exec(s);
  if (idHit) s = s.replace(/\d{17}[\dXx]/g, (m) => String(maskIdCard(m)));
  const phoneHit = /(?<!\d)1\d{10}(?!\d)/.exec(s);
  if (phoneHit) s = s.replace(/(?<!\d)1\d{10}(?!\d)/g, (m) => String(maskPhone(m)));
  return s;
}

export class IssueCollector {
  readonly issues: ParseIssue[] = [];

  add(i: {
    row?: number | null;
    name?: string | null;
    field?: string | null;
    rawValue?: unknown;
    type: IssueType;
    severity?: "WARN" | "ERROR";
    /** 已确认安全（如只写了「有/没有」），跳过脱敏 */
    rawValueIsSafe?: boolean;
    message: string;
  }): void {
    this.issues.push({
      row: i.row ?? null,
      name: i.name ?? null,
      field: i.field ?? null,
      rawValue: i.rawValueIsSafe
        ? i.rawValue === null || i.rawValue === undefined
          ? null
          : String(i.rawValue)
        : safeRawValue(i.field ?? null, i.rawValue ?? null),
      type: i.type,
      severity: i.severity ?? "WARN",
      message: i.message,
    });
  }

  /** 合并另一个收集器（预览/导入各自聚合时用） */
  merge(other: IssueCollector | ParseIssue[]): void {
    const list = Array.isArray(other) ? other : other.issues;
    this.issues.push(...list);
  }

  countByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of this.issues) out[i.type] = (out[i.type] ?? 0) + 1;
    return out;
  }
}
