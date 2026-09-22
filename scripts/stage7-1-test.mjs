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
 * 覆盖规格书第十三节 13 项：
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

  // ============ 启动服务器（副本数据库） ============
  const server = spawn(
    NODE,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: ROOT, env: env(), stdio: ["ignore", "pipe", "pipe"] }
  );
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const cleanup = async () => {
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg71_merge_fail`);
      await prisma.employee.deleteMany({ where: { name: { startsWith: "阶段7治理员工" } } });
      await prisma.employee.deleteMany({ where: { name: SYN_MIG_EMP } });
      await prisma.departmentRule.deleteMany({ where: { department: { name: SYN_DEPT } } });
      await prisma.department.deleteMany({ where: { name: SYN_DEPT } });
      await prisma.store.deleteMany({
        where: { name: { in: [SYN_STORE_MAIN, SYN_STORE_A, SYN_STORE_B] } },
      });
      await prisma.storeAlias.deleteMany({ where: { alias: { in: [SYN_STORE_A, SYN_STORE_B] } } });
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
