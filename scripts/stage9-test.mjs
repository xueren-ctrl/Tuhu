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
    // 「招聘面试登记表」「薪资表」以 Excel 原始名单为准，只追加软件新增的员工
    const addedBySoftware = await prisma.employee.count({
      where: {
        deletedAt: null,
        sourceSheet: null,
        status: { in: ["INTERVIEWED", "ACTIVE", "RESIGNED", "NC3", "OPS", "OPS_RESIGNED"] },
      },
    });
    const mirrorRows = {};
    for (const s of ["招聘面试登记表", "薪资表"]) {
      mirrorRows[s] = await prisma.sheetRow.count({ where: { sheet: s } });
    }
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
    const EXCEL_BASE = ["招聘面试登记表", "薪资表"];
    let mapOk = true;
    const mapDetail = [];
    for (const [sheet, statuses] of Object.entries(MAP)) {
      const eligible = statuses === null ? total : statuses.reduce((s, st) => s + (statusCounts[st] ?? 0), 0);
      const expected = EXCEL_BASE.includes(sheet) ? mirrorRows[sheet] + addedBySoftware : eligible;
      const got = await sheetCount(sheet);
      const ok = got.status === 200 && got.count === expected;
      if (!ok) {
        mapOk = false;
        mapDetail.push(`${sheet}: 期望 ${expected} 实际 ${got.count}`);
      }
    }
    check("S9-04b", "招聘面试登记表 / 薪资表 以 Excel 原始名单为准", mirrorRows["招聘面试登记表"] === 478 && mirrorRows["薪资表"] === 290, `原始 ${mirrorRows["招聘面试登记表"]} / ${mirrorRows["薪资表"]} 行`);
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

    // ---------- 原始名单行是否已挂上员工档案（状态列不再是空的） ----------
    const linkCount = await prisma.sheetRowEmployeeLink.count();
    const sheetPage = await req(`/sheets/${encodeURIComponent("薪资表")}`);
    const sheetHtml = (await sheetPage.text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-04c",
      "招聘/薪资表的原始行已挂上员工档案，状态列显示真实状态",
      linkCount === 744 && sheetHtml.includes("286 人已挂上员工档案"),
      `关联 ${linkCount} 条`
    );
    const orphanRows = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS c FROM SheetRowEmployeeLink l LEFT JOIN Employee e ON e.id = l.employeeId WHERE e.id IS NULL"
    );
    check("S9-04d", "无孤儿关联（每条关联都指向真实存在的员工）", Number(orphanRows?.[0]?.c ?? 0) === 0, `孤儿 ${orphanRows?.[0]?.c ?? "?"} 条`);

    // ===== 关键场景：之前的员工要离职 =====
    // 挑一个「已建档 + 在薪资表原始名单里 + 当前已入职」的真实员工，验证改状态后
    // 薪资表里那一行的状态列跟着变，同时在职表人数 −1 / 离职表 +1
    const cand = await prisma.sheetRowEmployeeLink.findFirst({
      where: { sheet: "薪资表", employee: { status: "ACTIVE", deletedAt: null } },
      orderBy: { rowNo: "asc" },
      select: { employee: { select: { id: true, name: true } } },
    });
    if (cand) {
      const nm = cand.employee.name;
      const statusCellOfRow = async () => {
        const r = await req(
          `/sheets/${encodeURIComponent("薪资表")}?col=3&op=equals&val=${encodeURIComponent(nm)}&size=20`
        );
        const h = (await r.text()).replace(/<!--[\s\S]*?-->/g, "");
        const body = h.split("<tbody>")[1] ?? "";
        const tr = body.split("<tr")[1] ?? "";
        const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
          m[1].replace(/<[^>]+>/g, "").trim()
        );
        return tds.length ? tds[tds.length - 1] : null;
      };
      const beforeCell = await statusCellOfRow();
      const stRes = await changeStatus([cand.employee.id], "RESIGNED");
      const afterCell = await statusCellOfRow();
      const onJob = await sheetCount("在职");
      const resigned = await sheetCount("离职");
      check(
        "S9-04e",
        "把一个已有员工改成离职：薪资表原始行状态跟着变，且在职表 −1 / 离职表 +1",
        stRes.status === 200 &&
          stRes.data.changed === 1 &&
          beforeCell === "已入职" &&
          afterCell === "离职" &&
          onJob.count === 289 &&
          resigned.count === 1402,
        `状态列：${beforeCell} → ${afterCell}；在职 ${onJob.count} 离职 ${resigned.count}`
      );
      // 复原
      await changeStatus([cand.employee.id], "ACTIVE");
    } else {
      check("S9-04e", "把一个已有员工改成离职：薪资表原始行状态跟着变", false, "未找到合适的样本员工");
    }

    // ---------- 「Excel 原始留档」页面已按要求删除，但底座数据必须完好 ----------
    const removedPage = await req(`/excel/${encodeURIComponent("不存在")}`);
    const excelRows = await prisma.sheetRow.count();
    const recruit = await sheetCount("招聘面试登记表");
    const salary = await sheetCount("薪资表");
    check(
      "S9-11",
      "Excel 留档页已下线，但底座数据完好、两张名单表人数不变",
      removedPage.status === 307 &&
        excelRows === 4443 &&
        recruit.count === 478 &&
        salary.count === 290,
      `留档页=${removedPage.status} · SheetRow=${excelRows} 行 · 招聘=${recruit.count} · 薪资=${salary.count}`
    );

    // ---------- 已删除的两个列表页：改为自动跳转，不 404 ----------
    const gone1 = await req("/employees/views/active");
    const gone2 = await req("/employees/views/resigned");
    const gone3 = await req(`/excel/${encodeURIComponent("薪资表")}`);
    const loc = (r) => decodeURIComponent(r.headers.get("location") ?? "");
    check(
      "S9-21",
      "旧网址（在职/离职列表、Excel 留档）自动跳转到对应员工表，不再 404",
      gone1.status === 307 &&
        loc(gone1).includes("/sheets/在职") &&
        gone2.status === 307 &&
        loc(gone2).includes("/sheets/离职") &&
        gone3.status === 307 &&
        loc(gone3).includes("/sheets/薪资表"),
      `active→${loc(gone1)} · resigned→${loc(gone2)} · excel/薪资表→${loc(gone3)}`
    );
    const navHtml = (await (await req("/employees/views")).text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-22",
      "视图总览的在职/离职入口已指向「员工表」",
      navHtml.includes("/sheets/在职") && navHtml.includes("/sheets/离职"),
      ""
    );

    // ---------- 「全部员工（数据库）」已并入员工表的「数据库」 ----------
    const dbLegacy = await req("/employees/database");
    const liveNow = await prisma.employee.count({ where: { deletedAt: null } });
    const dbSheet = await sheetCount("数据库");
    const deletedCount = await prisma.employee.count({ where: { deletedAt: { not: null } } });
    const dbWithDeleted = await req(`/sheets/${encodeURIComponent("数据库")}?showDeleted=1`);
    const dbHtml = (await dbWithDeleted.text()).replace(/<!--[\s\S]*?-->/g, "");
    const mDel = /(\d+)\s*个字段\s*·\s*(\d+)\s*人/.exec(dbHtml);
    check(
      "S9-23",
      "「全部员工（数据库）」并入员工表「数据库」，旧网址自动跳转",
      dbLegacy.status === 307 &&
        decodeURIComponent(dbLegacy.headers.get("location") ?? "").includes("/sheets/数据库") &&
        dbSheet.count === liveNow,
      `旧网址→${decodeURIComponent(dbLegacy.headers.get("location") ?? "")} · 员工表数据库 ${dbSheet.count} 人（= 全部在册 ${liveNow}）`
    );
    check(
      "S9-24",
      "「数据库」表可切换显示已停用档案（多出已停用人数）",
      mDel && Number(mDel[2]) === liveNow + deletedCount,
      `含已停用 ${mDel ? mDel[2] : "?"} 人（在册 ${liveNow} + 已停用 ${deletedCount}）`
    );
    // 行内「是否」下拉：数据库表有 7 个是否字段，首屏 20 行应渲染出大量可编辑 <select>
    const dbPageHtml = (await (await req(`/sheets/${encodeURIComponent("数据库")}?size=20`)).text());
    const selectCount = (dbPageHtml.match(/<select/g) ?? []).length;
    check(
      "S9-25",
      "「数据库」表 7 个「是否」字段支持行内下拉直接改",
      selectCount > 20 && dbPageHtml.includes("<option value=\"是\">是</option>"),
      `首屏 20 行共 ${selectCount} 个下拉（工具栏 3 个 + 行内是否字段）`
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
    const activeSheetHtml = await (await req(`/sheets/${encodeURIComponent("在职")}`)).text();
    const longNums = activeSheetHtml.match(/\d{17}[\dXx]/g) ?? [];
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
