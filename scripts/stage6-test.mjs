/**
 * ============================================================
 * 第六阶段验收测试 —— 登录 / 权限 / 审计 / 导入加固
 * scripts/stage6-test.mjs
 *
 * 运行方式：
 *   npm run build          （必须先重新构建，测试驱动 next start）
 *   npm run test:stage6    （= tsx scripts/stage6-test.mjs）
 *
 * 设计（与 stage5 测试同一安全模型）：
 *   - 把 data/hr.db 复制成 data/stage6-test.db；
 *   - 在副本上执行 db:push + seed-users（保证 Session 表与账号存在）；
 *   - 用 DATABASE_URL=副本 启动 next -p 3199；
 *   - 全部 API 通过真实 HTTP 请求验证（登录 Cookie / 中间件 401 / 路由守卫 / 角色 403）；
 *   - 结束后杀掉服务器、删除副本，生产库 1920 人数据不被污染。
 *
 * ⚠ 只使用合成数据（假身份证 / 假手机号，与 pre-push-check 白名单同一批号码），
 *   可安全提交到代码仓库。
 *
 * 覆盖需求书第六阶段验证点：
 *   [S6-01] 登录成功 200 + HttpOnly 会话 Cookie（服务端 Session 落库）
 *   [S6-02] 登录失败 401（错误密码 / 不存在用户）
 *   [S6-03] 未登录访问业务 API/页面：一律 401 / 302→/login（中间件拦截）
 *   [S6-04] /api/auth/me：有会话返回真实用户；登出后 401
 *   [S6-05] HR 角色可做：员工查询/编辑、预览导入、门店/职位/部门设置
 *   [S6-06] HR 角色被拒：stores/merge、departments/auto、department-rules → 403
 *   [S6-07] ADMIN 角色可做：上述门禁全部通过
 *   [S6-08] 伪造 x-operator 无效：审计/变更记录的操作人是登录者而非请求头
 *   [S6-09] 审计日志记录真实用户（actor = 登录 HR）
 *   [S6-10] 文件完整性：预览后篡改存储文件 → 提交 409 FILE_CHANGED
 *   [S6-11] 版本保护：预览后改库 → 提交 409 VERSION_CONFLICT
 *   [S6-12] 重试版本基线：提交后改库 → 带 retry 的重试 409
 *   [S6-13] 逐员工事务（SQLite 触发器制造确定性失败）：
 *           一行失败只回滚该员工（档案+历史同事务回滚），其他行照常成功（207）；
 *           去掉触发器后「重试失败项」成功（200）
 *   [S6-14] 46 字段回归矩阵（数据驱动 46 列）：Diff 敏感字段脱敏展示、
 *           库内为真实值、预览 JSON 不外发原始敏感值，46/46 通过
 *   [S6-15] 计算字段实时化：lib/tenure 从 hireDate/resignDate 推算，
 *           与导入快照字段完全解耦
 * ============================================================
 */
