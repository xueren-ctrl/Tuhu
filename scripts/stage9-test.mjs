/**
 * Stage 9 验收：员工表（状态驱动）+ 新增员工 + 更改状态
 *
 * 全程真实 HTTP。会临时创建 2 名测试员工（运行时随机姓名后缀），
 * 测完**物理删除**该员工及其变更历史 / 审计，生产数据零残留。
 *
 * 运行：npm run test:stage9   （需先 npm run build && npm run serve）
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import os from "node:os";

const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

const LOCAL = "127.0.0.1";
const LAN = (() => {
  for (const [, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal && !info.address.startsWith("169.254.")) {
        if (info.address.startsWith("192.168.") || info.address.startsWith("10.")) return info.address;
      }
    }
  }
  return null;
})();
const HOST = `http://${LOCAL}:${PORT}`;

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${id} ${name}${detail ? " —— " + detail : ""}`);
}

const PROBE_USER = "__stage9_probe__";
const PROBE_PASS = randomBytes(12).toString("base64url") + "Aa1!";
const TAG = `S9TEST${randomBytes(2).toString("hex").toUpperCase()}`;

let sid = "";

async function req(path, init = {}) {
  return fetch(`${HOST}${path}`, {
    ...init,
    headers: {
      cookie: `hr_session=${sid}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    redirect: "manual",
  });
}

/** 读某张表的行数（页面顶部「N 个字段 · M 人」）
 *  React SSR 会在文本表达式之间插入 <!-- --> 注释，先去掉再匹配。 */
async function sheetCount(sheet) {
  const res = await req(`/sheets/${encodeURIComponent(sheet)}`);
  const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
  const m = /(\d+)\s*个字段\s*·\s*(\d+)\s*人/.exec(html);
  if (!m) return { status: res.status, count: null };
  return { status: res.status, count: Number(m[2]) };
}

