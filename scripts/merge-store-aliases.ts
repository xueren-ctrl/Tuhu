/**
 * 合并「基名 / 基名店」同名门店（Stage 9.41，2026-10-05）
 *
 * ## 为什么需要（实测数据）
 * 候选门店范围从 39 家扩到全部 ACTIVE 后，暴露出 **15 组**疑似同名门店：
 *   「东城东宝路」(#340, 在职0/历史50)‖「东城东宝路店」(#341, 在职8/历史22/有编制/有考核)
 *   「塘厦林村新阳」(#360, 在职0/历史65) ‖「塘厦林村新阳路店」(#361, 在职12/历史22/有编制/有考核)
 *   …… 共 15 组，模式高度一致：**带「店」字的那家有在职员工 + 有编制 + 有考核**，
 *   不带「店」字的在职 0、但历史离职员工很多。
 *
 * 这是 Excel 里同一家店两种写法造成的历史遗留（与之前已合并的
 * 「东城景湖春天」→「东城景湖春天店」同一类问题）。
 * ⚠️ 不处理的话，新增员工时下拉里会出现两个只差一个「店」字的选项，**极易选错**
 *   → 新人归属错店 → 编制表/流失率/人员分布全错。
 *
 * ## 合并规则（每组）
 *   · 主店 = **在职人数多的那家**（即带「店」字的）；平手时取历史总人数多的
 *   · 被合并店 = 另一家 → 员工 storeId 全部改到主店、门店置 INACTIVE、
 *     旧名登记为 `StoreAlias`（历史写法不丢）
 *   · **完全复用 `lib/store-merge-service.ts`**（preview → snapshot → 事务内 apply，
 *     含EmployeeHistory / AuditLog / StoreAlias），与你在「门店管理」页面点完全等价
 *
 * ## 用法
 *   npx tsx scripts/merge-store-aliases.mts            # 只预览，不写库（默认）
 *   npx tsx scripts/merge-store-aliases.mts --apply    # 真执行
 *
 * ⚠️ 执行前请先 `npm run backup`。
 */
import { prisma } from "../lib/prisma";
import { previewStoreMerge, mergeStores } from "../lib/store-merge-service";

const APPLY = process.argv.includes("--apply");
const OPERATOR = "9.41-别名门店合并";

/** 一组疑似同名门店 */
interface Pair {
  main: { id: number; name: string };
  dup: { id: number; name: string };
  mainActive: number;
  dupActive: number;
  mainHistory: number;
  dupHistory: number;
}

async function findPairs(): Promise<Pair[]> {
  const stores = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const emp = await prisma.employee.groupBy({
    by: ["storeId", "status"],
    where: { storeId: { not: null }, deletedAt: null },
    _count: { _all: true },
  });
  const act = new Map<number, number>();
  const hist = new Map<number, number>();
  for (const e of emp) {
    const id = e.storeId as number;
    if (e.status === "ACTIVE") act.set(id, (act.get(id) ?? 0) + e._count._all);
    hist.set(id, (hist.get(id) ?? 0) + e._count._all);
  }

  const pairs: Pair[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const a = stores[i];
      const b = stores[j];
      if (a.name === b.name) continue;
      /**
       * 匹配规则：**一方名字是另一方的前缀**（覆盖全部历史写法）
       *   「塘厦林村新阳」/「塘厦林村新阳路店」  ← 中间多了「路」，不是「+店」
       *   「南昌三店西」  /「南昌三店西路店」    ← 同理
       *   「惠州水云居」  /「惠州水云居店」      ← 标准的「+店」
       * 只按「+店」会漏掉前两种（Stage 9.41 实测漏了 2 组）。
       */
      const isPrefixPair = b.name.startsWith(a.name) || a.name.startsWith(b.name);
      if (!isPrefixPair) continue;
      if (seen.has(a.id) || seen.has(b.id)) continue;
      seen.add(a.id);
      seen.add(b.id);

      const aAct = act.get(a.id) ?? 0;
      const bAct = act.get(b.id) ?? 0;
      const aHist = hist.get(a.id) ?? 0;
      const bHist = hist.get(b.id) ?? 0;
      /**
       * 主店打分（**按优先级从高到低**，全部用整数避免浮点误差）：
       *   ① 在职人数多者为主店        ×1e12
       *   ② **名字更长者为主店**      ×1e6   ← 「惠州水云居」vs「惠州水云居店」两家人职都是 0，
       *      历史人数 32 vs 7，若按历史决胜会选「水云居」→ 门店正名丢掉「店」字（实测踩过）
       *   ③ 历史人数多者            ×1e3
       *   ④ id 小者（保证幂等）      ×1
       */
      const score = (active: number, nameLen: number, history: number, id: number) =>
        active * 1e12 + nameLen * 1e6 + history * 1e3 + (100000 - Math.min(id, 99999));
      const aIsMain = score(aAct, a.name.length, aHist, a.id) >= score(bAct, b.name.length, bHist, b.id);
      const main = aIsMain ? a : b;
      const dup = aIsMain ? b : a;
      pairs.push({
        main: { id: main.id, name: main.name },
        dup: { id: dup.id, name: dup.name },
        mainActive: aIsMain ? aAct : bAct,
        dupActive: aIsMain ? bAct : aAct,
        mainHistory: aIsMain ? aHist : bHist,
        dupHistory: aIsMain ? bHist : aHist,
      });
    }
  }
  return pairs;
}