import {
  copyFileSync,
  existsSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import ExcelJS from "exceljs";

const ROOT = process.cwd();
const TEST_DB = path.resolve(ROOT, "data", "stage6-test.db");
const NODE = process.execPath;

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

// 合成数据（假身份证 / 假手机号，与 pre-push-check.mjs 白名单同一批，可安全提交）
const SYN = {
  name: "阶段六测试员工甲",
  idCard: "110101199003078818",
  phone: "13800138000",
  hire: "2022-05-10",
  phoneNew: "13900139000",
  nameB: "阶段六测试员工乙",
  idCardB: "110101199003078819",
  phoneB: "13800138001",
  hireB: "2023-06-01",
  phoneBNew: "13900139001",
  newEmp: "阶段六导入新员工",
  newEmpIdCard: "110101199501011234",
  newEmpHire: "2024-04-01",
  newEmpPhone: "13900000001",
};

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

  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.error("❌ 未检测到 .next 构建产物：请先执行 npm run build 再跑 test:stage6");
    process.exit(2);
  }

  console.log("═".repeat(72));
  console.log("第六阶段验收测试  TEST_DB =", TEST_DB);
  console.log("═".repeat(72));

  const env = () => ({
    ...process.env,
    NODE_OPTIONS: "",
    DATABASE_URL: process.env.DATABASE_URL,
  });

  // 副本上保证 Session/AppUser 表结构与账号（幂等）
  execSync(`"${NODE}" node_modules/prisma/build/index.js db push --skip-generate`, {
    cwd: ROOT,
    env: env(),
    stdio: "inherit",
  });
  execSync(`"${NODE}" node_modules/tsx/dist/cli.mjs scripts/seed-users.ts`, {
    cwd: ROOT,
    env: env(),
    stdio: "inherit",
  });

  // 在副本里建合成员工（测试前清理 + 重建，保证可复现）
  const prisma = (await import("../lib/prisma.ts")).prisma; // 此刻连的是副本
  const CODE_A = "THHR2026900001";
  const CODE_B = "THHR2026900002";
  const CODE_46 = "THHR2026900003";
  const cleanSynthetic = async () => {
    await prisma.employee.deleteMany({
      where: { name: { in: [SYN.name, SYN.nameB, SYN.newEmp, "阶段六46员工"] } },
    });
    await prisma.importPreview.deleteMany({ where: { fileName: { startsWith: "stage6-" } } });
  };
  await cleanSynthetic();
  const empA = await prisma.employee.create({
    data: {
      employeeId: CODE_A,
      name: SYN.name,
      idCardNo: SYN.idCard,
      phone: SYN.phone,
      hireDate: new Date(SYN.hire + "T00:00:00.000Z"),
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage6-test",
      dataFlags: null,
    },
  });
  const empB = await prisma.employee.create({
    data: {
      employeeId: CODE_B,
      name: SYN.nameB,
      idCardNo: SYN.idCardB,
      phone: SYN.phoneB,
      hireDate: new Date(SYN.hireB + "T00:00:00.000Z"),
      status: "ACTIVE",
      sourceSheet: "数据库",
      importBatch: "stage6-test",
      dataFlags: null,
    },
  });

  // ============ 启动 next 服务器（副本数据库） ============
  const PORT = 3199;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(NODE, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const cleanup = async () => {
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_stage6_s6_13`);
    } catch {}
    try {
      server.kill();
    } catch {}
    await prisma.$disconnect();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  };

  // 等待服务器就绪
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

  // ---- fetch 工具（简单 cookie jar）----
  const jar = { cookie: "" };
  const api = async (method, p, { json, form, noAuth, headers = {} } = {}) => {
    const opts = { method, headers: { ...headers }, redirect: "manual" };
    if (!noAuth && jar.cookie && !jar.cookie.endsWith("hr_session=")) opts.headers["Cookie"] = jar.cookie;
    if (form) opts.body = form;
    else if (json !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(json);
    }
    const res = await fetch(BASE + p, opts);
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const first = sc.split(";")[0];
      if (first.startsWith("hr_session=")) jar.cookie = first; // 空值=登出
    }
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body, res };
  };
  const login = async (username, password) => {
    jar.cookie = "";
    return api("POST", "/api/auth/login", { json: { username, password }, noAuth: true });
  };

  // ---- 工作簿构造（表头与解析器 EXPECTED_HEADER / FIELD_SPECS 对齐）----
  function buildWorkbook(rows /* {rowNo: {colNo: value}} */) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据库");
    ws.getCell(1, 1).value = "（旧版残留占位）";
    const headers = {
      1: "序号", 2: "门店名称", 3: "入职时间", 4: "在职年限", 5: "姓名",
      6: "身份证号", 7: "联系电话", 8: "工种级别", 9: "职位备注", 10: "是否住宿舍",
      11: "社保购买", 12: "紧急联系人1", 13: "紧急联系人电话1", 14: "紧急联系人2",
      15: "紧急联系人电话2", 16: "劳动合同", 17: "社保协议", 18: "消防承诺书",
      19: "宿舍免责协议", 20: "入职体检", 21: "工资卡的开户银行支行", 22: "银行卡账号",
      23: "薪资待遇", 24: "现居住地址", 25: "招聘人", 26: "离职原因", 27: "备注",
      28: "年龄", 29: "面试时间", 30: "面试地点", 31: "面试结果", 32: "面试人",
      33: "是否入职", 34: "简历表", 35: "面试评估表", 36: "在职年限", 37: "首月保障",
      38: "备注", 39: "带教人", 40: "入职表", 41: "面试评估表", 42: "证书级别",
      43: "备注", 44: "是否满7天", 45: "是否入职满2个月", 46: "未成年备注",
    };
    for (const [c, t] of Object.entries(headers)) ws.getCell(2, Number(c)).value = t;
    for (const [rowNo, cols] of Object.entries(rows)) {
      for (const [col, val] of Object.entries(cols)) {
        if (val === undefined || val === null) continue;
        ws.getCell(Number(rowNo), Number(col)).value = val;
      }
    }
    return wb;
  }
  const bufferOf = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());
  const upload = async (wb, name) => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(await bufferOf(wb))]), name);
    return api("POST", "/api/import/preview", { form: fd });
  };

  // ============ [S6-02] 登录失败（未登录状态下测） ============
  {
    const bad = await login("hr", "wrong-password");
    const nobody = await api("POST", "/api/auth/login", { json: { username: "ghost_user", password: "x" }, noAuth: true });
    check(
      "S6-02",
      "登录失败：错误密码 / 不存在用户均 401 且不产生会话",
      bad.status === 401 && nobody.status === 401,
      JSON.stringify({ bad: bad.status, nobody: nobody.status })
    );
  }

  // ============ [S6-03] 未登录访问业务 API/页面一律被拦 ============
  {
    const u = {
      "GET /api/employees": (await api("GET", "/api/employees", { noAuth: true })).status,
      "POST /api/employees": (await api("POST", "/api/employees", { json: { name: "x" }, noAuth: true })).status,
      "PUT /api/employees/:id": (await api("PUT", `/api/employees/${empA.id}`, { json: { remark: "x" }, noAuth: true })).status,
      "DELETE /api/employees/:id": (await api("DELETE", `/api/employees/${empA.id}`, { noAuth: true })).status,
      "POST /api/import/preview": (await api("POST", "/api/import/preview", { json: {}, noAuth: true })).status,
      "POST /api/stores/merge": (await api("POST", "/api/stores/merge", { json: { mainStoreId: 1, mergeStoreIds: [2] }, noAuth: true })).status,
      "GET /api/statistics": (await api("GET", "/api/statistics", { noAuth: true })).status,
      "GET /api/data-quality": (await api("GET", "/api/data-quality", { noAuth: true })).status,
      "GET /api/employees/:id": (await api("GET", `/api/employees/${empA.id}`, { noAuth: true })).status,
    };
    check(
      "S6-03",
      "未登录访问业务 API 一律 401（GET/POST/PUT/DELETE）",
      Object.values(u).every((s) => s === 401),
      JSON.stringify(u)
    );
    const pg = await fetch(`${BASE}/employees`, { redirect: "manual" });
    check(
      "S6-03b",
      "未登录访问业务页面 → 30x 重定向 /login（携带 redirect 参数）",
      (pg.status === 302 || pg.status === 307) && String(pg.headers.get("location")).includes("/login"),
      `status=${pg.status} location=${pg.headers.get("location")}`
    );
  }

  // ============ [S6-01] 登录成功（HR） ============
  {
    const r = await login("hr", "Tuhu@Hr2026");
    const scHeader = r.res.headers.get("set-cookie") ?? "";
    const sid = jar.cookie.split("=")[1];
    const sessionRow = sid ? await prisma.session.findUnique({ where: { id: sid } }) : null;
    check(
      "S6-01",
      "登录成功：200 + HttpOnly 会话 Cookie + 服务端 Session 落库",
      r.status === 200 &&
        /hr_session=/.test(scHeader) &&
        /httponly/i.test(scHeader) &&
        !!sessionRow &&
        sessionRow.role === "HR" &&
        sessionRow.username === "hr",
      JSON.stringify({ status: r.status, httpOnly: /httponly/i.test(scHeader), dbSession: !!sessionRow })
    );
  }

  // ============ [S6-04] /api/auth/me + 登出 ============
  {
    const me = await api("GET", "/api/auth/me");
    const out = await api("POST", "/api/auth/logout");
    const me2 = await api("GET", "/api/auth/me", { noAuth: true });
    check(
      "S6-04",
      "/api/auth/me 返回真实用户；登出后会话销毁再访问 401",
      me.status === 200 && me.body?.user?.username === "hr" && me.body?.user?.role === "HR" &&
        out.status === 200 && me2.status === 401,
      JSON.stringify({ me: me.body?.user, out: out.status, me2: me2.status })
    );
  }

  // ============ [S6-05] HR 角色可做 ============
  {
    await login("hr", "Tuhu@Hr2026");
    const getEmployees = await api("GET", "/api/employees?pageSize=5");
    const putEmp = await api("PUT", `/api/employees/${empA.id}`, { json: { remark: "阶段六编辑" } });
    const createStore = await api("POST", "/api/stores", { json: { name: "阶段六测试门店" } });
    const storeId = createStore.body?.data?.id;
    const putStore = await api("PUT", `/api/stores/${storeId}`, { json: { code: "S6ST" } });
    const createPos = await api("POST", "/api/positions", { json: { name: "阶段六测试职位" } });
    const posId = createPos.body?.data?.id;
    const putPos = await api("PUT", `/api/positions/${posId}`, { json: { level: "L6" } });
    const patchDept = await api("PATCH", "/api/departments/1", { json: { status: "ACTIVE" } });
    const patchPos = await api("PATCH", `/api/positions/${posId}`, { json: { status: "INACTIVE" } });
    const wb = buildWorkbook({ 3: { 5: SYN.name, 6: SYN.idCard, 7: SYN.phone, 3: SYN.hire } });
    const preview = await upload(wb, "stage6-hr.xlsx");
    check(
      "S6-05",
      "HR 角色可做：员工查询/编辑、门店/职位/部门设置、预览导入",
      getEmployees.status === 200 &&
        putEmp.status === 200 &&
        createStore.status === 201 &&
        putStore.status === 200 &&
        createPos.status === 201 &&
        putPos.status === 200 &&
        patchDept.status === 200 &&
        patchPos.status === 200 &&
        preview.status === 201,
      JSON.stringify({
        getEmployees: getEmployees.status, putEmp: putEmp.status,
        createStore: createStore.status, putStore: putStore.status,
        createPos: createPos.status, putPos: putPos.status,
        patchDept: patchDept.status, patchPos: patchPos.status, preview: preview.status,
      })
    );
    if (storeId) await prisma.store.delete({ where: { id: storeId } });
    if (posId) await prisma.position.delete({ where: { id: posId } });
    const pvId = preview.body?.data?.id;
    if (pvId) await prisma.importPreview.delete({ where: { id: pvId } });
  }

  // ============ [S6-06] HR 角色被拒（ADMIN 专属） ============
  {
    const merge = await api("POST", "/api/stores/merge", { json: { mainStoreId: 1, mergeStoreIds: [2] } });
    const autoDept = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const rules = await api("GET", "/api/department-rules");
    check(
      "S6-06",
      "HR 角色被拒：stores/merge、departments/auto、department-rules → 403",
      merge.status === 403 && autoDept.status === 403 && rules.status === 403,
      JSON.stringify({ merge: merge.status, autoDept: autoDept.status, rules: rules.status })
    );
  }

  // ============ [S6-07] ADMIN 角色可做 ============
  {
    await login("admin", "Tuhu@Admin2026");
    const me = await api("GET", "/api/auth/me");
    const s1 = await prisma.store.findFirst({ orderBy: { id: "asc" } });
    const s2 = await prisma.store.findFirst({ where: { id: { not: s1.id } }, orderBy: { id: "asc" } });
    const merge = await api("POST", "/api/stores/merge", { json: { mainStoreId: s1.id, mergeStoreIds: [s2.id] } });
    const autoDept = await api("POST", "/api/departments/auto", { json: { action: "preview" } });
    const rules = await api("GET", "/api/department-rules");
    check(
      "S6-07",
      "ADMIN 角色可做：stores/merge、departments/auto、department-rules 门禁通过（非 401/403）",
      me.body?.user?.role === "ADMIN" &&
        [merge.status, autoDept.status, rules.status].every((s) => s === 200 || s === 400),
      JSON.stringify({ role: me.body?.user?.role, merge: merge.status, autoDept: autoDept.status, rules: rules.status, mergeMsg: merge.body?.error ?? merge.body?.ok })
    );
    await login("hr", "Tuhu@Hr2026"); // 切回 HR（后续用例用 HR 会话）
  }

  // ============ [S6-08] 伪造 x-operator 无效 ============
  {
    await prisma.employeeHistory.deleteMany({ where: { employeeCode: CODE_A } });
    const r = await api("PUT", `/api/employees/${empA.id}`, {
      json: { remark: "阶段六 x-operator 测试" },
      headers: { "x-operator": "evil-impersonator" },
    });
    const audit = await prisma.auditLog.findFirst({ where: { entityId: String(empA.id) }, orderBy: { id: "desc" } });
    const hist = await prisma.employeeHistory.findFirst({ where: { employeeCode: CODE_A }, orderBy: { id: "desc" } });
    check(
      "S6-08",
      "伪造 x-operator 无效：审计/变更记录的操作人 = 登录用户，而非请求头",
      r.status === 200 &&
        audit?.actor === "HR 操作员" &&
        hist?.operator === "HR 操作员" &&
        audit?.actor !== "evil-impersonator" &&
        hist?.operator !== "evil-impersonator",
      JSON.stringify({ auditActor: audit?.actor, histOperator: hist?.operator })
    );
  }

  // ============ [S6-09] 审计记录真实用户 ============
  {
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: String(empA.id), action: "UPDATE" },
      orderBy: { id: "desc" },
    });
    check(
      "S6-09",
      "审计日志记录真实用户（actor = 登录 HR 操作员）",
      audit?.actor === "HR 操作员",
      JSON.stringify({ actor: audit?.actor, id: audit?.id })
    );
  }

  // ============ 共享工作簿（行5001=甲 modified / 行5002=新员工 create / 行5003=乙 modified） ============
  // ⚠ 行号刻意取 5001+：生产库 EmployeeSourceRow 溯源映射最大行号仅 ~1936，
  //   若用 3/4/5 会与「数据库」Sheet 的第 4 行真实员工撞车（sourceRow 级联误匹配）。
  const wbMulti = buildWorkbook({
    5001: { 5: SYN.name, 6: SYN.idCard, 7: SYN.phoneNew, 3: SYN.hire },
    5002: { 5: SYN.newEmp, 7: SYN.newEmpPhone, 3: SYN.newEmpHire, 6: SYN.newEmpIdCard },
    5003: { 5: SYN.nameB, 6: SYN.idCardB, 7: SYN.phoneBNew, 3: SYN.hireB },
  });

  // ============ [S6-10] 文件完整性（FILE_CHANGED） ============
  {
    const p = await upload(wbMulti, "stage6-fc.xlsx");
    const pid = p.body?.data?.id;
    check(
      "S6-10-setup",
      "预览创建成功（服务端记录 fileSha256 指纹）",
      p.status === 201 && !!p.body?.data?.fileSha256,
      JSON.stringify({ status: p.status, sha: (p.body?.data?.fileSha256 ?? "").slice(0, 12) })
    );
    const row = await prisma.importPreview.findUnique({ where: { id: pid } });
    const storedFile = path.resolve(ROOT, row.storedPath);
    const fh = openSync(storedFile, "r+");
    writeSync(fh, Buffer.from("X")); // 篡改 1 字节（把偏移 0 处写成 'X'）
    closeSync(fh);
    const c = await api("POST", `/api/import/preview/${pid}`, {});
    check(
      "S6-10",
      "文件完整性：预览后篡改存储文件 → 提交 409 FILE_CHANGED",
      c.status === 409 && c.body?.code === "FILE_CHANGED",
      JSON.stringify({ status: c.status, code: c.body?.code, error: c.body?.error?.slice(0, 40) })
    );
    await prisma.importPreview.delete({ where: { id: pid } });
  }

  // ============ [S6-11] 版本保护（预览后改库 → 409） ============
  {
    const p = await upload(wbMulti, "stage6-vc.xlsx");
    const pid = p.body?.data?.id;
    await prisma.employee.update({ where: { id: empB.id }, data: { remark: "预览后被外部改动" } });
    const c = await api("POST", `/api/import/preview/${pid}`, {});
    check(
      "S6-11",
      "版本保护：预览后改库 → 提交 409 VERSION_CONFLICT",
      c.status === 409 && c.body?.code === "VERSION_CONFLICT",
      JSON.stringify({ status: c.status, code: c.body?.code })
    );
    await prisma.importPreview.delete({ where: { id: pid } });
  }

  // ============ [S6-12] 重试版本基线 + [S6-13] 逐员工事务（触发器场景） ============
  // 用一个 SQLite 触发器制造「乙那行写库必失败」的确定性场景，
  // 同时验证：逐员工事务回滚（S6-13）+ 提交后改库的 retry 版本保护（S6-12）。
  {
    // 现场确认：甲/乙手机号为原值
    const aBefore = await prisma.employee.findUnique({ where: { id: empA.id } });
    const bBefore = await prisma.employee.findUnique({ where: { id: empB.id } });
    if (aBefore.phone !== SYN.phone || bBefore.phone !== SYN.phoneB) {
      await prisma.employee.update({ where: { id: empA.id }, data: { phone: SYN.phone, remark: null } });
      await prisma.employee.update({ where: { id: empB.id }, data: { phone: SYN.phoneB, remark: null } });
      await prisma.employee.deleteMany({ where: { name: SYN.newEmp } });
    }

    // 挂触发器：乙的手机号更新到 phoneBNew 时中止（模拟「这一行写库失败」）
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER IF NOT EXISTS trg_stage6_s6_13
       AFTER UPDATE OF phone ON employee
       WHEN old.name = '${SYN.nameB}' AND new.phone = '${SYN.phoneBNew}'
       BEGIN
         SELECT RAISE(ABORT, 'stage6-test: 模拟乙的档案写入失败');
       END`
    );

    const p = await upload(wbMulti, "stage6-tx.xlsx");
    const pid = p.body?.data?.id;
    const diff = p.body?.data?.diff;
    const aInPreview = diff?.modified?.find((m) => m.employeeCode === CODE_A);
    const bInPreview = diff?.modified?.find((m) => m.employeeCode === CODE_B);
    check(
      "S6-13-setup",
      "预览 Diff 同时包含甲、乙两人（且乙的手机号变化已脱敏展示）",
      !!aInPreview && !!bInPreview &&
        bInPreview.changes.some((ch) => ch.field === "phone" && ch.displayNewValue?.includes("*")),
      JSON.stringify({ a: !!aInPreview, b: !!bInPreview, bPhoneMasked: bInPreview?.changes.find((ch) => ch.field === "phone")?.displayNewValue })
    );

    // 首次提交：甲成功 / 新员工成功 / 乙被触发器中止 → 207 PARTIAL
    const c1 = await api("POST", `/api/import/preview/${pid}`, {});
    const aAfter = await prisma.employee.findUnique({ where: { id: empA.id } });
    const bAfter = await prisma.employee.findUnique({ where: { id: empB.id } });
    const createdNew = await prisma.employee.findFirst({ where: { name: SYN.newEmp } });
    check(
      "S6-13",
      "逐员工事务：一行失败不阻断其他行（207 PARTIAL；甲 + 新员工照常写入真实值）",
      c1.status === 207 &&
        c1.body?.data?.updated === 1 &&
        c1.body?.data?.created === 1 &&
        c1.body?.data?.failed === 1 &&
        c1.body?.data?.failures?.[0]?.rowNo === 5003 &&
        aAfter?.phone === SYN.phoneNew &&
        !!createdNew,
      JSON.stringify({ status: c1.status, updated: c1.body?.data?.updated, created: c1.body?.data?.created, failed: c1.body?.data?.failed, failRow: c1.body?.data?.failures?.[0]?.rowNo, aPhone: aAfter?.phone })
    );
    // 成功行的「档案 + 变更历史」同事务落库（历史已脱敏）
    const aHistory = await prisma.employeeHistory.findFirst({
      where: { employeeCode: CODE_A, source: "BATCH_UPDATE", fieldName: "phone" },
    });
    check(
      "S6-13b",
      "成功行「档案更新 + 变更历史」同事务落库（历史值已脱敏，非明文）",
      !!aHistory && aHistory.newValue?.includes("*") && aHistory.newValue !== SYN.phoneNew,
      JSON.stringify({ hasHistory: !!aHistory, maskedNew: aHistory?.newValue })
    );
    // 失败行完整回滚：乙的手机号保持原值、且无该行的变更历史残留
    const bOrphan = await prisma.employeeHistory.findFirst({
      where: { employeeCode: CODE_B, source: "BATCH_UPDATE", fieldName: "phone" },
    });
    check(
      "S6-13c",
      "失败行完整回滚：乙的手机号保持原值、且无该行的变更历史残留",
      bAfter?.phone === SYN.phoneB && bOrphan === null,
      JSON.stringify({ bPhone: bAfter?.phone, expect: SYN.phoneB, orphan: !!bOrphan })
    );

    // ---- S6-12：提交（PARTIAL）后再改库 → 带 retry 的重试被版本保护拦截 ----
    const row = await prisma.importPreview.findUnique({ where: { id: pid } });
    const lastCommitVer = row?.lastCommitDbVersion;
    await prisma.employee.update({ where: { id: empA.id }, data: { remark: "提交后又被外部改动" } });
    const c2 = await api("POST", `/api/import/preview/${pid}?retry=1`, {});
    check(
      "S6-12",
      "重试版本基线：提交后再改库 → 带 retry 的重试 409 VERSION_CONFLICT",
      c2.status === 409 && c2.body?.code === "VERSION_CONFLICT",
      JSON.stringify({ c2: c2.status, c2code: c2.body?.code, error: c2.body?.error?.slice(0, 40) })
    );
    check(
      "S6-12b",
      "提交后 lastCommitDbVersion 已刷新（作为下次重试的基线）",
      !!lastCommitVer && c2.status === 409,
      JSON.stringify({ hasLastCommitDbVersion: !!lastCommitVer })
    );

    // ---- S6-13d：去掉触发器 + 重新预览 → 乙写入成功（200，真实值落库）----
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_stage6_s6_13`);
    const p2 = await upload(wbMulti, "stage6-tx2.xlsx");
    const pid2 = p2.body?.data?.id;
    const c3 = await api("POST", `/api/import/preview/${pid2}`, {});
    const bAfter2 = await prisma.employee.findUnique({ where: { id: empB.id } });
    check(
      "S6-13d",
      "去掉故障源后重新提交成功（200，乙写入真实值）",
      c3.status === 200 && bAfter2?.phone === SYN.phoneBNew,
      JSON.stringify({ c3: c3.status, c3updated: c3.body?.data?.updated, bPhone: bAfter2?.phone })
    );

    // 清理现场
    await prisma.importPreview.deleteMany({ where: { id: { in: [pid, pid2] } } });
    await prisma.employee.update({ where: { id: empA.id }, data: { phone: SYN.phone, remark: null } });
    await prisma.employee.update({ where: { id: empB.id }, data: { phone: SYN.phoneB } });
    await prisma.employee.deleteMany({ where: { name: SYN.newEmp } });
  }

  // ============ [S6-14] 46 字段回归矩阵（显式 46 列） ============
  {
    // 建一个全新的合成员工（无身份证/手机号 → 矩阵里几乎所有列都是「变化」）
    const emp46 = await prisma.employee.create({
      data: {
        employeeId: CODE_46,
        name: "阶段六46员工",
        hireDate: new Date("2021-08-08T00:00:00.000Z"),
        status: "ACTIVE",
        sourceSheet: "数据库",
        importBatch: "stage6-test",
        dataFlags: null,
      },
    });

    // 46 列逐列填「可区分的」合成值（长数字全为假号，绝不碰真实数据）
    const COL_VALUES = {
      1: 99,
      2: "阶段六矩阵门店",
      3: "2021-08-08",
      4: "3.7 年",
      5: "阶段六46员工",
      6: "110101199001011234",
      7: "13700000001",
      8: "矩阵工种",
      9: "矩阵职位备注",
      10: "是",
      11: "已购",
      12: "矩阵紧急甲",
      13: "13700000002",
      14: "矩阵紧急乙",
      15: "13700000003",
      16: "矩阵劳动合同",
      17: "矩阵社保协议",
      18: "矩阵消防承诺",
      19: "矩阵宿舍免责",
      20: "矩阵入职体检",
      21: "矩阵开户行",
      22: "6228480000001111",
      23: "矩阵薪资 4000",
      24: "矩阵现居住地址",
      25: "矩阵招聘人",
      27: "",
      28: "35",
      29: "2021-07-20",
      30: "矩阵面试地点",
      31: "矩阵面试结果",
      32: "矩阵面试人",
      33: "是",
      34: "矩阵简历",
      35: "矩阵评估",
      36: "3.8 年",
      37: "矩阵首月保障",
      38: "矩阵备注",
      39: "矩阵带教",
      40: "矩阵入职表",
      41: "矩阵评估2",
      42: "矩阵证书",
      43: "矩阵备注3",
      44: "是",
      45: "是",
      46: "矩阵未成年",
    };
    const wb46 = buildWorkbook({ 3: COL_VALUES });
    const p = await upload(wb46, "stage6-46.xlsx");
    const pid = p.body?.data?.id;
    const target = p.body?.data?.diff?.modified?.find((m) => m.employeeCode === CODE_46);
    const c = await api("POST", `/api/import/preview/${pid}`, {});
    const after = await prisma.employee.findUnique({ where: { id: emp46.id } });

    // 逐列回归矩阵：46 个 Excel 列 → 对应库字段的「期望值」。
    // 敏感列额外要求：Diff 展示脱敏（含 * 且 ≠ 原值）+ 库内为真实值。
    const COL_CHECK = [
      { col: 1, field: null, expect: "LOC_ONLY" },
      { col: 2, field: "storeNameRaw", expect: "阶段六矩阵门店" },
      { col: 3, field: "hireDate", expect: "2021-08-08" },
      { col: 4, field: "tenureTextAtImport", expect: "3.7 年" },
      { col: 5, field: "name", expect: "阶段六46员工" },
      { col: 6, field: "idCardNo", expect: "110101199001011234", sensitive: true },
      { col: 7, field: "phone", expect: "13700000001", sensitive: true },
      { col: 8, field: "jobGradeRaw", expect: "矩阵工种" },
      { col: 9, field: "positionNote", expect: "矩阵职位备注" },
      { col: 10, field: "dormitory", expect: "是" },
      { col: 11, field: "socialInsurancePurchased", expect: "已购" },
      { col: 12, field: "emergencyContact1", expect: "矩阵紧急甲" },
      { col: 13, field: "emergencyPhone1", expect: "13700000002", sensitive: true },
      { col: 14, field: "emergencyContact2", expect: "矩阵紧急乙" },
      { col: 15, field: "emergencyPhone2", expect: "13700000003", sensitive: true },
      { col: 16, field: "laborContract", expect: "矩阵劳动合同" },
      { col: 17, field: "socialInsuranceAgreement", expect: "矩阵社保协议" },
      { col: 18, field: "fireSafetyCommitment", expect: "矩阵消防承诺" },
      { col: 19, field: "dormitoryWaiver", expect: "矩阵宿舍免责" },
      { col: 20, field: "onboardingMedical", expect: "矩阵入职体检" },
      { col: 21, field: "bankBranch", expect: "矩阵开户行" },
      { col: 22, field: "bankAccountNo", expect: "6228480000001111", sensitive: true },
      { col: 23, field: "salaryTerms", expect: "矩阵薪资 4000", sensitive: true },
      { col: 24, field: "currentAddress", expect: "矩阵现居住地址", sensitive: true },
      { col: 25, field: "recruiterName", expect: "矩阵招聘人" },
      { col: 26, field: "resignReason", expect: null },
      { col: 27, field: "resignDate", expect: null },
      { col: 28, field: "age", expect: "35" },
      { col: 29, field: "interviewDate", expect: "2021-07-20" },
      { col: 30, field: "interviewLocation", expect: "矩阵面试地点" },
      { col: 31, field: "interviewResult", expect: "矩阵面试结果" },
      { col: 32, field: "interviewerName", expect: "矩阵面试人" },
      { col: 33, field: "interviewHired", expect: "是" },
      { col: 34, field: "docResume", expect: "矩阵简历" },
      { col: 35, field: "docInterviewEvaluation", expect: "矩阵评估" },
      { col: 36, field: "resignedTenureText", expect: "3.8 年" },
      { col: 37, field: "firstMonthGuarantee", expect: "矩阵首月保障", sensitive: true },
      { col: 38, field: "remark", expect: "矩阵备注" },
      { col: 39, field: "mentorName", expect: "矩阵带教" },
      { col: 40, field: "docOnboardingForm", expect: "矩阵入职表" },
      { col: 41, field: "docInterviewEvaluation2", expect: "矩阵评估2" },
      { col: 42, field: "certificateLevel", expect: "矩阵证书" },
      { col: 43, field: "remark3", expect: "矩阵备注3" },
      { col: 44, field: "computed7Days", expect: "是" },
      { col: 45, field: "computed2Months", expect: "是" },
      { col: 46, field: "minorNote", expect: "矩阵未成年" },
    ];
    const norm = (v) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v);

    let allPass = true;
    let failSample = null;
    const covered = [];
    for (const { col, field, expect, sensitive } of COL_CHECK) {
      if (field === null) {
        // 第 1 列「序号」为定位列，不入库（无 seqNo 字段）
        covered.push({ col, field: "（定位列，不入库）", ok: true });
        continue;
      }
      const dbNorm = norm(after ? after[field] : null);
      const expectedNorm = expect === null ? null : String(expect);
      const dbOk = dbNorm === expectedNorm;

      let ok = dbOk;
      if (sensitive) {
        const chg = target?.changes?.find((x) => x.field === field);
        // 敏感列：只要它发生了变更，Diff 展示必须脱敏（含 * 且 ≠ 原值）
        const displayOk = !chg
          ? true
          : String(chg.displayNewValue ?? "").includes("*") && chg.displayNewValue !== expect;
        ok = dbOk && displayOk;
        if (!ok && !failSample)
          failSample = { col, field, db: dbNorm, expect, display: chg?.displayNewValue };
      } else if (!dbOk && !failSample) {
        failSample = { col, field, db: dbNorm, expect };
      }
      covered.push({ col, field, ok });
      allPass = allPass && ok;
    }
    const coveredCols = covered.length;
    check(
      "S6-14",
      `46 字段回归矩阵：库内真实值 + 敏感列 Diff 脱敏（${coveredCols}/46 列逐项校验）`,
      c.status === 200 && allPass && coveredCols === 46,
      allPass
        ? `全部 ${coveredCols} 列通过；commit=${c.status}`
        : `首处不符：${JSON.stringify(failSample)} commit=${c.status}`
    );
    // 预览 Diff JSON 不外发原始敏感值（raw 只在提交阶段内存使用）
    const diffJson = JSON.stringify(p.body?.data?.diff ?? {});
    const noLeak =
      !diffJson.includes("13700000001") &&
      !diffJson.includes("6228480000001111") &&
      !diffJson.includes("矩阵薪资 4000") &&
      !diffJson.includes("矩阵现居住地址");
    check(
      "S6-14b",
      "预览 Diff JSON 不外发原始敏感值（手机/银行卡/薪资/住址 仅出现脱敏形态）",
      noLeak,
      noLeak ? "ok" : "发现明文敏感值外发"
    );
    // 列表接口脱敏
    const list = await api("GET", "/api/employees?pageSize=5&name=阶段六46员工");
    const rowList = list.body?.data?.find((r) => r.name === "阶段六46员工");
    check(
      "S6-14c",
      "列表接口脱敏（身份证/手机 为掩码）且非敏感列可见",
      !!rowList && rowList.idCardNo?.includes("*") && rowList.phone?.includes("*") && rowList.name === "阶段六46员工",
      JSON.stringify({ idCardNo: rowList?.idCardNo, phone: rowList?.phone })
    );

    // 清理
    await prisma.importPreview.delete({ where: { id: pid } });
    await prisma.employee.delete({ where: { id: emp46.id } });
  }

  // ============ [S6-15] 计算字段实时化 ============
  {
    const { computeTenure, renderBool } = await import("../lib/tenure.ts");
    const t = new Date("2026-05-10T00:00:00Z");
    const active = computeTenure("2022-05-10", null, t);
    const resigned = computeTenure("2022-05-10", "2024-06-01", t);
    const noHire = computeTenure(null, null, t);
    check(
      "S6-15",
      "计算字段实时化：在职/离职分别推算；缺入职日 → 未知（null）",
      active.days === 1461 && active.past7Days === true && active.past2Months === true && active.active === true &&
        resigned.days !== null && resigned.active === false &&
        noHire.days === null && noHire.past7Days === null && noHire.past2Months === null &&
        noHire.tenureText === "—",
      JSON.stringify({ activeDays: active.days, activeText: active.tenureText, resignedDays: resigned.days, noHireText: noHire.tenureText })
    );
    check(
      "S6-15b",
      "计算字段渲染：未知 / 是 / 否",
      renderBool(null) === "未知（缺入职日期）" && renderBool(true) === "是" && renderBool(false) === "否",
      JSON.stringify({ null: renderBool(null), true: renderBool(true), false: renderBool(false) })
    );
  }

  // ============ 收尾 ============
  await cleanSynthetic();
  await cleanup();
  console.log("═".repeat(72));
  console.log(`第六阶段测试完成：通过 ${pass} · 失败 ${fail}`);
  console.log("═".repeat(72));
  if (fail > 0) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("✗ 测试运行异常：", e);
  try {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  } catch {}
  process.exit(1);
});
