/**
 * 计算字段（第六阶段：计算字段与原始字段重新分类；Stage 6.1：满2个月口径修正）
 *
 * 业务约定（见阶段六规格书第十节 + Stage 6.1 规格书第一/二/三节）：
 * - `hireDate` / `resignDate` 是**原始业务字段**（数据库按项目约定存 UTC 零点），
 *   一切时长相关结论只从它们实时推算。
 * - `computed7Days` / `computed2Months` / `tenureTextAtImport` / `resignedTenureText`
 *   只是「导入时 Excel 里的公式计算快照」，保留仅为历史兼容，**绝不作为任何判定依据**。
 *
 * 「入职满2个月」业务口径（Stage 6.1 确认）：
 *   **不是 60 天**，而是「入职日期 + 2 个自然月」：
 *     - 2026-01-10 入职 → 2026-03-10 满 2 个月
 *     - 2026-01-31 入职 → 2026-03-31 满 2 个月
 *     - 目标月份没有对应日期时，落到目标月份最后一天
 *       （例：2025-12-31 + 2 个月 → 2026-02-28，因 2026 年 2 月无 31 日）。
 *   判断逻辑：today 的日历日 >= hireDate + 2 个自然月，**绝不使用 days >= 60 / 61 近似**。
 *
 * 日期规范（与「纯日期字段存 UTC 零点」约定一致）：
 * - "YYYY-MM-DD" 字符串**严格校验日历合法性**（如 "2026-02-29" 非闰年 → 非法，
 *   绝不让 JS 静默滚成 2026-03-01）；
 * - 内部统一用「日历日键」Date.UTC(年, 月, 日) 做逐日比较，与时区无关：
 *     · 精确 UTC 零点 Date（DB 值 / ISO "…Z" 解析）→ 取 UTC 分量；
 *     · 其余 Date（本地零点 / 当前时间）→ 取本地分量；
 *     · "YYYY-MM-DD" 字符串 → 直接按该日历日。
 * - 非法日期（"not-a-date"、"2026-13-45"、"2026-02-29"）会让
 *   getTwoMonthDate / hasCompletedTwoMonths / computeTenure **抛错**，不静默产生错误结果；
 * - 唯一允许的 null 语义：hireDate 为 null / undefined / 空串（无入职日）→ 返回 null（未知）。
 *
 * 本模块提供纯函数，可在 Server Component 与 Client Component 中安全复用，
 * 也不依赖任何服务端资源。
 */

const DAY_MS = 86_400_000;

/** 严格校验 "YYYY-MM-DD" 是否为合法日历日期；合法返回 {y, mo, d}，否则 null */
function parseStrictDate(v: string): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // 该月最后一天
  if (d < 1 || d > lastDay) return null; // 例如 2026-02-29 → 非法
  return { y, mo, d };
}

/**
 * 输入 → UTC 零点 Date（仅对合法 "YYYY-MM-DD" 与 Date 有效）。
 * - 合法 "YYYY-MM-DD" 字符串 → 该日 UTC 零点；
 * - Date 对象 → 原样（NaN → null）；
 * - 空 → null；
 * - **其余非法字符串（"2026-02-29"、"not-a-date"）→ 抛错**（不静默）。
 */
function toDate(v: string | Date | null | undefined, ctx: string): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const strict = parseStrictDate(v);
    if (strict) return new Date(Date.UTC(strict.y, strict.mo - 1, strict.d));
    throw new Error(`${ctx}: 非法日期 "${v}"（不允许静默产生错误结果）`);
  }
  throw new Error(`${ctx}: 非法日期 "${String(v)}"`);
}

/** 日历日键 Date.UTC(年,月,日)：
 *  精确 UTC 零点 Date（DB 值 / "…Z"）→ UTC 分量；否则 → 本地分量。 */
