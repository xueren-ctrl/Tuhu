/**
 * ============================================================
 * 第三阶段验收测试
 * scripts/stage3-test.mjs
 *
 * 覆盖需求书「五、测试要求」：
 *   1. 门店别名：不同名称查询结果一致
 *   2. 批量修改：修改部门后，部门统计同步变化
 *   3. 员工修改：生成 EmployeeHistory 记录
 *   4. 新增页面可访问（/stores /data-quality /employees/batch）
 *
 * ⚠ 只使用合成数据（假姓名/假身份证/假手机号），可安全提交到仓库。
 * 运行前提：npm run build && npm run start
 * ============================================================
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

const T = {
  // 注意：别名不能是标准名的子串（否则关键词检索会互相命中，测不出差异）
  store: "阶段三测试门店_临时",
  alias: "阶段三测试_旧写法",
  dept: "阶段三测试部门_临时",
  emp1: "阶段三测试员工_甲",
  emp2: "阶段三测试员工_乙",
  idCard: "110101199001011234",
  phone: "13800138000",
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

async function stats(detail = false) {
  const r = await get("/api/statistics" + (detail ? "?detail=1" : ""));
  return r.json?.data ?? null;
}

function distOf(data, key, id) {
  return (data?.[key] ?? []).find((x) => String(x.id) === String(id)) ?? null;
}

/** 清理上次可能残留的同名测试数据 */
async function cleanupLeftover(names) {
  for (const n of names) {
    const r = await get(
      "/api/employees?keyword=" + encodeURIComponent(n) + "&includeDeleted=true&pageSize=50"
    );
    for (const e of r.json?.data ?? []) await send("DELETE", `/api/employees/${e.id}`);
  }
}

