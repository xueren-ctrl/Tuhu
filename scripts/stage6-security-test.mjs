/**
 * ============================================================
 * Stage 6.1 安全验收测试（登录限流 / 审计 / 实时角色 / 操作人根除）
 * scripts/stage6-security-test.mjs
 *
 * 运行方式：
 *   npm run build                （必须先重新构建）
 *   npm run test:stage6:security （= tsx scripts/stage6-security-test.mjs）
 *
 * 安全模型（与 stage6 测试一致）：
 *   - data/hr.db 复制为 data/stage6-security-test.db（副本）；
 *   - 副本上 db:push + seed-users（SEED_*_PASSWORD 环境变量 + --reset-password --only=<账号>）；
 *   - DATABASE_URL 指副本，next start -p 3198，全部走真实 HTTP；
 *   - 结束后杀服务器、删副本，生产库 1920 人数据零污染。
 *
 * 覆盖规格书 13 项：
 *   [SEC-01] 无 Cookie 访问业务 API → 401
 *   [SEC-02] 伪造 Cookie（不存在的 sessionId）→ 401
 *   [SEC-03] 真实 Session → 200
 *   [SEC-04] HR 访问 ADMIN 接口 → 403
 *   [SEC-05] 客户端伪造 x-operator 头 → 无效（审计/历史记真实用户）
 *   [SEC-06] 客户端 body.operator 字段 → 被完全忽略
 *   [SEC-07] AppUser 停用 → 原 Session 立即失效
 *   [SEC-08] AppUser 角色修改 → 原 Session 立即使用新角色
 *   [SEC-09] 连续错误密码 → 429（内存限流，单实例）
 *   [SEC-10] 成功登录 → LOGIN_SUCCESS 审计
 *   [SEC-11] 失败登录 → LOGIN_FAILED 审计（不含密码）
 *   [SEC-12] 退出 → LOGOUT 审计
 *   [SEC-13] API 认证覆盖率 = 100%（spawn check-auth-coverage）
 * ============================================================
 */
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";

const ROOT = process.cwd();
const TEST_DB = path.resolve(ROOT, "data", "stage6-security-test.db");
const NODE = process.execPath;
const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;