function dayKey(d: Date): number {
  if (d.getTime() % DAY_MS === 0) {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 日历日键（输入可为 "YYYY-MM-DD" 字符串或 Date） */
function inputKey(v: string | Date): number {
  if (typeof v === "string") {
    const s = parseStrictDate(v);
    if (!s) throw new Error(`非法日期 "${v}"（不允许静默产生错误结果）`);
    return Date.UTC(s.y, s.mo - 1, s.d);
  }
  return dayKey(v);
}

/**
 * 自然月加法：日历日 d（+ n 个月），目标月没有对应日时落到目标月最后一天。
 * 结果保持与输入相同的「零点语义」（UTC 零点进 → UTC 零点出；本地零点进 → 本地零点出）。
 */
export function addNaturalMonths(d: Date, n: number): Date {
  const y = d.getTime() % DAY_MS === 0 ? d.getUTCFullYear() : d.getFullYear();
  const m = d.getTime() % DAY_MS === 0 ? d.getUTCMonth() : d.getMonth();
  const day = d.getTime() % DAY_MS === 0 ? d.getUTCDate() : d.getDate();
  const idx = m + n;
  const targetYear = y + Math.floor(idx / 12);
  const targetMonth = ((idx % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const dd = Math.min(day, lastDay);
  return d.getTime() % DAY_MS === 0
    ? new Date(Date.UTC(targetYear, targetMonth, dd))
    : new Date(targetYear, targetMonth, dd);
}

/**
 * 满 2 个月日期 = 入职日期 + 2 个自然月。
 * hireDate 为 null / 空 → null；非法日期 → 抛错。
 */
export function getTwoMonthDate(hireDate: Date | string | null | undefined): Date | null {
  const h = toDate(hireDate, "getTwoMonthDate");
  if (!h) return null;
  return addNaturalMonths(h, 2);
}

/**
 * 是否入职满 2 个月：today 的日历日 >= (hireDate + 2 个自然月)。
 *
 * 返回：
 *   - true / false：判断结果；
 *   - null：hireDate 为 null / undefined / 空（无入职日，无法判断）。
 * 非法日期（"2026-02-29"、"not-a-date" 等）→ **抛错**，绝不静默产生错误结果。
 *
 * @param hireDate 入职日期（"YYYY-MM-DD" / Date；数据库值即 UTC 零点 Date）
 * @param today    判断基准日（"YYYY-MM-DD" / Date；可注入，便于测试；默认今天）
 */
export function hasCompletedTwoMonths(
  hireDate: Date | string | null | undefined,
  today: Date | string = new Date()
): boolean | null {
  if (hireDate === null || hireDate === undefined || hireDate === "") return null;
  const h = toDate(hireDate, "hasCompletedTwoMonths");
  if (!h) return null;
  const twoMonthKey = dayKey(addNaturalMonths(h, 2));
  return inputKey(today) >= twoMonthKey;
}

export interface TenureInfo {
  hireDate: Date | null;
  resignDate: Date | null;
  /** 计算参考日：离职员工取离职日期，在职员工取当前时间 */
  reference: Date;
  /** 在职天数（参考日 − 入职日，毫秒差向下取整），无入职日则为 null */
  days: number | null;
  /** 在职年限文本，如「3.2 年」/「120 天」/「—」 */
  tenureText: string;
  /** 是否满 7 天（在职日 ≥ 7） */
  past7Days: boolean | null;
  /** 是否入职满 2 个月（自然月口径：参考日 >= 入职日 + 2 个自然月；缺入职日为 null） */
  past2Months: boolean | null;
  /** 满 2 个月的具体日期（入职日 + 2 自然月，月末落到目标月最后一天；缺入职日为 null） */
  twoMonthDate: Date | null;
  /** 是否在职（无离职日） */
  active: boolean;
}

/**
 * 从原始入职 / 离职日实时推算任职时长相关结论（不写库、纯展示与判定依据）。
 * @param hireDate   入职日期（字符串或 Date，UTC 零点存储亦可）
 * @param resignDate 离职日期（可选；提供则视为已离职）
 * @param now        参考当前时间（可注入，便于测试）
 *
 * 注意：非空但非法的日期会**抛错**，不静默产生错误结果。
 */
export function computeTenure(
  hireDate: string | Date | null | undefined,
  resignDate?: string | Date | null | undefined,
  now: Date = new Date()
): TenureInfo {
  const h = toDate(hireDate, "computeTenure(hireDate)");
  const r = toDate(resignDate, "computeTenure(resignDate)");
  const active = !r;
  const reference = r ?? now;

  let days: number | null = null;
  if (h) {
    days = Math.floor((reference.getTime() - h.getTime()) / DAY_MS);
  }

  const years = days === null ? null : days / 365.25;
  const tenureText =
    days === null
      ? "—"
      : years !== null && years >= 1
        ? `${years.toFixed(1)} 年`
        : `${days} 天`;

  const past7Days = days === null ? null : days >= 7;
  // Stage 6.1 口径修正：满 2 个月 = 自然月加法（参考日历日 >= 入职日 + 2 个自然月），
  // 不再用 days >= 60 近似。twoMonthDate 与 past2Months 同源，保证展示与判定一致。
  const twoMonthDate = h ? getTwoMonthDate(h) : null;
  const past2Months =
    twoMonthDate === null
      ? null
      : dayKey(reference) >= dayKey(twoMonthDate);

  return {
    hireDate: h,
    resignDate: r,
    reference,
    days,
    tenureText,
    past7Days,
    past2Months,
    twoMonthDate,
    active,
  };
}

/** 把布尔结果渲染成中文（null → 未知，即缺少入职日期） */
export function renderBool(v: boolean | null): string {
  if (v === null) return "未知（缺入职日期）";
  return v ? "是" : "否";
}

/** 把 Date 渲染成 YYYY-MM-DD（与 dayKey 同一套语义：UTC 零点 Date 用 UTC 分量，否则本地分量） */
export function renderDate(d: Date | null): string {
  if (!d) return "—";
  const y = d.getTime() % DAY_MS === 0 ? d.getUTCFullYear() : d.getFullYear();
  const m = d.getTime() % DAY_MS === 0 ? d.getUTCMonth() + 1 : d.getMonth() + 1;
  const dd = d.getTime() % DAY_MS === 0 ? d.getUTCDate() : d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
