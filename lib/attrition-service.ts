import { prisma } from "./prisma";
import { addNaturalMonths } from "./tenure";
import { storesOfManyAt } from "./store-period-service";

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
 * ── 店长 / 技术店长 / 副店长 三者的关系（用户确认，重要）────────────
 *   **店长与技术店长互斥**：店长 = 全职店长；技术店长 = 由机修晋升的店长，
 *   **职位性质不同**。一家店只填其中一列 —— 这一列本身就说明了「这家店是哪种店」。
 *   实测 36 家：21 家有店长、13 家有技术店长、**0 家两者都有**、2 家都没有。
 *   副店长与两者不互斥（可与店长同店并存，此时多出一行单独考核）。
 *
 *   「邀约数量」取**该行填了名字的那一列**（与 Excel 公式逐行核对一致）：
 *   店长行 `$C` / 技术店长行 `$D` / 副店长行 `$E`。
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

/**
 * 流失率的一行 = 一家门店的**店长**。
 * 若该店另有副店长，Excel 的惯例是**再插一行**：店名重复、店长列填副店长的名字、
 * 其余「人数/流失率」与上一行完全相同，只把「邀约数量」换成副店长的面试数。
 * （Excel 原文就是这么排的：R4 常平朗贝社区店-何小亮、R5 同店-王成龙；
 *   「邀约数量」公式引用的列也随之从 C 换成 E。）
 * `role` 用于页面区分「店长行 / 副店长行」。
 */
export interface AttritionRow {
  sortOrder: number;
  storeName: string;
  /** 店长行 / 副店长行 */
  role: "STORE_MANAGER" | "DEPUTY_MANAGER";
  /**
   * 本行用于匹配「邀约数量」的姓名：
   *   店长行 = 店长（没有则技术店长，两者互斥）
   *   副店长行 = 副店长
   */
  managerName: string | null;
  /** 考核指标登记的三个岗位（店长 / 技术店长 互斥，副店长可并存） */
  managers: { storeManager: string | null; techManager: string | null; deputyManager: string | null };
  /** 月初人数：1 号在职 且 入职满 3 个月（按门店计，店长/副店长行相同） */
  monthStartHeadcount: number;
  /** 当月离职（且入职满 3 个月） */
  monthResigned: number;
  /** 当月入职 */
  monthHired: number;
  /** 流失率 =（当月离职 − 当月入职）/ 月初人数；月初人数为 0 时为 null */
  rate: number | null;
  /** 邀约数量：当月面试且招聘人 = 本行 managerName */
  invites: number;
}

