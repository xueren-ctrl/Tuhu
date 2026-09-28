/**
 * Stage 9.31 —— 一次性数据订正（用户 2026-09-28 明确指令）
 *
 * 背景（全部经审计/只读查证）：
 *   1. 「东城景湖春天」(#342) 与「东城景湖春天店」(#343) 是同一家店的两条记录。
 *      用户确认：#342 后期已统一改名为「东城景湖春天店」→ 应并入 #343。
 *      #342：在职 1（龚峰）+ 离职 27，无编制；#343：在职 8 + 已面试 4 + 离职 6，有编制。
 *   2. 龚峰 THHR2026000002 的 Excel 原文是「塘厦林村新阳路店」(#361)，
 *      但本人 2026-09-27 22:28/22:39 两次操作把门店改到了 #359、#342。
 *      用户确认：**最终应挂 #361 塘厦林村新阳路店**。
 *
 * 执行顺序（先人后店，避免合并把刚改好的龚峰又带走）：
 *   ① 龚峰 #342 → #361（写 EmployeeHistory + AuditLog）
 *   ② 合并门店 #342 → #343（复用 store-merge-service 的事务 + 审计 + 别名 + 停用）
 *
 * ⚠️ 安全约定（遵循项目铁律）：
 *   默认**只读预览**；必须显式 `--apply` 才写库。
 *   写前打印将要改动的员工名单，写后打印结果。
 *
 * 用法：
 *   npx tsx scripts/fix-jinghu-store.ts            # 只预览
 *   npx tsx scripts/fix-jinghu-store.ts --apply    # 真正执行
 */
import { prisma } from "../lib/prisma";
import { updateEmployee } from "../lib/employee-service";
import { previewStoreMerge, mergeStores, findMergeClusters } from "../lib/store-merge-service";

const APPLY = process.argv.includes("--apply");
const OPERATOR = "系统管理员";
const GF_EMPLOYEE_ID = "THHR2026000002";
const OLD_STORE = 342; // 东城景湖春天
const MAIN_STORE = 343; // 东城景湖春天店
const RIGHT_STORE = 361; // 塘厦林村新阳路店