async function main() {
  console.log(APPLY ? "=== 真执行模式（会写库）===" : "=== 预览模式（不写库，加 --apply 才执行）===\n");

  const pairs = await findPairs();
  if (pairs.length === 0) {
    console.log("没有需要合并的同名门店。");
    return;
  }

  console.log(`发现 ${pairs.length} 组「基名 / 基名店」同名门店：\n`);

  // 逐组预览（走真实预览接口；服务端会校验是否属于同一候选簇）
  let previewOk = 0;
  let totalMoved = 0;
  for (const pair of pairs) {
    try {
      const pv = await previewStoreMerge({
        mainStoreId: pair.main.id,
        mergeStoreIds: [pair.dup.id],
      });
      previewOk++;
      totalMoved += pv.preview.moveCount;
      console.log(
        `✅ ${pair.dup.name} (#${pair.dup.id}) → ${pair.main.name} (#${pair.main.id})` +
          `   迁移 ${pv.preview.moveCount} 人` +
          `（主店在职 ${pair.mainActive} + 被并店历史 ${pair.dupHistory} → 合并后在职 ${pv.preview.mainTotalAfter}）；` +
          `登记别名「${pv.preview.aliasesToCreate.join("、")}」`
      );
    } catch (e) {
      console.log(`⚠️  ${pair.dup.name} → ${pair.main.name}：${(e as Error).message}（跳过）`);
    }
  }

  console.log(`\n可执行 ${previewOk} 组，合计迁移 ${totalMoved} 人（全部会留 EmployeeHistory 与 AuditLog 记录）。`);

  if (!APPLY) {
    console.log("\n-- 这是预览，未写任何数据。确认无误后加 --apply 执行。");
    return;
  }

  /**
 * 执行阶段：**每组独立走「预览 → 立即执行」**（不能先全预览再全执行）。
 *
 * ⚠️ 实测踩坑（2026-10-05）：先预览 15 组再逐组执行时，
 *    第 1 组合并成功后 **dbVersion 变了**（别名数 1→2、历史数 2043→2093），
 *    后面 14 组全部撞 `STALE_MERGE_PREVIEW`（快照过期）→ 只完成 1/15。
 *    这正是快照机制该有的保护（防止用旧数字改数据），不是bug。
 * → 所以每组「预览完立刻执行」，让快照永远是最新的。
 */
  let ok = 0;
  for (const pair of pairs) {
    try {
      // ① 现预览（拿到当下最新的 snapshot）
      const pv = await previewStoreMerge({
        mainStoreId: pair.main.id,
        mergeStoreIds: [pair.dup.id],
      });
      // ② 立即执行，绝不隔组复用快照
      const r = await mergeStores({
        mainStoreId: pair.main.id,
        mergeStoreIds: [pair.dup.id],
        snapshot: pv.snapshot,
        operator: OPERATOR,
      });
      console.log(
        `✅ ${pair.dup.name} → ${pair.main.name}：迁移 ${r.employeesMoved} 人` +
          `，别名 ${r.aliasesCreated} 条，门店置 INACTIVE ${r.storesDeactivated} 家` +
          `，合并后在职 ${r.mainTotalAfter} 人`
      );
      ok++;
    } catch (e) {
      console.log(`❌ ${pair.dup.name} → ${pair.main.name} 失败：${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log(`\n完成 ${ok}/${pairs.length} 组。`);

  // 复核
  const left = await findPairs();
  console.log(`\n复核：剩余同名组 ${left.length}${left.length ? "（" + left.map((p) => `${p.dup.name}/${p.main.name}`).join("、") + "）" : " ✅"}`);
  const activeN = await prisma.store.count({ where: { status: "ACTIVE" } });
  console.log(`ACTIVE 门店数：${activeN}`);
}

main()
  .catch((e) => {
    console.error("失败：", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());