async function main() {
  console.log("═".repeat(76));
  console.log("第三阶段验收测试   BASE =", BASE);
  console.log("═".repeat(76));

  const cleanup = { employeeIds: [], storeIds: [], deptIds: [], aliasIds: [] };
  const empPrefix = "阶段三测试员工";

  try {
    // ============================================================
    console.log("\n──── 准备 ────");
    await cleanupLeftover([empPrefix]);

    const storeRes = await send("POST", "/api/stores", { name: T.store });
    let storeId = storeRes.json?.data?.id ?? null;
    if (storeId) cleanup.storeIds.push(storeId);
    else {
      const list = await get("/api/stores?includeInactive=true&keyword=" + encodeURIComponent(T.store));
      storeId = list.json?.data?.find((s) => s.name === T.store)?.id ?? null;
      if (storeId) cleanup.storeIds.push(storeId);
    }
    check("P1", `标准门店「${T.store}」可用`, !!storeId, `id=${storeId}`);

    const deptRes = await send("POST", "/api/departments", { name: T.dept });
    let deptId = deptRes.json?.data?.id ?? null;
    if (deptId) cleanup.deptIds.push(deptId);
    else {
      const list = await get("/api/departments?includeInactive=true&keyword=" + encodeURIComponent(T.dept));
      deptId = list.json?.data?.find((d) => d.name === T.dept)?.id ?? null;
      if (deptId) cleanup.deptIds.push(deptId);
    }
    check("P2", `部门「${T.dept}」可用`, !!deptId, `id=${deptId}`);

    const baseStats = await stats();
    console.log(`   基线：员工 ${baseStats.totalEmployees} / 在职 ${baseStats.activeEmployees}`);

    // ============================================================
    console.log("\n──── 测试 1：门店别名 —— 不同名称查询结果一致 ────");

    // 1a. 甲：直接挂在标准门店
    const e1 = await send("POST", "/api/employees", {
      name: T.emp1,
      idCardNo: T.idCard,
      phone: T.phone,
      hireDate: "2026-01-05",
      status: "ACTIVE",
      storeId,
    });
    check("1.0a", "新增员工甲（挂标准门店）", e1.status === 201, `id=${e1.json?.data?.id}`);
    const emp1Id = e1.json?.data?.id;
    if (emp1Id) cleanup.employeeIds.push(emp1Id);

    // 1b. 乙：门店原文列写成「别名」，且不给 storeId —— 模拟历史脏写法
    const e2 = await send("POST", "/api/employees", {
      name: T.emp2,
      idCardNo: "110101199001011235",
      phone: "13900139000",
      hireDate: "2026-01-06",
      status: "ACTIVE",
      storeNameRaw: T.alias,
    });
    check("1.0b", "新增员工乙（门店原文写成别名、无门店外键）", e2.status === 201,
      `id=${e2.json?.data?.id}`);
    const emp2Id = e2.json?.data?.id;
    if (emp2Id) cleanup.employeeIds.push(emp2Id);

    // 别名登记前：用标准名查得到甲，用别名查得到乙（两者不同）
    const beforeStandard = await get(`/api/employees?keyword=${encodeURIComponent(T.store)}`);
    const beforeAlias = await get(`/api/employees?keyword=${encodeURIComponent(T.alias)}`);
    check("1.1", "登记别名前：标准名只命中甲", beforeStandard.json?.total === 1,
      `total=${beforeStandard.json?.total}`);
    check("1.2", "登记别名前：别名只命中乙", beforeAlias.json?.total === 1,
      `total=${beforeAlias.json?.total}`);

    // 登记别名（并自动统一归属）
    const aliasRes = await send("POST", `/api/stores/${storeId}/aliases`, {
      alias: T.alias,
      note: "第三阶段验收：历史写法",
      operator: "验收脚本",
    });
    check("1.3", "登记别名成功", aliasRes.status === 201 && !!aliasRes.json?.data?.alias?.id,
      `别名 id=${aliasRes.json?.data?.alias?.id}`);
    const aliasId = aliasRes.json?.data?.alias?.id;
    if (aliasId) cleanup.aliasIds.push(aliasId);
    const repointed = aliasRes.json?.data?.applied?.repointed ?? 0;
    check("1.4", "别名登记时自动统一归属（乙的门店外键指向标准门店）", repointed === 1,
      `重挂 ${repointed} 人（期望 1）`);

    // 关键验证：两个名称查询结果一致
    const afterStandard = await get(`/api/employees?keyword=${encodeURIComponent(T.store)}`);
    const afterAlias = await get(`/api/employees?keyword=${encodeURIComponent(T.alias)}`);
    check("1.5", "★ 用标准名查询命中 2 人", afterStandard.json?.total === 2,
      `total=${afterStandard.json?.total}（期望 2）`);
    check("1.6", "★ 用别名查询同样命中 2 人", afterAlias.json?.total === 2,
      `total=${afterAlias.json?.total}（期望 2）`);
    check("1.7", "★ 两种名称查询结果完全一致",
      afterStandard.json?.total === afterAlias.json?.total &&
        [...(afterStandard.json?.data ?? [])].map((x) => x.id).sort().join(",") ===
          [...(afterAlias.json?.data ?? [])].map((x) => x.id).sort().join(","),
      "两次返回的员工 id 集合相同");

    // 不复制员工数据：员工总数只增加了测试的两条，没有出现任何副本
    const afterStats = await stats();
    check("1.8", "别名未复制任何员工数据（总数只 +2）",
      afterStats.totalEmployees === baseStats.totalEmployees + 2,
      `${baseStats.totalEmployees} → ${afterStats.totalEmployees}`);

    // 门店分布：标准门店 total=2
    const sdBefore = await stats(true);
    const sd = distOf(sdBefore, "storeDistribution", storeId);
    check("1.9", "门店分布统计把两人都算进标准门店", sd?.total === 2 && sd?.active === 2,
      `total=${sd?.total} active=${sd?.active}`);

    // ============================================================
    console.log("\n──── 测试 2：批量修改部门 —— 部门统计同步变化 ────");

    const before = await stats(true);
    const unassignedBefore = distOf(before, "departmentDistribution", null);
    const deptBefore = distOf(before, "departmentDistribution", deptId);

    const batch = await send("POST", "/api/employees/batch", {
      filter: { departmentId: "__none__", keyword: empPrefix },
      departmentId: deptId,
      operator: "验收脚本",
    });
    check("2.1", "批量修改请求成功", batch.status === 200 && batch.json?.ok,
      JSON.stringify(batch.json?.data ?? batch.json?.error));
    const b = batch.json?.data ?? {};
    check("2.2", "批量修改命中 2 人且全部更新", b.matched === 2 && b.updated === 2,
      `matched=${b.matched} updated=${b.updated} unchanged=${b.unchanged} failed=${b.failed}`);

    const after = await stats(true);
    const deptAfter = distOf(after, "departmentDistribution", deptId);
    const unassignedAfter = distOf(after, "departmentDistribution", null);
    check("2.3", "★ 部门统计同步：新部门总人数 +2",
      (deptBefore?.total ?? 0) + 2 === (deptAfter?.total ?? 0),
      `${deptBefore?.total ?? 0} → ${deptAfter?.total ?? 0}`);
    check("2.4", "★ 部门统计同步：「未分配」人数 -2",
      (unassignedBefore?.total ?? 0) - 2 === (unassignedAfter?.total ?? 0),
      `${unassignedBefore?.total ?? 0} → ${unassignedAfter?.total ?? 0}`);

    const deptView = await get(`/employees/views/departments?departmentId=${deptId}`);
    check("2.5", "部门人员视图立即包含这两名员工",
      deptView.status === 200 && deptView.text.includes(T.emp1) && deptView.text.includes(T.emp2),
      `HTTP ${deptView.status}`);

    const distView = await get("/employees/views/distribution");
    check("2.6", "人员分布统计页同步（HTTP 200 且含部门名）",
      distView.status === 200 && distView.text.includes(T.dept), `HTTP ${distView.status}`);

    // ============================================================
    console.log("\n──── 测试 3：员工修改生成变更记录 ────");

    const beforeHist = await get(`/api/employees/${emp1Id}/history`);
    check("3.0", "新增员工已自动写入「新增」事件", (beforeHist.json?.total ?? 0) >= 1,
      `已有 ${beforeHist.json?.total} 条`);

    const upd = await send("PUT", `/api/employees/${emp1Id}`, {
      storeId: null,
      positionId: null,
      remark: "验收脚本修改备注",
    });
    check("3.1", "修改员工成功", upd.status === 200, `HTTP ${upd.status}`);

    const hist = await get(`/api/employees/${emp1Id}/history`);
    const rows = hist.json?.data ?? [];
    const remarkRow = rows.find((r) => r.fieldLabel === "备注");
    check("3.2", "★ 变更记录里出现被修改的字段", !!remarkRow,
      `字段：${rows.slice(0, 3).map((r) => r.fieldLabel).join(", ")}`);
    check("3.3", "★ 记录了「修改后」的值", remarkRow?.newValue === "验收脚本修改备注",
      `newValue=${remarkRow?.newValue}`);
    check("3.4", "★ 记录了操作人与操作时间",
      !!remarkRow?.operator && !!remarkRow?.operatedAt,
      `operator=${remarkRow?.operator} operatedAt=${remarkRow?.operatedAt?.slice(0, 19)}`);

    const batchRows = rows.filter((r) => r.source === "BATCH_UPDATE");
    check("3.5", "★ 批量修改也写入了变更记录（来源 BATCH_UPDATE）", batchRows.length >= 1,
      `${batchRows.length} 条，字段：${batchRows.map((r) => r.fieldLabel).join(", ")}`);

    const histPage = await get(`/employees/${emp1Id}`);
    check("3.6", "员工详情页含「变更记录」标签", histPage.text.includes("变更记录"),
      `HTTP ${histPage.status}`);

    // 敏感字段脱敏验证
    const idUpdate = await send("PUT", `/api/employees/${emp1Id}`, { phone: "13700137000" });
    if (idUpdate.status === 200) {
      const h2 = await get(`/api/employees/${emp1Id}/history`);
      const phoneRow = (h2.json?.data ?? []).find((r) => r.fieldLabel?.includes("联系电话"));
      check("3.7", "敏感字段变更只记录脱敏值",
        !phoneRow || !(phoneRow.newValue ?? "").includes("13700137000"),
        `记录值=${phoneRow?.newValue ?? "（无）"}`);
    }

    // ============================================================
    console.log("\n──── 测试 4：页面可访问性与接口口径 ────");
    const pages = [
      "/stores",
      "/data-quality",
      "/data-quality/status-conflict",
      "/data-quality/no-department",
      "/data-quality/no-position",
      "/data-quality/no-store",
      "/data-quality/duplicate",
      "/employees/batch",
    ];
    let allOk = true;
    const bad = [];
    for (const p of pages) {
      const r = await get(p);
      if (r.status !== 200) {
        allOk = false;
        bad.push(`${p}(${r.status})`);
      }
    }
    check("4.1", `全部 ${pages.length} 个新页面 HTTP 200`, allOk,
      bad.length ? `异常：${bad.join(", ")}` : "全部 200");

    const dq = await get("/api/data-quality");
    const cats = dq.json?.data?.rows ?? [];
    check("4.2", "数据质量汇总返回 5 类问题", cats.length === 5,
      cats.map((c) => `${c.label}=${c.count}`).join(" · "));
    check("4.3", "各类问题数量与明细接口一致", true,
      "逐类校验中…");
    for (const c of cats) {
      const d = await get(`/api/data-quality/${c.key}?pageSize=5`);
      const ok = d.json?.total === c.count;
      if (!ok) {
        fail++;
        failures.push(`4.3 ${c.label} 汇总与明细不一致`);
        console.log(`❌ [4.3] ${c.label} 汇总 ${c.count} ≠ 明细 ${d.json?.total}`);
      } else {
        console.log(`   ✓ ${c.label}：汇总 ${c.count} = 明细 ${d.json?.total}`);
      }
    }

    // ============================================================
    console.log("\n──── 清理测试数据 ────");
    for (const id of cleanup.aliasIds) {
      await send("DELETE", `/api/store-aliases/${id}`);
      console.log(`   已删除测试别名 id=${id}`);
    }
    for (const id of cleanup.employeeIds) {
      await send("DELETE", `/api/employees/${id}`);
      console.log(`   已停用测试员工 id=${id}`);
    }
    for (const id of cleanup.storeIds) {
      await send("PATCH", `/api/stores/${id}`, { status: "INACTIVE" });
      console.log(`   已停用测试门店 id=${id}`);
    }
    for (const id of cleanup.deptIds) {
      await send("PATCH", `/api/departments/${id}`, { status: "INACTIVE" });
      console.log(`   已停用测试部门 id=${id}`);
    }
    console.log("   （彻底删除请用 npm run test:cleanup）");
  } catch (e) {
    console.error("\n❌ 执行中断：", e);
    fail++;
    failures.push("执行中断 " + e.message);
  }

  console.log("\n" + "═".repeat(76));
  console.log(`第三阶段验收结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log("失败项：" + failures.join("；"));
  console.log("═".repeat(76));
  process.exit(fail === 0 ? 0 : 1);
}

main();
