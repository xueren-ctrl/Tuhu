import { prisma } from "./prisma";
import { addNaturalMonths } from "./tenure";

/**
 * 门店人员流失率（Stage 9.18）
 *
 * 复刻 Excel「人员流失率」Sheet（2026 年门店考核指标数据）。
 * 列与 Excel 第 3 行严格一致：
 *   序号 | 门店名称 | 店长 | 技术店长 | 副店长 | 实时人数 | 当月离职 | 当月入职 | 流失率 | 邀约数量
 *
 * ── 计算口径（原表旁边的文字说明，用户 2026-11-24 确认，以此为准）────
 *   流失率     =（当月离职人数 − 当月入职人数）/ 月初人数
 *   当月离职   = 当月离职 **且离职时入职满 3 个月**（离职日 − 入职日 ≥ 3 个自然月）
 *   当月入职   = 当月入职（入职日期落在当月）
 *   月初人数   = 月初在职人数：入职日期 < 月初，且无离职日期或离职日期 ≥ 月初。
 *                ⚠️ **不要求入职满 3 个月**（旧版要求，2026-11-24 已改）。
 *                分母是**月初人数**，不是原表公式用的实时人数。
 *   门店归属   = **现门店**（Employee.storeId）。调店（A→B）归属 B 店、
 *                入职日期不变，既不算 A 店的离职，也不算 B 店的入职 ——
 *                按现门店 + 入职/离职日期算，自然就对了，不用特殊处理。
 *   店长名     = 按现门店的在职人员填（jobGradeRaw 原文匹配，与编制/分布一致）：
 *                店长 ← {店长, 代理店长}；技术店长 ← 技术店长；副店长 ← 副店长。
 *                同店同工种多人时取入职最早者。
 *   门店名单   = 指标计划 ∪ 有在职/离职员工的门店（计划表 AttritionIndicator
 *                从未导入过，0 行，不能只靠它 —— 与编制/分布同一修法）。
 * ────────────────────────────────────────────────────────────────
 *
 * ⚠️ 与原表公式的两处**有意**差异（均为按文字定义修正，非 bug）：
 *
 * 1. **分母用月初人数，不用实时人数**。原表公式 `(G-H)/F` 的 F 是实时人数，
 *    文字说明写的是月初人数 —— 以文字为准。
 *
 * 2. **离职的「满 3 个月」按离职日算**（离职日 − 入职日 ≥ 3 个自然月），
 *    不按月初算。原表公式靠解析文本列「在职年限」取月份数，对离职表里
 *    未算出的行会返回空、IFERROR 兜底成 0 → 这些人被漏掉；库里存的是
 *    真实 hireDate/resignDate，直接用自然月加法更准、更可测。
 *    自然月加法复用 `lib/tenure.ts` 的 `addNaturalMonths`（与「满 2 个月」口径同源）。
 *
 * 3. **门店按当前 `storeId` 统计，而非门店名字符串、也非任职历史**。
 *    Excel 公式里给每家店手写了一个别名分支（如 `离职!$B:$B="常平朗贝社区"`），
 *    因为 Excel 的门店名字符串不统一；库里 `storeId` 已把别名归一。
 *    调店按现门店计（用户确认），所以不需要 `storesOfManyAt` 任职历史。
 *
 * 「邀约数量」= 招聘面试登记表里，**面试时间落在当月、招聘人是该店店长**的记录数。
 *   ⚠️ 店长/技术店长/副店长三列取自**现门店在职员工的工种**（见上），不是
 *      指标计划表的手填姓名 —— 计划表是空的，从员工推导是唯一来源。
 *      （旧版注：李正秋库里工种是「店长」，原表流失率记的是「副店长」；
 *       用户 2026-11-24 确认按现门店在职人员填，即按库里工种为准。）
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
  /** 月初人数：入职日期 < 月初，且无离职日期或离职日期 ≥ 月初（按现门店计，不要求满 3 个月） */
  monthStartHeadcount: number;
  /** 当月离职（离职日期落在当月，且离职时入职满 3 个自然月） */
  monthResigned: number;
  /** 当月入职 */
  monthHired: number;
  /** 流失率 =（当月离职 − 当月入职）/ 月初人数；月初人数为 0 时为 null */
  rate: number | null;
  /** 邀约数量：当月面试且招聘人 = 本行 managerName */
  invites: number;
  /**
   * 月初人数的来源（2026-11-24 起恒为 COMPUTED）：
   *   旧版用 AttritionBaseline 人工快照覆盖月初人数（Stage 9.22），因为旧口径
   *   （1 号在职且入职满 3 个月、只算 ACTIVE）会漏掉 269 条「标记离职却没有
   *   离职日期」的历史档案，2026-09 少算约 35 人。
   *   新口径（入职日期 < 月初，且无离职日期或离职日期 ≥ 月初，不要求满 3 个月）
   *   本身就把这批人计入了，快照不再需要 —— 字段保留仅为兼容，不再有 SNAPSHOT。
   */
  headcountSource: "SNAPSHOT" | "COMPUTED";
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
  /** 该月月初人数是否用了人工快照 —— 2026-11-24 起恒为 false（口径修正后不再用快照，见 headcountSource） */
  usesSnapshot: boolean;
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

