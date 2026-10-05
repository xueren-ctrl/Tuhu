/**
 * 修复社保门店映射（换数据源后 storeId 全部失效）
 *
 * ## 背景（2026-10-05）
 *
 * `import-excel.ts --reset` 重建了门店主数据（新文件里的门店是新 id），
 * 而 `SocialInsuranceStoreMapping.storeId` 指向的是**旧 id** → 27 条
 * 「已确认」映射的 storeId 全部变成孤儿（指向不存在的门店）。
 *
 * ## 做法
 *
 * **不猜、只按已有的确认记录恢复**：
 *   ① `note` 里写了「确认对应「XXX」」→ 用 XXX 去当前门店主数据精确匹配
 *   ② `note` 写了「完全一致」→ 用 `rawName` 精确匹配
 *  匹配不到就**保持 PENDING，绝不自动挂靠**（挂错门店 = 买错人的社保）。
 *
 * 默认预览，`--apply` 才写库。
 */
import { prisma } from "../lib/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const maps = await prisma.socialInsuranceStoreMapping.findMany({
    where: { status: "CONFIRMED" },
  });
  const stores = await prisma.store.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
  });
  const byName = new Map(stores.map((s) => [s.name, s]));

  interface Fix {
    id: number;
    rawName: string;
    targetName: string;
    storeId: number;
    note: string;
  }
  const fixes: Fix[] = [];
  const manual: { rawName: string; note: string; target: string }[] = [];

  for (const m of maps) {
    if (m.storeId !== null) continue; // 已有有效 storeId，跳过
    const note = m.note ?? "";
    const mm = note.match(/确认对应「(.+?)」/);
    const target = mm ? mm[1] : m.rawName;
    const hit = byName.get(target);
    if (hit) {
      fixes.push({ id: m.id, rawName: m.rawName, targetName: hit.name, storeId: hit.id, note });
    } else {
      manual.push({ rawName: m.rawName, note, target });
    }
  }

  console.log(`CONFIRMED 映射 ${maps.length} 条`);
  console.log(`  可按已有确认记录自动恢复：${fixes.length} 条`);
  console.log(`  需人工确认：${manual.length} 条\n`);

  for (const f of fixes) {
    console.log(`  ✅ ${f.rawName} → ${f.targetName} (#${f.storeId})  [${f.note || "无备注"}]`);
  }
  for (const m of manual) {
    console.log(`  ⚠️  ${m.rawName} → 找不到「${m.target}」  [${m.note || "无备注"}]  保持 PENDING`);
  }

  if (!APPLY) {
    console.log("\n-- 预览，未写库。确认后加 --apply");
    await prisma.$disconnect();
    return;
  }

  let n = 0;
  for (const f of fixes) {
    await prisma.socialInsuranceStoreMapping.update({
      where: { id: f.id },
      data: { storeId: f.storeId },
    });
    await prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entity: "SocialInsuranceStoreMapping",
        entityId: String(f.id),
        actor: "9.42-数据源切换后修复",
        detail: `${f.rawName} → ${f.targetName}（按已有确认记录恢复；换数据源后 storeId 失效）`,
      },
    });
    n++;
  }
  console.log(`\n已恢复 ${n} 条。`);

  const bad = await prisma.socialInsuranceStoreMapping.count({
    where: { status: "CONFIRMED", storeId: null },
  });
  console.log(`剩余「已确认但 storeId 为空」：${bad} 条`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});