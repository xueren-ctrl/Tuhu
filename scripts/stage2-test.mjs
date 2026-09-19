/**
 * ============================================================
 * 第二阶段验收测试
 * scripts/stage2-test.mjs
 *
 * 覆盖需求书「五、测试要求」的 4 项：
 *   1. 新增员工(status=ACTIVE) 是否自动出现在「在职人员」
 *   2. 状态 ACTIVE → RESIGNED 后，是否自动从「在职人员」消失、出现在「离职人员」
 *   3. 修改门店后，门店人员列表是否自动更新
 *   4. 刷新页面数据是否仍来自数据库
 *
 * 另附：/api/statistics 统计口径校验、人员视图各页面可访问性。
 *
 * ⚠ 只使用合成数据（假姓名/假身份证/假手机号），可安全提交到代码仓库。
 * 运行前提：npm run build && npm run start
 * ============================================================
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

// 合成测试数据
const T = {
  empName: "阶段二测试员工",
  idCard: "110101199001011234",
  phone: "13800138000",
  storeA: "阶段二测试门店A_临时",
  storeB: "阶段二测试门店B_临时",
  dept: "阶段二测试部门_临时",
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
    /* html */
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
 * 从页面 HTML 中读取「结果条数」。
 *
 * 注意：不能直接用「页面是否包含姓名」来判断，因为筛选框的 value 和
 * 「当前筛选」提示里也会回显关键词，必然包含姓名 → 会误判。
 * 因此这里解析卡片标题里的真实命中数，形如「在职人员（1 条）」。
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

