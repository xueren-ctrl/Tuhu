/**
 * ============================================================
 * 第二阶段开发验收脚本
 * scripts/stage2-acceptance.mjs
 *
 * 按验收要求逐项执行（不新增任何业务功能，只做验证）：
 *   1. 五个人员视图是否全部由 Employee 唯一数据源动态生成
 *   2. 新增「测试员工001」（ACTIVE / 测试门店 / 测试部门）后的联动
 *   3. 状态 ACTIVE → RESIGNED 后的联动
 *   4. 页面是否实时查库（无 mock、无第二份员工表）
 *
 * ⚠ 仅使用合成数据（假姓名 / 假身份证 / 假手机号），可安全提交到仓库。
 * 运行前提：npm run build && npm run start
 * ============================================================
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

// 验收要求指定的测试数据
const T = {
  empName: "测试员工001",
  idCard: "110101199001011234",
  phone: "13800138000",
  store: "测试门店",
  dept: "测试部门",
};

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

async function get(path) {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: r.status, text, json };
}

async function send(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: r.status, text, json };
}

/**
 * 读取页面卡片标题里的真实命中数，形如「在职人员（1 条）」。
 * 不能用「页面是否包含姓名」判断 —— 筛选框 value 与「当前筛选」提示会回显关键词。
 */
async function pageCount(path, label) {
  const r = await get(path);
  const re = /([^\n<>]{0,60})（(\d+)\s*条）/g;
  let m;
  while ((m = re.exec(r.text)) !== null) {
    if (m[1].includes(label)) return { count: Number(m[2]), status: r.status };
  }
  return { count: null, status: r.status };
}

async function stats(detail = false) {
  const r = await get("/api/statistics" + (detail ? "?detail=1" : ""));
  return r.json?.data ?? null;
}

function distOf(data, key, id) {
  const list = data?.[key] ?? [];
  return list.find((x) => String(x.id) === String(id)) ?? null;
}