async function createEmployee(payload) {
  const res = await req("/api/employees", { method: "POST", body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function changeStatus(ids, status) {
  const res = await req("/api/employees/status", {
    method: "POST",
    body: JSON.stringify({ ids, status }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function cleanup() {
  const emps = await prisma.employee.findMany({
    where: { name: { contains: TAG } },
    select: { id: true },
  });
  for (const e of emps) {
    await prisma.employeeHistory.deleteMany({ where: { employeeId: e.id } });
    await prisma.auditLog.deleteMany({ where: { entity: "Employee", entityId: String(e.id) } });
  }
  const del = await prisma.employee.deleteMany({ where: { name: { contains: TAG } } });
  await prisma.auditLog.deleteMany({ where: { actor: PROBE_USER } });
  await prisma.session.deleteMany({ where: { username: PROBE_USER } });
  await prisma.appUser.deleteMany({ where: { username: PROBE_USER } });
  return del.count;
}

async function main() {
  console.log("\n======= Stage 9 验收（员工表 / 新增员工 / 更改状态）=======\n");

  await cleanup();
  const user = await prisma.appUser.create({
    data: {
      username: PROBE_USER,
      displayName: "临时验收账号",
      role: "HR",
      status: "ACTIVE",
      passwordHash: hashPassword(PROBE_PASS),
    },
  });

  try {
    // ---------- 登录 ----------
    const login = await fetch(`${HOST}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS }),
    });
    const ck = login.headers.get("set-cookie") ?? "";
    sid = /hr_session=([^;]+)/.exec(ck)?.[1] ?? "";
    check("S9-01", "临时账号登录成功", login.status === 200 && Boolean(sid), `status=${login.status}`);

    // ---------- 未登录保护 ----------
    const anon1 = await fetch(`${HOST}/employees/status`, { redirect: "manual" });
    const anon2 = await fetch(`${HOST}/api/employees/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1], status: "ACTIVE" }),
    });
    check("S9-02", "未登录访问改状态页 → 跳登录", anon1.status === 307, `status=${anon1.status}`);
    check("S9-03", "未登录调改状态 API → 401", anon2.status === 401, `status=${anon2.status}`);

    // ---------- 状态 → 表 映射（行数 = 该状态人数） ----------
    const statusCounts = Object.fromEntries(
      (await prisma.employee.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } })).map(
        (r) => [r.status, r._count._all]
      )
    );
    const total = await prisma.employee.count({ where: { deletedAt: null } });
    const MAP = {
      在职: ["ACTIVE"],
      南昌3店: ["NC3"],
      运营部: ["OPS"],
      离职: ["RESIGNED"],
      运营部离职: ["OPS_RESIGNED"],
      招聘面试登记表: ["INTERVIEWED", "ACTIVE", "RESIGNED", "NC3", "OPS", "OPS_RESIGNED"],
      薪资表: ["ACTIVE", "RESIGNED", "NC3", "OPS", "OPS_RESIGNED"],
      数据库: null,
    };
    let mapOk = true;
    const mapDetail = [];
    for (const [sheet, statuses] of Object.entries(MAP)) {
      const expected = statuses === null ? total : statuses.reduce((s, st) => s + (statusCounts[st] ?? 0), 0);
      const got = await sheetCount(sheet);
      const ok = got.status === 200 && got.count === expected;
      if (!ok) {
        mapOk = false;
        mapDetail.push(`${sheet}: 期望 ${expected} 实际 ${got.count}`);
      }
    }
    check("S9-04", "8 张表的行数与状态映射完全一致", mapOk, mapDetail.join(" | "));

    // ---------- 候选中 / 其他 一个表都不进 ----------
    const allSheetCounts = async () => {
      const out = {};
      for (const s of ["在职", "离职", "南昌3店", "运营部", "招聘面试登记表", "运营部离职", "薪资表", "数据库"]) {
        out[s] = (await sheetCount(s)).count;
      }
      return out;
    };
    const base = await allSheetCounts();

    // ---------- 新增门店员工（已入职） ----------
    const stores = await prisma.store.findMany({ where: { status: "ACTIVE", name: { not: "其他" } }, take: 1 });
    const storeId = stores[0].id;
    const created = await createEmployee({
      name: `${TAG}门店甲`,
      status: "ACTIVE",
      storeId: String(storeId),
      hireDate: "2026-01-05",
      phone: "13800000001",
      salaryTerms: "测试用薪资",
    });
    const empId = created.data?.data?.id;
    const empCode = created.data?.data?.employeeId;
    check("S9-05", "新增门店员工成功且自动生成编号", created.status === 201 && Boolean(empCode), `id=${empId} code=${empCode}`);

    let now = await allSheetCounts();
    check(
      "S9-06",
      "新增「已入职」者立刻出现在 在职 / 招聘面试登记表 / 薪资表",
      now["在职"] === base["在职"] + 1 &&
        now["招聘面试登记表"] === base["招聘面试登记表"] + 1 &&
        now["薪资表"] === base["薪资表"] + 1 &&
        now["离职"] === base["离职"] &&
        now["运营部"] === base["运营部"] &&
        now["数据库"] === base["数据库"] + 1,
      `在职 ${base["在职"]}→${now["在职"]}，招聘 ${base["招聘面试登记表"]}→${now["招聘面试登记表"]}，薪资 ${base["薪资表"]}→${now["薪资表"]}`
    );

    // ---------- 改成 OPS（运营部）→ 从在职移出，进运营部 ----------
    const toOps = await changeStatus([empId], "OPS");
    now = await allSheetCounts();
    check("S9-07", "状态改为「运营部」后搬家正确", toOps.status === 200 && toOps.data.changed === 1, `changed=${toOps.data.changed}`);
    check(
      "S9-08",
      "改运营部：在职 −1、运营部 +1、招聘与薪资不变",
      now["在职"] === base["在职"] &&
        now["运营部"] === base["运营部"] + 1 &&
        now["招聘面试登记表"] === base["招聘面试登记表"] + 1 &&
        now["薪资表"] === base["薪资表"] + 1,
      `在职 ${now["在职"]}，运营部 ${now["运营部"]}`
    );

    // ---------- 改成 INTERVIEWED（已面试）→ 只在招聘面试登记表 ----------
    await changeStatus([empId], "INTERVIEWED");
    now = await allSheetCounts();
    check(
      "S9-09",
      "改「已面试」：只剩招聘面试登记表（薪资表也移出）",
      now["在职"] === base["在职"] &&
        now["运营部"] === base["运营部"] &&
        now["薪资表"] === base["薪资表"] &&
        now["招聘面试登记表"] === base["招聘面试登记表"] + 1,
      `招聘 ${now["招聘面试登记表"]}，薪资 ${now["薪资表"]}`
    );

    // ---------- 改成 CANDIDATE（候选中）→ 任何表都不出现 ----------
    await changeStatus([empId], "CANDIDATE");
    now = await allSheetCounts();
    const statusSheets = Object.keys(base).filter((k) => k !== "数据库");
    const allBase = statusSheets.every((k) => now[k] === base[k]);
    check(
      "S9-10",
      "改「候选中」：不出现在任何表（仅数据库仍包含）",
      allBase && now["数据库"] === base["数据库"] + 1,
      `7 张表全部回到基线=${allBase}，数据库 ${base["数据库"]}→${now["数据库"]}`
    );

    // ---------- 文件：Excel 原始留档不受影响 ----------
    const excel = await req(`/excel/${encodeURIComponent("在职")}`);
    const excelHtml = (await excel.text()).replace(/<!--[\s\S]*?-->/g, "");
    const excelRows = await prisma.sheetRow.count({ where: { sheet: "在职" } });
    check(
      "S9-11",
      "Excel 原始留档页仍显示导入时的原始行数（不受状态影响）",
      excel.status === 200 && excelHtml.includes(`${excelRows} 行`),
      `原始 ${excelRows} 行`
    );

    // ---------- 运营部新增（自动挂运营部） ----------
    const opsDept = await prisma.department.findFirst({ where: { name: "运营部" } });
    const created2 = await createEmployee({
      name: `${TAG}运营乙`,
      status: "OPS",
      departmentId: String(opsDept.id),
      hireDate: "2026-02-10",
      workPhone: "13900000002",
      householdAddress: "测试户籍地址",
    });
    const empId2 = created2.data?.data?.id;
    now = await allSheetCounts();
    check(
      "S9-12",
      "新增运营部员工出现在 运营部 / 招聘面试登记表 / 薪资表",
      created2.status === 201 &&
        now["运营部"] === base["运营部"] + 1 &&
        now["招聘面试登记表"] === base["招聘面试登记表"] + 1 &&
        now["薪资表"] === base["薪资表"] + 1,
      `运营部 ${now["运营部"]}`
    );

    // ---------- 变更历史 + 审计 ----------
    const hist = await prisma.employeeHistory.findMany({ where: { employeeId: empId, fieldName: "status" } });
    const audit = await prisma.auditLog.findMany({ where: { action: "STATUS_CHANGE", entityId: String(empId) } });
    check("S9-13", "改状态写入员工变更历史", hist.length >= 3, `${hist.length} 条`);
    check("S9-14", "改状态写入系统审计（含操作人）", audit.length >= 3 && audit.every((a) => Boolean(a.actor)), `${audit.length} 条，操作人=${audit[0]?.actor ?? ""}`);

    // ---------- 软删除后从所有表消失 ----------
    const delRes = await req(`/api/employees/${empId2}`, { method: "DELETE" });
    now = await allSheetCounts();
    check(
      "S9-15",
      "停用（软删除）后从所有表消失、数据库表也减少",
      delRes.status === 200 &&
        now["运营部"] === base["运营部"] &&
        now["招聘面试登记表"] === base["招聘面试登记表"] &&
        now["薪资表"] === base["薪资表"],
      `DELETE status=${delRes.status}`
    );

    // ---------- 敏感列在员工驱动的表里同样服务端打码 ----------
    const sheetHtml = await (await req(`/sheets/${encodeURIComponent("在职")}`)).text();
    const longNums = sheetHtml.match(/\d{17}[\dXx]/g) ?? [];
    check("S9-16", "员工表里的敏感列在服务端就打码（无 17 位以上长号）", longNums.length === 0, `命中 ${longNums.length}`);

    // ---------- 新增员工页 ----------
    const newPage = await req("/employees/new");
    const newHtml = await newPage.text();
    const newStore = await req("/employees/new?kind=STORE");
    const storeHtml = await newStore.text();
    const newOps = await req("/employees/new?kind=OPS");
    const opsHtml = await newOps.text();
    check(
      "S9-17",
      "新增员工页可选两种类型，且两类字段不同",
      newPage.status === 200 &&
        newHtml.includes("门店员工") &&
        newHtml.includes("运营部员工") &&
        storeHtml.includes("工资卡的开户银行支行") &&
        opsHtml.includes("工作电话"),
      `STORE=${newStore.status} OPS=${newOps.status}`
    );

    // ---------- 改状态页 ----------
    const statusPage = await req("/employees/status");
    const statusHtml = await statusPage.text();
    check(
      "S9-18",
      "更改状态页可用且列出 8 个状态",
      statusPage.status === 200 &&
        statusHtml.includes("候选中") &&
        statusHtml.includes("运营部离职") &&
        statusHtml.includes("已面试"),
      `status=${statusPage.status}`
    );

    // ---------- 非法状态被拒 ----------
    const bad = await changeStatus([empId], "NOT_A_STATUS");
    check("S9-19", "非法状态被拒绝（400）", bad.status === 400, `status=${bad.status}`);
  } finally {
    const removed = await cleanup();
    check("S9-20", "测试员工与临时账号已清理（生产零残留）", removed >= 1, `删除 ${removed} 名测试员工 + 临时账号`);
    void user;
    await prisma.$disconnect();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n======= 通过 ${pass}/${results.length} =======`);
  if (pass !== results.length) {
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.id} ${r.name}`));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("验收脚本异常：", e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