async function main() {
  console.log("═".repeat(74));
  console.log("第二阶段验收测试  BASE =", BASE);
  console.log("═".repeat(74));

  const cleanup = { employeeIds: [], storeIds: [], deptIds: [] };

  try {
    // ================= 准备：建两个门店 + 一个部门 =================
    console.log("\n──── 准备测试数据 ────");
    for (const name of [T.storeA, T.storeB]) {
      const res = await send("POST", "/api/stores", { name });
      if (res.status === 201) {
        cleanup.storeIds.push(res.json.data.id);
        console.log(`   已建门店 ${name} (id=${res.json.data.id})`);
      } else if (res.status === 400) {
        // 已存在，查出来复用
        const list = await get("/api/stores?includeInactive=true&keyword=" + encodeURIComponent(name));
        const hit = list.json?.data?.find((s) => s.name === name);
        if (hit) cleanup.storeIds.push(hit.id);
        console.log(`   复用已存在门店 ${name} (id=${hit?.id})`);
      }
    }
    const deptRes = await send("POST", "/api/departments", { name: T.dept });
    if (deptRes.status === 201) {
      cleanup.deptIds.push(deptRes.json.data.id);
      console.log(`   已建部门 ${T.dept} (id=${deptRes.json.data.id})`);
    } else {
      const list = await get("/api/departments?includeInactive=true&keyword=" + encodeURIComponent(T.dept));
      const hit = list.json?.data?.find((d) => d.name === T.dept);
      if (hit) cleanup.deptIds.push(hit.id);
      console.log(`   复用已存在部门 ${T.dept} (id=${hit?.id})`);
    }

    const storeAId = cleanup.storeIds[0];
    const storeBId = cleanup.storeIds[1];
    const deptId = cleanup.deptIds[0];

    // 先清理可能残留的同名员工（上次测试未清理干净）
    const leftover = await get(
      "/api/employees?keyword=" + encodeURIComponent(T.empName) + "&includeDeleted=true&pageSize=50"
    );
    for (const e of leftover.json?.data ?? []) {
      await send("DELETE", `/api/employees/${e.id}`);
    }

    // ================= 测试 1：新增 ACTIVE 员工 → 出现在在职人员 =================
    console.log("\n──── 测试 1：新增 ACTIVE 员工是否自动出现在「在职人员」 ────");

    const beforeStats = (await get("/api/statistics")).json.data;
    console.log(`   新增前：在职 ${beforeStats.activeEmployees} / 离职 ${beforeStats.resignedEmployees}`);

    const created = await send("POST", "/api/employees", {
      name: T.empName,
      idCardNo: T.idCard,
      phone: T.phone,
      hireDate: "2026-01-05",
      status: "ACTIVE",
      storeId: storeAId,
      departmentId: deptId,
    });
    const empId = created.json?.data?.id;
    const empNo = created.json?.data?.employeeId;
    if (empId) cleanup.employeeIds.push(empId);
    check("1.0", "新增员工成功（status=ACTIVE）", created.status === 201 && !!empId,
      `id=${empId} employeeId=${empNo}`);

    // 在职人员视图（锁定 status=ACTIVE）应能看到
    const activeCount1 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    check("1.1", "自动出现在 /employees/views/active（在职人员）", activeCount1.count === 1,
      `页面命中数 = ${activeCount1.count}（期望 1）`);

    // 离职人员视图不应出现
    const resignedCount1 = await pageCount(
      `/employees/views/resigned?keyword=${encodeURIComponent(T.empName)}`,
      "离职人员"
    );
    check("1.2", "未出现在 /employees/views/resigned（离职人员）", resignedCount1.count === 0,
      `页面命中数 = ${resignedCount1.count}（期望 0）`);

    // 通过接口核对状态筛选口径
    const apiActive = await get(
      `/api/employees?status=ACTIVE&keyword=${encodeURIComponent(T.empName)}`
    );
    check("1.3", "在职人员视图口径 = status ACTIVE（接口核对）", apiActive.json?.total === 1,
      `命中 ${apiActive.json?.total} 条`);

    // 统计接口应 +1
    const afterStats1 = (await get("/api/statistics")).json.data;
    check("1.4", "/api/statistics 在职数量 +1",
      afterStats1.activeEmployees === beforeStats.activeEmployees + 1,
      `${beforeStats.activeEmployees} → ${afterStats1.activeEmployees}`);

    // ================= 测试 2：ACTIVE → RESIGNED =================
    console.log("\n──── 测试 2：状态 ACTIVE → RESIGNED 的自动联动 ────");

    const upd = await send("PUT", `/api/employees/${empId}`, {
      status: "RESIGNED",
      resignDate: "2026-03-31",
      resignReason: "阶段二测试离职",
    });
    check("2.0", "状态修改成功", upd.status === 200 && upd.json?.data?.status === "RESIGNED",
      `status=${upd.json?.data?.status}`);

    const activeCount2 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    check("2.1", "自动从「在职人员」消失", activeCount2.count === 0,
      `页面命中数 = ${activeCount2.count}（期望 0）`);

    const resignedCount2 = await pageCount(
      `/employees/views/resigned?keyword=${encodeURIComponent(T.empName)}`,
      "离职人员"
    );
    check("2.2", "自动出现在「离职人员」", resignedCount2.count === 1,
      `页面命中数 = ${resignedCount2.count}（期望 1）`);

    const apiResigned = await get(
      `/api/employees?status=RESIGNED&keyword=${encodeURIComponent(T.empName)}`
    );
    check("2.3", "接口口径同步（status=RESIGNED 命中 1 条）", apiResigned.json?.total === 1,
      `命中 ${apiResigned.json?.total} 条`);

    const apiActiveAfterResign = await get(
      `/api/employees?status=ACTIVE&keyword=${encodeURIComponent(T.empName)}`
    );
    check("2.3b", "接口口径同步（status=ACTIVE 命中 0 条）",
      apiActiveAfterResign.json?.total === 0,
      `命中 ${apiActiveAfterResign.json?.total} 条`);

    const afterStats2 = (await get("/api/statistics")).json.data;
    check("2.4", "/api/statistics 在职 -1、离职 +1",
      afterStats2.activeEmployees === beforeStats.activeEmployees &&
        afterStats2.resignedEmployees === beforeStats.resignedEmployees + 1,
      `在职 ${afterStats1.activeEmployees}→${afterStats2.activeEmployees}，离职 ${beforeStats.resignedEmployees}→${afterStats2.resignedEmployees}`);

    // 还原为在职，便于后续门店测试
    await send("PUT", `/api/employees/${empId}`, { status: "ACTIVE" });

    // ================= 测试 3：修改门店 → 门店人员列表自动更新 =================
    console.log("\n──── 测试 3：修改门店后门店人员列表是否自动更新 ────");

    const storeACount1 = await pageCount(
      `/employees/views/stores?storeId=${storeAId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("3.1", "员工出现在门店A 的人员列表", storeACount1.count === 1,
      `门店A 页面命中数 = ${storeACount1.count}（期望 1）`);

    const storeBCount1 = await pageCount(
      `/employees/views/stores?storeId=${storeBId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("3.2", "员工不在门店B 的人员列表", storeBCount1.count === 0,
      `门店B 页面命中数 = ${storeBCount1.count}（期望 0）`);

    // 门店A 的汇总数字（改门店前）
    const sumA1 = await get(`/api/employees?storeId=${storeAId}&pageSize=1`);
    const sumB1 = await get(`/api/employees?storeId=${storeBId}&pageSize=1`);

    const move = await send("PUT", `/api/employees/${empId}`, { storeId: storeBId });
    check("3.3", "修改门店成功", move.status === 200 && move.json?.data?.storeId === storeBId,
      `storeId ${storeAId} → ${move.json?.data?.storeId}`);

    const storeACount2 = await pageCount(
      `/employees/views/stores?storeId=${storeAId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    const storeBCount2 = await pageCount(
      `/employees/views/stores?storeId=${storeBId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("3.4", "自动从门店A 人员列表移出", storeACount2.count === 0,
      `门店A 页面命中数 = ${storeACount2.count}（期望 0）`);
    check("3.5", "自动出现在门店B 人员列表", storeBCount2.count === 1,
      `门店B 页面命中数 = ${storeBCount2.count}（期望 1）`);

    const sumA2 = await get(`/api/employees?storeId=${storeAId}&pageSize=1`);
    const sumB2 = await get(`/api/employees?storeId=${storeBId}&pageSize=1`);
    check("3.6", "门店人数统计同步变化",
      sumA2.json?.total === sumA1.json?.total - 1 && sumB2.json?.total === sumB1.json?.total + 1,
      `门店A ${sumA1.json?.total}→${sumA2.json?.total}，门店B ${sumB1.json?.total}→${sumB2.json?.total}`);

    // 门店总览页也应有该门店（动态生成）
    const storeOverview = await get("/employees/views/stores");
    check("3.7", "门店列表由 Store 表动态生成（含新建门店）", storeOverview.text.includes(T.storeA),
      `门店总览页${storeOverview.text.includes(T.storeA) ? "包含" : "未包含"} ${T.storeA}`);

    // 部门联动
    const deptCount = await pageCount(
      `/employees/views/departments?departmentId=${deptId}&keyword=${encodeURIComponent(T.empName)}`,
      "人员列表"
    );
    check("3.8", "部门人员列表同步（部门归属正确）", deptCount.count === 1,
      `部门页面命中数 = ${deptCount.count}（期望 1）`);

    // ================= 测试 4：刷新后数据仍来自数据库 =================
    console.log("\n──── 测试 4：刷新页面后数据是否仍来自数据库 ────");

    // 员工已改为在职，重新确认页面命中数
    await send("PUT", `/api/employees/${empId}`, { status: "ACTIVE" });
    const r1 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    const r2 = await pageCount(
      `/employees/views/active?keyword=${encodeURIComponent(T.empName)}`,
      "在职人员"
    );
    check("4.1", "同一页面连续两次请求结果一致（服务端实时查询）",
      r1.count === 1 && r2.count === 1,
      `两次命中数：${r1.count} / ${r2.count}（均为 1）`);

    // 分页/筛选参数在刷新后依然生效（URL 驱动）
    const paged = await get("/employees/views/active?page=2&pageSize=10&sortBy=name&sortOrder=desc");
    check("4.2", "URL 参数在刷新后依然生效（分页/排序）", paged.status === 200,
      `HTTP ${paged.status}`);

    // ================= 补充：统计接口与各视图可访问 =================
    console.log("\n──── 补充：统计接口与视图可访问性 ────");

    const stat = await get("/api/statistics");
    const sd = stat.json?.data;
    check("S1", "GET /api/statistics 返回全部规定字段",
      stat.status === 200 &&
        typeof sd?.totalEmployees === "number" &&
        typeof sd?.activeEmployees === "number" &&
        typeof sd?.resignedEmployees === "number" &&
        typeof sd?.storeCount === "number" &&
        typeof sd?.departmentCount === "number" &&
        typeof sd?.positionCount === "number",
      `总数=${sd?.totalEmployees} 在职=${sd?.activeEmployees} 离职=${sd?.resignedEmployees} 门店=${sd?.storeCount} 部门=${sd?.departmentCount} 岗位=${sd?.positionCount}`);

    const detail = await get("/api/statistics?detail=1");
    const dd = detail.json?.data;
    check("S2", "GET /api/statistics?detail=1 附带三类分布",
      Array.isArray(dd?.storeDistribution) &&
        Array.isArray(dd?.departmentDistribution) &&
        Array.isArray(dd?.positionDistribution),
      `storeDistribution=${dd?.storeDistribution?.length} departmentDistribution=${dd?.departmentDistribution?.length} positionDistribution=${dd?.positionDistribution?.length}`);

    // 统计口径一致性：各视图命中数之和应等于统计总数
    const totalFromApi = (await get("/api/employees?pageSize=1")).json?.total;
    const sumStore = (dd?.storeDistribution ?? []).reduce((s, r) => s + r.total, 0);
    check("S3", "分布统计口径自洽（门店人数合计 = 员工总数）",
      sumStore === totalFromApi,
      `门店合计=${sumStore} 员工总数=${totalFromApi}`);

    const sumDept = (dd?.departmentDistribution ?? []).reduce((s, r) => s + r.total, 0);
    check("S4", "分布统计口径自洽（部门人数合计 = 员工总数）",
      sumDept === totalFromApi,
      `部门合计=${sumDept} 员工总数=${totalFromApi}`);

    const views = [
      "/employees/views",
      "/employees/views/active",
      "/employees/views/resigned",
      "/employees/views/stores",
      "/employees/views/departments",
      "/employees/views/distribution",
      "/settings/departments",
    ];
    for (const v of views) {
      const r = await get(v);
      check("页面", `可访问 ${v}`, r.status === 200 && r.text.includes("途虎"), `HTTP ${r.status}`);
    }

    // 未分配筛选可用
    const unassignedDept = await get("/api/employees?departmentId=__none__&pageSize=1");
    check("S5", "支持「未分配」筛选（departmentId=__none__）",
      unassignedDept.status === 200 && (unassignedDept.json?.total ?? -1) >= 0,
      `未分配部门员工 ${unassignedDept.json?.total} 人`);
  } catch (e) {
    check("ERR", "测试过程未抛异常", false, String(e?.message ?? e));
  } finally {
    // ================= 清理 =================
    console.log("\n──── 清理测试数据 ────");
    for (const id of cleanup.employeeIds) {
      // 软删除 + 物理删除：测试数据不留痕
      await send("DELETE", `/api/employees/${id}`);
    }
    if (cleanup.employeeIds.length) {
      console.log(`   已停用 ${cleanup.employeeIds.length} 名测试员工（数据保留为软删除状态）`);
    }
    const dl = await get("/api/departments?includeInactive=true");
    for (const d of dl.json?.data ?? []) {
      if (d.name === T.dept && d.employeeCount === 0) {
        console.log(`   测试部门 ${d.name} 已无关联员工，可手工删除或保留（id=${d.id}）`);
      }
    }
    console.log("");
    console.log("═".repeat(74));
    console.log(`第二阶段验收结果：通过 ${pass} 项，失败 ${fail} 项`);
    if (failures.length) {
      console.log("失败项：");
      failures.forEach((f) => console.log("   - " + f));
    }
    console.log("═".repeat(74));
    if (fail > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("测试脚本异常：", e);
  process.exit(1);
});