async function main() {
  console.log(`\n${APPLY ? "🔴 执行模式（会写库）" : "🟡 预览模式（不写库，加 --apply 才执行）"}\n`);

  // ---------- ① 龚峰 ----------
  const gf = await prisma.employee.findFirst({
    where: { employeeId: GF_EMPLOYEE_ID },
    select: {
      id: true,
      employeeId: true,
      name: true,
      status: true,
      storeId: true,
      storeNameRaw: true,
      store: { select: { id: true, name: true } },
    },
  });
  if (!gf) throw new Error(`找不到员工 ${GF_EMPLOYEE_ID}`);

  console.log("========== 步骤① 龚峰的门店 ==========");
  console.log(`  ${gf.employeeId} ${gf.name}（${gf.status}）`);
  console.log(`  当前：#${gf.storeId} ${gf.store?.name ?? "(无)"}`);
  console.log(`  Excel 原文：${gf.storeNameRaw ?? "(无)"}`);
  const right = await prisma.store.findUnique({ where: { id: RIGHT_STORE }, select: { name: true, status: true } });
  console.log(`  目标：#${RIGHT_STORE} ${right?.name}（status=${right?.status}）`);

  const needFix = gf.storeId !== RIGHT_STORE;
  if (needFix && APPLY) {
    await updateEmployee(gf.id, { storeId: RIGHT_STORE }, OPERATOR);
    const after = await prisma.employee.findUnique({
      where: { id: gf.id },
      select: { storeId: true, store: { select: { name: true } } },
    });
    console.log(`  ✅ 已改：现在挂在 #${after?.storeId} ${after?.store?.name}`);
  } else if (needFix) {
    console.log(`  ⏭ 待执行：把龚峰改到 #${RIGHT_STORE} ${right?.name}`);
  } else {
    console.log(`  ✓ 已在目标门店，无需改动`);
  }

  // ---------- ② 门店合并 ----------
  console.log("\n========== 步骤② 合并门店 #342 → #343 ==========");
  const src = await prisma.store.findUnique({
    where: { id: OLD_STORE },
    select: { id: true, name: true, status: true },
  });
  const main = await prisma.store.findUnique({
    where: { id: MAIN_STORE },
    select: { id: true, name: true, status: true },
  });
  console.log(`  被并：#${src?.id} ${src?.name}（${src?.status}）`);
  console.log(`  主店：#${main?.id} ${main?.name}（${main?.status}）`);

  const srcPeople = await prisma.employee.groupBy({
    by: ["status"],
    where: { storeId: OLD_STORE, deletedAt: null },
    _count: { _all: true },
  });
  console.log(
    `  #342 现有员工：${srcPeople.map((g) => `${g.status}=${g._count._all}`).join(" ") || "（无）"}`
  );
  if (src?.status !== "ACTIVE") {
    console.log("  ⚠️ #342 已停用，无需再合并（可能已合并过）");
    await prisma.$disconnect();
    return;
  }

  // 候选簇校验：mergeStores 会要求两家属于同一「疑似重复门店」簇，先自查
  const clusters = await findMergeClusters();
  const inSameCluster = clusters.some(
    (c) => c.stores.some((s) => s.id === OLD_STORE) && c.stores.some((s) => s.id === MAIN_STORE)
  );
  console.log(`  同属一个疑似重复簇：${inSameCluster ? "是" : "否"}`);

  try {
    const { snapshot, preview } = await previewStoreMerge({
      mainStoreId: MAIN_STORE,
      mergeStoreIds: [OLD_STORE],
    });
    console.log(
      `  预览：将迁移 ${preview.moveCount} 人到「${preview.mainStore.name}」，` +
        `合并后该店共 ${preview.mainTotalAfter} 人；新建别名：${preview.aliasesToCreate.join("、") || "（无）"}`
    );
    console.log(`  dbVersion=${snapshot.dbVersion}`);

    if (APPLY) {
      const res = await mergeStores({
        mainStoreId: MAIN_STORE,
        mergeStoreIds: [OLD_STORE],
        operator: OPERATOR,
        snapshot,
      });
      console.log(`  ✅ 合并完成：`, JSON.stringify(res, null, 2).slice(0, 600));
    } else {
      console.log("  ⏭ 待执行合并（加 --apply 才写入）");
    }
  } catch (e) {
    console.log(`  ⚠️ 走标准合并流程被拒：${(e as Error).message}`);
    console.log(`     （服务要求两家必须同属「疑似重复门店」候选簇，否则拒绝自动合并）`);
  }

  // ---------- 结果复核 ----------
  console.log("\n========== 复核 ==========");
  const after = await prisma.employee.findFirst({
    where: { employeeId: GF_EMPLOYEE_ID },
    select: { storeId: true, store: { select: { name: true } } },
  });
  console.log(`  龚峰现在在：#${after?.storeId} ${after?.store?.name}`);
  const left = await prisma.store.findUnique({ where: { id: OLD_STORE }, select: { name: true, status: true } });
  console.log(`  #342 现在：${left?.name}（status=${left?.status}）`);

  // 在职门店数（用户口径 36 + 南昌3店 3 = 39）
  const activeStores = await prisma.employee.groupBy({
    by: ["storeId"],
    where: { status: "ACTIVE", storeId: { not: null }, deletedAt: null },
  });
  const nc3Stores = await prisma.employee.groupBy({
    by: ["storeId"],
    where: { status: "NC3", storeId: { not: null }, deletedAt: null },
  });
  const nc3Ids = new Set(nc3Stores.map((s) => s.storeId));
  const actIds = new Set(activeStores.map((s) => s.storeId));
  const union = new Set([...actIds, ...nc3Ids]);
  console.log(`  在职表门店：${actIds.size} 家；南昌3店门店：${nc3Ids.size} 家；合计可选 ${union.size} 家`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("执行失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
