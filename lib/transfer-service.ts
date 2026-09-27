import { prisma } from "./prisma";

/**
 * 调店记录（Stage 9.26）
 *
 * 回答一个业务问题：**谁、哪天、从哪家店调到了哪家店、谁操作的。**
 *
 * ── 数据来源：`EmployeeHistory` 中 `fieldName === "storeId"` 的行 ──────────
 * 每次改门店（单个编辑 / 批量编辑）都会自动写一条，**实时**。
 *
 * ⚠️ 值有两种形态（读历史数据时必须都认）：
 *   1. **门店 ID**（现行）：`oldValue`/`newValue` 存 Store.id → 解析成店名
 *   2. **店名文本**（早期版本）：直接存「东城东宝路店」这种字符串
 *      实测 14 个唯一值里 **13 个本身就是可读的店名**，可直接展示；
 *      另有 `"NULL"` / `"其他"` 两个特殊值，按文本原样显示。
 *   → 所以**先试 ID 解析，失败就当文本用**，绝不显示成「未知」或空。
 *
 * ⚠️ 数据来源要如实区分（页面会标注，不要让用户误以为是真实调店）：
 *   · `UPDATE` / `BATCH_UPDATE` 且操作人是真实用户 = **真实调店**
 *   · 操作人含「临时验收账号」「测试」「Stage 7.3.x」= **测试或治理过程产生的记录**
 *   本页把两者都列出来（历史事实不能删），但用标签明确区分。
 */

export interface TransferRecord {
  id: number;
  employeeId: number;
  /** 员工姓名（软删的也尽量取到） */
  employeeName: string;
  employeeCode: string | null;
  /** 调出门店；null = 未挂门店 */
  fromStore: string | null;
  /** 调入门店；null = 移出门店（变成未分配） */
  toStore: string | null;
  operatedAt: Date;
  operator: string;
  source: string;
  /** 这条记录是不是「测试/治理噪音」 */
  isNoise: boolean;
  /** 批次归组（同一次批量操作的多条记录共享），可据此折叠 */
  batchKey: string | null;
}

export interface TransferSummary {
  total: number;
  /** 涉及员工数 */
  employeeCount: number;
  /** 真实调店（非测试/治理）条数 */
  realCount: number;
  noiseCount: number;
  /** 按操作人分组统计 */
  byOperator: { operator: string; count: number }[];
  /** 门店之间调动最频繁的组合 Top 5 */
  topRoutes: { from: string; to: string; count: number }[];
  /** 有进（从"未挂门店"调入）的员工数 */
  assignedIn: number;
  /** 有出（调出后未挂门店）的员工数 */
  assignedOut: number;
}

/**
 * 判断是不是测试 / 治理过程产生的噪音。
 *
 * 判定依据只有一条：**操作人是不是「系统/脚本/测试」性质**。
 * 系统内置管理员账号 `admin` / `hr` 不算噪音（那是真人账号）。
 */
function isNoiseOperator(operator: string): boolean {
  const s = operator.toLowerCase().trim();
  // 系统内置真人账号 —— 绝不判为噪音
  if (s === "admin" || s === "hr") return false;
  return (
    s.startsWith("测试") ||
    s.includes("测试") ||
    s.includes("临时") ||
    s.includes("临时验收") ||
    s.includes("stage") ||
    s === "system"
  );
}

/**
 * 读调店记录。
 * @param limit 返回条数上限（默认 200）
 * @param keyword 按员工姓名/工号模糊过滤
 * @param storeKeyword 按门店名过滤（命中「调出」或「调入」任一侧）
 * @param onlyReal true = 只看真实调店（过滤测试/治理）
 */
export async function getTransfers({
  limit = 200,
  keyword,
  storeKeyword,
  onlyReal = false,
}: {
  limit?: number;
  keyword?: string;
  storeKeyword?: string;
  onlyReal?: boolean;
} = {}): Promise<{ records: TransferRecord[]; summary: TransferSummary; allCount: number }> {
  // ① 取全部 storeId 变更（116 条量级，一次取完再在内存里解析/过滤/排序）
  const rows = await prisma.employeeHistory.findMany({
    where: { fieldName: "storeId" },
    orderBy: { operatedAt: "desc" },
    include: {
      employee: {
        select: { id: true, name: true, employeeId: true, deletedAt: true },
      },
    },
  });

  // ② 门店 ID → 店名
  const stores = await prisma.store.findMany({ select: { id: true, name: true } });
  const nameById = new Map(stores.map((s) => [s.id, s.name]));

  /**
   * 把 oldValue/newValue 解析成店名。
   * 先试 ID；不是有效 ID 就**当店名文本原样用**（早期版本存过店名）。
   */
  const resolve = (v: string | null): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === "" || s === "null" || s === "NULL") return null;
    if (/^\d+$/.test(s)) {
      const byId = nameById.get(Number(s));
      if (byId) return byId;
      // 数字但查不到（门店被删）→ 显示成「门店 #id」而不是丢掉
      return `门店 #${s}`;
    }
    // 非数字：当成早期版本存的店名文本
    return s;
  };

  // ③ 解析
  const all: TransferRecord[] = rows.map((r) => {
    const operator = r.operator || "未知";
    return {
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.employee?.name ?? `（员工已删除 #${r.employeeId}）`,
      employeeCode: r.employee?.employeeId ?? r.employeeCode,
      fromStore: resolve(r.oldValue),
      toStore: resolve(r.newValue),
      operatedAt: r.operatedAt,
      operator,
      source: r.source,
      isNoise: isNoiseOperator(operator),
      batchKey: r.batchKey,
    };
  });

  // ④ 汇总（基于「全量」而非过滤后的结果，统计口径才稳定）
  const byOperator = new Map<string, number>();
  for (const r of all) byOperator.set(r.operator, (byOperator.get(r.operator) ?? 0) + 1);
  const route = new Map<string, { from: string; to: string; count: number }>();
  for (const r of all) {
    if (!r.fromStore && !r.toStore) continue;
    const k = `${r.fromStore ?? "（未挂门店）"}→${r.toStore ?? "（未挂门店）"}`;
    if (!route.has(k)) route.set(k, { from: r.fromStore ?? "（未挂门店）", to: r.toStore ?? "（未挂门店）", count: 0 });
    route.get(k)!.count++;
  }
  const summary: TransferSummary = {
    total: all.length,
    employeeCount: new Set(all.map((r) => r.employeeId)).size,
    realCount: all.filter((r) => !r.isNoise).length,
    noiseCount: all.filter((r) => r.isNoise).length,
    byOperator: [...byOperator.entries()]
      .map(([operator, count]) => ({ operator, count }))
      .sort((a, b) => b.count - a.count),
    topRoutes: [...route.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    assignedIn: all.filter((r) => !r.fromStore && r.toStore).length,
    assignedOut: all.filter((r) => r.fromStore && !r.toStore).length,
  };

  // ⑤ 过滤
  let filtered = all;
  const kw = (keyword ?? "").trim();
  if (kw) {
    filtered = filtered.filter(
      (r) => r.employeeName.includes(kw) || (r.employeeCode ?? "").includes(kw)
    );
  }
  const sk = (storeKeyword ?? "").trim();
  if (sk) {
    filtered = filtered.filter(
      (r) => (r.fromStore ?? "").includes(sk) || (r.toStore ?? "").includes(sk)
    );
  }
  if (onlyReal) filtered = filtered.filter((r) => !r.isNoise);

  return {
    records: filtered.slice(0, limit),
    summary,
    allCount: all.length,
  };
}