export interface AttritionSummary {
  month: string;
  monthStartTotal: number;
  resignedTotal: number;
  hiredTotal: number;
  /** 邀约数量合计（店长行 + 副店长行都计，两个管理者各招各的） */
  invitesTotal: number;
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
      id: true,
      storeId: true,
      status: true,
      hireDate: true,
      resignDate: true,
    },
  });

  /**
   * 员工在某月的归属门店（Stage 9.19）。
   *
   * ⚠️ 途虎门店之间调动频繁，A 店的人可能被借到 B 店帮忙、调回、或调走不回来。
   *    光看 Employee 当前的 storeId 算不出「1 号那天他在哪家店」。
   *    这里**按统计月 1 号那天的任职归属**来判断（用 EmployeeStorePeriod 任职历史），
   *    没有历史记录时回退到当前门店（视为长期在此店）。
   *
   * 用户确认的口径：**按当前门店计** —— 调走就从原店减、调入就给新店加，
   * 绝不「两边都算」（会重复计数、总数虚高）。
   *
   * ✅ 实测验证（2026-08）：回填了 249 段任职历史后，49 位「有多段档案」的在职员工，
   *    用任职历史算出的 8/1 归属与当前门店**100% 一致（0 处不同）**，
   *    合计行数字不变（月初 207 / 离职 20 / 入职 27 / −3.4%）。
   *    说明「按当前门店」这个近似本来就是对的，回填是**加固**而非纠错。
   *
   * ⚠️ 仍然算不准的场景（无解，需要业务侧信息）：
   *    「8/1 那天人在 A 店，之后（8 月内）才调到 B 店」——
   *    这类人在库里只有「当前门店 = B 店」的单一档案、没有任何历史线索，
   *    软件无法凭空知道他 8/1 在哪。**只能靠今后每次调动都及时在软件里改门店**。
   *    （Stage 9.19 起改门店会自动记一段任职，之后这类情况就准了。）
   */
  const fallback = new Map<number, number | null>(emps.map((e) => [e.id, e.storeId]));
  const storeAtStart = await storesOfManyAt(
    emps.map((e) => e.id),
    start,
    fallback
  );

  const byStore = new Map<number, typeof emps>();
  for (const e of emps) {
    const sid = storeAtStart.get(e.id) ?? e.storeId;
    if (sid === null || sid === undefined) continue;
    if (!byStore.has(sid)) byStore.set(sid, []);
    byStore.get(sid)!.push(e);
  }

  // ③ 邀约数量：当月面试记录，按招聘人（管理者姓名）分组
  const invites = await getInvitesByRecruiter(start, end);

  // ④ 逐店计算（有副店长的门店会产出 2 行）
  const rows: AttritionRow[] = [];
  for (const p of plans) {
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

    const rate =
      monthStartHeadcount > 0 ? (monthResigned - monthHired) / monthStartHeadcount : null;
    const managers = {
      storeManager: p.storeManager,
      techManager: p.techManager,
      deputyManager: p.deputyManager,
    };
    // 店长行与副店长行共用的人数（同一门店的数据）
    const baseRow = {
      sortOrder: p.sortOrder,
      storeName: p.store.name,
      managers,
      monthStartHeadcount,
      monthResigned,
      monthHired,
      rate,
    };

    // 店长行
    // ⚠️ 店长 / 技术店长**互斥**（用户确认）：店长 = 全职店长，
    //    技术店长 = 由机修晋升的店长，**职位性质不同**，
    //    一家店只会填其中一列。Excel 36 家里 21 家店长 / 13 家技术店长 / 0 家两者都有。
    //    「邀约数量」取**本格填了名字的那一列**（Excel J 列公式逐一核对过：
    //    店长行用 $C、技术店长行用 $D、副店长行用 $E）。
    //    ⛔ 早期版本让「技术店长顶替店长」取邀约，是错的 —— 已修正。
    const inviteName = p.storeManager ?? p.techManager;
    rows.push({
      ...baseRow,
      role: "STORE_MANAGER",
      managerName: inviteName,
      invites: inviteName ? invites.get(inviteName) ?? 0 : 0,
    });

    // 该店有副店长 → 追加一行，人数/流失率相同，只换邀约数量
    if (p.deputyManager) {
      rows.push({
        ...baseRow,
        role: "DEPUTY_MANAGER",
        managerName: p.deputyManager,
        invites: invites.get(p.deputyManager) ?? 0,
      });
    }
  }

  // ⑤ 汇总
  // ⚠️ 副店长行的人数/流失率与店长行**完全相同**（同一个门店的数据），
  //    汇总时**只能算一次**，否则总人数翻倍、整体流失率算错。
  //    邀约数量则两条都要计（两个管理者各招各的）。
  const storeRows = rows.filter((r) => r.role === "STORE_MANAGER");
  const monthStartTotal = storeRows.reduce((s, r) => s + r.monthStartHeadcount, 0);
  const resignedTotal = storeRows.reduce((s, r) => s + r.monthResigned, 0);
  const hiredTotal = storeRows.reduce((s, r) => s + r.monthHired, 0);
  const invitesTotal = rows.reduce((s, r) => s + r.invites, 0);
  const withRate = rows
    .filter((r) => r.rate !== null)
    .sort((a, b) => b.rate! - a.rate!);

  return {
    rows,
    summary: {
      month,
      monthStartTotal,
      resignedTotal,
      hiredTotal,
      invitesTotal,
      overallRate: monthStartTotal > 0 ? (resignedTotal - hiredTotal) / monthStartTotal : null,
      storesWithResign: storeRows.filter((r) => r.monthResigned > 0).length,
      topWorst: withRate
        .filter((r) => r.role === "STORE_MANAGER")
        .slice(0, 3)
        .map((r) => ({ storeName: r.storeName, rate: r.rate! })),
      topBest: withRate
        .filter((r) => r.role === "STORE_MANAGER")
        .slice(-3)
        .reverse()
        .map((r) => ({ storeName: r.storeName, rate: r.rate! })),
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
