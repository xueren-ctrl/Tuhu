/**
 * 门店服务（第三阶段新增）
 *
 * 职责：
 * 1. 门店列表（含员工数 / 在职数 / 离职数 / 别名）
 * 2. 门店别名（StoreAlias）的增删与「统一归属」
 *
 * 核心约定 —— **不复制员工数据**：
 * 别名表只存「别名字符串 + 指向标准门店的外键」。
 * 新增别名时，把「门店原文列 storeNameRaw 等于该别名」的员工重新挂到标准门店，
 * **只改 storeId 这一个外键**，storeNameRaw 原文一律保留，随时可追溯。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { DEFAULT_OPERATOR, recordEmployeeHistory } from "./history-service";
import { EMPLOYEE_STATUS } from "./constants";

/**
 * Stage 7.1.3：门店别名统一归属的事务被整体回滚时抛出（API 层映射 409 ALIAS_BATCH_ABORTED）。
 * 语义：别名创建 / 员工重挂 / 变更历史 / 批次审计 全部未保留任何改动（0 残留、0 半成功）。
 */
export class StoreAliasAbortedError extends Error {
  constructor(detail: string) {
    super("门店别名统一归属已整体回滚（别名 / 员工 / 历史 / 审计均未保留任何改动）：" + detail);
    this.name = "StoreAliasAbortedError";
  }
}

/**
 * Stage 7.1.4：addStoreAlias 事务内二次验证发现标准门店已停用（ACTIVE → INACTIVE 竞态）
 * 时抛出（API 层映射 409 STORE_NOT_ACTIVE）。整个事务零写入。
 */
export class StoreNotActiveError extends Error {
  constructor(detail: string) {
    super("标准门店状态已变化（已停用），别名操作被拒绝：" + detail);
    this.name = "StoreNotActiveError";
  }
}

/**
 * Stage 7.1.4：removeStoreAlias 的「删除别名 + 审计」事务被整体回滚时抛出
 * （API 层映射 409 ALIAS_DELETE_ABORTED）：别名未删、审计未落，零残留。
 */
export class StoreAliasDeleteAbortedError extends Error {
  constructor(detail: string) {
    super("删除门店别名已整体回滚（别名 / 审计均未保留任何改动）：" + detail);
    this.name = "StoreAliasDeleteAbortedError";
  }
}

export interface StoreAliasRow {
  id: number;
  alias: string;
  note: string | null;
  createdAt: string;
}

export interface StoreWithCounts {
  id: number;
  name: string;
  code: string | null;
  region: string | null;
  address: string | null;
  plannedHeadcount: number | null;
  status: string;
  aliasCount: number;
  total: number;
  active: number;
  resigned: number;
  /** 未挂到本门店、但门店原文列写成了本门店某个别名的员工数（理论上应为 0） */
  aliases: StoreAliasRow[];
}

/**
 * 门店列表 + 实时人数统计
 * 全部由 Employee 表按 storeId 聚合得出，不落任何统计表。
 */
