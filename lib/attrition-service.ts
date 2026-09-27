import { prisma } from "./prisma";
import { addNaturalMonths } from "./tenure";

/**
 * 门店人员流失率（Stage 9.18）
 *
 * 复刻 Excel「人员流失率」Sheet（2026 年门店考核指标数据）。
 * 列与 Excel 第 3 行严格一致：
 *   序号 | 门店名称 | 店长 | 技术店长 | 副店长 | 实时人数 | 当月离职 | 当月入职 | 流失率 | 邀约数量
 *
 * ── 计算口径（用户公式，与 Excel 公式逐条对齐）────────────────────────
 *   流失率     =（当月离职人数 − 当月入职人数）/ 月初人数
 *   当月离职   = 当月离职 **且入职满 3 个月**
 *   当月入职   = 当月入职
 *   月初人数   = 1 号在职人数 **且入职时间满 3 个月**
 * ────────────────────────────────────────────────────────────────
 *
 * ⚠️ 与 Excel 的两处**有意**差异（均为改进，非 bug）：
 *
 * 1. **「入职满 3 个月」改用真实日期判定**（Excel 靠解析文本列「在职年限」如「3年2个月」取月份数）。
 *    Excel 那个文本列对**离职表里未算出的行会返回空**，IFERROR 兜底成 0 → 这些人被漏掉。
 *    库里存的是真实 hireDate，直接 `入职日 + 3 自然月 ≤ 月初` 更准、更可测。
 *    自然月加法复用 `lib/tenure.ts` 的 `addNaturalMonths`（与「满 2 个月」口径同源）。
 *
 * 2. **门店按 `storeId` 统计，而非门店名字符串**。
 *    Excel 公式里给每家店手写了一个别名分支（如 `离职!$B:$B="常平朗贝社区"`），
 *    因为 Excel 的门店名字符串不统一（「常平朗贝社区店」/「常平朗贝社区」两个写法）。
 *    库里 `storeId` 已把别名归一，且 `StoreAlias` 可追溯 —— 按 id 统计天然覆盖这些别名。
 *
 * 「邀约数量」= 招聘面试登记表里，**面试时间落在当月、招聘人是该店店长**的记录数。
 *   ⚠️ 店长/技术店长/副店长三列取自 Excel C/D/E 列的**手填姓名**（考核指标的口径），
 *      不是从员工档案实时查的 —— 所以这三列不落库，导入一次即可。
 */

/** 统计月（月初，UTC 零点），如 2026-08-01 */
export interface MonthParam {
  /** 统计月，格式 YYYY-MM */
  month: string;
}

export interface AttritionRow {
  sortOrder: number;
  storeName: string;
  /** 考核指标里的店长/技术店长/副店长姓名（Excel 手填，导入时存） */
  managers: { storeManager: string | null; techManager: string | null; deputyManager: string | null };
  /** 月初人数：1 号在职 且 入职满 3 个月 */
  monthStartHeadcount: number;
  /** 当月离职（且入职满 3 个月） */
  monthResigned: number;
  /** 当月入职 */
  monthHired: number;
  /** 流失率 =（当月离职 − 当月入职）/ 月初人数；月初人数为 0 时为 null */
  rate: number | null;
  /** 邀约数量：当月面试且招聘人为该店店长 */
  invites: number;
}

export interface AttritionSummary {
  month: string;
  monthStartTotal: number;
  resignedTotal: number;
  hiredTotal: number;
  /** 全公司流失率 =（合计离职 − 合计入职）/ 合计月初人数 */
  overallRate: number | null;
  storesWithResign: number;
  /** 流失率最高的三家 */
  topWorst: { storeName: string; rate: number }[];
  /** 流失率最低的三家（有负值的=净流入） */
  topBest: { storeName: string; rate: number }[];
}

/** 解析 YYYY-MM → {start, end}（end = 下个月 1 号，左闭右开） */
export function parseMonth(month: string): { start: Date; end: Date; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? "").trim());
  if (!m) throw new Error("月份格式应为 YYYY-MM，收到：" + month);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error("月份应在 1~12 之间，收到：" + month);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end = new Date(Date.UTC(y, mo, 1));
  return { start, end, label: `${y}年${mo}月` };
}

/** 默认统计月 = 上一个自然月（本月还没过完，统计了也不准） */
export function defaultMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 入职是否满 3 个自然月（截至 asOf） */
function hiredAtLeast3MonthsAgo(hireDate: Date | null, asOf: Date): boolean {
  if (!hireDate) return false;
  // 3 个月 = 满一个季度，用自然月加法（1/31 + 3 月 = 4/30，与项目既有口径一致）
  const three = addNaturalMonths(hireDate, 3);
  return three.getTime() <= asOf.getTime();
}