async function main() {
  console.log("═".repeat(76));
  console.log("第二阶段开发验收   BASE =", BASE);
  console.log("═".repeat(76));

  const cleanup = { employeeIds: [], storeIds: [], deptIds: [] };

  try {
    // ============================================================
    console.log("\n──── 准备测试数据（验收要求：测试员工001 / 测试门店）────");

    // 门店
    let storeId = null;
    const storeRes = await send("POST", "/api/stores", { name: T.store });
    if (storeRes.status === 201) {
      storeId = storeRes.json.data.id;
      cleanup.storeIds.push(storeId);
      console.log(`   新建门店「${T.store}」 id=${storeId}`);
    } else {
      const list = await get("/api/stores?includeInactive=true&keyword=" + encodeURIComponent(T.store));
      const hit = list.json?.data?.find((s) => s.name === T.store);
      storeId = hit?.id ?? null;
      if (storeId) cleanup.storeIds.push(storeId);
      console.log(`   复用已存在门店「${T.store}」 id=${storeId}`);
    }
    check("P1", `门店「${T.store}」可用`, !!storeId, `id=${storeId}`);

    // 部门
    let deptId = null;
    const deptRes = await send("POST", "/api/departments", { name: T.dept });
    if (deptRes.status === 201) {
      deptId = deptRes.json.data.id;
      cleanup.deptIds.push(deptId);
      console.log(`   新建部门「${T.dept}」 id=${deptId}`);
    } else {
      const list = await get("/api/departments?includeInactive=true&keyword=" + encodeURIComponent(T.dept));
      const hit = list.json?.data?.find((d) => d.name === T.dept);
      deptId = hit?.id ?? null;
      if (deptId) cleanup.deptIds.push(deptId);
      console.log(`   复用已存在部门「${T.dept}」 id=${deptId}`);
    }
    check("P2", `部门「${T.dept}」可用`, !!deptId, `id=${deptId}`);

    // 清理上次残留
    const leftover = await get(
      "/api/employees?keyword=" + encodeURIComponent(T.empName) + "&includeDeleted=true&pageSize=50"
    );
    for (const e of leftover.json?.data ?? []) await send("DELETE", `/api/employees/${e.id}`);

    // ============================================================
    console.log("\n──── 测试 1：新增「测试员工001」（ACTIVE）────");
    const before = await stats(true);
    console.log(
      `   新增前：总 ${before.totalEmployees} / 在职 ${before.activeEmployees} / 离职 ${before.resignedEmployees}`
    );

    const created = await send("POST", "/api/employees", {
      name: T.empName,
      idCardNo: T.idCard,
      phone: T.phone,
      hireDate: "2026-01-05",
      status: "ACTIVE",
      storeId,
      departmentId: deptId,
      gender: "男",
    });
    const empId = created.json?.data?.id;
    const empNo = created.json?.data?.employeeId;
    if (empId) cleanup.employeeIds.push(empId);
    check(
      "1.0",
      `新增「${T.empName}」成功（status=ACTIVE，门店=${T.store}，部门=${T.dept}）`,
      created.status === 201 && !!empId,
      `id=${empId} 编号=${empNo}`
    );

    // ---- 1.1 在职人员 ----
    const active1 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    check("1.1", "自动出现在「在职人员」视图", active1.count === 1,
      `页面 /employees/views/active 命中 ${active1.count} 条（期望 1）`);

    // ---- 1.2 离职人员不应出现 ----
    const resigned1 = await pageCount(
      `/employees/views/resigned?keyword=${encodeURIComponent(T.empName)}`,
      "离职人员"
    );
    check("1.2", "未出现在「离职人员」视图", resigned1.count === 0,
      `页面 /employees/views/resigned 命中 ${resigned1.count} 条（期望 0）`);

    // ---- 1.3 API 口径一致 ----
    const apiActive = await get(
      `/api/employees?status=ACTIVE&keyword=${encodeURIComponent(T.empName)}`
    );
    check("1.3", "接口口径一致（status=ACTIVE 命中 1）", apiActive.json?.total === 1,
      `total=${apiActive.json?.total}`);

    // ============================================================
    console.log("\n──── 测试 2：门店人员视图（测试门店）────");
    const storeView1 = await pageCount(
      `/employees/views/stores?storeId=${storeId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("2.1", "出现在「门店人员查询」→ 测试门店 的人员列表", storeView1.count === 1,
      `命中 ${storeView1.count} 条（期望 1）`);

    const storeOverview = await get("/employees/views/stores");
    check("2.2", "门店清单由 Store 表动态生成（总览页含「测试门店」）",
      storeOverview.status === 200 && storeOverview.text.includes(T.store),
      `HTTP ${storeOverview.status}`);

    const afterCreate = await stats(true);
    const sd = distOf(afterCreate, "storeDistribution", storeId);
    check("2.3", "门店分布统计自动包含该门店（total=1 / active=1）",
      sd?.total === 1 && sd?.active === 1,
      `storeDistribution: ${sd ? `total=${sd.total} active=${sd.active} resigned=${sd.resigned}` : "未找到"}`);

    // ============================================================
    console.log("\n──── 测试 3：部门人员视图（测试部门）────");
    const deptView1 = await pageCount(
      `/employees/views/departments?departmentId=${deptId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("3.1", "出现在「部门人员查询」→ 测试部门 的人员列表", deptView1.count === 1,
      `命中 ${deptView1.count} 条（期望 1）`);

    const deptOverview = await get("/employees/views/departments");
    check("3.2", "部门清单由 Department 表动态生成（总览页含「测试部门」）",
      deptOverview.status === 200 && deptOverview.text.includes(T.dept),
      `HTTP ${deptOverview.status}`);

    const dd = distOf(afterCreate, "departmentDistribution", deptId);
    check("3.3", "部门分布统计自动包含该部门（total=1 / active=1）",
      dd?.total === 1 && dd?.active === 1,
      `departmentDistribution: ${dd ? `total=${dd.total} active=${dd.active} resigned=${dd.resigned}` : "未找到"}`);

    const pd = distOf(afterCreate, "positionDistribution", null);
    check("3.4", "岗位分布统计口径自洽（合计 = 员工总数）",
      (afterCreate.positionDistribution ?? []).reduce((s, x) => s + x.total, 0) === afterCreate.totalEmployees,
      `岗位合计=${(afterCreate.positionDistribution ?? []).reduce((s, x) => s + x.total, 0)} 员工总数=${afterCreate.totalEmployees}`);

    // ---- 分布统计口径自洽 ----
    check("3.5", "门店分布合计 = 员工总数",
      (afterCreate.storeDistribution ?? []).reduce((s, x) => s + x.total, 0) === afterCreate.totalEmployees,
      `门店合计=${(afterCreate.storeDistribution ?? []).reduce((s, x) => s + x.total, 0)} 员工总数=${afterCreate.totalEmployees}`);
    check("3.6", "部门分布合计 = 员工总数",
      (afterCreate.departmentDistribution ?? []).reduce((s, x) => s + x.total, 0) === afterCreate.totalEmployees,
      `部门合计=${(afterCreate.departmentDistribution ?? []).reduce((s, x) => s + x.total, 0)} 员工总数=${afterCreate.totalEmployees}`);

    // ============================================================
    console.log("\n──── 测试 4：状态 ACTIVE → RESIGNED ────");
    const upd = await send("PUT", `/api/employees/${empId}`, {
      status: "RESIGNED",
      resignDate: "2026-09-20",
      resignReason: "验收测试",
    });
    check("4.1", "状态修改成功", upd.status === 200 && upd.json?.data?.status === "RESIGNED",
      `status=${upd.json?.data?.status}`);

    const active2 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    check("4.2", "自动从「在职人员」消失", active2.count === 0,
      `命中 ${active2.count} 条（期望 0）`);

    const resigned2 = await pageCount(
      `/employees/views/resigned?keyword=${encodeURIComponent(T.empName)}`,
      "离职人员"
    );
    check("4.3", "自动出现在「离职人员」", resigned2.count === 1,
      `命中 ${resigned2.count} 条（期望 1）`);

    const resignedPage = await get(
      `/employees/views/resigned?keyword=${encodeURIComponent(T.empName)}`
    );
    check("4.4", "离职视图展示离职日期 / 离职原因",
      resignedPage.text.includes("2026-09-20") && resignedPage.text.includes("验收测试"),
      "页面含 2026-09-20 与「验收测试」");

    const afterResign = await stats(true);
    check("4.5", "统计接口同步（在职 -1 / 离职 +1）",
      afterResign.activeEmployees === afterCreate.activeEmployees - 1 &&
        afterResign.resignedEmployees === afterCreate.resignedEmployees + 1,
      `在职 ${afterCreate.activeEmployees}→${afterResign.activeEmployees}，离职 ${afterCreate.resignedEmployees}→${afterResign.resignedEmployees}`);

    const sd2 = distOf(afterResign, "storeDistribution", storeId);
    check("4.6", "门店视图同步（该店在职 1→0、离职 0→1）",
      sd2?.active === 0 && sd2?.resigned === 1,
      `total=${sd2?.total} active=${sd2?.active} resigned=${sd2?.resigned}`);

    const dd2 = distOf(afterResign, "departmentDistribution", deptId);
    check("4.7", "部门视图同步（离职仍计入部门总人数）",
      dd2?.total === 1 && dd2?.active === 0 && dd2?.resigned === 1,
      `total=${dd2?.total} active=${dd2?.active} resigned=${dd2?.resigned}`);

    const storeView2 = await pageCount(
      `/employees/views/stores?storeId=${storeId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("4.8", "离职后仍可在门店人员列表查到（门店视图不锁定状态）",
      storeView2.count === 1, `命中 ${storeView2.count} 条`);

    // ============================================================
    console.log("\n──── 测试 5：数据来源（实时查库 / 无 mock）────");
    const home = await get("/");
    const st = await stats();
    check("5.1", "首页统计数字与接口一致（非硬编码）",
      home.text.includes(String(st.totalEmployees)) && home.text.includes(String(st.activeEmployees)),
      `首页含 总数=${st.totalEmployees} 在职=${st.activeEmployees}`);

    const a1 = await pageCount(`/employees/views/active?keyword=${encodeURIComponent(T.empName)}`, "在职人员");
    const a2 = await pageCount(`/employees/views/active?keyword=${encodeURIComponent(T.empName)}`, "在职人员");
    check("5.2", "连续两次请求结果一致（服务端实时查询）",
      a1.count === a2.count && a1.count === 0, `两次命中：${a1.count} / ${a2.count}`);

    const pages = [
      "/", "/employees", "/employees/views", "/employees/views/active", "/employees/views/resigned",
      "/employees/views/stores", "/employees/views/departments", "/employees/views/distribution",
      `/employees/${empId}`,
    ];
    let allOk = true;
    const bad = [];
    for (const p of pages) {
      const r = await get(p);
      if (r.status !== 200) { allOk = false; bad.push(`${p}(${r.status})`); }
    }
    check("5.3", `全部 ${pages.length} 个页面 HTTP 200`, allOk, bad.length ? `异常：${bad.join(", ")}` : "全部 200");

    // ============================================================
    console.log("\n──── 清理测试数据 ────");
    for (const id of cleanup.employeeIds) {
      await send("DELETE", `/api/employees/${id}`);
      console.log(`   已停用测试员工 id=${id}（软删除，可用 cleanup 脚本彻底清理）`);
    }
    for (const id of cleanup.storeIds) {
      await send("PATCH", `/api/stores/${id}`, { status: "INACTIVE" });
      console.log(`   已停用测试门店 id=${id}（无员工关联后由 test:cleanup 彻底删除）`);
    }
    for (const id of cleanup.deptIds) {
      await send("PATCH", `/api/departments/${id}`, { status: "INACTIVE" });
      console.log(`   已停用测试部门 id=${id}`);
    }
  } catch (e) {
    console.error("\n❌ 执行中断：", e);
    fail++;
    failures.push("执行中断 " + e.message);
  }

  console.log("\n" + "═".repeat(76));
  console.log(`第二阶段开发验收结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log("失败项：" + failures.join("；"));
  console.log("═".repeat(76));
  process.exit(fail === 0 ? 0 : 1);
}

main();