export async function listStoresWithCounts(opts: { includeInactive?: boolean } = {}) {
  const stores = await prisma.store.findMany({
    where: opts.includeInactive ? {} : { status: "ACTIVE" },
    orderBy: { name: "asc" },
    include: {
      aliases: { orderBy: { alias: "asc" } },
      _count: { select: { employees: true } },
    },
  });

  // 一次分组查询拿到全部在职/离职分布，避免 N+1
  const grouped = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const stat = new Map<number, { active: number; resigned: number }>();
  for (const g of grouped) {
    if (g.storeId === null) continue;
    const cur = stat.get(g.storeId) ?? { active: 0, resigned: 0 };
    if (g.status === EMPLOYEE_STATUS.ACTIVE) cur.active += g._count._all;
    else if (g.status === EMPLOYEE_STATUS.RESIGNED) cur.resigned += g._count._all;
    stat.set(g.storeId, cur);
  }

  return stores.map<StoreWithCounts>((s) => {
    const c = stat.get(s.id) ?? { active: 0, resigned: 0 };
    return {
      id: s.id,
      name: s.name,
      code: s.code,
      region: s.region,
      address: s.address,
      plannedHeadcount: s.plannedHeadcount,
      status: s.status,
      total: s._count.employees,
      active: c.active,
      resigned: c.resigned,
      aliasCount: s.aliases.length,
      aliases: s.aliases.map((a) => ({
        id: a.id,
        alias: a.alias,
        note: a.note,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });
}

/**
 * 门店名称解析：先按标准名精确匹配，再按别名匹配。
 * 供导入脚本 / 各处在「只拿到一个名称字符串」时统一归属。
 */
export async function resolveStoreByName(
  name: string
): Promise<{ storeId: number; storeName: string; matchedBy: "name" | "alias" } | null> {
  const n = name?.trim();
  if (!n) return null;

  const byName = await prisma.store.findUnique({ where: { name: n } });
  if (byName) return { storeId: byName.id, storeName: byName.name, matchedBy: "name" };

  const byAlias = await prisma.storeAlias.findUnique({
    where: { alias: n },
    include: { store: true },
  });
  if (byAlias) {
    return { storeId: byAlias.store.id, storeName: byAlias.store.name, matchedBy: "alias" };
  }
  return null;
}

/** 某门店的全部可识别名称（标准名 + 全部别名） */
export async function listStoreAllNames(storeId: number): Promise<string[]> {
  const s = await prisma.store.findUnique({
    where: { id: storeId },
    include: { aliases: { select: { alias: true } } },
  });
  if (!s) return [];
  return [s.name, ...s.aliases.map((a) => a.alias)];
}

/**
 * 把「门店原文列等于这些名称」的员工统一挂到标准门店。
 * 只更新 storeId 外键；storeNameRaw 保留原文（可追溯）。
 * 每条变更都写 EmployeeHistory，来源标记为 BATCH_UPDATE。
 *
 * Stage 7.1.3：支持外部事务（opts.tx）—— 门店别名统一归属（addStoreAlias）把
 * 「创建别名 + 员工重挂 + 变更历史 + 批次审计」全部包进一个 prisma.$transaction，
 * 任一步失败整体回滚，绝不留下：
 *   - 孤儿 StoreAlias（别名建了但员工没迁完）
 *   - 部分员工被改挂、部分没改（半套 storeId）
 *   - 半套 EmployeeHistory
 *   - 记了「成功」的批次 AuditLog
 * @param tx 可选：外部事务客户端（addStoreAlias 传入）。不传则本函数自开事务。
 *
 * Stage 7.1.4（P1）：当传入 tx 时，**targets 查询也通过 tx 执行**（事务内读），
 * 绝不用事务外提前查询出的 targets 作为最终写入依据 —— 堵住
 * 「查询 targets → 事务写入」之间员工被并发修改的竞态窗口。
 */
export async function repointEmployeesByName(
  storeId: number,
  names: string[],
  operator = DEFAULT_OPERATOR,
  tx?: Prisma.TransactionClient
): Promise<{ scanned: number; repointed: number; batchKey: string | null }> {
  const candidates = names.map((n) => n.trim()).filter(Boolean);
  if (!candidates.length) return { scanned: 0, repointed: 0, batchKey: null };

  // 事务内执行「查 targets + 逐个重挂 + 历史 + 批次审计」
  const runInTx = async (t: Prisma.TransactionClient) => {
    // Stage 7.1.4：targets 查询走 tx（t.employee…）
    //
    // ⚠️ 这里必须显式包含 storeId 为 null 的行。
    // Prisma 的 `NOT: { storeId: x }` 会翻译成 `NOT (storeId = x)`，
    // 而 SQL 里 `NULL = x` 结果是 NULL、`NOT NULL` 仍是 NULL → 整行被排除。
    // 也就是说：门店为空（尚未归属）的员工会被静默漏掉 —— 而这恰恰是别名
    // 功能最需要处理的那批人。因此用 OR 显式覆盖 null。
    const targets = await t.employee.findMany({
      where: {
        deletedAt: null,
        storeNameRaw: { in: candidates },
        OR: [{ storeId: null }, { storeId: { not: storeId } }],
      },
      select: { id: true, employeeId: true, storeId: true, storeNameRaw: true },
    });
    if (!targets.length) return { scanned: 0, repointed: 0, batchKey: null as string | null };

    const batchKey = `alias-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let repointed = 0;
    for (const tg of targets) {
      await t.employee.update({ where: { id: tg.id }, data: { storeId } });
      await recordEmployeeHistory({
        employeeId: tg.id,
        employeeCode: tg.employeeId,
        source: "BATCH_UPDATE",
        batchKey,
        operator,
        changes: [{ field: "storeId", oldValue: tg.storeId, newValue: storeId }],
        tx: t,
      });
      repointed++;
    }
    // 批次审计（Stage 7.1.3：与业务修改同事务，失败整体回滚，不留「改了没审计」）
    await t.auditLog.create({
      data: {
        actor: operator,
        action: "BATCH_UPDATE",
        entity: "Store",
        entityId: String(storeId),
        summary: `门店别名统一归属：${candidates.join("、")} → 重挂 ${repointed} 人`,
        detail: JSON.stringify({
          batchKey,
          type: "store-alias",
          storeId,
          names: candidates,
          repointed,
          at: new Date().toISOString(),
        }),
      },
    });
    return { scanned: targets.length, repointed, batchKey };
  };

  if (tx) {
    return await runInTx(tx);
  }
  return await prisma.$transaction(async (t) => runInTx(t));
}

/**
 * 新增别名并立即统一归属
 *
 * Stage 7.1.3 全批事务：「创建别名 + 员工重挂 + 变更历史 + 批次审计」
 * 全部包进同一个 prisma.$transaction。任一步失败 → 整体回滚。
 * 预检（门店存在 / 别名重名 / 与标准名相同）仍在事务外做（只读、快速失败），
 * 但事务内会对别名唯一性再查一次（防 TOCTOU：预检与写入之间他人建了同别名）。
 *
 * Stage 7.1.4（P1 + ACTIVE 二次验证）：
 *   1. 事务内再查 Store 存在
 *   2. 事务内验证 Store.status === ACTIVE（已停用 → StoreNotActiveError → 409 STORE_NOT_ACTIVE，零写入）
 *   3. 事务内再查 Alias 唯一（TOCTOU）
 *   4. 创建 StoreAlias
 *   5. targets 查询在 tx 内执行（repointEmployeesByName 传入 tx）
 *   6. 更新 Employee / 7. 写 EmployeeHistory / 8. 写批次 AuditLog（同事务）
 */
export async function addStoreAlias(opts: {
  storeId: number;
  alias: string;
  note?: string | null;
  operator?: string;
}) {
  const alias = opts.alias?.trim();
  if (!alias) throw new Error("别名不能为空");

  // ---- 事务外快速预检（只读，失败立即抛出，不进事务）----
  const store = await prisma.store.findUnique({ where: { id: opts.storeId } });
  if (!store) throw new Error("门店不存在");
  if (alias === store.name) throw new Error("别名不能与门店标准名称相同");

  const dup = await prisma.storeAlias.findUnique({
    where: { alias },
    include: { store: { select: { name: true } } },
  });
  if (dup) {
    throw new Error(
      dup.storeId === opts.storeId
        ? "该别名已属于本门店"
        : `该别名已属于门店「${dup.store.name}」，一个别名只能归属一家门店`
    );
  }

  const operator = opts.operator ?? DEFAULT_OPERATOR;
  const note = opts.note?.trim() || null;

  // ---- 全批事务：别名创建 + 员工重挂 + 历史 + 审计 原子（Stage 7.1.3 / 7.1.4）----
  try {
    const result = await prisma.$transaction(async (tx) => {
      // ① 事务内再查 Store 存在 + ② ACTIVE 二次验证（Stage 7.1.4）
      const storeInTx = await tx.store.findUnique({
        where: { id: opts.storeId },
        select: { id: true, name: true, status: true },
      });
      if (!storeInTx) throw new Error("门店不存在（写入前一刻已被删除）");
      if (storeInTx.status !== "ACTIVE") {
        throw new StoreNotActiveError(`门店「${storeInTx.name}」当前状态为 ${storeInTx.status}`);
      }
      // ③ 事务内再查别名唯一（防预检与写入之间被他人抢先创建）
      const dupInTx = await tx.storeAlias.findUnique({ where: { alias } });
      if (dupInTx) {
        throw new Error("该别名已存在（创建前一刻被占用），请更换别名");
      }
      // ④ 创建 StoreAlias
      const created = await tx.storeAlias.create({
        data: { storeId: opts.storeId, alias, note },
      });
      // ⑤⑥⑦⑧ 立即统一归属（targets 查询在 tx 内；员工重挂 + 历史 + 批次审计）
      const applied = await repointEmployeesByName(opts.storeId, [alias], operator, tx);

      return { alias: created, applied };
    });
    return result;
  } catch (err) {
    // StoreNotActiveError 原样抛出（409 STORE_NOT_ACTIVE，事务零写入）
    if (err instanceof StoreNotActiveError) throw err;
    // 事务已整体回滚（别名 / 员工 / 历史 / 审计 全部未保留任何改动，0 残留）
    if (err instanceof Error && !(err instanceof StoreAliasAbortedError)) {
      throw new StoreAliasAbortedError(err.message);
    }
    throw err;
  }
}

/**
 * 删除别名（已挂到标准门店的员工不动，保持现状）
 *
 * Stage 7.1.4（P0）：「查询删除前信息 → 删除别名 → 写 AuditLog(DELETE/StoreAlias)」
 * 三个步骤在同一 prisma.$transaction 内完成。任一步失败（含触发器强制
 * AuditLog 写入失败）→ 别名删除整体回滚，审计不留残留（0 半成功）。
 * 员工当前 storeId 不做任何改变。
 */
export async function removeStoreAlias(aliasId: number, operator = DEFAULT_OPERATOR) {
  try {
    const row = await prisma.$transaction(async (tx) => {
      // ① 查询删除前信息（同事务内读取）
      const found = await tx.storeAlias.findUnique({
        where: { id: aliasId },
        select: { id: true, alias: true, storeId: true, note: true },
      });
      if (!found) throw new Error("别名不存在");
      // ② 删除别名（员工 storeId 不动）
      await tx.storeAlias.delete({ where: { id: aliasId } });
      // ③ 审计（actor = Session 操作人；detail 含 aliasId / alias / storeId / note，无敏感数据）
      await tx.auditLog.create({
        data: {
          actor: operator,
          action: "DELETE",
          entity: "StoreAlias",
          entityId: String(aliasId),
          summary: `删除门店别名「${found.alias}」`,
          detail: JSON.stringify({
            aliasId: found.id,
            alias: found.alias,
            storeId: found.storeId,
            note: found.note,
          }),
        },
      });
      return found;
    });
    return row;
  } catch (err) {
    if (err instanceof Error && err.message === "别名不存在") throw err;
    // 事务已整体回滚（别名未删、审计未落，零残留）
    if (err instanceof Error && !(err instanceof StoreAliasDeleteAbortedError)) {
      throw new StoreAliasDeleteAbortedError(err.message);
    }
    throw err;
  }
}

export interface AliasCandidate {
  /** 建议保留为标准名的门店 */
  standardId: number;
  standardName: string;
  standardActive: number;
  standardTotal: number;
  /** 建议登记为别名的门店（登记后其员工会统一归属到标准名） */
  aliasId: number;
  aliasName: string;
  aliasActive: number;
  aliasTotal: number;
  reason: string;
}

/**
 * 门店别名候选：**门店名之间两两比对**，找出疑似同一家店的两种写法。
 *
 * 只做只读检测与提示，**绝不自动合并** —— 合并属业务判断。
 *
 * 判据（任一命中即列为候选）：
 *  A. 两个名称相差一个「店」字（如「XX路」/「XX路店」）
 *  B. 一方是另一方的名称前缀，且长度差 ≤ 3
 *
 * 「谁做标准名」的建议：取在职人数更多的那个（实测规律是带「店」后缀的多为在职，
 * 无后缀的几乎全是离职，即后者是历史写法）。
 */
export async function findAliasCandidates(): Promise<AliasCandidate[]> {
  // Stage 7.1.1：候选检测只针对 ACTIVE 门店 —— 已合并停用（INACTIVE）的旧门店
  // 不再进入新的自动候选，避免「已合并门店被重新推荐为待合并」。
  const stores = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
  });
  const grouped = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const stat = new Map<number, { active: number; total: number }>();
  for (const g of grouped) {
    if (g.storeId === null) continue;
    const cur = stat.get(g.storeId) ?? { active: 0, total: 0 };
    cur.total += g._count._all;
    if (g.status === EMPLOYEE_STATUS.ACTIVE) cur.active += g._count._all;
    stat.set(g.storeId, cur);
  }

  const out: AliasCandidate[] = [];
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const a = stores[i];
      const b = stores[j];
      let reason: string | null = null;

      if (a.name.replace(/店$/, "") === b.name.replace(/店$/, "")) {
        reason = "仅相差一个「店」字";
      } else if (
        (a.name.startsWith(b.name) || b.name.startsWith(a.name)) &&
        Math.abs(a.name.length - b.name.length) <= 3
      ) {
        reason = "一方是另一方的名称前缀";
      }
      if (!reason) continue;

      const sa = stat.get(a.id) ?? { active: 0, total: 0 };
      const sb = stat.get(b.id) ?? { active: 0, total: 0 };
      // 在职人数多的做标准名；相等时取总人数多的
      const standard = sa.active >= sb.active ? a : b;
      const alias = standard.id === a.id ? b : a;
      const ss = standard.id === a.id ? sa : sb;
      const as = standard.id === a.id ? sb : sa;

      out.push({
        standardId: standard.id,
        standardName: standard.name,
        standardActive: ss.active,
        standardTotal: ss.total,
        aliasId: alias.id,
        aliasName: alias.name,
        aliasActive: as.active,
        aliasTotal: as.total,
        reason,
      });
    }
  }
  return out.sort((x, y) => y.aliasTotal - x.aliasTotal);
}