/** 生成可选月份列表（含当月往前 24 个月） */
export function monthOptions(now = new Date()): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i <= 23; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ value, label: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月` });
  }
  return out;
}

export async function getAttrition({ month }: MonthParam): Promise<{
  rows: AttritionRow[];
  summary: AttritionSummary;
  monthList: { value: string; label: string }[];
}> {
  const { start, end } = parseMonth(month);

  // ① 门店 + 考核指标里的三个管理岗姓名
  const plans = await prisma.attritionIndicator.findMany({
    orderBy: [{ sortOrder: "asc" }, { storeId: "asc" }],
    include: { store: { select: { id: true, name: true } } },
  });

  // ② 取所有在职 + 离职员工（流失率要把离职的人算进来）
  const emps = await prisma.employee.findMany({
    where: { deletedAt: null, status: { in: ["ACTIVE", "RESIGNED"] }, storeId: { not: null } },
    select: {
      storeId: true,
      status: true,
      hireDate: true,
      resignDate: true,
    },
  });

  const byStore = new Map<number, typeof emps>();
  for (const e of emps) {
    if (!byStore.has(e.storeId!)) byStore.set(e.storeId!, []);
    byStore.get(e.storeId!)!.push(e);
  }

  // ③ 邀约数量：当月面试记录，按招聘人（店长姓名）分组
  const invites = await getInvitesByRecruiter(start, end);

  // ④ 逐店计算
  const rows: AttritionRow[] = plans.map((p) => {
    const list = byStore.get(p.storeId) ?? [];

    // 月初人数：1 号在职 且 入职满 3 个月
    let monthStartHeadcount = 0;
    // 当月离职：离职日期落在当月 且 入职满 3 个月
    let monthResigned = 0;
    // 当月入职：入职日期落在当月
    let monthHired = 0;

    for (const e of list) {
      const hired3m = hiredAtLeast3MonthsAgo(e.hireDate, start);

      if (e.status === "ACTIVE") {
        // 月初仍在职：需 入职 ≤ 月初 且 入职满 3 个月
        if (e.hireDate && e.hireDate.getTime() <= start.getTime() && hired3m) monthStartHeadcount++;
      } else {
        // RESIGNED
        if (e.resignDate && e.resignDate.getTime() >= start.getTime() && e.resignDate.getTime() < end.getTime()) {
          if (hired3m) monthResigned++;
        }
      }

      // 当月入职：入职日期落在当月（在职离职都算，与 Excel H 列口径一致）
      if (e.hireDate && e.hireDate.getTime() >= start.getTime() && e.hireDate.getTime() < end.getTime()) {
        monthHired++;
      }
    }

    // 邀约：Excel J 列 = COUNTIFS(招聘面试登记表!O=店长, F=当月)
    // 店长列是手填姓名，若为空则退而用「技术店长」再试（Excel 各行取值列不同）
    const inviteKey = p.storeManager ?? p.techManager ?? p.deputyManager ?? "";
    const invitesCount = inviteKey ? invites.get(inviteKey) ?? 0 : 0;

    const rate =
      monthStartHeadcount > 0 ? (monthResigned - monthHired) / monthStartHeadcount : null;

    return {
      sortOrder: p.sortOrder,
      storeName: p.store.name,
      managers: {
        storeManager: p.storeManager,
        techManager: p.techManager,
        deputyManager: p.deputyManager,
      },
      monthStartHeadcount,
      monthResigned,
      monthHired,
      rate,
      invites: invitesCount,
    };
  });

  // ⑤ 汇总
  const monthStartTotal = rows.reduce((s, r) => s + r.monthStartHeadcount, 0);
  const resignedTotal = rows.reduce((s, r) => s + r.monthResigned, 0);
  const hiredTotal = rows.reduce((s, r) => s + r.monthHired, 0);
  const withRate = rows.filter((r) => r.rate !== null).sort((a, b) => b.rate! - a.rate!);

  return {
    rows,
    summary: {
      month,
      monthStartTotal,
      resignedTotal,
      hiredTotal,
      overallRate: monthStartTotal > 0 ? (resignedTotal - hiredTotal) / monthStartTotal : null,
      storesWithResign: rows.filter((r) => r.monthResigned > 0).length,
      topWorst: withRate.slice(0, 3).map((r) => ({ storeName: r.storeName, rate: r.rate! })),
      topBest: withRate.slice(-3).reverse().map((r) => ({ storeName: r.storeName, rate: r.rate! })),
    },
    monthList: monthOptions(),
  };
}

/**
 * 当月面试记录，按「招聘人」姓名分组计数。
 *
 * ⚠️ `SheetRow.cells` 是 JSON 字符串数组，面试时间在 Excel 的 F 列（index 5）。
 *    面试时间在导入时存成「YYYY-MM-DD」或 ISO 串 —— 这里做前缀匹配当月。
 *    招聘人在 O 列（index 14）。
 */
async function getInvitesByRecruiter(start: Date, end: Date): Promise<Map<string, number>> {
  const prefix = start.toISOString().slice(0, 7); // YYYY-MM
  const rows = await prisma.sheetRow.findMany({
    where: { sheet: "招聘面试登记表" },
    select: { cellsJson: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    const cells = safeParse(r.cellsJson);
    if (!cells) continue;
    const interviewAt = String(cells[5] ?? "").trim();
    if (!interviewAt.startsWith(prefix)) continue;
    // 防止把 2026-08 误配到 2026-08-15 之外的情况：同月即可
    if (interviewAt < start.toISOString().slice(0, 10) || interviewAt >= end.toISOString().slice(0, 10)) continue;
    const recruiter = String(cells[14] ?? "").trim();
    if (!recruiter) continue;
    map.set(recruiter, (map.get(recruiter) ?? 0) + 1);
  }
  return map;
}

function safeParse(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? "" : String(x)));
  if (typeof v !== "string") return null;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map((x) => (x === null || x === undefined ? "" : String(x))) : null;
  } catch {
    return null;
  }
}
