/**
 * ============================================================
 * Stage 7.1 数据治理安全底座验收测试
 * scripts/stage7-1-test.mjs
 *
 * 运行方式：
 *   npm run build               （必须先重新构建，API 测试走 next start）
 *   npm run test:stage7.1      （= tsx scripts/stage7-1-test.mjs）
 *
 * 安全模型（与 stage6 / stage6.1 一致）：
 *   - data/hr.db 复制为 data/stage7-1-test.db（副本）；
 *   - 副本上 db:push + seed-users（SEED_*_PASSWORD 环境变量 + --reset-password）；
 *   - DATABASE_URL 指副本，next start -p 3199，全部治理写操作走副本；
 *   - 结束后杀服务器、删副本，生产库员工数量零变化。
 *
 * 覆盖规格书第十三节 13 项（Stage 7.1）+ 15~18 项（Stage 7.1.1 收口）：
 *   [G7-01] 部门自动归属 >500 人（600 名合成员工）：preview affected=600
 *   [G7-02] preview 全量统计（byDepartment / byRule / unmatched）
 *   [G7-03] display items 可截断（500/300），但 apply 不截断（updated=600）
 *   [G7-04] 预览数量 = 执行数量（matched = updated + unchanged + failed）
 *   [G7-05] 数据变化后旧预览不能直接执行（stale snapshot → 409 STALE_PREVIEW）
 *   [G7-06] 门店合并事务回滚（确定性失败，员工/门店/别名/历史/审计五表前后一致）
 *   [G7-07] 门店候选只预览不自动执行（findMergeClusters 只读，数据零变化）
 *   [G7-08] 页面不存在硬编码治理数字（grep 1902 等）
 *   [G7-09] EmployeeHistory 正确（部门归属变更逐条留痕）
 *   [G7-10] AuditLog 正确（批次含 batchKey / 类型 / 数量 / 部门 / 规则）
 *   [G7-11] operator 来自 Session（伪造 x-operator / body.operator 无效）
 *   [G7-12] 测试结束生产数据库员工数量完全不变
 *   [G7-13] 无测试残留
 *   [G7-14] 批量原子回滚（触发器确定性失败：员工档案/历史/审计三表零残留）
 *   [G7-15] 门店合并预览 = 执行（预览 moveCount = 实际迁移，含 straggler 不自动迁）
 *   [G7-16] INACTIVE 门店不参与候选 / 不可作为主店或来源
 *   [G7-17] 无启用规则时 unmatched = baseCount（口径）
 *   [G7-18] 清理后零残留
 *   [G7-19] snapshot 与请求错配 → 409 STALE_MERGE_PREVIEW（五表零变化）
 *   [G7-20] 缺 snapshot → 400 MERGE_PREVIEW_REQUIRED（五表零变化）
 *   [G7-21] 非同一候选簇 → 409 INVALID_MERGE_CLUSTER（五表零变化）
 *   [G7-22] 合法簇部分合并 A+B（C 保留）+ snapshot 顺序容忍（反转集合不变仍通过）
 *   [G7-23] 部门规则条件改（数量不变、命中集合变化）→ 旧快照 409 STALE_PREVIEW（三表零变化）
 *   [G7-24] 部门 apply 缺 snapshot → 400 DEPARTMENT_PREVIEW_REQUIRED（三表零变化）
 *   [G7-25] 门店别名统一归属确定性失败 → 全批回滚（四表零残留，409）
 *   [G7-26] 门店合并竞态保护（写库前 source 被停用 → 409 MERGE_STATE_CHANGED，五表零变化）
 *   [G7-27] DepartmentRule CREATE 审计（AuditLog +1，actor=Session 用户，x-operator 伪造无效）
 *   [G7-28] DepartmentRule UPDATE（old/new 变化字段）+ DELETE（删除前内容）审计
 *   [G7-29] StoreAlias DELETE 审计 +1；触发器制造审计失败 → 别名删除整体回滚（零残留）
 *   [G7-30] 部门 apply 的 overrideExisting 与 snapshot 错配 → 409 STALE_PREVIEW（三表零变化）
 *   [G7-31] resolver：INACTIVE 旧店 + Alias → 指向 ACTIVE 主店（绝不返回 INACTIVE 旧店）
 *   [G7-32] resolver：INACTIVE 同名店且无有效 Alias → storeId=null（不重绑/不复活）
 *   [G7-33] Excel 导入预览与正式 commit 共用同一门店解析（旧店名 → ACTIVE 主店，原文保留）
 *   [G7-34] StoreAlias 创建零迁移也必写 CREATE 审计（actor=Session，绝不 0 审计）
 *   [G7-35] Alias 创建 + CREATE 审计触发器强制失败 → 整笔回滚（四表零残留，409）
 *   [G7-36] merge → alias → import：真实合并后旧店名 Excel 解析/预览/commit 三级一致指向主店
 *   [G7-37] 服务器实时 preview 是确认与执行的唯一口径（人数漂移后 GET 返回最新值 +
 *           静态检查 StoreMergePanel 最终确认不再用 previewOf()）
 *   [G7-38] snapshot → 事务竞态：preview 后源店 3→4 人，用旧 snapshot 执行必须
 *           409 STALE_MERGE_PREVIEW，五表零变化；事务内存在最终 snapshot 复核
 *   [G7-39] 最终 confirm 唯一数据源 = 服务器 preview（明确类型 + confirm 只读 sp.*）
 * ============================================================
 */
import { copyFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import ExcelJS from "exceljs";

const ROOT = process.cwd();
const TEST_DB = path.resolve(ROOT, "data", "stage7-1-test.db");
const SRC_DB = path.resolve(ROOT, "data", "hr.db");
const NODE = process.execPath;
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

// 测试专用密码（仅存在于测试环境内存/副本库，绝不作为生产默认值）
const TEST_ADMIN_PWD = "Stage7-1#Admin@2026";
const TEST_HR_PWD = "Stage7-1#Hr@2026";

// 合成数据标记（绝不与生产数据冲突）
const SYN_DEPT = "阶段7治理测试部门";
const SYN_MARKER = "阶段7治理测试工种"; // 600 人共享的 jobGradeRaw 唯一标记
const SYN_STORE_MAIN = "7治理主店";
const SYN_STORE_A = "7治理甲店";
const SYN_STORE_B = "7治理乙店";
const SYN_MIG_EMP = "7治理迁移员工";
const SYN_STRAG = "阶段7治理员工straggler"; // storeNameRaw=甲店名 但 storeId=null：绝不自动迁移
const SYN_INACT = "7治理停店"; // INACTIVE 门店：不得再进入候选/不得作为主店或来源
// Stage 7.1.2 新增：合法候选簇（丙/丙店/丙店分 互相成候选对 → 同一簇）
const SYN_CLUSTER_A = "7治理丙";
const SYN_CLUSTER_B = "7治理丙店"; // A 去掉末尾「店」≠A；B 去掉「店」=A → A↔B 候选对
const SYN_CLUSTER_C = "7治理丙店分"; // A 是 C 前缀、长度差1 → A↔C 候选对；B 是 C 前缀长度差1 → B↔C
// 非法簇：丁/戊 名称不相似、互不成候选对
const SYN_BAD_X = "7治理丁店";
const SYN_BAD_Y = "7治理戊店";
// G7-15 专用合法簇（己/己店 去掉店后相同 → 候选对），与 G7-22 簇互不干扰
const SYN_G15_MAIN = "7治理己";
const SYN_G15_SRC = "7治理己店";
// Stage 7.1.3 G7-23 专用：各 3 名员工的候选门店对（改规则指向门店 A→B：数量不变、命中集合变）
const SYN_G23_A = "7治理庚";
const SYN_G23_B = "7治理庚店";
const SYN_G23_EMP = "阶段7庚员工";
// Stage 7.1.3 G7-25 专用：别名统一归属（独立门店 + 2 名原文写旧名的员工）
const SYN_ALIAS_STORE = "7别名主店";
const SYN_ALIAS_NAME = "阶段7别名乙"; // 员工 storeNameRaw 写此名；测试中注册为 SYN_ALIAS_STORE 的别名
const SYN_ALIAS_EMP = "阶段7别名员工";
// Stage 7.1.3 G7-26 专用：竞态保护（各 1 名员工的候选门店对，raw UPDATE 只改 status 不碰 updatedAt）
const SYN_G26_A = "7治理癸";
const SYN_G26_B = "7治理癸店";
const SYN_G26_EMP = "阶段7癸员工";
// Stage 7.1.5 专用：统一门店解析 resolver 与「merge → alias → import」回归
const SYN_G31_INACT = "7治理别名旧"; // INACTIVE 门店，且其名称注册为 G31 主店的别名 → resolver 必须给主店
const SYN_G31_MAIN = "7治理别名主"; // ACTIVE 主店
const SYN_G32_INACT = "7治理无别"; // INACTIVE 门店且无别名 → resolver 必须给 null
// G7-34/35 专用：零迁移也必有 CREATE 审计（独立主店，无员工 storeNameRaw 指向别名）
const SYN_G34_STORE = "7治理导入主";
const SYN_G34_ALIAS = "7治理导入旧名"; // G7-34：别名成功创建（零迁移）+ CREATE 审计
const SYN_G34_ALIAS_2 = "7治理导入零迁"; // G7-35：CREATE 审计触发器强制失败 → 整笔回滚
// G7-36 专用：真实 merge → alias → import 回归（子/子店 去掉「店」= 子 → 合法候选簇）
const SYN_G36_MAIN = "7治理子";
const SYN_G36_SRC = "7治理子店";
const SYN_G36_EMP = "阶段7合并迁移"; // 挂在 source（子店）的员工，merge 后迁到主店
const SYN_G36_IMPORT = "阶段7合并导入"; // G7-36：合并后用旧店名导入的新员工 → 必落主店
const SYN_G33_EMP = "阶段7导入测试"; // G7-33 commit 创建的新员工（库中不存在，必然新建）
// Stage 7.1.6 G7-37 专用：服务器实时 preview 是确认与执行的唯一口径（辰/辰店 去掉「店」= 辰 → 合法候选簇）
const SYN_G37_MAIN = "7治理辰";
const SYN_G37_SRC = "7治理辰店";
const SYN_G37_EMP = "阶段7口径员工";

// G7-38 专用：事务内 snapshot 最终防线（preview 后源店 3 人 → 并发改成 4 人）
// 合法候选簇：去尾「店」相同（辰 / 辰店）
const SYN_G38_MAIN = "7治理戌";
const SYN_G38_SRC = "7治理戌店";
const SYN_G38_EMP = "阶段7竞态员工";
const SYN_G38_MAIN_EMP = "阶段7竞态主店员工";

let pass = 0;
let fail = 0;
const failures = [];
function check(id, title, ok, detail) {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${title}`);
  }
  console.log(`${ok ? "✅" : "❌"} [${id}] ${title}${detail ? `\n       ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ============ 准备：记录生产基线 + 建立副本 ============
  if (!existsSync(SRC_DB)) {
    console.error("❌ 找不到 data/hr.db，请先完成基线导入");
    process.exit(2);
  }
  // 用生产库原文件统计基线（绝不改动它）
  const prodBaseline = await countEmployeesInFile(SRC_DB);
  console.log("生产库（data/hr.db）员工基线 =", prodBaseline);

  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  copyFileSync(SRC_DB, TEST_DB);
  process.env.DATABASE_URL = "file:" + TEST_DB;
  process.env.SEED_ADMIN_PASSWORD = TEST_ADMIN_PWD;
  process.env.SEED_HR_PASSWORD = TEST_HR_PWD;

  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.error("❌ 未检测到 .next 构建产物：请先执行 npm run build 再跑 test:stage7.1");
    process.exit(2);
  }

  console.log("═".repeat(72));
  console.log("Stage 7.1 治理安全底座测试  TEST_DB =", TEST_DB);
  console.log("═".repeat(72));

  const env = () => ({
    ...process.env,
    NODE_OPTIONS: "",
    DATABASE_URL: process.env.DATABASE_URL,
    SEED_ADMIN_PASSWORD: TEST_ADMIN_PWD,
    SEED_HR_PASSWORD: TEST_HR_PWD,
  });

  execSync(`"${NODE}" node_modules/prisma/build/index.js db push --skip-generate`, {
    cwd: ROOT,
    env: env(),
    stdio: "inherit",
  });
  execSync(`"${NODE}" node_modules/tsx/dist/cli.mjs scripts/seed-users.ts -- --reset-password`, {
    cwd: ROOT,
    env: env(),
    stdio: "inherit",
  });

  const prisma = (await import("../lib/prisma.ts")).prisma; // 此刻连的是副本

  // ============ 构造 600 名合成员工 + 一条归属规则 ============
  await prisma.employee.deleteMany({ where: { name: { startsWith: "阶段7治理员工" } } });
  await prisma.employee.deleteMany({ where: { name: SYN_MIG_EMP } });
  await prisma.department.deleteMany({ where: { name: SYN_DEPT } });
  await prisma.store.deleteMany({
    where: { name: { in: [SYN_STORE_MAIN, SYN_STORE_A, SYN_STORE_B] } },
  });

  const dept = await prisma.department.create({ data: { name: SYN_DEPT } });

  // 批量造 600 人（全部无部门、共享唯一工种标记）
  const batch = [];
  for (let i = 1; i <= 600; i++) {
    batch.push({
      employeeId: "THHR71" + String(i).padStart(5, "0"),
      name: "阶段7治理员工" + i,
      jobGradeRaw: SYN_MARKER + (i % 2 === 0 ? "A" : "B"), // 两个子组都含标记
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      departmentId: null,
      storeId: null,
    });
  }
  await prisma.employee.createMany({ data: batch });

  await prisma.departmentRule.create({
    data: {
      departmentId: dept.id,
      employeeType: SYN_MARKER,
      priority: 1,
      enabled: true,
    },
  });

  // 门店合并测试用：主店 + 甲/乙 + 各自挂 2 个员工
  const stMain = await prisma.store.create({ data: { name: SYN_STORE_MAIN } });
  const stA = await prisma.store.create({ data: { name: SYN_STORE_A } });
  const stB = await prisma.store.create({ data: { name: SYN_STORE_B } });
  // Stage 7.1.1 新增：INACTIVE 门店（不得再进入候选 / 不得作为主店或来源）
  const stInact = await prisma.store.create({
    data: { name: SYN_INACT, status: "INACTIVE" },
  });
  const migPrefix = "stage7-1-mig-";
  for (const s of [stA, stB]) {
    for (let k = 1; k <= 2; k++) {
      await prisma.employee.create({
        data: {
          employeeId: migPrefix + s.name + k,
          name: SYN_MIG_EMP,
          status: "ACTIVE",
          sourceSheet: "数据库",
          importBatch: "stage7-1-test",
          storeId: s.id,
        },
      });
    }
  }
  // Stage 7.1.1 新增：straggler 员工 —— storeNameRaw 写着甲店名、但 storeId 为空。
  // 删 stragglers 逻辑后，门店合并**绝不**迁移这种人（只迁 storeId 精确匹配的）。
  await prisma.employee.create({
    data: {
      employeeId: "stage7-1-straggler-1",
      name: SYN_STRAG,
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      storeNameRaw: SYN_STORE_A, // 原文写着甲店名
      storeId: null, // 但并未真正挂到甲店
    },
  });

  // Stage 7.1.2 新增：合法候选簇 A/B/C（互相成候选对，同一簇）+ 非法簇 X/Y（互不成对）
  const stCA = await prisma.store.create({ data: { name: SYN_CLUSTER_A } });
  const stCB = await prisma.store.create({ data: { name: SYN_CLUSTER_B } });
  const stCC = await prisma.store.create({ data: { name: SYN_CLUSTER_C } });
  const stBX = await prisma.store.create({ data: { name: SYN_BAD_X } });
  const stBY = await prisma.store.create({ data: { name: SYN_BAD_Y } });
  const clusterPrefix = "stage71-cluster-";
  for (const s of [stCA, stCB, stCC, stBX, stBY]) {
    await prisma.employee.create({
      data: {
        employeeId: clusterPrefix + s.name,
        name: "7治理簇员工",
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeId: s.id,
      },
    });
  }
  // G7-15 专用合法簇（己/己店）+ 1 员工挂「己店」
  const stG15Main = await prisma.store.create({ data: { name: SYN_G15_MAIN } });
  const stG15Src = await prisma.store.create({ data: { name: SYN_G15_SRC } });
  await prisma.employee.create({
    data: {
      employeeId: clusterPrefix + SYN_G15_SRC,
      name: "7治理簇员工",
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      storeId: stG15Src.id,
    },
  });

  // Stage 7.1.3 G7-23 专用：候选门店对（庚/庚店，候选对：庚店去掉末尾「店」= 庚），各挂 3 名员工
  //   后续：创建门店维度规则指向庚店 → 命中 3 名；改规则指向庚 → 庚无员工命中 0 名？
  //   不行——要保证「数量不变、集合变」：两店各 3 人互调。规则指向庚店(3人)→指向庚(3人)：数量=3 不变、命中集合 3→3 全变。
  const stG23A = await prisma.store.create({ data: { name: SYN_G23_A } });
  const stG23B = await prisma.store.create({ data: { name: SYN_G23_B } });
  for (const s of [stG23A, stG23B]) {
    for (let k = 1; k <= 3; k++) {
      await prisma.employee.create({
        data: {
          employeeId: `stage713-${s.name}-${k}`,
          name: SYN_G23_EMP + k,
          status: "ACTIVE",
          sourceSheet: "数据库",
          importBatch: "stage7-1-test",
          storeId: s.id,
          departmentId: null,
        },
      });
    }
  }

  // Stage 7.1.3 G7-25 专用：别名统一归属 —— 独立主店 + 2 名员工 storeNameRaw 写旧名、storeId 未挂
  const stAliasStore = await prisma.store.create({ data: { name: SYN_ALIAS_STORE } });
  for (let k = 1; k <= 2; k++) {
    await prisma.employee.create({
      data: {
        employeeId: `stage713-alias-${k}`,
        name: SYN_ALIAS_EMP + k,
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeNameRaw: SYN_ALIAS_NAME,
        storeId: null,
      },
    });
  }

  // Stage 7.1.3 G7-26 专用：竞态保护 —— 候选门店对（癸/癸店，候选对：癸店去掉末尾「店」= 癸），各挂 1 名员工
  const stG26A = await prisma.store.create({ data: { name: SYN_G26_A } });
  const stG26B = await prisma.store.create({ data: { name: SYN_G26_B } });
  await prisma.employee.create({
    data: {
      employeeId: "stage713-g26-b-1",
      name: SYN_G26_EMP + 1,
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      storeId: stG26B.id,
    },
  });

  // Stage 7.1.5 G7-31/32 专用：INACTIVE 门店的别名解析与「无别名」解析
  // G31：旧店(INACTIVE)的名称注册为主店(ACTIVE)的别名 → resolver 必须给主店（绝不给 INACTIVE 旧店）
  const stG31Main = await prisma.store.create({ data: { name: SYN_G31_MAIN } });
  const stG31Inact = await prisma.store.create({ data: { name: SYN_G31_INACT, status: "INACTIVE" } });
  await prisma.storeAlias.create({ data: { storeId: stG31Main.id, alias: SYN_G31_INACT } });
  // G32：INACTIVE 门店且无任何别名 → resolver 必须给 null（不重绑/不复活）
  const stG32Inact = await prisma.store.create({ data: { name: SYN_G32_INACT, status: "INACTIVE" } });
  // G7-34/35 专用：零迁移别名 + CREATE 审计原子性（主店 ACTIVE，无员工 storeNameRaw 指向其别名）
  const stG34 = await prisma.store.create({ data: { name: SYN_G34_STORE } });
  // G7-36 专用：merge → alias → import 回归（子/子店 去掉「店」= 子 → 合法候选簇）
  const stG36Main = await prisma.store.create({ data: { name: SYN_G36_MAIN } });
  const stG36Src = await prisma.store.create({ data: { name: SYN_G36_SRC } });
  for (let k = 1; k <= 2; k++) {
    await prisma.employee.create({
      data: {
        employeeId: `stage715-g36-${k}`,
        name: SYN_G36_EMP + k,
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeId: stG36Src.id,
      },
    });
  }
  // G7-37 专用：源店先挂 1 人（模拟「页面加载时的旧数据」），测试中再加到 2 人制造漂移
  const stG37Main = await prisma.store.create({ data: { name: SYN_G37_MAIN } });
  const stG37Src = await prisma.store.create({ data: { name: SYN_G37_SRC } });
  await prisma.employee.create({
    data: {
      employeeId: "stage716-g37-src-1",
      name: SYN_G37_EMP + "1",
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      storeId: stG37Src.id,
    },
  });

  // G7-38 专用：preview → 事务之间发生并发改库（源店 3 人 → 4 人），验证事务内最后防线
  const stG38Main = await prisma.store.create({ data: { name: SYN_G38_MAIN } });
  const stG38Src = await prisma.store.create({ data: { name: SYN_G38_SRC } });
  for (let k = 1; k <= 3; k++) {
    await prisma.employee.create({
      data: {
        employeeId: `stage716-g38-src-${k}`,
        name: SYN_G38_EMP + k,
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeId: stG38Src.id,
      },
    });
  }
  // 主店挂 1 人（用于验证 mainTotalBefore 也参与比对）
  await prisma.employee.create({
    data: {
      employeeId: "stage716-g38-main-1",
      name: SYN_G38_MAIN_EMP + "1",
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage7-1-test",
      storeId: stG38Main.id,
    },
  });


  // ============ 启动服务器（副本数据库） ============
  const server = spawn(
    NODE,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: ROOT, env: env(), stdio: ["ignore", "pipe", "pipe"] }
  );
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  // 分两段：removeSynthetic() 供 G7-18 复用；finalize() 真正收尾删库
  const SYN_CLUSTER_NAMES = [SYN_CLUSTER_A, SYN_CLUSTER_B, SYN_CLUSTER_C, SYN_BAD_X, SYN_BAD_Y, SYN_G15_MAIN, SYN_G15_SRC];
  const SYN_G23_NAMES = [SYN_G23_A, SYN_G23_B];
  const SYN_G26_NAMES = [SYN_G26_A, SYN_G26_B];
  const removeSynthetic = async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg71_merge_fail`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg71_batch_fail`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg713_alias_fail`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg714_aliasdel_fail`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg715_alias_create_fail`);
    // 先解绑 FK（员工 → 全部合成门店 / 合成部门）
    await prisma.employee.updateMany({
      where: {
        storeId: {
          in: [
            stMain.id, stA.id, stB.id, stInact.id, stCA.id, stCB.id, stCC.id, stBX.id, stBY.id,
            stG15Main.id, stG15Src.id, stG23A.id, stG23B.id, stAliasStore.id, stG26A.id, stG26B.id,
            stG31Main.id, stG31Inact.id, stG32Inact.id, stG34.id, stG36Main.id, stG36Src.id,
            stG37Main.id, stG37Src.id,
            stG38Main.id, stG38Src.id,
          ],
        },
      },
      data: { storeId: null },
    });
    await prisma.employee.updateMany({
      where: { departmentId: dept.id },
      data: { departmentId: null },
    });
    // 合成数据（员工按名称；规则/别名/门店/部门按名称）
    await prisma.employee.deleteMany({ where: { name: { startsWith: "阶段7治理员工" } } });
    await prisma.employee.deleteMany({ where: { name: SYN_MIG_EMP } });
    await prisma.employee.deleteMany({ where: { name: "7治理簇员工" } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G23_EMP } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_ALIAS_EMP } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G26_EMP } } });
    // Stage 7.1.5：G7-36 merge 迁移员工 + G7-33/G7-36 导入创建的新员工
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G36_EMP } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G33_EMP } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G36_IMPORT } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G37_EMP } } });
    // Stage 7.1.6 事务收口：G7-38 竞态合成员工（源店 + 主店）
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G38_EMP } } });
    await prisma.employee.deleteMany({ where: { name: { startsWith: SYN_G38_MAIN_EMP } } });
    // G7-23/26 专用规则（指向 G23/G26 门店）
    await prisma.departmentRule.deleteMany({
      where: { storeId: { in: [stG23A.id, stG23B.id, stG26A.id, stG26B.id] } },
    });
    await prisma.departmentRule.deleteMany({ where: { department: { name: SYN_DEPT } } });
    await prisma.storeAlias.deleteMany({
      where: {
        alias: {
          in: [
            SYN_STORE_A,
            SYN_STORE_B,
            SYN_INACT,
            SYN_ALIAS_NAME,
            "阶段7别名删除",
            "阶段7别名删除2",
            ...SYN_CLUSTER_NAMES,
            // Stage 7.1.5：G31 别名（旧店名→主店）/ G34 导入别名 / G36 合并别名
            SYN_G31_INACT,
            SYN_G34_ALIAS,
            SYN_G36_SRC,
          ],
        },
      },
    });
    await prisma.store.deleteMany({
      where: {
        name: {
          in: [
            SYN_STORE_MAIN, SYN_STORE_A, SYN_STORE_B, SYN_INACT,
            ...SYN_CLUSTER_NAMES, ...SYN_G23_NAMES, SYN_ALIAS_STORE, ...SYN_G26_NAMES,
            SYN_G31_MAIN, SYN_G31_INACT, SYN_G32_INACT, SYN_G34_STORE, SYN_G36_MAIN, SYN_G36_SRC,
            SYN_G37_MAIN, SYN_G37_SRC,
            SYN_G38_MAIN, SYN_G38_SRC,
          ],
        },
      },
    });
    await prisma.department.deleteMany({ where: { name: SYN_DEPT } });
    // Stage 7.1.5：G7-33/G7-36 创建的导入预览批次一并清掉（不留测试预览）
    await prisma.importPreview.deleteMany({
      where: { fileName: { in: ["stage715-g33.xlsx", "stage715-g36.xlsx"] } },
    });
  };
  const cleanup = async () => {
    try {
      await removeSynthetic();
    } catch {}
    try {
      server.kill();
    } catch {}
    await prisma.$disconnect();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  };

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (r.status < 500) {
        up = true;
        break;
      }
    } catch {}
  }
  if (!up) {
    console.error("❌ next 服务器启动失败：\n" + serverLog.slice(-2000));
    await cleanup();
    process.exit(2);
  }

  // ---- fetch 工具（cookie jar）----
  const jar = { cookie: "" };
  const api = async (method, p, { json, noAuth, headers = {} } = {}) => {
    const opts = { method, headers: { ...headers }, redirect: "manual" };
    if (!noAuth && jar.cookie) opts.headers["Cookie"] = jar.cookie;
    if (json !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(json);
    }
    const res = await fetch(BASE + p, opts);
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const first = sc.split(";")[0];
      if (first.startsWith("hr_session=")) jar.cookie = first;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body, res };
  };
  const login = async (username, password) =>
    api("POST", "/api/auth/login", { json: { username, password }, noAuth: true });

  // ---- Stage 7.1.5：构造「数据库」Sheet 的 xlsx 并上传预览（复用 stage6 表头映射）----
  const DB_HEADERS = {
    1: "序号", 2: "门店名称", 3: "入职时间", 4: "在职年限", 5: "姓名",
    6: "身份证号", 7: "联系电话", 8: "工种级别", 9: "职位备注", 10: "是否住宿舍",
  };
  function buildWorkbook(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据库");
    ws.getCell(1, 1).value = "（旧版残留占位）";
    for (const [c, t] of Object.entries(DB_HEADERS)) ws.getCell(2, Number(c)).value = t;
    for (const [rowNo, cols] of Object.entries(rows)) {
      for (const [col, val] of Object.entries(cols)) {
        if (val === undefined || val === null) continue;
        ws.getCell(Number(rowNo), Number(col)).value = val;
      }
    }
    return wb;
  }
  const uploadPreview = async (rows, name) => {
    const buffer = Buffer.from(await buildWorkbook(rows).xlsx.writeBuffer());
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buffer)]), name);
    const res = await fetch(BASE + "/api/import/preview", {
      method: "POST",
      headers: { Cookie: jar.cookie },
      body: fd,
      redirect: "manual",
    });
    const sc = res.headers.get("set-cookie");
    if (sc && sc.split(";")[0].startsWith("hr_session=")) jar.cookie = sc.split(";")[0];
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  // 登录 admin（部门自动归属 / 门店合并均 ADMIN only）
  const lg = await login("admin", TEST_ADMIN_PWD);
  if (lg.status !== 200) {
    console.error("❌ admin 登录失败", lg.status, JSON.stringify(lg.body));
    await cleanup();
    process.exit(2);
  }

  // ============ [G7-01] 部门自动归属 >500 人 ============
  {
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const d = pv.body?.data;
    check(
      "G7-01",
      "preview affected = 600（>500 上限场景，不再受 500 截断影响）",
      pv.status === 200 && d?.affected === 600,
      JSON.stringify({ status: pv.status, affected: d?.affected })
    );
  }

  // ============ [G7-02] preview 全量统计 ============
  {
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const d = pv.body?.data;
    const byDept = d?.byDepartment?.find((x) => x.departmentId === dept.id);
    const byRule = d?.byRule;
    check(
      "G7-02",
      "preview 全量统计：byDepartment 正确、byRule 命中 600、unmatched 为其余无部门员工",
      pv.status === 200 &&
        byDept?.count === 600 &&
        byRule?.length === 1 &&
        byRule[0].count === 600 &&
        typeof d?.unmatched === "number" &&
        d.unmatched > 0,
      JSON.stringify({
        byDept: byDept?.count,
        byRuleCount: byRule?.[0]?.count,
        unmatched: d?.unmatched,
      })
    );
  }

  // ============ [G7-03] display 截断但 apply 不截断 ============
  {
    const pv = await api("POST", "/api/departments/auto", {
      json: { action: "preview", itemLimit: 300 },
    });
    const d = pv.body?.data;
    check(
      "G7-03a",
      "display items 可截断（itemLimit=300 → items=300，affected 仍是 600）",
      d?.items?.length === 300 && d?.affected === 600 && d?.itemsTruncated === true,
      JSON.stringify({ items: d?.items?.length, affected: d?.affected, truncated: d?.itemsTruncated })
    );

    // 全量应用（携带默认 500 截断的快照，执行数量必须 = 全量 600）
    const pv2 = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const apply = await api("POST", "/api/departments/auto", {
      json: {
        action: "apply",
        snapshot: pv2.body?.data?.snapshot,
      },
    });
    const a = apply.body?.data;
    const nowDept = await prisma.employee.count({
      where: { name: { startsWith: "阶段7治理员工" }, departmentId: dept.id },
    });
    check(
      "G7-03b",
      "apply 不截断：600 人全部写入部门（updated=600，未卡在 500）",
      apply.status === 200 && a?.updated === 600 && nowDept === 600,
      JSON.stringify({ status: apply.status, updated: a?.updated, inDb: nowDept })
    );
    // 复位：把这 600 人的部门清空，供 G7-04/G7-05 重新走「无部门 → 归属」
    await prisma.employee.updateMany({
      where: { name: { startsWith: "阶段7治理员工" }, departmentId: dept.id },
      data: { departmentId: null },
    });
  }

  // ============ [G7-04] 预览数量 = 执行数量 ============
  {
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const matched = pv.body?.data?.affected;
    const apply = await api("POST", "/api/departments/auto", {
      json: { action: "apply", snapshot: pv.body?.data?.snapshot },
    });
    const a = apply.body?.data;
    const sum = (a?.updated ?? 0) + (a?.unchanged ?? 0) + (a?.failed ?? 0);
    check(
      "G7-04",
      "预览数量 = 执行数量（matched=600 = updated+unchanged+failed，失败不留半修改）",
      apply.status === 200 && matched === 600 && a?.matched === 600 && sum === 600 && a?.failed === 0,
      JSON.stringify({ matched, aMatched: a?.matched, updated: a?.updated, unchanged: a?.unchanged, failed: a?.failed, sum })
    );
    await prisma.employee.updateMany({
      where: { name: { startsWith: "阶段7治理员工" }, departmentId: dept.id },
      data: { departmentId: null },
    });
  }

  // ============ [G7-05] 旧预览拒绝执行（数据变化 → 409） ============
  {
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const snap = pv.body?.data?.snapshot;
    // 预览后再新增 1 名匹配员工 → 匹配数 600 → 601
    await prisma.employee.create({
      data: {
        employeeId: "THHR71" + "STALE".padEnd(5, "9"),
        name: "阶段7治理员工stale",
        jobGradeRaw: SYN_MARKER,
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        departmentId: null,
      },
    });
    const stale = await api("POST", "/api/departments/auto", {
      json: { action: "apply", snapshot: snap },
    });
    check(
      "G7-05",
      "数据变化后旧预览直接执行 → 409 STALE_PREVIEW（拒绝）",
      stale.status === 409 && stale.body?.code === "STALE_PREVIEW",
      JSON.stringify({ status: stale.status, code: stale.body?.code })
    );
    await prisma.employee.deleteMany({ where: { name: "阶段7治理员工stale" } });
  }

  // ============ [G7-06] 门店合并事务回滚（确定性失败） ============
  {
    // 挂一个触发器：一旦把员工改挂到主店就中止 → 让整个合并事务回滚
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg71_merge_fail
       AFTER UPDATE OF storeId ON employee
       WHEN new.storeId = ${stMain.id}
       BEGIN
         SELECT RAISE(ABORT, 'stage7-1-test: 强制回滚门店合并');
       END`
    );

    // 记录失败前五张表的状态
    const empStoreBefore = await prisma.employee.findMany({
      where: { name: SYN_MIG_EMP },
      select: { id: true, storeId: true },
    });
    const aliasBefore = await prisma.storeAlias.count();
    const storeAStatusBefore = (await prisma.store.findUnique({ where: { id: stA.id } }))?.status;
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();

    const res = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stMain.id, mergeStoreIds: [stA.id, stB.id] },
    });

    const empStoreAfter = await prisma.employee.findMany({
      where: { name: SYN_MIG_EMP },
      select: { id: true, storeId: true },
    });
    const aliasAfter = await prisma.storeAlias.count();
    const storeAStatusAfter = (await prisma.store.findUnique({ where: { id: stA.id } }))?.status;
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();

    // 触发器强制失败后，五张表必须与失败前完全一致
    const empUnchanged =
      empStoreBefore.length === empStoreAfter.length &&
      empStoreBefore.every((e, i) => e.storeId === empStoreAfter[i]?.storeId);
    const storeStillActive = storeAStatusBefore === "ACTIVE" && storeAStatusAfter === "ACTIVE";
    const noAliasLeak = aliasBefore === aliasAfter;
    const noHistLeak = histBefore === histAfter;
    const noAuditLeak = auditBefore === auditAfter;

    check(
      "G7-06",
      "门店合并确定性失败 → 事务整体回滚（员工/门店/别名/历史/审计五表前后一致）",
      res.status !== 200 && empUnchanged && storeStillActive && noAliasLeak && noHistLeak && noAuditLeak,
      JSON.stringify({
        status: res.status,
        err: res.body?.error,
        empUnchanged,
        storeStillActive,
        noAliasLeak,
        noHistLeak,
        noAuditLeak,
      })
    );

    // 移除触发器
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg71_merge_fail`);
  }

  // ============ [G7-07] 门店候选只预览不自动执行 ============
  {
    const storesBefore = await prisma.store.count();
    const empBefore = await prisma.employee.count();
    const histBefore = await prisma.employeeHistory.count();
    // findMergeClusters 是只读候选生成（页面预览走它）
    const { findMergeClusters } = await import("../lib/store-merge-service.ts");
    await findMergeClusters();
    await findMergeClusters(); // 调两次，确认纯只读
    const storesAfter = await prisma.store.count();
    const empAfter = await prisma.employee.count();
    const histAfter = await prisma.employeeHistory.count();
    check(
      "G7-07",
      "门店候选只预览不自动执行（findMergeClusters 只读，门店/员工/历史数量零变化）",
      storesBefore === storesAfter && empBefore === empAfter && histBefore === histAfter,
      JSON.stringify({ stores: [storesBefore, storesAfter], emp: [empBefore, empAfter], hist: [histBefore, histAfter] })
    );
  }

  // ============ [G7-08] 页面不存在硬编码治理数字 ============
  {
    const dq = readFileSync(path.join(ROOT, "app/(app)/data-quality/page.tsx"), "utf8");
    const da = readFileSync(path.join(ROOT, "app/(app)/employees/department-auto/page.tsx"), "utf8");
    const noHard =
      !/\b1902\b/.test(dq) &&
      !/\b1902\b/.test(da) &&
      !/\b1936\b/.test(dq) &&
      !/\b210\b\s*人/.test(dq);
    // 确认 data-quality 用的是实时量
    const usesLive = /noDeptRow\?\.count/.test(dq);
    check(
      "G7-08",
      "数据质量 / 部门自动归属页面不再硬编码 1902 等历史数字，且改用实时统计",
      noHard && usesLive,
      JSON.stringify({ noHard, usesLive })
    );
  }

  // ============ [G7-09] EmployeeHistory 正确 ============
  {
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    await api("POST", "/api/departments/auto", { json: { action: "apply", snapshot: pv.body?.data?.snapshot } });
    const hist = await prisma.employeeHistory.findMany({
      where: {
        fieldName: "departmentId",
        employee: { name: { startsWith: "阶段7治理员工" } },
      },
      select: { id: true, oldValue: true, newValue: true, operator: true, source: true },
      take: 5,
      orderBy: { id: "desc" },
    });
    const sample = hist[0];
    const ok =
      hist.length > 0 &&
      sample?.oldValue === null &&
      String(sample?.newValue) === String(dept.id) &&
      sample?.source === "BATCH_UPDATE" &&
      typeof sample?.operator === "string" &&
      sample.operator.length > 0;
    check(
      "G7-09",
      "部门归属变更逐条写 EmployeeHistory（null → 部门id，source=BATCH_UPDATE，operator 非空）",
      ok,
      JSON.stringify({ sample, total: hist.length })
    );
  }

  // ============ [G7-10] AuditLog 正确 ============
  {
    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Department", entityId: String(dept.id) },
      orderBy: { id: "desc" },
    });
    const detail = audit?.detail ? JSON.parse(audit.detail) : null;
    const ok =
      !!audit &&
      detail?.type === "department-auto" &&
      detail?.departmentId === dept.id &&
      Number.isInteger(detail?.employeeCount) &&
      Array.isArray(detail?.ruleIds) &&
      detail?.batchKey;
    check(
      "G7-10",
      "治理批次 AuditLog 含 batchKey / 类型 / 员工数 / 部门 / 规则（敏感字段不落明文）",
      ok,
      JSON.stringify({ action: audit?.action, detail })
    );
  }

  // ============ [G7-11] operator 来自 Session（伪造无效） ============
  {
    const pv = await api("POST", "/api/departments/auto", {
      json: { action: "preview" },
    });
    const r = await api("POST", "/api/departments/auto", {
      json: { action: "apply", snapshot: pv.body?.data?.snapshot },
      headers: { "x-operator": "forged-evil" },
    });
    // body 里塞一个伪造 operator（会被服务端忽略，只认 Session）
    const r2 = await api("POST", "/api/departments/auto", {
      json: { action: "apply", snapshot: pv.body?.data?.snapshot, operator: "forged-evil" },
    });
    const latestAudit = await prisma.auditLog.findFirst({
      where: { entity: "Department", entityId: String(dept.id) },
      orderBy: { id: "desc" },
    });
    // admin 的 displayName 是「系统管理员」
    const actorIsSession = latestAudit?.actor === "系统管理员";
    const noForged = !/forged-evil/.test(latestAudit?.actor ?? "") && !/forged-evil/.test(latestAudit?.detail ?? "");
    check(
      "G7-11",
      "operator 只来自 Session 真实用户（伪造 x-operator / body.operator 一律无效）",
      r.status === 200 && r2.status === 200 && actorIsSession && noForged,
      JSON.stringify({ r: r.status, r2: r2.status, actor: latestAudit?.actor, noForged })
    );
  }

  // ============ HR 访问治理接口 → 403（权限门禁） ============
  {
    const hrJar = { cookie: "" };
    const hrLogin = await (async () => {
      const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "hr", password: TEST_HR_PWD }),
        redirect: "manual",
      };
      const res = await fetch(BASE + "/api/auth/login", opts);
      const sc = res.headers.get("set-cookie");
      if (sc) {
        const first = sc.split(";")[0];
        if (first.startsWith("hr_session=")) hrJar.cookie = first;
      }
      return res;
    })();
    const hrForbidden = await (async () => {
      const res = await fetch(BASE + "/api/departments/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: hrJar.cookie },
        body: JSON.stringify({ action: "preview" }),
        redirect: "manual",
      });
      return { status: res.status };
    })();
    check(
      "G7-ADMIN",
      "HR 角色访问部门自动归属（ADMIN only）→ 403",
      hrLogin.status === 200 && hrForbidden.status === 403,
      JSON.stringify({ hrLogin: hrLogin.status, hrForbidden: hrForbidden.status })
    );
  }

  // ============ [G7-12] 生产数据库员工数量完全不变 ============
  {
    const prodNow = await countEmployeesInFile(SRC_DB);
    check(
      "G7-12",
      "测试结束生产库员工数量与基线一致（零污染）",
      prodNow === prodBaseline,
      JSON.stringify({ baseline: prodBaseline, now: prodNow })
    );
  }

  // ============ [G7-13] 无测试残留（副本清理后无合成数据） ============
  {
    // 在 cleanup 前，先确认副本里合成数据可被识别（数量正确）
    const synEmp = await prisma.employee.count({ where: { name: { startsWith: "阶段7治理员工" } } });
    const synMig = await prisma.employee.count({ where: { name: SYN_MIG_EMP } });
    const synDept = await prisma.department.count({ where: { name: SYN_DEPT } });
    const synStore = await prisma.store.count({
      where: { name: { in: [SYN_STORE_MAIN, SYN_STORE_A, SYN_STORE_B] } },
    });
    check(
      "G7-13",
      "合成测试数据已全部登记且可被 cleanup 识别（员工/迁移员工/部门/门店）",
      synEmp >= 600 && synMig >= 4 && synDept === 1 && synStore === 3,
      JSON.stringify({ synEmp, synMig, synDept, synStore })
    );
  }

  // ============ [G7-14] 批量原子回滚（确定性失败：员工/历史/审计三表零残留） ============
  {
    const rows600 = await prisma.employee.findMany({
      where: { name: { startsWith: "阶段7治理员工" } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 25,
    });
    const ids600 = rows600.map((r) => r.id);
    // 复位到无部门，便于验证「失败后没有半修改」
    await prisma.employee.updateMany({ where: { id: { in: ids600 } }, data: { departmentId: null } });

    const deptHitBefore = await prisma.employee.count({
      where: { id: { in: ids600 }, departmentId: dept.id },
    });
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();

    // 触发器：任何把 departmentId 置为测试部门的更新都中止 → 整批回滚
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg71_batch_fail
       BEFORE UPDATE ON employee
       WHEN new.departmentId = ${dept.id}
       BEGIN
         SELECT RAISE(ABORT, 'stage7-1-test: 强制批量回滚');
       END`
    );
    const r14 = await api("POST", "/api/employees/batch", {
      json: { ids: ids600, departmentId: dept.id },
    });
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg71_batch_fail`);

    const deptHitAfter = await prisma.employee.count({
      where: { id: { in: ids600 }, departmentId: dept.id },
    });
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();

    check(
      "G7-14",
      "批量原子回滚：确定性失败后员工档案/变更历史/审计三表零残留（409 BATCH_ABORTED）",
      r14.status === 409 &&
        r14.body?.code === "BATCH_ABORTED" &&
        deptHitBefore === 0 &&
        deptHitAfter === 0 &&
        histBefore === histAfter &&
        auditBefore === auditAfter,
      JSON.stringify({
        status: r14.status,
        code: r14.body?.code,
        deptHit: [deptHitBefore, deptHitAfter],
        hist: [histBefore, histAfter],
        audit: [auditBefore, auditAfter],
      })
    );
  }

  // ============ [G7-15] 门店合并 预览=执行 + straggler 不自动迁 ============
  {
    // 用 G7-15 专用合法簇 stG15Main(「7治理己」)+ stG15Src(「7治理己店」) 合并
    await prisma.employee.updateMany({
      where: { name: SYN_STRAG },
      data: { storeNameRaw: SYN_G15_SRC, storeId: null },
    });
    const pv = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stG15Main.id}&mergeStoreIds=${stG15Src.id}`
    );
    const snap = pv.body?.data?.snapshot;
    const moveCount = pv.body?.data?.preview?.moveCount;
    const exec = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stG15Main.id, mergeStoreIds: [stG15Src.id], snapshot: snap },
    });
    const moved = exec.body?.data?.employeesMoved;
    // straggler：原文写着 stG15Src 名但 storeId=null，删 stragglers 逻辑后绝不迁移
    const strag = await prisma.employee.findFirst({
      where: { name: SYN_STRAG },
      select: { storeId: true },
    });
    const aliasesNow = await prisma.storeAlias.count({ where: { alias: SYN_G15_SRC } });
    check(
      "G7-15",
      "门店合并 预览数量=执行数量（1 人），straggler（原文写旧名但无 storeId）不自动迁",
      pv.status === 200 &&
        moveCount === 1 &&
        exec.status === 200 &&
        moved === 1 &&
        strag?.storeId === null &&
        aliasesNow >= 1,
      JSON.stringify({
        pvStatus: pv.status,
        moveCount,
        execStatus: exec.status,
        moved,
        stragStoreId: strag?.storeId ?? "missing",
        aliasesNow,
      })
    );
  }

  // ============ [G7-16] INACTIVE 门店不参与候选 / 不可作主店或来源 ============
  {
    // INACTIVE 门店拿不到合法 snapshot（GET 预览直接抛「已停用」），
    // 因此 POST 必然在 snapshot 校验阶段被拒（缺 snapshot → 400，或 ACTIVE → 409）。
    // 构造一个「mainStoreId 指向 stInact」的伪造 snapshot，让请求越过 ①②③④⑤⑥，
    // 直奔 ⑦ ACTIVE 检查 → 抛「主门店已停用」→ 409 MERGE_STATE_CHANGED（不执行任何写入）。
    const { computeDbVersion } = await import("../lib/import-preview-service.ts");
    const dbVer = await computeDbVersion();
    const fakeSnap = {
      dbVersion: dbVer,
      mainStoreId: stInact.id,
      mergeStoreIds: [stCA.id],
      perStoreCount: { [stCA.id]: await prisma.employee.count({ where: { storeId: stCA.id } }) },
      moveCount: 1,
      mainTotalBefore: 0,
    };
    const rMain = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stInact.id, mergeStoreIds: [stCA.id], snapshot: fakeSnap },
    });
    // INACTIVE 作来源：主店用合法 stCA，但被合并是 stInact → 同样越过 snapshot 到 ⑦ 失败
    const fakeSnap2 = {
      dbVersion: dbVer,
      mainStoreId: stCA.id,
      mergeStoreIds: [stInact.id],
      perStoreCount: { [stInact.id]: 0 },
      moveCount: 0,
      mainTotalBefore: await prisma.employee.count({ where: { storeId: stCA.id } }),
    };
    const rSrc = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stCA.id, mergeStoreIds: [stInact.id], snapshot: fakeSnap2 },
    });
    const { findMergeClusters } = await import("../lib/store-merge-service.ts");
    const clusters = await findMergeClusters();
    const inactInClusters = clusters.some((c) => c.stores.some((s) => s.id === stInact.id));
    check(
      "G7-16",
      "INACTIVE 门店：不可作被合并来源（409）、不可作主门店（409），且不进入候选簇",
      rSrc.status === 409 &&
        rMain.status === 409 &&
        rMain.body?.code === "MERGE_STATE_CHANGED" &&
        !inactInClusters,
      JSON.stringify({
        srcStatus: rSrc.status,
        srcCode: rSrc.body?.code,
        mainStatus: rMain.status,
        mainCode: rMain.body?.code,
        inactInClusters,
      })
    );
  }

  // ============ [G7-17] 无启用规则时 unmatched = baseCount ============
  {
    await prisma.departmentRule.updateMany({ data: { enabled: false } });
    const pv = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const d = pv.body?.data;
    const noDept = await prisma.employee.count({ where: { deletedAt: null, departmentId: null } });
    const ok =
      pv.status === 200 &&
      d?.affected === 0 &&
      d?.unmatched === noDept &&
      d?.snapshot?.baseEmployeeCount === noDept;
    // 恢复规则，供后续
    await prisma.departmentRule.updateMany({ data: { enabled: true } });
    check(
      "G7-17",
      "无启用规则时：affected=0，unmatched=baseCount=实时无部门人数（口径一致）",
      ok,
      JSON.stringify({ affected: d?.affected, unmatched: d?.unmatched, noDept })
    );
  }

  // ============ [G7-19] snapshot 与请求错配 → 409 STALE_MERGE_PREVIEW（数据零变化） ============
  {
    // 取 A+C 的合法预览快照（A 主、C 被合并）
    const pv = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stCA.id}&mergeStoreIds=${stCC.id}`
    );
    const snapAC = pv.body?.data?.snapshot;
    // 但请求里却把主店改成 B、被合并仍用 C —— snapshot（A+C）与请求（B+C）错配
    const empBefore = await prisma.employee.count();
    const storeBefore = await prisma.store.count();
    const aliasBefore = await prisma.storeAlias.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stCB.id, mergeStoreIds: [stCC.id], snapshot: snapAC },
    });
    const empAfter = await prisma.employee.count();
    const storeAfter = await prisma.store.count();
    const aliasAfter = await prisma.storeAlias.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange =
      empBefore === empAfter &&
      storeBefore === storeAfter &&
      aliasBefore === aliasAfter &&
      histBefore === histAfter &&
      auditBefore === auditAfter;
    check(
      "G7-19",
      "snapshot 与请求错配（A+C 预览拿去 B+C 执行）→ 409 STALE_MERGE_PREVIEW，五表零变化",
      r.status === 409 && r.body?.code === "STALE_MERGE_PREVIEW" && noChange,
      JSON.stringify({
        status: r.status,
        code: r.body?.code,
        noChange,
      })
    );
  }

  // ============ [G7-20] 缺 snapshot → 400 MERGE_PREVIEW_REQUIRED（数据零变化） ============
  {
    const empBefore = await prisma.employee.count();
    const storeBefore = await prisma.store.count();
    const aliasBefore = await prisma.storeAlias.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stCA.id, mergeStoreIds: [stCB.id] },
    });
    const empAfter = await prisma.employee.count();
    const storeAfter = await prisma.store.count();
    const aliasAfter = await prisma.storeAlias.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange =
      empBefore === empAfter &&
      storeBefore === storeAfter &&
      aliasBefore === aliasAfter &&
      histBefore === histAfter &&
      auditBefore === auditAfter;
    check(
      "G7-20",
      "缺 snapshot → 400 MERGE_PREVIEW_REQUIRED，绝不执行任何写入（五表零变化）",
      r.status === 400 && r.body?.code === "MERGE_PREVIEW_REQUIRED" && noChange,
      JSON.stringify({ status: r.status, code: r.body?.code, noChange })
    );
  }

  // ============ [G7-21] 非同一候选簇 → 409 INVALID_MERGE_CLUSTER（数据零变化） ============
  {
    // X / Y 名称不相似、互不成候选对 → 不属于同一候选簇
    const pv = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stBX.id}&mergeStoreIds=${stBY.id}`
    );
    const snapXY = pv.body?.data?.snapshot;
    // 预览本身可能成功（两个 ACTIVE 门店存在），但执行时候选簇校验必失败
    const empBefore = await prisma.employee.count();
    const storeBefore = await prisma.store.count();
    const aliasBefore = await prisma.storeAlias.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stBX.id, mergeStoreIds: [stBY.id], snapshot: snapXY },
    });
    const empAfter = await prisma.employee.count();
    const storeAfter = await prisma.store.count();
    const aliasAfter = await prisma.storeAlias.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange =
      empBefore === empAfter &&
      storeBefore === storeAfter &&
      aliasBefore === aliasAfter &&
      histBefore === histAfter &&
      auditBefore === auditAfter;
    check(
      "G7-21",
      "非同一候选簇的两个 ACTIVE 门店 → 409 INVALID_MERGE_CLUSTER，五表零变化",
      r.status === 409 && r.body?.code === "INVALID_MERGE_CLUSTER" && noChange,
      JSON.stringify({ status: r.status, code: r.body?.code, noChange, pvStatus: pv.status })
    );
  }

  // ============ [G7-22] 合法簇部分合并（A+B，C 保留）+ snapshot 顺序容忍 ============
  {
    // 候选簇 A/B/C；只合并 A+B（C 保留不动）
    const pv = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stCA.id}&mergeStoreIds=${stCB.id}`
    );
    let snap = pv.body?.data?.snapshot;
    // 验证 snapshot 顺序容忍：把 snapshot.mergeStoreIds 反转，集合不变应仍通过
    snap = { ...snap, mergeStoreIds: [...(snap.mergeStoreIds ?? [])].reverse() };
    const cEmpBefore = await prisma.employee.count({ where: { storeId: stCC.id } });
    const cStatusBefore = (await prisma.store.findUnique({ where: { id: stCC.id } }))?.status;
    const r = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stCA.id, mergeStoreIds: [stCB.id], snapshot: snap },
    });
    const moved = r.body?.data?.employeesMoved;
    const cEmpAfter = await prisma.employee.count({ where: { storeId: stCC.id } });
    const cStatusAfter = (await prisma.store.findUnique({ where: { id: stCC.id } }))?.status;
    const cAliasCreated = await prisma.storeAlias.count({ where: { alias: SYN_CLUSTER_C } });
    const bAliasCreated = await prisma.storeAlias.count({ where: { alias: SYN_CLUSTER_B } });
    const bStatus = (await prisma.store.findUnique({ where: { id: stCB.id } }))?.status;
    check(
      "G7-22",
      "合法簇部分合并 A+B（C 保留 ACTIVE/员工不动/不建 C 别名）+ snapshot 顺序容忍（反转集合不变仍通过）",
      r.status === 200 &&
        moved === 1 &&
        bStatus === "INACTIVE" &&
        bAliasCreated >= 1 &&
        // C 完全不受影响
        cStatusBefore === "ACTIVE" &&
        cStatusAfter === "ACTIVE" &&
        cEmpBefore === cEmpAfter &&
        cAliasCreated === 0,
      JSON.stringify({
        status: r.status,
        moved,
        bStatus,
        bAliasCreated,
        cStatus: [cStatusBefore, cStatusAfter],
        cEmp: [cEmpBefore, cEmpAfter],
        cAliasCreated,
      })
    );
  }

  // ============ [G7-23] 部门规则条件变化（数量不变、命中集合变化）→ 409 STALE_PREVIEW ============
  {
    // G23 候选对：庚/庚店 各挂 3 名无部门员工。
    // 规则先指向庚店（命中 3 人）→ 预览 → 改规则指向庚（仍命中 3 人，但命中集合全换）→ 重新 apply 旧快照。
    // 关键：规则数量不变、匹配总人数不变（3=3），但命中员工集合变化 → 必须 409（不靠 matchedCount 防陈旧）。
    const rule23 = await prisma.departmentRule.create({
      data: { departmentId: dept.id, storeId: stG23B.id, priority: 50, enabled: true },
    });
    // ① 规则指向庚店，预览（命中庚店 3 人）
    const pvBefore = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const snap23 = pvBefore.body?.data?.snapshot;
    const affectedBefore = pvBefore.body?.data?.affected;
    // ② 改规则匹配条件（庚店 → 庚）：规则数量不变、匹配总数不变、命中员工集合全换
    await prisma.departmentRule.update({ where: { id: rule23.id }, data: { storeId: stG23A.id } });
    const pvAfter = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const affectedAfter = pvAfter.body?.data?.affected;
    // ③ 用「旧快照」执行 → 必须 409 STALE_PREVIEW
    const empBefore = await prisma.employee.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r23 = await api("POST", "/api/departments/auto", {
      json: { action: "apply", snapshot: snap23 },
    });
    const empAfter = await prisma.employee.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange = empBefore === empAfter && histBefore === histAfter && auditBefore === auditAfter;
    // 数量不变（3=3）仍然拒绝 —— 证明防陈旧不靠 matchedCount
    check(
      "G7-23",
      "规则条件改（数量不变、命中集合变化）→ 旧快照 apply 409 STALE_PREVIEW，Employee/History/Audit 零变化",
      r23.status === 409 &&
        r23.body?.code === "STALE_PREVIEW" &&
        noChange &&
        affectedBefore === affectedAfter,
      JSON.stringify({
        status: r23.status,
        code: r23.body?.code,
        noChange,
        affected: [affectedBefore, affectedAfter],
      })
    );
    await prisma.departmentRule.delete({ where: { id: rule23.id } });
  }

  // ============ [G7-24] apply 缺 snapshot → 400 DEPARTMENT_PREVIEW_REQUIRED ============
  {
    const empBefore = await prisma.employee.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r24 = await api("POST", "/api/departments/auto", { json: { action: "apply" } });
    const empAfter = await prisma.employee.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange = empBefore === empAfter && histBefore === histAfter && auditBefore === auditAfter;
    check(
      "G7-24",
      "apply 缺 snapshot → 400 DEPARTMENT_PREVIEW_REQUIRED，Employee/History/Audit 零变化",
      r24.status === 400 && r24.body?.code === "DEPARTMENT_PREVIEW_REQUIRED" && noChange,
      JSON.stringify({ status: r24.status, code: r24.body?.code, noChange })
    );
  }

  // ============ [G7-25] 门店别名统一归属全批事务（触发器强制失败 → 409 四表零残留） ============
  {
    // 2 名员工：storeNameRaw=别名原文、storeId=null。注册别名 → 全批重挂。
    // 触发器：任何把员工 storeId 改挂到主店即中止 → 整笔回滚（别名/员工/历史/审计 全部不保留）。
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg713_alias_fail
       BEFORE UPDATE OF storeId ON employee
       WHEN new.storeId = ${stAliasStore.id}
       BEGIN
         SELECT RAISE(ABORT, 'stage7.1.3-test: 强制别名统一归属回滚');
       END`
    );
    const aliasBefore = await prisma.storeAlias.count();
    const empStoreBefore = await prisma.employee.findMany({
      where: { name: { startsWith: SYN_ALIAS_EMP } },
      select: { id: true, storeId: true },
    });
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    const r25 = await api("POST", `/api/stores/${stAliasStore.id}/aliases`, {
      json: { alias: SYN_ALIAS_NAME },
    });
    const aliasAfter = await prisma.storeAlias.count();
    const empStoreAfter = await prisma.employee.findMany({
      where: { name: { startsWith: SYN_ALIAS_EMP } },
      select: { id: true, storeId: true },
    });
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg713_alias_fail`);

    // 整笔回滚后：别名没建、员工没改挂、历史/审计没写（四表前后一致）
    const aliasUnchanged = aliasBefore === aliasAfter;
    const empUnchanged =
      empStoreBefore.length === empStoreAfter.length &&
      empStoreBefore.every((e, i) => e.storeId === empStoreAfter[i]?.storeId);
    const histUnchanged = histBefore === histAfter;
    const auditUnchanged = auditBefore === auditAfter;
    check(
      "G7-25",
      "门店别名统一归属确定性失败 → 全批回滚（StoreAlias/员工/历史/审计 四表零残留，409）",
      r25.status === 409 &&
        aliasUnchanged &&
        empUnchanged &&
        histUnchanged &&
        auditUnchanged,
      JSON.stringify({
        status: r25.status,
        code: r25.body?.code,
        aliasUnchanged,
        empUnchanged,
        histUnchanged,
        auditUnchanged,
      })
    );
  }

  // ============ [G7-26] 门店合并竞态保护（写库前 source 被停用 → 409，五表零变化） ============
  {
    // 癸/癸店 候选对，癸店挂 1 名员工。先预览取快照，再用 raw UPDATE 把 source(癸店)
    // 直接置 INACTIVE（不走 Prisma，不碰 updatedAt → dbVersion 不变），最后执行 merge。
    // 期望：事务外 ACTIVE 预检/事务内二次校验拦住 → 409 MERGE_STATE_CHANGED，五表零变化。
    const pv26 = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stG26A.id}&mergeStoreIds=${stG26B.id}`
    );
    const snap26 = pv26.body?.data?.snapshot;
    // raw UPDATE：只改 status，不碰 updatedAt（保持 dbVersion 不变，精准命中 ACTIVE 校验而非版本校验）
    await prisma.$executeRawUnsafe(`UPDATE store SET status = 'INACTIVE' WHERE id = ${stG26B.id}`);

    const empBefore = await prisma.employee.count();
    const storeCountBefore = await prisma.store.count();
    const aliasBefore = await prisma.storeAlias.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();

    const r26 = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stG26A.id, mergeStoreIds: [stG26B.id], snapshot: snap26 },
    });

    const empAfter = await prisma.employee.count();
    const storeCountAfter = await prisma.store.count();
    const aliasAfter = await prisma.storeAlias.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();

    // 五表零变化：员工/别名/历史/审计 数量不变；门店总数不变（status 是测试预置，非 merge 所为）
    const noChange =
      empBefore === empAfter &&
      storeCountBefore === storeCountAfter &&
      aliasBefore === aliasAfter &&
      histBefore === histAfter &&
      auditBefore === auditAfter;
    check(
      "G7-26",
      "写库前 source 被停用（竞态）→ merge 不执行（409 MERGE_STATE_CHANGED），五表零变化",
      r26.status === 409 && r26.body?.code === "MERGE_STATE_CHANGED" && noChange,
      JSON.stringify({
        status: r26.status,
        code: r26.body?.code,
        noChange,
      })
    );
    // 恢复 source 为 ACTIVE，供 cleanup 正常删店（FK 解绑不受 status 影响）
    await prisma.$executeRawUnsafe(`UPDATE store SET status = 'ACTIVE' WHERE id = ${stG26B.id}`);
  }

  // ============ [G7-27] DepartmentRule CREATE 审计（actor = Session，不可伪造） ============
  {
    const admin = await prisma.appUser.findFirst({ where: { username: "admin" } });
    const expectActor = (admin?.displayName?.trim() || admin?.username?.trim() || "").slice(0, 64);
    const auditBefore = await prisma.auditLog.count();
    // 携带伪造 x-operator 头：审计 actor 必须仍是真实 Session 用户，不能被头覆盖
    const r27 = await api(
      "POST",
      "/api/department-rules",
      {
        json: { departmentId: dept.id, priority: 900, employeeType: "阶段7治理测试工种", enabled: false, remark: "stage7.1.4 测试规则" },
        headers: { "x-operator": "forged-operator" },
      }
    );
    const log = await prisma.auditLog.findFirst({
      where: { entity: "DepartmentRule", action: "CREATE" },
      orderBy: { id: "desc" },
    });
    const ruleId = r27.body?.data?.id;
    const detail = log?.detail ? JSON.parse(log.detail) : null;
    check(
      "G7-27",
      "规则 CREATE：HTTP 成功 + AuditLog +1（entity=DepartmentRule, action=CREATE, actor=Session 用户，x-operator 伪造无效）",
      r27.status === 201 &&
        ruleId !== undefined &&
        (await prisma.auditLog.count()) === auditBefore + 1 &&
        log?.entity === "DepartmentRule" &&
        log?.action === "CREATE" &&
        log?.entityId === String(ruleId) &&
        log?.actor === expectActor &&
        log?.actor !== "forged-operator" &&
        detail?.departmentId === dept.id &&
        detail?.priority === 900 &&
        detail?.enabled === false &&
        detail?.employeeType === "阶段7治理测试工种",
      JSON.stringify({
        status: r27.status,
        ruleId,
        expectActor,
        logActor: log?.actor,
        auditDelta: (await prisma.auditLog.count()) - auditBefore,
      })
    );
    if (ruleId) await prisma.departmentRule.delete({ where: { id: ruleId } });
  }

  // ============ [G7-28] DepartmentRule UPDATE（old/new）+ DELETE（删除前内容）审计 ============
  {
    const admin = await prisma.appUser.findFirst({ where: { username: "admin" } });
    const expectActor = (admin?.displayName?.trim() || admin?.username?.trim() || "").slice(0, 64);
    // 新建一条规则给 G7-28 独立使用（enabled 变化走 UPDATE 审计）
    const rule28 = await prisma.departmentRule.create({
      data: { departmentId: dept.id, priority: 950, enabled: true, remark: "g7-28" },
    });

    // ---- UPDATE：enabled true→false + priority 950→960 + remark 变更；只记变化字段 ----
    const upd = await api("PUT", `/api/department-rules/${rule28.id}`, {
      json: { enabled: false, priority: 960, remark: "g7-28-modified" },
      headers: { "x-operator": "forged-operator" },
    });
    const upLog = await prisma.auditLog.findFirst({
      where: { entity: "DepartmentRule", action: "UPDATE", entityId: String(rule28.id) },
      orderBy: { id: "desc" },
    });
    const upDetail = upLog?.detail ? JSON.parse(upLog.detail) : null;
    const upChanges = upDetail?.changes ?? {};
    const updOk =
      upd.status === 200 &&
      upLog?.entity === "DepartmentRule" &&
      upLog?.entityId === String(rule28.id) &&
      upLog?.actor === expectActor &&
      upLog?.actor !== "forged-operator" &&
      upChanges.enabled?.oldValue === true &&
      upChanges.enabled?.newValue === false &&
      upChanges.priority?.oldValue === 950 &&
      upChanges.priority?.newValue === 960 &&
      upChanges.remark?.oldValue === "g7-28" &&
      upChanges.remark?.newValue === "g7-28-modified";

    // ---- DELETE：审计 detail 必须保存删除前规则内容 ----
    const del = await api("DELETE", `/api/department-rules/${rule28.id}`);
    const delLog = await prisma.auditLog.findFirst({
      where: { entity: "DepartmentRule", action: "DELETE", entityId: String(rule28.id) },
      orderBy: { id: "desc" },
    });
    const delDetail = delLog?.detail ? JSON.parse(delLog.detail) : null;
    const delOk =
      del.status === 200 &&
      (await prisma.departmentRule.count({ where: { id: rule28.id } })) === 0 &&
      delLog?.entity === "DepartmentRule" &&
      delLog?.entityId === String(rule28.id) &&
      delLog?.actor === expectActor &&
      delDetail?.enabled === false &&
      delDetail?.priority === 960 &&
      delDetail?.departmentId === dept.id &&
      delDetail?.remark === "g7-28-modified";
    check(
      "G7-28",
      "规则 UPDATE 审计记录 old/new 变化字段 + DELETE 审计记录删除前内容（actor=Session，伪造无效）",
      updOk && delOk,
      JSON.stringify({
        updStatus: upd.status,
        upChanges: upChanges,
        delStatus: del.status,
        delDetail: delDetail,
        expectActor,
      })
    );
  }

  // ============ [G7-29] StoreAlias DELETE 审计 + 触发器制造审计失败 → 别名删除回滚（零残留） ============
  {
    const admin = await prisma.appUser.findFirst({ where: { username: "admin" } });
    const expectActor = (admin?.displayName?.trim() || admin?.username?.trim() || "").slice(0, 64);
    // 在 G7-25 主店（7别名主店）上新建一个别名供本测试删除
    const rCreate = await api("POST", `/api/stores/${stAliasStore.id}/aliases`, {
      json: { alias: "阶段7别名删除" },
    });
    const alias = await prisma.storeAlias.findFirst({ where: { alias: "阶段7别名删除" } });
    const aliasCntBefore = await prisma.storeAlias.count();
    const auditBefore = await prisma.auditLog.count();

    // ① 正常 DELETE：成功 + AuditLog +1（entity=StoreAlias, action=DELETE, actor=Session）
    const rDel = await api("DELETE", `/api/store-aliases/${alias.id}`, {
      headers: { "x-operator": "forged-operator" },
    });
    const delLog = await prisma.auditLog.findFirst({
      where: { entity: "StoreAlias", action: "DELETE", entityId: String(alias.id) },
      orderBy: { id: "desc" },
    });
    const delDetail = delLog?.detail ? JSON.parse(delLog.detail) : null;
    const delOk =
      rDel.status === 200 &&
      (await prisma.storeAlias.count({ where: { id: alias.id } })) === 0 &&
      (await prisma.auditLog.count()) === auditBefore + 1 &&
      delLog?.actor === expectActor &&
      delLog?.actor !== "forged-operator" &&
      delDetail?.alias === "阶段7别名删除" &&
      delDetail?.storeId === stAliasStore.id;

    // ② 新建第二个别名，用触发器强制 AuditLog 写入失败 → 删除必须整体回滚
    const rCreate2 = await api("POST", `/api/stores/${stAliasStore.id}/aliases`, {
      json: { alias: "阶段7别名删除2" },
    });
    const alias2 = await prisma.storeAlias.findFirst({ where: { alias: "阶段7别名删除2" } });
    const aliasCntBefore2 = await prisma.storeAlias.count();
    const auditBefore2 = await prisma.auditLog.count();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg714_aliasdel_fail
       BEFORE INSERT ON "AuditLog"
       WHEN "AuditLog".entity = 'StoreAlias'
       BEGIN
         SELECT RAISE(ABORT, 'stage7.1.4-test: 强制别名删除审计写入失败');
       END`
    );
    const rDel2 = await api("DELETE", `/api/store-aliases/${alias2.id}`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg714_aliasdel_fail`);
    const aliasAfter2 = await prisma.storeAlias.count();
    const auditAfter2 = await prisma.auditLog.count();
    // 回滚后：别名还在（未删）、审计没新增（未落），零残留零半成功
    const rollbackOk =
      rDel2.status === 409 &&
      rDel2.body?.code === "ALIAS_DELETE_ABORTED" &&
      (await prisma.storeAlias.count({ where: { id: alias2.id } })) === 1 &&
      aliasCntBefore2 === aliasAfter2 &&
      auditBefore2 === auditAfter2;
    // 收尾：删掉残留的测试别名（不带触发器，走审计，正常成功）
    await api("DELETE", `/api/store-aliases/${alias2.id}`);

    check(
      "G7-29",
      "别名 DELETE：成功 +1 审计（actor=Session）；审计写入失败时别名删除整体回滚（零残留）",
      delOk && rollbackOk,
      JSON.stringify({
        delStatus: rDel.status,
        delDetail,
        del2Status: rDel2.status,
        del2Code: rDel2.body?.code,
        aliasUnchangedAfterFail: aliasCntBefore2 === aliasAfter2,
        auditUnchangedAfterFail: auditBefore2 === auditAfter2,
      })
    );
  }

  // ============ [G7-30] 部门 apply 的 overrideExisting 与 snapshot 错配 → 409 STALE_PREVIEW ============
  {
    const empBefore = await prisma.employee.count();
    const histBefore = await prisma.employeeHistory.count();
    const auditBefore = await prisma.auditLog.count();
    // 预览 overrideExisting=false（快照记录 overrideExisting=false）
    const pv30 = await api("POST", "/api/departments/auto", {
      json: { action: "preview", overrideExisting: false },
    });
    const snap30 = pv30.body?.data?.snapshot;
    // 用同一快照但请求 overrideExisting=true → 执行参数与快照绑定不一致 → 必须 409 STALE_PREVIEW
    const r30 = await api("POST", "/api/departments/auto", {
      json: { action: "apply", overrideExisting: true, snapshot: snap30 },
    });
    const empAfter = await prisma.employee.count();
    const histAfter = await prisma.employeeHistory.count();
    const auditAfter = await prisma.auditLog.count();
    const noChange = empBefore === empAfter && histBefore === histAfter && auditBefore === auditAfter;
    check(
      "G7-30",
      "apply 的 overrideExisting 与 snapshot 错配 → 409 STALE_PREVIEW，Employee/History/Audit 零变化",
      r30.status === 409 && r30.body?.code === "STALE_PREVIEW" && noChange,
      JSON.stringify({
        status: r30.status,
        code: r30.body?.code,
        snapOverride: snap30?.overrideExisting,
        noChange,
      })
    );
  }

  // ============ Stage 7.1.5 专用：统一门店解析 resolver（副本库直调 lib） ============
  const storeService = await import("../lib/store-service.ts");

  // ============ [G7-31] INACTIVE 旧店 + Alias 指向 ACTIVE 主店 → resolver 返回主店 ============
  {
    // 场景（setup 已构造）：
    //   stG31Inact「7治理别名旧」= INACTIVE 门店
    //   storeAlias.alias = 「7治理别名旧」→ stG31Main「7治理别名主」(ACTIVE)
    // resolver(rawName = 旧店名) 必须返回 ACTIVE 主店 storeId，绝不能返回 INACTIVE 旧店。
    const rName = await storeService.resolveStoreByName(SYN_G31_INACT);
    const rBatch = await storeService.resolveStoreNamesBatch([SYN_G31_INACT, SYN_G31_MAIN]);
    const ok =
      rName?.storeId === stG31Main.id &&
      rName?.matchedBy === "alias" &&
      rName?.storeId !== stG31Inact.id &&
      // 批量与单值同一规则
      rBatch.get(SYN_G31_INACT)?.storeId === stG31Main.id &&
      rBatch.get(SYN_G31_MAIN)?.storeId === stG31Main.id &&
      rBatch.get(SYN_G31_MAIN)?.matchedBy === "name";
    check(
      "G7-31",
      "resolver：INACTIVE 旧店名 + 有效 Alias → 返回 ACTIVE 主店 storeId（绝不返回 INACTIVE 旧店，批量=单值）",
      !!ok,
      JSON.stringify({
        rName,
        batch: Object.fromEntries(rBatch),
        expectMain: stG31Main.id,
        inact: stG31Inact.id,
      })
    );
  }

  // ============ [G7-32] INACTIVE 同名店且无 Alias → resolver 返回 null ============
  {
    // stG32Inact「7治理无别」= INACTIVE 门店，且没有任何别名指向它或它自身。
    const r = await storeService.resolveStoreByName(SYN_G32_INACT);
    const ok = r?.storeId === null && r?.matchedBy === "inactive-no-alias" && r?.storeId !== stG32Inact.id;
    check(
      "G7-32",
      "resolver：INACTIVE 同名门店且无有效 Alias → storeId=null（不重绑/不复活 INACTIVE 门店）",
      ok,
      JSON.stringify({ r, inact: stG32Inact.id })
    );
  }

  // ============ [G7-33] Excel 导入预览与正式 commit 门店解析一致（旧店名 → ACTIVE 主店） ============
  {
    // 场景：ACTIVE 主店 stG31Main + INACTIVE 旧店 stG31Inact + Alias「7治理别名旧」→ 主店
    // （setup 已构造）。Excel 新员工的门店原文列写「旧店名」，预期：
    //   预览 diff created 行 storeResolution = "alias"（解析规则唯一来源）
    //   正式 commit 后库中员工 storeId = 主店、storeNameRaw 原文保留
    // 两者由同一 resolver 驱动，绝不出现「预览挂 A 店、提交却挂 INACTIVE A」。
    const g33IdCard = "999001199001010001";
    const g33Phone = "13900000001";
    const pv = await uploadPreview(
      { 5001: { 2: SYN_G31_INACT, 5: SYN_G33_EMP + "1", 6: g33IdCard, 7: g33Phone, 3: "2026-07-01" } },
      "stage715-g33.xlsx"
    );
    const created = pv.body?.data?.diff?.created?.find((c) => c.rowNo === 5001);
    const pvResolutionOk =
      pv.status === 201 &&
      created?.storeResolution === "alias" &&
      created?.storeName === SYN_G31_INACT;
    // 预览阶段的 resolver 结果（同一规则的服务端直调）
    const resolver = await storeService.resolveStoreByName(SYN_G31_INACT);

    const commit = await api("POST", `/api/import/preview/${pv.body?.data?.id}`, {});
    const emp = await prisma.employee.findFirst({ where: { name: SYN_G33_EMP + "1" } });
    const commitOk =
      commit.status === 200 &&
      commit.body?.data?.created === 1 &&
      emp?.storeId === stG31Main.id &&
      emp?.storeNameRaw === SYN_G31_INACT &&
      emp?.storeId !== stG31Inact.id;
    check(
      "G7-33",
      "预览与正式 commit 共用同一门店解析：旧店名 → 预览 storeResolution=alias 且 commit storeId=ACTIVE 主店（原文保留、不挂 INACTIVE 旧店）",
      pvResolutionOk && commitOk && resolver?.storeId === stG31Main.id,
      JSON.stringify({
        pvStatus: pv.status,
        createdResolution: created?.storeResolution,
        commitStatus: commit.status,
        empStoreId: emp?.storeId,
        empStoreNameRaw: emp?.storeNameRaw,
        expectMain: stG31Main.id,
      })
    );
  }

  // ============ [G7-34] StoreAlias 创建零迁移也必写 CREATE 审计（actor=Session） ============
  {
    const admin = await prisma.appUser.findFirst({ where: { username: "admin" } });
    const expectActor = (admin?.displayName?.trim() || admin?.username?.trim() || "").slice(0, 64);
    // stG34「7治理导入主」ACTIVE；没有任何员工 storeNameRaw 写「7治理导入旧名」→ 零迁移
    const g34ZeroMig =
      (await prisma.employee.count({ where: { storeNameRaw: SYN_G34_ALIAS } })) === 0;
    const aliasBefore = await prisma.storeAlias.count();
    const auditBefore = await prisma.auditLog.count();
    const r34 = await api("POST", `/api/stores/${stG34.id}/aliases`, {
      json: { alias: SYN_G34_ALIAS },
    });
    const alias = await prisma.storeAlias.findFirst({ where: { alias: SYN_G34_ALIAS } });
    const createLog = await prisma.auditLog.findFirst({
      where: { entity: "StoreAlias", action: "CREATE", entityId: String(alias?.id ?? -1) },
      orderBy: { id: "desc" },
    });
    const cDetail = createLog?.detail ? JSON.parse(createLog.detail) : null;
    const ok =
      g34ZeroMig &&
      r34.status === 201 &&
      r34.body?.data?.applied?.repointed === 0 &&
      alias !== null &&
      (await prisma.storeAlias.count()) === aliasBefore + 1 &&
      (await prisma.auditLog.count()) === auditBefore + 1 &&
      createLog?.actor === expectActor &&
      cDetail?.alias === SYN_G34_ALIAS &&
      cDetail?.storeId === stG34.id;
    check(
      "G7-34",
      "Alias 创建零迁移（repointed=0）也必写 CREATE 审计 +1（actor=Session，entity=StoreAlias）",
      ok,
      JSON.stringify({
        zeroMig: g34ZeroMig,
        status: r34.status,
        repointed: r34.body?.data?.applied?.repointed,
        aliasDelta: (await prisma.storeAlias.count()) - aliasBefore,
        auditDelta: (await prisma.auditLog.count()) - auditBefore,
        actor: createLog?.actor,
      })
    );
  }

  // ============ [G7-35] Alias 创建 + CREATE 审计触发器强制失败 → 整笔回滚（409 四表零残留） ============
  {
    const auditBefore = await prisma.auditLog.count();
    const aliasBefore = await prisma.storeAlias.count();
    const empBefore = await prisma.employee.count();
    const histBefore = await prisma.employeeHistory.count();
    // 触发器：StoreAlias 的 CREATE 审计写入必失败（确定性失败）
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg715_alias_create_fail
       BEFORE INSERT ON "AuditLog"
       WHEN "AuditLog".entity = 'StoreAlias' AND "AuditLog".action = 'CREATE'
       BEGIN
         SELECT RAISE(ABORT, 'stage7.1.5-test: 强制别名 CREATE 审计写入失败');
       END`
    );
    const r35 = await api("POST", `/api/stores/${stG34.id}/aliases`, {
      json: { alias: SYN_G34_ALIAS_2 },
    });
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg715_alias_create_fail`);
    const aliasExists = (await prisma.storeAlias.count({ where: { alias: SYN_G34_ALIAS_2 } })) === 1;
    const ok =
      r35.status === 409 &&
      r35.body?.code === "ALIAS_BATCH_ABORTED" &&
      aliasExists === false &&
      (await prisma.storeAlias.count()) === aliasBefore &&
      (await prisma.employee.count()) === empBefore &&
      (await prisma.employeeHistory.count()) === histBefore &&
      (await prisma.auditLog.count()) === auditBefore;
    check(
      "G7-35",
      "Alias CREATE 审计写入失败 → 整笔回滚（Alias/员工/历史/审计 四表零残留，409 ALIAS_BATCH_ABORTED）",
      ok,
      JSON.stringify({
        status: r35.status,
        code: r35.body?.code,
        aliasExists,
        aliasUnchanged: (await prisma.storeAlias.count()) === aliasBefore,
        empUnchanged: (await prisma.employee.count()) === empBefore,
        histUnchanged: (await prisma.employeeHistory.count()) === histBefore,
        auditUnchanged: (await prisma.auditLog.count()) === auditBefore,
      })
    );
  }

  // ============ [G7-36] merge → alias → import 真实回归（本阶段最重要） ============
  {
    // ① 真实执行门店合并（HTTP）：子(主,ACTIVE) + 子店(源,ACTIVE，2 名员工)
    const pv36 = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stG36Main.id}&mergeStoreIds=${stG36Src.id}`
    );
    const snap36 = pv36.body?.data?.snapshot;
    const exec36 = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: stG36Main.id, mergeStoreIds: [stG36Src.id], snapshot: snap36 },
    });
    const mainAfter = await prisma.store.findUnique({ where: { id: stG36Main.id } });
    const srcAfter = await prisma.store.findUnique({ where: { id: stG36Src.id } });
    const aliasRow = await prisma.storeAlias.findFirst({ where: { alias: SYN_G36_SRC } });
    const mainEmps = await prisma.employee.count({ where: { storeId: stG36Main.id } });
    const srcEmps = await prisma.employee.count({ where: { storeId: stG36Src.id } });
    const mergeOk =
      exec36.status === 200 &&
      mainAfter?.status === "ACTIVE" &&
      srcAfter?.status === "INACTIVE" &&
      aliasRow?.storeId === stG36Main.id &&
      mainEmps === 2 &&
      srcEmps === 0;

    // ② 模拟下一次 Excel 中出现源门店旧名称「7治理子店」（新员工的门店原文列）
    const resolver36 = await storeService.resolveStoreByName(SYN_G36_SRC);
    const pv36b = await uploadPreview(
      { 5002: { 2: SYN_G36_SRC, 5: SYN_G36_IMPORT + "1", 6: "999001199001010002", 7: "13900000002", 3: "2026-08-01" } },
      "stage715-g36.xlsx"
    );
    const created36 = pv36b.body?.data?.diff?.created?.find((c) => c.rowNo === 5002);
    const commit36 = await api("POST", `/api/import/preview/${pv36b.body?.data?.id}`, {});
    const emp36 = await prisma.employee.findFirst({ where: { name: SYN_G36_IMPORT + "1" } });
    const importOk =
      resolver36?.storeId === stG36Main.id &&
      resolver36?.matchedBy === "alias" &&
      resolver36?.storeId !== stG36Src.id &&
      created36?.storeResolution === "alias" &&
      commit36.status === 200 &&
      emp36?.storeId === stG36Main.id &&
      emp36?.storeNameRaw === SYN_G36_SRC;
    check(
      "G7-36",
      "merge→alias→import：合并后主店 ACTIVE/源店 INACTIVE/别名已建/员工已迁；旧店名 Excel 在 resolver/预览/commit 三级一致指向 ACTIVE 主店（绝不指向 INACTIVE 源店）",
      mergeOk && importOk,
      JSON.stringify({
        merge: {
          status: exec36.status,
          main: mainAfter?.status,
          src: srcAfter?.status,
          alias: aliasRow?.storeId === stG36Main.id,
          mainEmps,
          srcEmps,
        },
        resolver: resolver36,
        createdResolution: created36?.storeResolution,
        commitStatus: commit36.status,
        empStoreId: emp36?.storeId,
        empRaw: emp36?.storeNameRaw,
        expectMain: stG36Main.id,
      })
    );
  }

  // ============ [G7-37] 服务器实时 preview 是确认与执行的唯一口径 ============
  {
    // 场景：页面加载时源店 1 人（页面 clusters 快照 = 1）；执行前数据库已变成 2 人。
    // 期望：GET /api/stores/merge 返回的**服务器实时 preview** moveCount=2、
    //       mainTotalAfter=主店真实人数+2 —— 确认框与 POST 的 snapshot 都以它为准。
    // 同时静态检查 StoreMergePanel.tsx：最终确认弹窗不再用 previewOf(...) 的旧页面数据。
    // ① 页面「旧数据」：源店此刻 1 人（setup 只挂了 1 人）
    const staleSnapshotMoveCount = await prisma.employee.count({ where: { storeId: stG37Src.id } });
    const mainRealBefore = await prisma.employee.count({ where: { storeId: stG37Main.id } });

    // ② 制造漂移：源店加到 2 人（页面旧 clusters 仍停留在 1 人）
    await prisma.employee.create({
      data: {
        employeeId: "stage716-g37-src-2",
        name: SYN_G37_EMP + "2",
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeId: stG37Src.id,
      },
    });
    const srcRealNow = await prisma.employee.count({ where: { storeId: stG37Src.id } });

    // ③ 执行前重新请求服务器预览（与前端 merge() 点击「执行合并」时做的 GET 一致）
    const pv37 = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stG37Main.id}&mergeStoreIds=${stG37Src.id}`
    );
    const sp = pv37.body?.data?.preview;
    const snap37 = pv37.body?.data?.snapshot;

    // ④ 静态检查：最终确认弹窗必须读服务器 preview，而不是页面 previewOf()
    const panelSrc = readFileSync(
      path.join(ROOT, "components", "stores", "StoreMergePanel.tsx"),
      "utf8"
    );
    // 抽出 confirm(...) 那一段（从 confirm( 到对应闭合）作为检查范围
    const confirmStart = panelSrc.indexOf("!confirm(");
    const confirmBlock = confirmStart >= 0 ? panelSrc.slice(confirmStart, confirmStart + 1400) : "";
    // 确认块内必须出现服务器 preview 的 5 个字段，且**不得**出现 previewOf(
    const usesServerFields =
      confirmBlock.includes("sp.mainStore.name") &&
      confirmBlock.includes("sp.mergedStores") &&
      confirmBlock.includes("sp.moveCount") &&
      confirmBlock.includes("sp.mainTotalAfter") &&
      confirmBlock.includes("sp.aliasesToCreate");
    const noPreviewOfInConfirm = !confirmBlock.includes("previewOf(");
    // 且不得再有 `let snapshot: unknown`（Stage 7.1.6 已改为 MergePreviewResponse）
    const noUnknownSnapshot = !panelSrc.includes("let snapshot: unknown");
    const postsServerSnapshot = panelSrc.includes("snapshot: serverPreview.snapshot");
    const staticOk =
      confirmStart >= 0 && usesServerFields && noPreviewOfInConfirm && noUnknownSnapshot && postsServerSnapshot;

    const apiOk =
      pv37.status === 200 &&
      staleSnapshotMoveCount === 1 &&
      srcRealNow === 2 &&
      sp?.moveCount === 2 &&
      sp?.mainTotalAfter === mainRealBefore + 2 &&
      sp?.mainStore?.id === stG37Main.id &&
      sp?.mergedStores?.[0]?.id === stG37Src.id &&
      Array.isArray(snap37?.mergeStoreIds);

    check(
      "G7-37",
      "服务器实时 preview 是确认与执行唯一口径：源店 1→2 人漂移后 GET preview.moveCount=2、mainTotalAfter=真实人数+2；静态检查 StoreMergePanel 最终确认用 sp.*（无 previewOf/无 snapshot:unknown、POST 携带 serverPreview.snapshot）",
      apiOk && staticOk,
      JSON.stringify({
        staleSnapshotMoveCount,
        srcRealNow,
        apiMoveCount: sp?.moveCount,
        apiMainTotalAfter: sp?.mainTotalAfter,
        expectAfter: mainRealBefore + 2,
        static: { confirmStart, usesServerFields, noPreviewOfInConfirm, noUnknownSnapshot, postsServerSnapshot },
      })
    );
  }

  // ============ [G7-38] snapshot → 事务之间发生并发改库：事务内最后防线 ============
  {
    // 确定性构造（无 sleep、无定时竞态）：
    //   ① GET /api/stores/merge 拿 snapshot（源店 3 人）
    //   ② 立刻用 Prisma 直接写库把源店加到 4 人（模拟「preview 与真正写入之间被并发修改」）
    //   ③ 用**旧 snapshot** POST /api/stores/merge
    // 期望：409 STALE_MERGE_PREVIEW（事务内复核拦下），
    //       且 Employee / EmployeeHistory / StoreAlias / Store.status / AuditLog 五项零变化。
    //
    // 注：事务外的 assertMergeRequestFresh 本就会先拦下（dbVersion 已变），
    //     本测试的真正价值在于同时验证**事务内**那道防线存在且不产生任何副作用：
    //     即使事务外校验被绕过（未来重构/直调 service），事务内仍必须拦住。
    //     为此额外做一次「直调 service 层」路径的等价验证不可行（需要真实 HTTP 才能拿 session），
    //     故此处通过源码静态断言确认事务内复核块存在，并验证 HTTP 路径五表零变化。

    const before38 = {
      empSrc: await prisma.employee.count({ where: { storeId: stG38Src.id } }),
      empMain: await prisma.employee.count({ where: { storeId: stG38Main.id } }),
      hist: await prisma.employeeHistory.count(),
      alias: await prisma.storeAlias.count(),
      audit: await prisma.auditLog.count(),
      srcStatus: (await prisma.store.findUnique({ where: { id: stG38Src.id } }))?.status,
      mainStatus: (await prisma.store.findUnique({ where: { id: stG38Main.id } }))?.status,
    };

    // ① 预览：此时源店 3 人
    const pv38 = await api(
      "GET",
      `/api/stores/merge?mainStoreId=${stG38Main.id}&mergeStoreIds=${stG38Src.id}`
    );
    const snap38 = pv38.body?.data?.snapshot;
    const previewMove38 = pv38.body?.data?.preview?.moveCount;

    // ② 并发改库：源店 3 人 → 4 人（在 preview 与真正执行之间）
    await prisma.employee.create({
      data: {
        employeeId: "stage716-g38-src-4",
        name: SYN_G38_EMP + "4",
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage7-1-test",
        storeId: stG38Src.id,
      },
    });
    const srcNow38 = await prisma.employee.count({ where: { storeId: stG38Src.id } });

    // ③ 用**旧 snapshot** 执行
    const r38 = await api("POST", "/api/stores/merge", {
      json: {
        mainStoreId: stG38Main.id,
        mergeStoreIds: [stG38Src.id],
        snapshot: snap38,
      },
    });

    const after38 = {
      empSrc: await prisma.employee.count({ where: { storeId: stG38Src.id } }),
      empMain: await prisma.employee.count({ where: { storeId: stG38Main.id } }),
      hist: await prisma.employeeHistory.count(),
      alias: await prisma.storeAlias.count(),
      audit: await prisma.auditLog.count(),
      srcStatus: (await prisma.store.findUnique({ where: { id: stG38Src.id } }))?.status,
      mainStatus: (await prisma.store.findUnique({ where: { id: stG38Main.id } }))?.status,
    };

    // 五项零变化（源店人数因测试自己加的 1 人而 +1，属预期；主店人数必须不变）
    const noChange =
      after38.empMain === before38.empMain &&
      after38.hist === before38.hist &&
      after38.alias === before38.alias &&
      after38.audit === before38.audit &&
      after38.srcStatus === before38.srcStatus &&
      after38.mainStatus === before38.mainStatus &&
      after38.empSrc === before38.empSrc + 1; // 仅测试自己加的那 1 人

    // 静态断言：事务内复核块真实存在（snapshot 校验在 $transaction 内部、写入之前）
    const svcSrc = readFileSync(path.join(ROOT, "lib", "store-merge-service.ts"), "utf8");
    const txIdx = svcSrc.indexOf("prisma.$transaction(async (tx)");
    const inTxGuardIdx = svcSrc.indexOf("computeDbVersion(tx)", txIdx);
    const guardThrowsStale = svcSrc.indexOf("StaleMergePreviewError", inTxGuardIdx);
    // guardIdx 必须落在事务块内（在第一个 employee.update 之前）
    const firstWriteIdx = svcSrc.indexOf("tx.employee.update", txIdx);
    const guardInsideTx = txIdx >= 0 && inTxGuardIdx > txIdx && firstWriteIdx > inTxGuardIdx;

    check(
      "G7-38",
      "snapshot→事务竞态：preview 后源店 3→4 人，用旧 snapshot 执行必须 409 STALE_MERGE_PREVIEW，且 Employee/History/StoreAlias/Store.status/AuditLog 零变化；事务内存在最终 snapshot 复核（computeDbVersion(tx) 在首个写入之前）",
      pv38.status === 200 &&
        previewMove38 === 3 &&
        srcNow38 === 4 &&
        r38.status === 409 &&
        r38.body?.code === "STALE_MERGE_PREVIEW" &&
        noChange &&
        guardInsideTx,
      JSON.stringify({
        previewMove38,
        srcNow38,
        status: r38.status,
        code: r38.body?.code,
        before38,
        after38,
        guardInsideTx: { txIdx, inTxGuardIdx, guardThrowsStale, firstWriteIdx },
      })
    );
  }

  // ============ [G7-39] 最终 confirm 唯一数据源 = 服务器 preview（独立静态断言） ============
  {
    const panel = readFileSync(path.join(ROOT, "components", "stores", "StoreMergePanel.tsx"), "utf8");

    // ① 明确类型存在，且不是 `let snapshot: unknown`
    const hasTypedResponse = /type\s+MergePreviewResponse\s*=/.test(panel);
    const typedShapeOk =
      hasTypedResponse &&
      panel.includes("snapshot: MergePreviewSnapshot") &&
      /preview:\s*\{/.test(panel);
    const noUnknownSnapshot = !panel.includes("let snapshot: unknown");

    // ② confirm 块只读 serverPreview 的 5 个字段
    const cStart = panel.indexOf("!confirm(");
    const cBlock = cStart >= 0 ? panel.slice(cStart, cStart + 1600) : "";
    const confirmUsesServer =
      cBlock.includes("sp.mainStore.name") &&
      cBlock.includes("sp.mergedStores") &&
      cBlock.includes("sp.moveCount") &&
      cBlock.includes("sp.mainTotalAfter") &&
      cBlock.includes("sp.aliasesToCreate");
    const confirmNoPreviewOf = !cBlock.includes("previewOf(");

    // ③ 明确禁止的旧写法：previewOf().moveCount / afterTotal / aliasesToCreate 作为 confirm 数据源
    //    （页面静态展示区允许用 previewOf，但 confirm 块内一律不允许 —— 上面 ② 已覆盖）
    const noConfirmMoveCount = !cBlock.includes("previewOf(idx).moveCount");
    const noConfirmAfterTotal = !cBlock.includes("afterTotal");

    // ④ POST 携带的是 serverPreview.snapshot（与 confirm 同一数据源）
    const postServerSnapshot = panel.includes("snapshot: serverPreview.snapshot");

    // ⑤ previewOf 仍保留但仅用于页面静态展示（必须仍有调用，说明未破坏旧 UI）
    const previewOfStillUsed = panel.includes("previewOf(idx)");

    check(
      "G7-39",
      "最终 confirm 唯一数据源为服务器 preview：存在 MergePreviewResponse 明确类型（无 snapshot:unknown）、confirm 块读 sp.mainStore/sp.mergedStores/sp.moveCount/sp.mainTotalAfter/sp.aliasesToCreate 且不含 previewOf/afterTotal、POST 携带 serverPreview.snapshot；previewOf 保留仅供页面静态展示",
      typedShapeOk &&
        noUnknownSnapshot &&
        confirmUsesServer &&
        confirmNoPreviewOf &&
        noConfirmMoveCount &&
        noConfirmAfterTotal &&
        postServerSnapshot &&
        previewOfStillUsed,
      JSON.stringify({
        hasTypedResponse,
        typedShapeOk,
        noUnknownSnapshot,
        cStart,
        confirmUsesServer,
        confirmNoPreviewOf,
        noConfirmMoveCount,
        noConfirmAfterTotal,
        postServerSnapshot,
        previewOfStillUsed,
      })
    );
  }

  // ============ [G7-18] 清理后零残留 ============
  {
    await removeSynthetic();
    const remainEmp = await prisma.employee.count({ where: { name: { startsWith: "阶段7治理员工" } } });
    const remainMig = await prisma.employee.count({ where: { name: SYN_MIG_EMP } });
    const remainStrag = await prisma.employee.count({ where: { name: SYN_STRAG } });
    const remainDept = await prisma.department.count({ where: { name: SYN_DEPT } });
    const remainRule = await prisma.departmentRule.count({
      where: { department: { name: SYN_DEPT } },
    });
    const remainStore = await prisma.store.count({
      where: {
        name: {
          in: [
            SYN_STORE_MAIN,
            SYN_STORE_A,
            SYN_STORE_B,
            SYN_INACT,
            SYN_CLUSTER_A,
            SYN_CLUSTER_B,
            SYN_CLUSTER_C,
            SYN_BAD_X,
            SYN_BAD_Y,
          ],
        },
      },
    });
    const remainClusterEmp = await prisma.employee.count({ where: { name: "7治理簇员工" } });
    // Stage 7.1.5：G7-36 merge 迁移员工 / G7-33/G7-36 导入创建的新员工 也必须清空
    const remainG36Emp = await prisma.employee.count({ where: { name: { startsWith: SYN_G36_EMP } } });
    const remainG33Emp = await prisma.employee.count({ where: { name: { startsWith: SYN_G33_EMP } } });
    const remainG36Import = await prisma.employee.count({ where: { name: { startsWith: SYN_G36_IMPORT } } });
    // Stage 7.1.6：G7-37 服务器预览口径测试的员工/门店
    const remainG37Emp = await prisma.employee.count({ where: { name: { startsWith: SYN_G37_EMP } } });
    // Stage 7.1.6：G7-38 事务内竞态测试的合成员工/门店
    const remainG38Emp = await prisma.employee.count({
      where: { name: { startsWith: SYN_G38_EMP } },
    });
    const remainG38MainEmp = await prisma.employee.count({
      where: { name: { startsWith: SYN_G38_MAIN_EMP } },
    });
    const remainG38Store = await prisma.store.count({
      where: { name: { in: [SYN_G38_MAIN, SYN_G38_SRC] } },
    });
    // Stage 7.1.5：G31-G36 专用合成门店必须清空
    const remainG15Store = await prisma.store.count({
      where: {
        name: {
          in: [
            SYN_G31_MAIN, SYN_G31_INACT, SYN_G32_INACT, SYN_G34_STORE,
            SYN_G36_MAIN, SYN_G36_SRC, SYN_G37_MAIN, SYN_G37_SRC,
          ],
        },
      },
    });
    const remainG15Alias = await prisma.storeAlias.count({
      where: {
        alias: {
          in: [SYN_G31_INACT, SYN_G34_ALIAS, SYN_G34_ALIAS_2, SYN_G36_SRC],
        },
      },
    });
    const remainAlias = await prisma.storeAlias.count({
      where: {
        alias: {
          in: [
            SYN_STORE_A,
            SYN_STORE_B,
            SYN_INACT,
            SYN_CLUSTER_A,
            SYN_CLUSTER_B,
            SYN_CLUSTER_C,
            SYN_BAD_X,
            SYN_BAD_Y,
          ],
        },
      },
    });
    check(
      "G7-18",
      "清理后零残留（合成 员工/迁移/straggler/簇员工/部门/规则/门店/别名 全清空，含 7.1.5 导入/合并数据）",
      remainEmp === 0 &&
        remainMig === 0 &&
        remainStrag === 0 &&
        remainClusterEmp === 0 &&
        remainG36Emp === 0 &&
        remainG33Emp === 0 &&
        remainG36Import === 0 &&
        remainG37Emp === 0 &&
        remainG38Emp === 0 &&
        remainG38MainEmp === 0 &&
        remainG38Store === 0 &&
        remainDept === 0 &&
        remainRule === 0 &&
        remainStore === 0 &&
        remainG15Store === 0 &&
        remainG15Alias === 0 &&
        remainAlias === 0,
      JSON.stringify({
        remainEmp,
        remainMig,
        remainStrag,
        remainClusterEmp,
        remainG36Emp,
        remainG33Emp,
        remainG36Import,
        remainG37Emp,
        remainG38Emp,
        remainG38MainEmp,
        remainG38Store,
        remainDept,
        remainRule,
        remainStore,
        remainG15Store,
        remainG15Alias,
        remainAlias,
      })
    );
  }

  await cleanup();

  console.log("═".repeat(72));
  console.log(`通过 ${pass} · 失败 ${fail}${fail ? "：" + failures.join("；") : ""}`);
  console.log("═".repeat(72));
  process.exit(fail ? 1 : 0);
}

// 用独立连接直接统计某个 db 文件的员工数（不经过 Prisma 客户端，避免受环境变量影响）
async function countEmployeesInFile(dbFile) {
  const { PrismaClient } = await import("@prisma/client");
  const c = new PrismaClient({ datasourceUrl: "file:" + dbFile });
  try {
    return await c.employee.count({ where: { deletedAt: null } });
  } finally {
    await c.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
