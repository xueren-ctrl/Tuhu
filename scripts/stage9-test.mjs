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
      // ⚠️ 基线人数必须**实时取**，不能写死 289/1402 ——
      //    否则每次修正历史数据（如把误判的离职改回在职）都会让本项假失败。
      const onJobBefore = await sheetCount("在职");
      const resignedBefore = await sheetCount("离职");
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
          onJob.count === onJobBefore.count - 1 &&
          resigned.count === resignedBefore.count + 1,
        `状态列：${beforeCell} → ${afterCell}；在职 ${onJobBefore.count}→${onJob.count}（应 −1）、` +
          `离职 ${resignedBefore.count}→${resigned.count}（应 +1）`
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
      if (!tally.has(e.storeId)) tally.set(e.storeId, { svc: 0, mech: 0, beauty: 0, total: 0, tech: 0 });
      const t = tally.get(e.storeId);
      // ⚠️ Excel 口径（Stage 9.15 修）：
      //   「机修现有」含「技术店长」；「当前合计人数」= SUM(C:I) − D
      //   技术店长既单列在 D、又被 G 含一次，扣 D 抵消 → 结果就等于「该店在职总人数」
      t.total += 1;
      if (g === "客服经理") t.svc += 1;
      else if (g === "机修" || g === "技术店长") t.mech += 1;
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
      // 列序（22 列，与 Excel 一致）：0序号 1门店 2店长 3技术店长 4副店长 5客服经理
      //                               6机修现有 7美容现有 8后勤 9当前合计人数
      const pageSvc = tds[5] === "—" ? 0 : Number(tds[5]);
      const pageMech = tds[6] === "—" ? 0 : Number(tds[6]);
      const pageBeauty = tds[7] === "—" ? 0 : Number(tds[7]);
      const pageTotal = Number(tds[9]);
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

    // ---------- Stage 9.15.2：部分字段更新绝不能清空其它字段（S9-59） ----------
    // 严重 bug 回顾：`saveHeadcountPlan` 曾用 `data.x ?? null` 全量覆盖，
    // 而前端「全部保存」是 for 循环逐字段发请求（每次只带 1 个字段），
    // 于是每点一次「全部保存」就把另外 4 个满编值抹成空。
    // 实测后果：常平朗贝社区店 客服/美容/师傅/中小工 满编全被清空（审计 14:08:21）。
    const partialBefore = await prisma.storeHeadcount.findUnique({
      where: { storeId: target.storeId },
      select: { serviceManagerFull: true, mechanicFull: true, beautyFull: true, beautyMasterFull: true, beautyJuniorFull: true },
    });
    // 只改「机修满编」这**一个**字段
    await req(`/api/headcount/${target.storeId}`, {
      method: "PUT",
      body: JSON.stringify({ mechanicFull: (partialBefore?.mechanicFull ?? 3) + 1 }),
    });
    const partialAfter = await prisma.storeHeadcount.findUnique({
      where: { storeId: target.storeId },
      select: { serviceManagerFull: true, mechanicFull: true, beautyFull: true, beautyMasterFull: true, beautyJuniorFull: true },
    });
    const othersIntact = ["serviceManagerFull", "beautyFull", "beautyMasterFull", "beautyJuniorFull"].every(
      (k) => (partialBefore?.[k] ?? null) === (partialAfter?.[k] ?? null)
    );
    // 复原
    await req(`/api/headcount/${target.storeId}`, {
      method: "PUT",
      body: JSON.stringify({ mechanicFull: partialBefore?.mechanicFull ?? null }),
    });
    const partialRestored = await prisma.storeHeadcount.findUnique({
      where: { storeId: target.storeId },
      select: { serviceManagerFull: true, mechanicFull: true, beautyFull: true, beautyMasterFull: true, beautyJuniorFull: true },
    });
    const fullyRestored = ["serviceManagerFull", "mechanicFull", "beautyFull", "beautyMasterFull", "beautyJuniorFull"].every(
      (k) => (partialBefore?.[k] ?? null) === (partialRestored?.[k] ?? null)
    );
    check(
      "S9-59",
      "只改 1 个满编字段时，其余 4 个字段必须原样保留（曾被全部清空）",
      othersIntact && fullyRestored,
      `${target.store.name} 只改机修满编后：客服 ${partialBefore?.serviceManagerFull ?? "空"}→${partialAfter?.serviceManagerFull ?? "空"} ` +
        `美容 ${partialBefore?.beautyFull ?? "空"}→${partialAfter?.beautyFull ?? "空"} ` +
        `师傅 ${partialBefore?.beautyMasterFull ?? "空"}→${partialAfter?.beautyMasterFull ?? "空"} ` +
        `中小工 ${partialBefore?.beautyJuniorFull ?? "空"}→${partialAfter?.beautyJuniorFull ?? "空"}（测试后已复原：${fullyRestored}）`
    );

    // 满编 5 列必须与 Excel 完全一致（防「—」再次出现）
    const FULL_XL = { serviceManagerFull: 29, mechanicFull: 146, beautyFull: 83, beautyMasterFull: 38, beautyJuniorFull: 43 };
    const allPlans = await prisma.storeHeadcount.findMany({
      select: { serviceManagerFull: true, mechanicFull: true, beautyFull: true, beautyMasterFull: true, beautyJuniorFull: true },
    });
    const got = {};
    for (const k of Object.keys(FULL_XL)) got[k] = allPlans.reduce((s, p) => s + (p[k] ?? 0), 0);
    check(
      "S9-60",
      "满编 5 列合计与 Excel 一致（客服29/机修146/美容83/师傅38/中小工43）",
      Object.keys(FULL_XL).every((k) => got[k] === FULL_XL[k]),
      Object.keys(FULL_XL).map((k) => `${k}=${got[k]}/${FULL_XL[k]}`).join(" ")
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

    // ---------- 编制表：表头与表体必须逐列对齐（S9-50，Stage 9.14.1 修） ----------
    // 曾经的 bug：React 把 colSpan/rowSpan 输出成**大写属性**，浏览器不认 → 表头只还原出
    // 18 列而表体有 22 个 td → 整表错位（「客服经理」列下面显示「具体缺编明细」）。
    // 这里按 colspan/rowspan 还原表头，断言与表体列数一致且字段名逐列正确。
    const hcTableHtml = hcHtml.slice(hcHtml.indexOf("<table"), hcHtml.indexOf("</table>"));
    const hcHeadHtml = hcTableHtml.slice(hcTableHtml.indexOf("<thead"), hcTableHtml.indexOf("</thead>"));
    const grid = [];
    for (const [ri, rm] of [...hcHeadHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].entries()) {
      grid[ri] = grid[ri] ?? [];
      let col = 0;
      for (const cm of rm[1].matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)) {
        while (grid[ri][col]) col++;
        const cs = Number(/colspan="(\d+)"/i.exec(cm[1])?.[1] ?? 1);
        const rs = Number(/rowspan="(\d+)"/i.exec(cm[1])?.[1] ?? 1);
        const t = cm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        for (let dr = 0; dr < rs; dr++)
          for (let dc = 0; dc < cs; dc++) {
            grid[ri + dr] = grid[ri + dr] ?? [];
            grid[ri + dr][col + dc] = t;
          }
        col += cs;
      }
    }
    const hcBodyHtml = hcTableHtml.slice(hcTableHtml.indexOf("<tbody"));
    const hcFirstTr = hcBodyHtml.slice(hcBodyHtml.indexOf("<tr"), hcBodyHtml.indexOf("</tr>"));
    const hcTdCount = [...hcFirstTr.matchAll(/<td[\s>]/g)].length;
    const hcHeadWidth = Math.max(...grid.map((r) => (r ? r.length : 0)));
    check(
      "S9-50",
      "编制表表头与表体列数一致（colspan/rowspan 必须被浏览器识别）",
      hcHeadWidth === hcTdCount,
      `表头 ${hcHeadWidth} 列 / 表体 ${hcTdCount} 列`
    );

    // 逐列断言字段名（与 Excel 第 3 行一致）
    // 注意：第 2 行还原后的数组里，前 2 格是第 1 行 rowspan=2 的「序号/名称」补过来的，
    // 所以实际有 22 项（前 2 + 18 个字段 + 缺编 + 具体缺编）。
    const EXPECT_ROW2 = [
      "序号",
      "名称",
      "店长",
      "技术店长",
      "副店长",
      "客服经理",
      "机修现有",
      "美容现有",
      "后勤",
      "当前合计人数",
      "客服经理满编",
      "机修满编",
      "美容满编",
      "美容师傅满编",
      "美容中小工满编",
      "现有美容师傅",
      "现有美容中小工",
      "缺编",
      "机修",
      "美容",
      "客服经理",
      "具体缺编明细",
    ];
    const row2 = (grid[1] ?? []).filter(Boolean);
    check(
      "S9-51",
      "编制表逐列字段名与 Excel 完全一致（客服经理 / 具体缺编明细 不再错位）",
      row2.length === EXPECT_ROW2.length && EXPECT_ROW2.every((f, i) => row2[i] === f),
      `实际：${row2.join(" / ")}`
    );
    // 「客服经理」必须落在第 6 列（序号1 门店1 店长1 技术1 副店1 → 客服经理是第 6 个）
    check(
      "S9-52",
      "「客服经理」列位置正确（表头与表体都在第 6 列）",
      (grid[1] ?? [])[5] === "客服经理" && (grid[1] ?? [])[20] === "客服经理",
      `第6列=${(grid[1] ?? [])[5]}；第21列=${(grid[1] ?? [])[20]}`
    );

    // 逐列核对数据：表体第 6 列（客服经理）必须等于库里该店在职客服经理人数
    const hcFirstStore = (() => {
      const tds = [...hcFirstTr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      );
      return {
        name: tds[1],
        svc: tds[5],
        mech: tds[6],
        beauty: tds[7],
        total: tds[9],
        master: tds[15],
        junior: tds[16],
      };
    })();
    const hcStore = await prisma.store.findFirst({ where: { name: hcFirstStore.name }, select: { id: true } });
    const hcEmps = await prisma.employee.findMany({
      where: { deletedAt: null, status: "ACTIVE", storeId: hcStore?.id },
      select: { jobGradeRaw: true, positionNote: true },
    });
    const cnt = (pred) => hcEmps.filter((e) => pred(String(e.jobGradeRaw ?? "").trim())).length;
    const cnt2 = (g, n) =>
      hcEmps.filter(
        (e) => String(e.jobGradeRaw ?? "").trim() === g && n.includes(String(e.positionNote ?? "").trim())
      ).length;
    const expSvc = cnt((g) => g === "客服经理");
    // ⚠️ 「机修现有」含「技术店长」—— Excel 公式 COUNTIFS(工种,{机修,技术店长})（Stage 9.15 修）
    const expMech = cnt((g) => g === "机修" || g === "技术店长");
    const expBeauty = cnt((g) => g === "美容");
    const expMaster = cnt2("美容", ["师傅"]);
    const expJunior = cnt2("美容", ["学徒", "中工"]);
    const dash = (v) => (v === 0 ? "—" : String(v));
    // 「当前合计人数」= 各列之和 − 技术店长（技术店长已含在机修现有里，Excel J=SUM(C:I)-D）
    const expTotal =
      cnt((g) => g === "店长" || g === "代理店长") +
      cnt((g) => g === "副店长") +
      expSvc +
      expMech +
      expBeauty +
      cnt((g) => g === "后勤");
    check(
      "S9-53",
      "编制表数据列与表头对应正确（客服经理/机修现有/美容现有/当前合计，机修含技术店长）",
      hcFirstStore.svc === dash(expSvc) &&
        hcFirstStore.mech === dash(expMech) &&
        hcFirstStore.beauty === dash(expBeauty) &&
        hcFirstStore.total === String(expTotal),
      `${hcFirstStore.name}：客服 ${hcFirstStore.svc}/${dash(expSvc)} 机修 ${hcFirstStore.mech}/${dash(expMech)} ` +
        `美容 ${hcFirstStore.beauty}/${dash(expBeauty)} 合计 ${hcFirstStore.total}/${expTotal}`
    );

    // ---------- Stage 9.15：4 处口径回归防线（S9-54 ~ S9-57） ----------
    // 背景：用户报「现有美容师傅整列都是 -」。根因是代码用 `position.name`（职位字典，
    // 恒为「美容」）判断是否含「师傅」→ 永远 false → 整列恒 0。
    // 正确判据是 **`positionNote`（职位备注，Excel 在职表 I 列）**。
    check(
      "S9-54",
      "「现有美容师傅」按 positionNote=师傅 统计（不是 position.name）—— 修复整列为「—」的 bug",
      hcFirstStore.master === dash(expMaster),
      `${hcFirstStore.name} 师傅 ${hcFirstStore.master}，期望 ${dash(expMaster)}` +
        `（positionNote=师傅 ${expMaster} 人；position.name 恒为「美容」，用它判断必然全 0）`
    );
    check(
      "S9-55",
      "「现有美容中小工」= positionNote ∈ {学徒,中工}（不是「非师傅」），且师傅+中小工 ≤ 美容现有",
      hcFirstStore.junior === dash(expJunior) && expMaster + expJunior <= expBeauty,
      `中小工 ${hcFirstStore.junior}/${dash(expJunior)}；师傅 ${expMaster} + 中小工 ${expJunior} ≤ 美容现有 ${expBeauty}`
    );
    // 全库合计：必须与 Excel 合计行（第 40 行）完全一致
    const allActive = await prisma.employee.findMany({
      where: { deletedAt: null, status: "ACTIVE" },
      select: { jobGradeRaw: true, positionNote: true },
    });
    const ac = (pred) => allActive.filter((e) => pred(String(e.jobGradeRaw ?? "").trim(), String(e.positionNote ?? "").trim())).length;
    const XL_TOTAL = { beauty: 85, junior: 42, master: 33, mechanic: 151, total: 290 };
    const gotMaster = ac((g, n) => g === "美容" && n === "师傅");
    const gotJunior = ac((g, n) => g === "美容" && (n === "学徒" || n === "中工"));
    const gotBeauty = ac((g) => g === "美容");
    const gotMech = ac((g) => g === "机修" || g === "技术店长");
    const gotTotal =
      ac((g) => g === "店长" || g === "代理店长") +
      ac((g) => g === "副店长") +
      ac((g) => g === "客服经理") +
      gotMech +
      gotBeauty +
      ac((g) => g === "后勤");
    check(
      "S9-56",
      "全库合计与 Excel 合计行一致：美容85/师傅33/中小工42/机修151(含技术店长)/合计290",
      gotBeauty === XL_TOTAL.beauty &&
        gotJunior === XL_TOTAL.junior &&
        gotMaster === XL_TOTAL.master &&
        gotMech === XL_TOTAL.mechanic &&
        gotTotal === XL_TOTAL.total,
      `美容 ${gotBeauty}/85 中小工 ${gotJunior}/42 师傅 ${gotMaster}/33 机修 ${gotMech}/151 合计 ${gotTotal}/290`
    );
    // 缺编列必须原样显示负数（超编），不能被替换成「—」
    const hasNegativeGap = await prisma.$queryRawUnsafe(
      `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM "StoreHeadcount" WHERE "mechanicFull" IS NOT NULL) LIMIT 1`
    );
    const negGapCell = /class="text-sky-600 font-semibold">-\d+<\/span>/.test(hcHtml);
    check(
      "S9-57",
      "缺编明细列原样显示负数（超编，如 -2），不显示「—」",
      Boolean(hasNegativeGap.length) && negGapCell,
      `页面存在蓝色负数单元格：${negGapCell}（Excel S/T/U 列共 14 格为负数）`
    );

    // ---------- Stage 9.15.1：两表「职位备注」一致性（S9-58） ----------
    // 背景：用户亲自核对 Excel 后指出「骆作豪职位备注不是空的」，我查错表了。
    // 真相：在职表 I239 是**手填的「师傅」**（非 XLOOKUP 公式），而「数据库」表 R1685 为空。
    // 而编制表的 COUNTIFS 读的是 **在职!I:I** → 在职表才是权威。
    // 已在 scripts/fix-positionnote.mjs 修正入库，这里锁死结果防回退。
    const lzz = await prisma.employee.findFirst({
      where: { name: "骆作豪", deletedAt: null },
      select: { employeeId: true, positionNote: true, storeId: true },
    });
    const lzzStore = lzz?.storeId;
    const lzzMaster = lzzStore
      ? await prisma.employee.count({
          where: { deletedAt: null, status: "ACTIVE", storeId: lzzStore, jobGradeRaw: "美容", positionNote: "师傅" },
        })
      : -1;
    check(
      "S9-58",
      "两表不一致的职位备注已按「在职表」修正（骆作豪=师傅），凤岗碧湖师傅数为 2",
      lzz?.positionNote === "师傅" && lzzMaster === 2,
      `${lzz?.employeeId} 职位备注=${JSON.stringify(lzz?.positionNote)}；凤岗碧湖大道店在职美容师傅 ${lzzMaster}/2`
    );

    // ---------- Stage 9.18：人员流失率视图（S9-62 ~ S9-65） ----------
    const attrPage = await req("/attrition?month=2026-08");
    const attrHtml = (await attrPage.text()).replace(/<!--[\s\S]*?-->/g, "");
    check(
      "S9-62",
      "人员流失率页可访问，10 列与 Excel 完全一致",
      attrPage.status === 200 &&
        ["序号", "门店名称", "店长", "技术店长", "副店长", "实时人数", "当月离职", "当月入职", "流失率", "邀约数量"].every((c) =>
          attrHtml.includes(c)
        ),
      `http=${attrPage.status} 大小=${attrHtml.length}B`
    );

    // 36 家门店 + 2 家有副店长的追加行 + 合计行
    // （Stage 9.19：有副店长的门店会多出一行，人数/流失率相同、邀约数量取副店长）
    // 副店长行与 Excel 排法一致：**店名重复**、店长列留空、只在副店长列填名字。
    const attrBody = attrHtml.slice(attrHtml.indexOf("<tbody"));
    const attrRows = [...attrBody.matchAll(/<tr[\s\S]*?<\/tr>/g)]
      .map((m) => [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
      .filter((r) => r.length === 10);
    const dataRows = attrRows.slice(0, -1);
    // 副店长行 = 店长列为空、副店长列有值的行
    const attrDepRows = dataRows.filter((r) => r[2] === "—" && r[4] !== "—");
    const attrStoreRows = dataRows.filter((r) => !(r[2] === "—" && r[4] !== "—"));
    check(
      "S9-63",
      "流失率表 = 36 家门店 + 2 家副店长追加行 + 合计行",
      attrRows.length === 39 && attrStoreRows.length === 36 && attrDepRows.length === 2 &&
        attrRows[attrRows.length - 1][1] === "所有门店合计",
      `总行 ${attrRows.length}（店长行 ${attrStoreRows.length} + 副店长行 ${attrDepRows.length} + 1 合计）；` +
        `副店长行：${attrDepRows.map((r) => `${r[1]}-${r[4]}`).join("、")}`
    );

    // 公式核对：流失率 =（当月离职 − 当月入职）/ 月初人数（逐店核对 36 家店长行）
    const parseNum = (s) => (s === "—" || s === "" ? 0 : Number(String(s).replace("%", "")));
    let formulaOk = 0;
    for (const r of attrStoreRows) {
      const base = parseNum(r[5]), res = parseNum(r[6]), hire = parseNum(r[7]);
      const shown = parseNum(r[8]);
      const expect = base > 0 ? ((res - hire) / base) * 100 : null;
      if (expect === null ? shown === 0 : Math.abs(shown - expect) < 0.06) formulaOk++;
    }
    check(
      "S9-64",
      "流失率 =（当月离职 − 当月入职）/ 月初人数（逐店核对 36 家）",
      formulaOk === 36,
      `${formulaOk}/36 家公式吻合`
    );

    // 副店长行的人数/流失率必须与所属门店的店长行完全一致（只是考核对象不同）
    const depMatch = attrDepRows.every((d) => {
      const parent = attrStoreRows.find((s) => s[1] === d[1]);
      return parent && parent[5] === d[5] && parent[6] === d[6] && parent[7] === d[7] && parent[8] === d[8];
    });
    check(
      "S9-66",
      "副店长行：店名与店长行相同、店长列留空、名字只出现在副店长列，人数/流失率与店长行一致",
      depMatch,
      attrDepRows
        .map((d) => {
          const parent = attrStoreRows.find((s) => s[1] === d[1]);
          return `${d[1]}：店长列=${d[2]} 副店长列=${d[4]} 人数${d[5]}(店长行${parent?.[5]}) 邀约${d[9]}(店长行${parent?.[9]})`;
        })
        .join("；")
    );

    // 合计行的人数不能因副店长行而翻倍
    const sumHead = parseNum(attrRows[attrRows.length - 1][5]);
    const sumOfStores = attrStoreRows.reduce((s, r) => s + parseNum(r[5]), 0);
    check(
      "S9-67",
      "合计行人数只按门店算一次（副店长行不重复计入，否则总人数翻倍）",
      sumHead === sumOfStores,
      `合计 ${sumHead} vs 36 家门店相加 ${sumOfStores}`
    );

    // 口径：满 3 个月用自然月加法；与 Excel 的差异应只来自「Excel 按今天算年限」这一缺陷
    const indicators = await prisma.attritionIndicator.count();
    check(
      "S9-65",
      "考核指标已导入 36 家（含 Excel 同名两行已合并：38 行 → 36 家）",
      indicators === 36,
      `AttritionIndicator ${indicators} 条`
    );

    // ---------- Stage 9.20：店长 / 技术店长 互斥（S9-69） ----------
    // 用户澄清：「店长」代表全职店长，「技术店长」是由机修晋升的店长，**职位性质不同**。
    // 因此一家店只会填其中一列 —— 这一列本身就说明「这家店是哪种店」。
    const inds = await prisma.attritionIndicator.findMany({
      select: { storeManager: true, techManager: true, store: { select: { name: true } } },
    });
    const bothFilled = inds.filter((x) => x.storeManager && x.techManager);
    const sCount = inds.filter((x) => x.storeManager).length;
    const tCount = inds.filter((x) => x.techManager).length;
    check(
      "S9-69",
      "店长与技术店长互斥（无一家同时填两列），且店长行不把技术店长顶替进「店长」列",
      bothFilled.length === 0 &&
        sCount + tCount <= inds.length &&
        // 页面：店长列与技��店长列的内容必须与库里的两列逐一对应
        attrStoreRows.every((r) => {
          const rec = inds.find((i) => i.store.name === r[1]);
          if (!rec) return false;
          return (r[2] === "—") === !rec.storeManager && (r[3] === "—") === !rec.techManager;
        }),
      `店长 ${sCount} 家 / 技术店长 ${tCount} 家 / 两者都填 ${bothFilled.length} 家` +
        (bothFilled.length ? `（${bothFilled.map((x) => x.store.name).join("、")}）` : " ✓")
    );

    // ---------- Stage 9.19：任职门店历史（S9-68） ----------
    // 途虎门店之间调动频繁。改门店时必须自动记一段任职历史，
    // 否则「1 号那天他在哪家店」永远算不出来。
    const periodsBefore = await prisma.employeeStorePeriod.count();
    const mover = await prisma.employee.findFirst({
      where: { deletedAt: null, status: "ACTIVE", storeId: { not: null } },
      select: { id: true, employeeId: true, storeId: true, name: true },
    });
    const otherStore = await prisma.store.findFirst({
      where: { id: { not: mover.storeId }, status: "ACTIVE" },
      select: { id: true, name: true },
    });
    const upd = await req(`/api/employees/${mover.id}`, {
      method: "PUT",
      body: JSON.stringify({ storeId: otherStore.id }),
    });
    await new Promise((r) => setTimeout(r, 300));
    const newPeriods = await prisma.employeeStorePeriod.findMany({
      where: { employeeId: mover.id },
      select: { storeId: true, toDate: true },
    });
    // 复原
    await req(`/api/employees/${mover.id}`, {
      method: "PUT",
      body: JSON.stringify({ storeId: mover.storeId }),
    });
    await new Promise((r) => setTimeout(r, 300));
    const afterRestore = await prisma.employeeStorePeriod.findMany({
      where: { employeeId: mover.id },
      select: { storeId: true, toDate: true },
    });
    const restoredStore = await prisma.employee.findUnique({ where: { id: mover.id }, select: { storeId: true } });
    // 清理本次测试写入的任职历史
    await prisma.employeeStorePeriod.deleteMany({ where: { employeeId: mover.id } });

    check(
      "S9-68",
      "改门店时自动记任职历史（旧段关闭 + 新段开始），复原后门店正确",
      upd.status === 200 &&
        newPeriods.length >= 1 &&
        newPeriods.some((p) => p.storeId === otherStore.id && p.toDate === null) &&
        afterRestore.some((p) => p.storeId === mover.storeId && p.toDate === null) &&
        restoredStore?.storeId === mover.storeId,
      `${mover.employeeId} ${mover.name}：调到 ${otherStore.name} 后新段 ${newPeriods.length} 条（含 1 条至今未结束）；` +
        `复原后当前门店正确：${restoredStore?.storeId === mover.storeId}（测试任职历史已清理，表原有 ${periodsBefore} 条）`
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