/** 当前月份（YYYY-MM）—— 导出默认用它，避免「10 月导出还是 9 月」 */
export function currentMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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

  // ① 门店名单：指标计划 ∪ 有在职/离职员工的门店（现门店归属）。
  //    指标计划表（AttritionIndicator）从未导入过（0 行），不能只靠它；
  //    没有计划的门店照常出数（与编制/分布同一修法，2026-11-24）。
  const plans = await prisma.attritionIndicator.findMany({
    orderBy: [{ sortOrder: "asc" }, { storeId: "asc" }],
    include: { store: { select: { id: true, name: true } } },
  });

  // ② 取所有在职 + 离职员工（流失率要把离职的人算进来）。
  //    门店归属 = **现门店**（storeId），调店归属新店、入职日期不变，
  //    不用任职历史（storesOfManyAt）—— 用户 2026-11-24 确认。
  const emps = await prisma.employee.findMany({
    where: { deletedAt: null, status: { in: ["ACTIVE", "RESIGNED"] }, storeId: { not: null } },
    select: {
      id: true,
      storeId: true,
      status: true,
      name: true,
      jobGradeRaw: true,
      hireDate: true,
      resignDate: true,
    },
  });

  // 店长名：按现门店的在职人员填（jobGradeRaw 原文匹配，与编制/分布一致）。
  //   店长 ← {店长, 代理店长}；技术店长 ← 技术店长；副店长 ← 副店长。
  //   同店同工种多人时取入职最早者（入职日为空的排最后），再按 id。
  const pickManager = (storeId: number, grades: string[]): string | null => {
    const cands = emps
      .filter(
        (e) =>
          e.storeId === storeId &&
          e.status === "ACTIVE" &&
          grades.includes(String(e.jobGradeRaw ?? "").trim())
      )
      .sort((a, b) => {
        const ha = a.hireDate ? a.hireDate.getTime() : Infinity;
        const hb = b.hireDate ? b.hireDate.getTime() : Infinity;
        return ha - hb || a.id - b.id;
      });
    return cands.length ? cands[0].name : null;
  };

  const planByStore = new Map(plans.map((p) => [p.storeId, p]));
  const storeIds = new Set<number>([
    ...planByStore.keys(),
    ...emps.map((e) => e.storeId!),
  ]);
  const storeNames = new Map<number, string>();
  for (const p of plans) storeNames.set(p.storeId, p.store.name);
  const missingNames = [...storeIds].filter((id) => !storeNames.has(id));
  if (missingNames.length) {
    const stores = await prisma.store.findMany({
      where: { id: { in: missingNames } },
      select: { id: true, name: true },
    });
    for (const s of stores) storeNames.set(s.id, s.name);
  }
  // 有计划的门店按计划顺序在前，其余按 storeId 排后；序号按最终顺序 1..N 重排。
  const orderedStoreIds = [...storeIds].sort((a, b) => {
    const pa = planByStore.get(a);
    const pb = planByStore.get(b);
    if (pa && pb) return pa.sortOrder - pb.sortOrder || a - b;
    if (pa) return -1;
    if (pb) return 1;
    return a - b;
  });

  // ③ 邀约数量：当月面试记录，按招聘人（管理者姓名）分组
  const invites = await getInvitesByRecruiter(start, end);

  // ④ 逐店计算（有副店长的门店会产出 2 行）
  const rows: AttritionRow[] = [];
  orderedStoreIds.forEach((storeId, idx) => {
    const list = emps.filter((e) => e.storeId === storeId);

    // 月初人数：入职日期 < 月初，且无离职日期或离职日期 ≥ 月初。
    // ⚠️ 不要求入职满 3 个月（旧版要求，2026-11-24 按文字定义改掉）。
    //    269 条「标记离职却没有离职日期」的历史档案也按此计入（无离职日期
    //    即视为月初仍在职）—— 这正是旧版快照（AttritionBaseline）要补的
    //    35 人缺口来源；口径修正后公式本身就对了，不再用快照覆盖。
    let monthStartHeadcount = 0;
    // 当月离职：离职日期落在当月，且离职时入职满 3 个自然月
    //   （离职日 − 入职日 ≥ 3 个自然月，按离职日算，不按月初算）
    let monthResigned = 0;
    // 当月入职：入职日期落在当月
    let monthHired = 0;

    for (const e of list) {
      const hd = e.hireDate ? e.hireDate.getTime() : null;
      const rd = e.resignDate ? e.resignDate.getTime() : null;

      if (hd !== null && hd < start.getTime() && (rd === null || rd >= start.getTime())) {
        monthStartHeadcount++;
      }

      if (rd !== null && rd >= start.getTime() && rd < end.getTime()) {
        if (e.hireDate && hiredAtLeast3MonthsAgo(e.hireDate, e.resignDate!)) {
          monthResigned++;
        }
      }

      // 当月入职：入职日期落在当月（在职离职都算，与 Excel H 列口径一致）
      if (hd !== null && hd >= start.getTime() && hd < end.getTime()) {
        monthHired++;
      }
    }

    const rate =
      monthStartHeadcount > 0 ? (monthResigned - monthHired) / monthStartHeadcount : null;
    const managers = {
      storeManager: pickManager(storeId, ["店长", "代理店长"]),
      techManager: pickManager(storeId, ["技术店长"]),
      deputyManager: pickManager(storeId, ["副店长"]),
    };
    // 店长行与副店长行共用的人数（同一门店的数据）
    const baseRow = {
      sortOrder: idx + 1,
      storeName: storeNames.get(storeId) ?? `门店${storeId}`,
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
    const inviteName = managers.storeManager ?? managers.techManager;
    // 没有店长/技术店长时，副店长占用本行（人工表：店长列空、副店长列填名字）
    const soleDeputy = !inviteName && managers.deputyManager ? managers.deputyManager : null;
    const inviteFor = inviteName ?? soleDeputy;
    rows.push({
      ...baseRow,
      role: soleDeputy ? "DEPUTY_MANAGER" : "STORE_MANAGER",
      managerName: inviteFor,
      invites: inviteFor ? invites.get(inviteFor) ?? 0 : 0,
      headcountSource: "COMPUTED",
    });

    // 该店有副店长 **且已有店长/技术店长** → 才追加一行（人数/流失率相同，只换邀约数量）。
    // ⚠️ 没有店长的门店，副店长就填在本行里（人工表就是这么记的：
    //    店长列空、副店长列填名字，不另起一行）。实测「大朗富华中路店」属于这种。
    if (managers.deputyManager && inviteName) {
      rows.push({
        ...baseRow,
        role: "DEPUTY_MANAGER",
        managerName: managers.deputyManager,
        invites: invites.get(managers.deputyManager) ?? 0,
        headcountSource: "COMPUTED",
      });
    }
  });

  // ⑤ 汇总
  // ⚠️ 副店长行的人数/流失率与店长行**完全相同**（同一个门店的数据），
  //    汇总时**只能算一次**，否则总人数翻倍、整体流失率算错。
  //    邀约数量则两条都要计（两个管理者各招各的）。
  //    ⚠️ 2026-11-24 修：按门店去重（取每店第一行），不要只按 STORE_MANAGER 过滤 ——
  //    只有副店长的门店（soleDeputy）只有一行 DEPUTY_MANAGER，按角色过滤会
  //    漏掉整家店（实测 2026-09：深圳茜坑天虹店 11 人 + 1 名离职被漏掉）。
  const seenStores = new Set<string>();
  const storeRows = rows.filter((r) => {
    if (seenStores.has(r.storeName)) return false;
    seenStores.add(r.storeName);
    return true;
  });
  const monthStartTotal = storeRows.reduce((s, r) => s + r.monthStartHeadcount, 0);
  const resignedTotal = storeRows.reduce((s, r) => s + r.monthResigned, 0);
  const hiredTotal = storeRows.reduce((s, r) => s + r.monthHired, 0);
  const invitesTotal = rows.reduce((s, r) => s + r.invites, 0);
  const withRate = storeRows
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
      usesSnapshot: false,
      topWorst: withRate
        .slice(0, 3)
        .map((r) => ({ storeName: r.storeName, rate: r.rate! })),
      topBest: withRate
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
