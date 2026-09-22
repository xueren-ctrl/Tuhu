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
 * ============================================================
 */
import { copyFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

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
    // 先解绑 FK（员工 → 全部合成门店 / 合成部门）
    await prisma.employee.updateMany({
      where: {
        storeId: {
          in: [
            stMain.id, stA.id, stB.id, stInact.id, stCA.id, stCB.id, stCC.id, stBX.id, stBY.id,
            stG15Main.id, stG15Src.id, stG23A.id, stG23B.id, stAliasStore.id, stG26A.id, stG26B.id,
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
    // G7-23/26 专用规则（指向 G23/G26 门店）
    await prisma.departmentRule.deleteMany({
      where: { storeId: { in: [stG23A.id, stG23B.id, stG26A.id, stG26B.id] } },
    });
    await prisma.departmentRule.deleteMany({ where: { department: { name: SYN_DEPT } } });
    await prisma.storeAlias.deleteMany({
      where: {
        alias: { in: [SYN_STORE_A, SYN_STORE_B, SYN_INACT, SYN_ALIAS_NAME, ...SYN_CLUSTER_NAMES] },
      },
    });
    await prisma.store.deleteMany({
      where: {
        name: {
          in: [
            SYN_STORE_MAIN, SYN_STORE_A, SYN_STORE_B, SYN_INACT,
            ...SYN_CLUSTER_NAMES, ...SYN_G23_NAMES, SYN_ALIAS_STORE, ...SYN_G26_NAMES,
          ],
        },
      },
    });
    await prisma.department.deleteMany({ where: { name: SYN_DEPT } });
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
      "清理后零残留（合成 员工/迁移/straggler/簇员工/部门/规则/门店/别名 全清空）",
      remainEmp === 0 &&
        remainMig === 0 &&
        remainStrag === 0 &&
        remainClusterEmp === 0 &&
        remainDept === 0 &&
        remainRule === 0 &&
        remainStore === 0 &&
        remainAlias === 0,
      JSON.stringify({
        remainEmp,
        remainMig,
        remainStrag,
        remainClusterEmp,
        remainDept,
        remainRule,
        remainStore,
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
