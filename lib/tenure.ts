/**
 * 计算字段（第六阶段：计算字段与原始字段重新分类）
 *
 * 业务约定（见阶段六规格书第十节）：
 * - `hireDate` / `resignDate` 是**原始业务字段**，一切时长相关结论只从它们实时推算。
 * - `computed7Days` / `computed2Months` / `tenureTextAtImport` / `resignedTenureText`
 *   只是「导入时 Excel 里的公式计算快照」，保留仅为历史兼容，**绝不作为任何判定依据**。
 *
 * 本模块提供纯函数，从 hireDate / resignDate 实时计算：
 *   在职年限、是否满 7 天、是否入职满 2 个月。
 * 不依赖任何服务端资源，可在 Server Component 与 Client Component 中安全复用。
 */

export interface TenureInfo {
  hireDate: Date | null;
  resignDate: Date | null;
  /** 计算参考日：离职员工取离职日期，在职员工取当前时间 */
  reference: Date;
  /** 在职天数（参考日 − 入职日），无入职日则为 null */
  days: number | null;
  /** 在职年限文本，如「3.2 年」/「120 天」/「—」 */
  tenureText: string;
  /** 是否满 7 天（在职日 ≥ 7） */
  past7Days: boolean | null;
  /** 是否入职满 2 个月（约 60 天） */
  past2Months: boolean | null;
  /** 是否在职（无离职日） */
  active: boolean;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 从原始入职 / 离职日实时推算任职时长相关结论。
 * @param hireDate   入职日期（字符串或 Date，UTC 零点存储亦可）
 * @param resignDate 离职日期（可选；提供则视为已离职）
 * @param now        参考当前时间（可注入，便于测试）
 */
export function computeTenure(
  hireDate: string | Date | null | undefined,
  resignDate?: string | Date | null | undefined,
  now: Date = new Date()
): TenureInfo {
  const h = toDate(hireDate);
  const r = toDate(resignDate);
  const active = !r;
  const reference = r ?? now;

  let days: number | null = null;
  if (h) {
    days = Math.floor((reference.getTime() - h.getTime()) / 86_400_000);
  }

  const years = days === null ? null : days / 365.25;
  const tenureText =
    days === null
      ? "—"
      : years !== null && years >= 1
        ? `${years.toFixed(1)} 年`
        : `${days} 天`;

  const past7Days = days === null ? null : days >= 7;
  const past2Months = days === null ? null : days >= 60;

  return { hireDate: h, resignDate: r, reference, days, tenureText, past7Days, past2Months, active };
}

/** 把布尔结果渲染成中文（null → 未知，即缺少入职日期） */
export function renderBool(v: boolean | null): string {
  if (v === null) return "未知（缺入职日期）";
  return v ? "是" : "否";
}
