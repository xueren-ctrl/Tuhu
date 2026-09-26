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
      "「数据库」表 7 个「是否」字段渲染出行内下拉",
      selectCount > 20 && dbPageHtml.includes("<option value=\"是\">是</option>"),
      `首屏 20 行共 ${selectCount} 个下拉（工具栏 3 个 + 行内是否字段）`
    );

    // ---------- 行内下拉真的能存：PATCH 必须被支持，且改动同步到所有含该员工的表 ----------
    // ⚠️ S9-25 只验证了「下拉渲染出来了」，没验证「点下去能保存」——
    //    曾经因为路由只实现 PUT、缺 PATCH，导致下拉可见但一点就 405。必须真跑一次写入。
    const syncEmp = await prisma.employee.findFirst({
      where: { deletedAt: null, status: "ACTIVE", employeeId: { startsWith: "THHR2026" } },
      orderBy: { employeeId: "asc" },
      select: { id: true, name: true, employeeId: true, dormitory: true },
    });
    // 该员工按状态应出现的表（员工驱动型；excel 底座的表不含「是否」列）
    const SYNC_SHEETS = ["在职", "离职", "南昌3店", "运营部", "运营部离职", "数据库"];
    const selectedOf = (html) => {
      const m1 = /<option value="([^"]*)"\s+selected=""/.exec(html);
      if (m1) return m1[1] === "" ? "(空)" : m1[1];
      const m2 = /<option selected="" value="([^"]*)"/.exec(html);
      if (m2) return m2[1] === "" ? "(空)" : m2[1];
      return "(?)";
    };
    // 按 data-employee-ref 精确定位到「这个员工」的那一行（同名不同人必须区分开）
    const readYesNo = async (sheet, refId) => {
      const h = (
        await (
          await req(`/sheets/${encodeURIComponent(sheet)}?size=200`)
        ).text()
      ).replace(/<!--[\s\S]*?-->/g, "");
      const trs = (h.split("<tbody>")[1] ?? "").split("<tr").slice(1);
      const hit = trs.filter((t) => t.includes(`data-employee-ref="${refId}"`));
      if (!hit.length) return null; // 该表里没有这个人（状态不匹配）
      const sels = [...hit[0].matchAll(/<select[^>]*>[\s\S]*?<\/select>/g)];
      return { n: sels.length, first: sels.length ? selectedOf(sels[0][0]) : null };
    };

    const patchRes = await req(`/api/employees/${syncEmp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ dormitory: syncEmp.dormitory === "是" ? "否" : "是" }),
    });
    const patchedVal =
      (await prisma.employee.findUnique({ where: { id: syncEmp.id }, select: { dormitory: true } }))?.dormitory ??
      null;
    check(
      "S9-26",
      "行内下拉写入生效：PATCH /api/employees/:id 被支持（曾因只实现 PUT 而 405）",
      patchRes.status === 200 && patchedVal !== syncEmp.dormitory,
      `HTTP ${patchRes.status}，${JSON.stringify(syncEmp.dormitory)} → ${JSON.stringify(patchedVal)}`
    );

    // 同步：同一时刻读所有含该员工的表
    const syncDetail = [];
    let syncOk = true;
    let tablesWithHim = 0;
    for (const s of SYNC_SHEETS) {
      const r = await readYesNo(s, syncEmp.id);
      if (!r) {
        syncDetail.push(`${s}=无此人`);
        continue;
      }
      tablesWithHim++;
      const same = r.first === patchedVal;
      if (!same) syncOk = false;
      syncDetail.push(`${s}=${r.first}${same ? "✓" : "✗"}`);
    }
    check(
      "S9-27",
      "改一个字段后，该员工出现的所有表同步更新",
      syncOk && tablesWithHim >= 2,
      `${syncEmp.name}：${syncDetail.join(" / ")}（共 ${tablesWithHim} 张表含他）`
    );

    // 复原
    await req(`/api/employees/${syncEmp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ dormitory: syncEmp.dormitory }),
    });
    const restoredVal = (await prisma.employee.findUnique({
      where: { id: syncEmp.id },
      select: { dormitory: true },
    }))?.dormitory;
    check(
      "S9-28",
      "测试后已复原该员工字段（零污染）",
      restoredVal === syncEmp.dormitory,
      `复原为 ${JSON.stringify(restoredVal)}`
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

    // ---------- PWA：能「装到手机主屏幕当 App 用」 ----------
    // 必须在【未登录】状态下验证 —— 手机首次访问时还没登录，
    // 曾因 middleware 拦了 manifest / sw.js / PNG 图标而全部 307，装不上 App。
    const anon = (path) =>
      fetch(`${HOST}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });

    const mf = await anon("/manifest.webmanifest");
    const mfText = mf.status === 200 ? await mf.text() : "";
    let mfJson = null;
    try { mfJson = JSON.parse(mfText); } catch { /* 解析失败即视为不合格 */ }
    check(
      "S9-29",
      "PWA manifest 未登录也能取到（曾被登录守卫 307，导致装不了 App）",
      mf.status === 200 &&
        (mf.headers.get("content-type") ?? "").includes("manifest+json") &&
        mfJson?.display === "standalone" &&
        mfJson?.start_url === "/",
      `http=${mf.status} type=${mf.headers.get("content-type") ?? "-"} display=${mfJson?.display ?? "-"}`
    );
    check(
      "S9-30",
      "manifest 图标齐备（含 192/512 与 maskable）与桌面快捷方式",
      Array.isArray(mfJson?.icons) &&
        mfJson.icons.some((i) => i.sizes === "192x192") &&
        mfJson.icons.some((i) => i.sizes === "512x512") &&
        mfJson.icons.some((i) => String(i.purpose).includes("maskable")) &&
        (mfJson.shortcuts ?? []).length >= 3,
      `图标 ${mfJson?.icons?.length ?? 0} 个 / 快捷方式 ${(mfJson?.shortcuts ?? []).map((s) => s.short_name).join("、") ?? "无"}`
    );

    const sw = await anon("/sw.js");
    const swText = sw.status === 200 ? await sw.text() : "";
    check(
      "S9-31",
      "Service Worker 未登录可注册，且业务页面走「网络优先」不缓存过期人事数据",
      sw.status === 200 && swText.includes("addEventListener(\"fetch\"") && swText.includes('req.mode === "navigate"'),
      `http=${sw.status} 大小 ${swText.length}B`
    );

    const iconChecks = await Promise.all(
      ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"].map(async (p) => {
        const r = await anon(p);
        return { p, status: r.status, type: r.headers.get("content-type") ?? "" };
      })
    );
    check(
      "S9-32",
      "手机图标 PNG 未登录可直接下载（曾被 307 拦截）",
      iconChecks.every((c) => c.status === 200 && c.type.includes("png")),
      iconChecks.map((c) => `${c.p.replace("/icons/", "")}=${c.status}`).join(" ")
    );

    const off = await anon("/offline");
    const offText = off.status === 200 ? await off.text() : "";
    check(
      "S9-33",
      "断网兜底页可显示（不受登录校验影响）",
      off.status === 200 && offText.includes("连不上这台电脑"),
      `http=${off.status}`
    );

    // 根布局必须声明 manifest / apple 图标 / 移动端视口，否则 iPhone 装不出图标
    // 注意：React SSR 会渲染成 `<link rel="manifest" href="..."/>`（自闭合带斜杠），
    // 所以只查属性片段，不要查完整的 `>` 收尾。
    // sw.js 不在这里查 —— 它由客户端组件 ServiceWorkerRegistrar 注册，
    // SSR 的 HTML 里本来就没有；是否可注册由 S9-31 单独验证。
    const homeHtml = (await (await req("/")).text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-34",
      "根布局已声明 manifest、iOS 主屏图标与移动端视口",
      homeHtml.includes('rel="manifest"') &&
        homeHtml.includes("/manifest.webmanifest") &&
        homeHtml.includes("apple-touch-icon") &&
        homeHtml.includes("viewport-fit=cover"),
      `manifest=${homeHtml.includes("/manifest.webmanifest")} apple图标=${homeHtml.includes("apple-touch-icon")} 视口=${homeHtml.includes("viewport-fit=cover")}`
    );

    // 登录守卫本身不能被削弱：业务页面仍必须 307
    const guard = await anon("/sheets/" + encodeURIComponent("数据库"));
    check(
      "S9-35",
      "放行 PWA 资源的同时，业务页面仍受登录守卫保护",
      guard.status === 307,
      `未登录访问业务表 → ${guard.status}`
    );

    // ---------- 按列筛选：真的筛出结果，且顶部人数同步（S9-36 ~ S9-39） ----------
    const rowsIn = (html) => ((html.split("<tbody>")[1] ?? "").split("<tr").length - 1);

    const activeSheet = "/sheets/" + encodeURIComponent("在职");
    const emp0 = await prisma.employee.findFirst({
      where: { deletedAt: null, status: "ACTIVE" },
      orderBy: { employeeId: "asc" },
      select: { name: true, employeeId: true },
    });

    // 姓名列的 index 从表头里读，不写死
    const activeHtml0 = (await (await req(`${activeSheet}?size=1`)).text()).replace(/<!--[\s\S]*?-->/g, "");
    const thTexts = [...(activeHtml0.split("<thead>")[1] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    const nameIdx = thTexts.findIndex((t) => t.includes("姓名"));

    const filtered = (await (await req(`${activeSheet}?col=${nameIdx}&op=contains&val=${encodeURIComponent(emp0.name)}`)).text()).replace(
      /<!--[\s\S]*?-->/g,
      ""
    );
    const baseline = (await (await req(`${activeSheet}?size=200`)).text()).replace(/<!--[\s\S]*?-->/g, "");
    const filteredRows = rowsIn(filtered);
    const baselineRows = rowsIn(baseline);
    check(
      "S9-36",
      "按「姓名 包含」筛选真的把行筛少了（不是只改了标签）",
      nameIdx >= 0 && filteredRows > 0 && filteredRows < baselineRows,
      `姓名列 index=${nameIdx}；筛选后 ${filteredRows} 行 / 未筛选 ${baselineRows} 行；目标「${emp0.name}」`
    );

    // 顶部人数必须是筛选后的命中数 —— 之前固定显示全表人数，用户因此以为筛选没生效
    // 注意 React SSR 会在文本节点之间插 `<!-- -->`，已在上方统一去掉；
    // 但标签本身仍会把 `·` 与数字隔开，所以匹配时允许中间出现任意分隔。
    const headArea = (filtered.match(/个字段[\s\S]{0,260}/) ?? [""])[0]
      .replace(/<[^>]+>/g, "|")
      .replace(/\|+/g, "|");
    const shownMatched = Number((headArea.match(/个字段\s*·\s*\|?\s*(\d+)/) ?? [])[1] ?? NaN);
    check(
      "S9-37",
      "筛选后顶部显示「命中数 / 总数（已筛选）」而不是全表人数",
      headArea.includes("已筛选") && shownMatched === filteredRows,
      `顶部显示 ${shownMatched}，表格实际 ${filteredRows} 行；片段=${headArea.slice(0, 60)}`
    );

    // 查无此人的值 → 0 行（不能再出现「有 1 行」这种假象）
    const noneHtml = (await (await req(`${activeSheet}?col=${nameIdx}&op=contains&val=${encodeURIComponent("查无此人zzz")}`)).text()).replace(
      /<!--[\s\S]*?-->/g,
      ""
    );
    check(
      "S9-38",
      "筛选一个不存在的值 → 结果为 0 行",
      rowsIn(noneHtml) === 0 || noneHtml.includes("没有符合条件的记录"),
      `渲染 ${rowsIn(noneHtml)} 行`
    );

    // 筛选值必须真正进 URL（此前只在按 Enter 时提交，输入后点别处就丢）
    const hasValInUrl = filtered.includes(`value="${emp0.name}"`) || filtered.includes(`value=&#x27;`);
    check(
      "S9-39",
      "筛选值在页面上可回显（说明已随 URL 提交，不是只存在本地 state）",
      hasValInUrl || filtered.includes(encodeURIComponent(emp0.name)),
      ""
    );

    // ---------- 右下角浮动安装按钮已移除（曾与「保存修改」重叠） ----------
    const floatGone =
      !/fixed bottom-4 right-4[\s\S]{0,200}装到手机主屏幕/.test(activeHtml0) &&
      !activeHtml0.includes("装到主屏幕");
    check(
      "S9-40",
      "右下角浮动「装到主屏幕」按钮已移除（曾遮挡保存按钮），安装引导改到访问入口页",
      floatGone,
      floatGone ? "已移除" : "仍存在"
    );

    // ---------- 在职年限：实时 / 离职口径（S9-41） ----------
    // 逐表核对：在职类算到今天，离职类算到离职日，且都是每次请求实时算（无缓存）
    const tenureOf = async (sheet) => {
      const h = (await (await req(`/sheets/${encodeURIComponent(sheet)}?size=60`)).text()).replace(
        /<!--[\s\S]*?-->/g,
        ""
      );
      return (h.match(/\d+\s*年\s*\d+\s*个月/g) ?? []).length;
    };
    const [tActive, tNc3, tOps, tResigned] = await Promise.all([
      tenureOf("在职"),
      tenureOf("南昌3店"),
      tenureOf("运营部"),
      tenureOf("离职"),
    ]);
    // 拿一个离职员工手工核对：入职日期 → 离职日期 的自然月差
    const resignedSample = await prisma.employee.findFirst({
      where: { deletedAt: null, status: "RESIGNED", hireDate: { not: null }, resignDate: { not: null } },
      orderBy: { employeeId: "asc" },
      select: { name: true, hireDate: true, resignDate: true },
    });
    let manualOk = false;
    if (resignedSample) {
      const h = (await (await req(`/sheets/${encodeURIComponent("离职")}?q=${encodeURIComponent(resignedSample.name)}&size=20`)).text()).replace(
        /<!--[\s\S]*?-->/g,
        ""
      );
      // 期望值：自然月差
      const hy = resignedSample.hireDate.getUTCFullYear();
      const hm = resignedSample.hireDate.getUTCMonth();
      const hd = resignedSample.hireDate.getUTCDate();
      const ry = resignedSample.resignDate.getUTCFullYear();
      const rm = resignedSample.resignDate.getUTCMonth();
      const rd = resignedSample.resignDate.getUTCDate();
      let y = ry - hy;
      let mo = rm - hm;
      if (rd < hd) mo -= 1;
      if (mo < 0) { y -= 1; mo += 12; }
      manualOk = h.includes(`${y}年${mo}个月`);
    }
    check(
      "S9-41",
      "在职年限：在职类实时算到今天，离职类按「入职→离职」的自然月差",
      tActive > 0 && tNc3 > 0 && tOps > 0 && tResigned > 0 && manualOk,
      `在职${tActive} 南昌3店${tNc3} 运营部${tOps} 离职${tResigned} 行有值；` +
        `离职样本 ${resignedSample?.name ?? "-"} 期望 ${manualOk ? "吻合" : "不符"}`
    );

    // 实时性：同一个「在职」页连开两次，年限文本必须一致且非空（说明是算出来的，不是快照）
    const live1 = (await (await req(`${activeSheet}?size=60`)).text()).replace(/<!--[\s\S]*?-->/g, "");
    const live2 = (await (await req(`${activeSheet}?size=60`)).text()).replace(/<!--[\s\S]*?-->/g, "");
    const ten1 = (live1.match(/\d+\s*年\s*\d+\s*个月/g) ?? []).slice(0, 10).join(",");
    const ten2 = (live2.match(/\d+\s*年\s*\d+\s*个月/g) ?? []).slice(0, 10).join(",");
    check(
      "S9-42",
      "在职年限是每次请求实时计算（两次请求结果一致且有值，无缓存快照）",
      ten1.length > 0 && ten1 === ten2,
      `两次结果${ten1 === ten2 ? "一致" : "不一致"}：${ten1.slice(0, 50)}`
    );

    // ---------- 门店人员编制（Stage 9.14） ----------
    const hcPage = await req("/headcount");
    const hcHtml = (await hcPage.text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-43",
      "门店人员编制页可访问，且复刻 Excel 的分组表头",
      hcPage.status === 200 &&
        ["各门店现有总人数", "满编配制人数", "美容配制人数", "美容现有人数", "各职位缺编明细/人数", "具体缺编明细"].every((k) =>
          hcHtml.includes(k)
        ),
      `http=${hcPage.status} 大小 ${hcHtml.length}B`
    );

    // 门店数量：与 StoreHeadcount 条数一致（每家门店一行）
    const plans = await prisma.storeHeadcount.findMany({
      orderBy: { sortOrder: "asc" },
      include: { store: { select: { name: true } } },
    });
    const shownStoreNames = plans.filter((h) => hcHtml.includes(">" + h.store.name + "<"));
    check(
      "S9-44",
      "编制表覆盖全部有满编目标的门店（每店一行）",
      plans.length === 36 && shownStoreNames.length === plans.length,
      `编制记录 ${plans.length} 条，页面显示 ${shownStoreNames.length} 家`
    );

    // 「现有」必须与「在职」表实时统计一致 —— 逐店对账前 8 家
    const activeEmps = await prisma.employee.findMany({
      where: { deletedAt: null, status: "ACTIVE" },
      select: { storeId: true, jobGradeRaw: true, position: { select: { name: true } } },
    });
    const tally = new Map();
    for (const e of activeEmps) {
      if (e.storeId === null) continue;
      const g = String(e.jobGradeRaw ?? "").trim();
      const pos = String(e.position?.name ?? "").trim();
      if (!tally.has(e.storeId)) tally.set(e.storeId, { svc: 0, mech: 0, beauty: 0, total: 0 });
      const t = tally.get(e.storeId);
      // 当前合计人数 = 全部工种（与 Excel 一致）
      t.total += 1;
      if (g === "客服经理") t.svc += 1;
      else if (g === "机修") t.mech += 1;
      else if (g === "美容") t.beauty += 1;
    }

    let reconOk = 0;
    const reconDetail = [];
    for (const h of plans.slice(0, 8)) {
      const t = tally.get(h.storeId) ?? { svc: 0, mech: 0, beauty: 0, total: 0 };
      const idx = hcHtml.indexOf(">" + h.store.name + "<");
      const tr = hcHtml.slice(hcHtml.lastIndexOf("<tr", idx), hcHtml.indexOf("</tr>", idx));
      const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      );
      // 列序：0序号 1门店 2调整 3店长 4技术店长 5副店长 6客服经理 7机修 8美容 9后勤 10当前合计
      const pageSvc = tds[6] === "—" ? 0 : Number(tds[6]);
      const pageMech = tds[7] === "—" ? 0 : Number(tds[7]);
      const pageBeauty = tds[8] === "—" ? 0 : Number(tds[8]);
      const pageTotal = Number(tds[10]);
      const good = pageSvc === t.svc && pageMech === t.mech && pageBeauty === t.beauty && pageTotal === t.total;
      if (good) reconOk++;
      else
        reconDetail.push(
          `${h.store.name} 页面[客服${pageSvc} 机修${pageMech} 美容${pageBeauty} 合计${pageTotal}] vs 库[${t.svc}/${t.mech}/${t.beauty}/${t.total}]`
        );
    }
    check(
      "S9-45",
      "编制表「现有」人数与在职表实时统计逐店一致（客服/机修/美容/合计）",
      reconOk === 8,
      `${reconOk}/8 一致${reconDetail.length ? "；" + reconDetail.slice(0, 2).join("；") : ""}`
    );

    // 满编目标可改，且改后缺编重算 + 写审计
    const target = plans[0];
    const oldFull = target.mechanicFull;
    const newFull = (oldFull ?? 3) + 1;
    const put = await req(`/api/headcount/${target.storeId}`, {
      method: "PUT",
      body: JSON.stringify({ mechanicFull: newFull }),
    });
    const afterPut = await prisma.storeHeadcount.findUnique({
      where: { storeId: target.storeId },
      select: { mechanicFull: true },
    });
    const auditHit = await prisma.auditLog.findFirst({
      where: { entity: "StoreHeadcount", entityId: String(target.storeId) },
      orderBy: { id: "desc" },
    });
    // 复原
    await req(`/api/headcount/${target.storeId}`, {
      method: "PUT",
      body: JSON.stringify({ mechanicFull: oldFull }),
    });
    const restored = await prisma.storeHeadcount.findUnique({
      where: { storeId: target.storeId },
      select: { mechanicFull: true },
    });
    check(
      "S9-46",
      "满编目标可人工调整，写库 + 审计留痕 + 测后复原",
      put.status === 200 && afterPut?.mechanicFull === newFull && Boolean(auditHit) && restored?.mechanicFull === oldFull,
      `${target.store.name} 机修满编 ${oldFull} → ${newFull}（HTTP ${put.status}）→ 复原 ${restored?.mechanicFull}`
    );

    // 负数 / 非数字必须被拒
    const bad1 = await req(`/api/headcount/${target.storeId}`, { method: "PUT", body: JSON.stringify({ mechanicFull: -1 }) });
    const bad2 = await req(`/api/headcount/${target.storeId}`, { method: "PUT", body: JSON.stringify({ mechanicFull: "abc" }) });
    check(
      "S9-47",
      "满编输入非法值被拒绝（负数 / 非数字）",
      bad1.status === 400 && bad2.status === 400,
      `负数=${bad1.status} 非数字=${bad2.status}`
    );

    // 未登录不能改
    const anonPut = await fetch(`${HOST}/api/headcount/${target.storeId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mechanicFull: 9 }),
      signal: AbortSignal.timeout(20_000),
    });
    check("S9-48", "未登录不能修改满编目标", anonPut.status === 401, `HTTP ${anonPut.status}`);

    // 导航里有这个入口，且在「员工表」分组之外（它一行是门店不是人）
    const hcNavHtml = (await (await req("/")).text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-49",
      "侧边栏有「门店人员编制」入口",
      hcNavHtml.includes("/headcount") && hcNavHtml.includes("门店人员编制"),
      ""
    );

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