// 测试专用密码（仅存在于测试环境内存/副本库，绝不作为生产默认值）
// Stage 7.2C：测试密码运行时随机生成，绝不硬编码进仓库（仅作用于一次性副本库）
const TEST_ADMIN_PWD = `Stage6-1#Admin_${crypto.randomBytes(12).toString("hex")}`;
const TEST_HR_PWD = `Stage6-1#Hr_${crypto.randomBytes(12).toString("hex")}`;

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
  // ============ 准备：副本数据库（必须在 import lib/prisma 之前设 DATABASE_URL） ============
  const SRC = path.resolve(ROOT, "data", "hr.db");
  if (!existsSync(SRC)) {
    console.error("❌ 找不到 data/hr.db，请先完成基线导入");
    process.exit(2);
  }
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  copyFileSync(SRC, TEST_DB);
  process.env.DATABASE_URL = "file:" + TEST_DB;
  process.env.SEED_ADMIN_PASSWORD = TEST_ADMIN_PWD;
  process.env.SEED_HR_PASSWORD = TEST_HR_PWD;

  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.error("❌ 未检测到 .next 构建产物：请先执行 npm run build 再跑 test:stage6:security");
    process.exit(2);
  }

  console.log("═".repeat(72));
  console.log("Stage 6.1 安全验收测试  TEST_DB =", TEST_DB);
  console.log("═".repeat(72));

  const env = () => ({
    ...process.env,
    NODE_OPTIONS: "",
    DATABASE_URL: process.env.DATABASE_URL,
    SEED_ADMIN_PASSWORD: TEST_ADMIN_PWD,
    SEED_HR_PASSWORD: TEST_HR_PWD,
  });

  // 副本上保证表结构（Session/AppUser）+ 账号（测试密码；账号已存在故需 --reset-password）
  // Stage 7.2C：--reset-password 必须显式指定 --only（防止误改另一个账号）
  execSync(`"${NODE}" node_modules/prisma/build/index.js db push --skip-generate`, {
    cwd: ROOT,
    env: env(),
    stdio: "inherit",
  });
  for (const only of ["admin", "hr"]) {
    execSync(
      `"${NODE}" node_modules/tsx/dist/cli.mjs scripts/seed-users.ts -- --reset-password --only=${only}`,
      {
        cwd: ROOT,
        env: env(),
        stdio: "inherit",
      }
    );
  }

  const prisma = (await import("../lib/prisma.ts")).prisma; // 此刻连的是副本

  // 合成员工（供 SEC-05/06 修改测试用；测试结束清理）
  const SYN_NAME = "阶段六安全测试员工";
  const SYN_CODE = "THHR2026900010";
  await prisma.employee.deleteMany({ where: { name: SYN_NAME } });
  const emp = await prisma.employee.create({
    data: {
      employeeId: SYN_CODE,
      name: SYN_NAME,
      phone: "13900139010",
      hireDate: new Date("2024-01-10T00:00:00.000Z"),
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage6-security-test",
      dataFlags: null,
    },
  });
  // 合并测试用合成门店（清理生产门店）
  const st1 = await prisma.store.create({ data: { name: "安全测试门店一" } });
  const st2 = await prisma.store.create({ data: { name: "安全测试门店二" } });

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
      await prisma.employee.deleteMany({ where: { name: SYN_NAME } });
      await prisma.store.deleteMany({ where: { name: { in: ["安全测试门店一", "安全测试门店二"] } } });
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
  const api = async (method, p, { json, noAuth, headers = {}, ip } = {}) => {
    const opts = { method, headers: { ...headers }, redirect: "manual" };
    if (ip) opts.headers["X-Forwarded-For"] = ip;
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
  const login = async (username, password, ip) => {
    // 登录请求不附带现有会话（noAuth）；成功时 Set-Cookie 更新 jar，
    // 失败时保留原有 jar（避免一个失败登录把后续用例的会话清空）。
    return api("POST", "/api/auth/login", { json: { username, password }, noAuth: true, ip });
  };

  // ============ [SEC-01] 无 Cookie 访问业务 API → 401 ============
  {
    const r = await api("GET", "/api/stats", { noAuth: true });
    const r2 = await api("POST", "/api/employees", { json: {}, noAuth: true });
    check(
      "SEC-01",
      "无 Cookie 访问业务 API（GET /api/stats、POST /api/employees）→ 401",
      r.status === 401 && r2.status === 401,
      JSON.stringify({ stats: r.status, post: r2.status })
    );
  }

  // ============ [SEC-02] 伪造 Cookie → 401 ============
  {
    jar.cookie = "";
    const r = await api("GET", "/api/stats", {
      headers: { Cookie: "hr_session=deadbeef-forged-cookie" },
    });
    const r2 = await api("GET", "/api/employees?page=1", {
      headers: { Cookie: "hr_session=" + "f".repeat(64) },
    });
    check(
      "SEC-02",
      "伪造 Cookie（不存在的 sessionId）访问业务 API → 401",
      r.status === 401 && r2.status === 401,
      JSON.stringify({ forgedHex: r.status, forgedF: r2.status })
    );
    jar.cookie = "";
  }

  // ============ [SEC-03] 真实 Session → 200（顺带 SEC-10 的 LOGIN_SUCCESS） ============
  {
    const l = await login("hr", TEST_HR_PWD);
    const me = await api("GET", "/api/auth/me");
    const stats = await api("GET", "/api/stats");
    check(
      "SEC-03",
      "真实登录 Session → /api/auth/me、/api/stats 均 200",
      l.status === 200 && me.status === 200 && stats.status === 200,
      JSON.stringify({ login: l.status, me: me.status, stats: stats.status })
    );
    const audit = await prisma.auditLog.findFirst({
      where: { action: "LOGIN_SUCCESS", entityId: String((await prisma.appUser.findUnique({ where: { username: "hr" } })).id) },
      orderBy: { id: "desc" },
    });
    check(
      "SEC-10",
      "成功登录写 LOGIN_SUCCESS 审计（actor = hr）",
      !!audit && audit.actor === "hr",
      JSON.stringify({ audit: audit && { action: audit.action, actor: audit.actor } })
    );
  }

  // ============ [SEC-11] 失败登录 → LOGIN_FAILED（且 detail/summary 不含密码） ============
  {
    const hr = await prisma.appUser.findUnique({ where: { username: "hr" } });
    const before = await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", entityId: String(hr.id) } });
    await login("hr", "wrong-password-xyz", "10.99.99.1"); // 独立来源避免限流互扰
    const after = await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", entityId: String(hr.id) } });
    const row = await prisma.auditLog.findFirst({
      where: { action: "LOGIN_FAILED", entityId: String(hr.id) },
      orderBy: { id: "desc" },
    });
    const noLeak =
      !JSON.stringify(row).includes("wrong-password-xyz") &&
      !JSON.stringify(row).includes(TEST_HR_PWD);
    check(
      "SEC-11",
      "失败登录写 LOGIN_FAILED 审计，且记录中不含任何密码",
      after === before + 1 && noLeak,
      JSON.stringify({ added: after - before, noLeak, summary: row?.summary })
    );
  }

  // ============ [SEC-04] HR 访问 ADMIN 接口 → 403 ============
  {
    const merge = await api("POST", "/api/stores/merge", { json: { mainStoreId: st1.id, mergeStoreIds: [st2.id] } });
    const auto = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const rules = await api("GET", "/api/department-rules");
    check(
      "SEC-04",
      "HR 角色访问 ADMIN 接口（stores/merge、departments/auto、department-rules）→ 403",
      merge.status === 403 && auto.status === 403 && rules.status === 403,
      JSON.stringify({ merge: merge.status, auto: auto.status, rules: rules.status })
    );
  }

  // ============ [SEC-05] 伪造 x-operator 头无效 ============
  {
    const beforeHist = await prisma.employeeHistory.count({ where: { employeeCode: SYN_CODE } });
    const r = await api("PUT", `/api/employees/${emp.id}`, {
      json: { remark: "SEC-05 测试" },
      headers: { "x-operator": "evil-impersonator" },
    });
    const hist = await prisma.employeeHistory.findFirst({
      where: { employeeCode: SYN_CODE },
      orderBy: { id: "desc" },
    });
    check(
      "SEC-05",
      "伪造 x-operator 头无效：变更历史 operator = 登录用户 hr，而非 evil-impersonator",
      r.status === 200 && hist && hist.operator !== "evil-impersonator" && hist.operator === "HR 操作员",
      JSON.stringify({ status: r.status, before: beforeHist, op: hist?.operator })
    );
  }

  // ============ [SEC-06] 客户端 body.operator 字段被忽略 ============
  {
    const r = await api("POST", "/api/employees/batch", {
      json: {
        ids: [emp.id],
        storeId: st1.id,
        operator: "body-evil-operator",
      },
    });
    const hist = await prisma.employeeHistory.findFirst({
      where: { employeeCode: SYN_CODE, source: "BATCH_UPDATE" },
      orderBy: { id: "desc" },
    });
    check(
      "SEC-06",
      "客户端 body.operator 字段被完全忽略（批量修改历史 operator = 登录用户）",
      r.status === 200 && hist && hist.operator !== "body-evil-operator" && hist.operator === "HR 操作员",
      JSON.stringify({ status: r.status, op: hist?.operator })
    );
  }

  // ============ [SEC-07] AppUser 停用 → 原 Session 立即失效 ============
  {
    const hr = await prisma.appUser.findUnique({ where: { username: "hr" } });
    await prisma.appUser.update({ where: { id: hr.id }, data: { status: "DISABLED" } });
    const me = await api("GET", "/api/auth/me");
    const stats = await api("GET", "/api/stats");
    const sess = await prisma.session.findFirst({ where: { userId: hr.id } });
    // 停用期间：旧会话已失效（401）且会话行被销毁
    const disabledOk = me.status === 401 && stats.status === 401 && sess === null;
    await prisma.appUser.update({ where: { id: hr.id }, data: { status: "ACTIVE" } });
    // 恢复 ACTIVE 后，旧 Cookie 指向的会话已被删除，需重新登录才能拿到新会话
    const reLogin = await login("hr", TEST_HR_PWD);
    const meAfter = await api("GET", "/api/auth/me");
    check(
      "SEC-07",
      "AppUser.status=DISABLED 后原 Session 立即失效（401，会话被销毁）；恢复 ACTIVE 后重新登录可正常访问",
      disabledOk && reLogin.status === 200 && meAfter.status === 200,
      JSON.stringify({ meDisabled: me.status, statsDisabled: stats.status, sessionDeleted: sess === null, reLogin: reLogin.status, meAfter: meAfter.status })
    );
  }

  // ============ [SEC-08] AppUser 角色修改 → 原 Session 立即使用新角色 ============
  {
    const hr = await prisma.appUser.findUnique({ where: { username: "hr" } });
    await prisma.appUser.update({ where: { id: hr.id }, data: { role: "ADMIN" } });
    const merge = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: st1.id, mergeStoreIds: [st2.id] },
    });
    const hr2 = await prisma.appUser.findUnique({ where: { username: "hr" } });
    await prisma.appUser.update({ where: { id: hr2.id }, data: { role: "HR" } });
    const mergeAfter = await api("POST", "/api/stores/merge", {
      json: { mainStoreId: st1.id, mergeStoreIds: [st2.id] },
    });
    // 合并实际发生 → 撤销（把 st2 的员工挂回 st2 自身即可；测试里 st2 无员工，无需数据恢复）
    check(
      "SEC-08",
      "角色 HR→ADMIN 后，同一旧 Session 立即获得 ADMIN 权限（非 403）；改回 HR 后立即恢复 403",
      merge.status !== 403 && merge.status !== 401 && mergeAfter.status === 403,
      JSON.stringify({ asAdmin: merge.status, asHrAgain: mergeAfter.status })
    );
  }

  // ============ [SEC-09] 连续错误密码 → 429（同一来源 5 分钟 10 次） ============
  {
    const ip = "10.66.66.66"; // 独立来源，避免与前面用例互扰
    let last = 0;
    const statuses = [];
    for (let i = 1; i <= 10; i++) {
      const r = await api("POST", "/api/auth/login", { json: { username: "hr", password: "bad" }, noAuth: true, ip });
      statuses.push(r.status);
      last = r.status;
    }
    const first9 = statuses.slice(0, 9);
    check(
      "SEC-09",
      "连续错误密码：前 9 次 401，第 10 次触发 429 限流（内存计数，单实例）",
      first9.every((s) => s === 401) && last === 429,
      JSON.stringify({ statuses })
    );
    // 限流解除前即使密码正确也应 429
    const correctWhileBlocked = await api("POST", "/api/auth/login", { json: { username: "hr", password: TEST_HR_PWD }, noAuth: true, ip });
    check(
      "SEC-09b",
      "限流窗口内即使密码正确也拒绝（429），防止爆破成功后放行",
      correctWhileBlocked.status === 429,
      JSON.stringify({ status: correctWhileBlocked.status })
    );
  }

  // ============ [SEC-12] 退出 → LOGOUT 审计 + 会话销毁 ============
  {
    await login("hr", TEST_HR_PWD); // 重新拿会话（jar）
    const hr = await prisma.appUser.findUnique({ where: { username: "hr" } });
    const out = await api("POST", "/api/auth/logout");
    const me = await api("GET", "/api/auth/me");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "LOGOUT", entityId: String(hr.id) },
      orderBy: { id: "desc" },
    });
    check(
      "SEC-12",
      "退出登录：LOGOUT 审计（actor = hr）+ 会话销毁（再访问 me → 401）",
      out.status === 200 && !!audit && audit.actor === "hr" && me.status === 401,
      JSON.stringify({ out: out.status, auditActor: audit?.actor, meAfter: me.status })
    );
  }

  // ============ [SEC-13] API 认证覆盖率 100% ============
  {
    // Windows 下同步 spawn（execSync/execFileSync）派生第二个 node 进程会因
    // node.exe 句柄锁报 EBUSY，故用异步 spawn + await（与启动 next 服务器同一机制）。
    const runAuthCheck = () =>
      new Promise((resolve) => {
        const child = spawn(NODE, ["scripts/check-auth-coverage.mjs"], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
        child.on("error", (e) => resolve({ code: 1, out: out + String(e) }));
      });
    let ok = true;
    let detail = "";
    const r = await runAuthCheck();
    if (r.code === 0) {
      detail = "check:auth exit 0";
    } else {
      ok = false;
      detail = (r.out || r.err).slice(-500);
    }
    check("SEC-13", "API 认证覆盖率 = 100%（scripts/check-auth-coverage.mjs）", ok, detail);
  }

  // ============ 收尾 ============
  await cleanup();

  console.log("─".repeat(72));
  console.log(`Stage 6.1 安全测试：通过 ${pass} / ${pass + fail}${fail ? `   ❌ 失败 ${fail}` : ""}`);
  if (fail > 0) {
    console.log("失败项：\n  " + failures.join("\n  "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("❌ 测试执行异常：", e);
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  process.exit(1);
});
