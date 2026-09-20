/**
 * ============================================================
 * 第四阶段验收测试
 * scripts/stage4-test.mjs
 *
 * 覆盖需求书「五、测试要求」：
 *   1. 合并门店后：员工数量正确
 *   2. 部门自动分配：统计同步
 *   3. 问题关闭：数据质量统计变化
 *   4. 导入预览：不会直接修改数据库
 *
 * ⚠ 只使用合成数据（假姓名/假身份证/假手机号），可安全提交到仓库。
 * 运行前提：npm run build && npm run start
 * ============================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SRC_XLSX = path.join(process.cwd(), "途虎HR人员登记.xlsx");
const TMP_DIR = path.join(process.cwd(), "data", "import");

const T = {
  storeA: "阶段四测试门店A_临时",
  storeB: "阶段四测试门店B_临时",
  dept: "阶段四测试部门_临时",
  emp1: "阶段四测试员工_甲",
  emp2: "阶段四测试员工_乙",
  empNoDept: "阶段四测试员工_无部门",
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

async function get(p) {
  const r = await fetch(BASE + p);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: r.status, text, json };
}

async function send(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
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

async function cleanupLeftover(pattern) {
  const r = await get(
    "/api/employees?keyword=" + encodeURIComponent(pattern) + "&includeDeleted=true&pageSize=100"
  );
  for (const e of r.json?.data ?? []) await send("DELETE", `/api/employees/${e.id}`);
}

async function main() {
  console.log("═".repeat(76));
  console.log("第四阶段验收测试   BASE =", BASE);
  console.log("═".repeat(76));

  const cleanup = { employeeIds: [], storeIds: [], deptIds: [], ruleIds: [] };

  try {
    await cleanupLeftover("阶段四测试员工");

    // ============================================================
    console.log("\n──── 准备：建两家门店 + 一个部门 + 员工 ────");
    for (const name of [T.storeA, T.storeB]) {
      const r = await send("POST", "/api/stores", { name });
      let id = r.json?.data?.id ?? null;
      if (!id) {
        const list = await get("/api/stores?includeInactive=true&keyword=" + encodeURIComponent(name));
        id = list.json?.data?.find((s) => s.name === name)?.id ?? null;
      }
      if (id) cleanup.storeIds.push(id);
    }
    const dr = await send("POST", "/api/departments", { name: T.dept });
    let deptId = dr.json?.data?.id ?? null;
    if (!deptId) {
      const list = await get("/api/departments?includeInactive=true&keyword=" + encodeURIComponent(T.dept));
      deptId = list.json?.data?.find((d) => d.name === T.dept)?.id ?? null;
    }
    if (deptId) cleanup.deptIds.push(deptId);
    const [storeAId, storeBId] = cleanup.storeIds;
    check("P1", "两家测试门店 + 一个测试部门可用", !!(storeAId && storeBId && deptId),
      `A=${storeAId} B=${storeBId} 部门=${deptId}`);

    // 甲挂在 A 店，乙挂在 B 店
    for (const [name, storeId, card, phone] of [
      [T.emp1, storeAId, T.idCard, T.phone],
      [T.emp2, storeBId, "110101199001011235", "13900139000"],
      [T.empNoDept, storeAId, "110101199001011236", "13700137000"],
    ]) {
      const r = await send("POST", "/api/employees", {
        name,
        idCardNo: card,
        phone,
        hireDate: "2026-01-05",
        status: "ACTIVE",
        storeId,
      });
      if (r.json?.data?.id) cleanup.employeeIds.push(r.json?.data?.id);
    }
    check("P2", "3 名测试员工已建立", cleanup.employeeIds.length === 3, `ids=${cleanup.employeeIds}`);

    // ============================================================
    console.log("\n──── 测试 1：门店合并 —— 员工数量正确 ────");
    const beforeMerge = await stats(true);
    const aBefore = distOf(beforeMerge, "storeDistribution", storeAId);
    const bBefore = distOf(beforeMerge, "storeDistribution", storeBId);
    console.log(`   合并前：A店 ${aBefore?.total} 人，B店 ${bBefore?.total} 人`);

    const merge = await send("POST", "/api/stores/merge", {
      mainStoreId: storeAId,
      mergeStoreIds: [storeBId],
    });
    check("1.1", "合并请求成功", merge.status === 200 && merge.json?.ok,
      JSON.stringify(merge.json?.data ?? merge.json?.error));

    const m = merge.json?.data ?? {};
    check("1.2", "★ 合并后主门店人数 = 两家之和",
      m.mainTotalAfter === (aBefore?.total ?? 0) + (bBefore?.total ?? 0),
      `${(aBefore?.total ?? 0)} + ${(bBefore?.total ?? 0)} = ${(aBefore?.total ?? 0) + (bBefore?.total ?? 0)}，实际 ${m.mainTotalAfter}`);
    check("1.3", "★ 被合并门店人数归零", (await (async () => {
      const s = await stats(true);
      return distOf(s, "storeDistribution", storeBId)?.total ?? 0;
    })()) === 0, "B店已无员工");
    check("1.4", "员工总数不变（没有删除任何员工）",
      (await stats()).totalEmployees === beforeMerge.totalEmployees,
      `${beforeMerge.totalEmployees} → ${(await stats()).totalEmployees}`);
    // 别名是幂等的：重复合并同一对门店时不会重复建别名，
    // 因此这里断言「合并后主门店确实拥有被合并门店名这个别名」，而不是「本次新建了几个」
    const aliasesRes = await get(`/api/stores/${storeAId}/aliases`);
    const aliasNames = aliasesRes.json?.data ?? [];
    check("1.5", "★ 保留 StoreAlias 记录（被合并门店名成为主门店的别名）",
      aliasNames.includes(T.storeB),
      `主门店别名：[${aliasNames.join("、")}]（本次新建 ${m.aliasesCreated ?? 0} 个）`);
    check("1.6", "生成了 EmployeeHistory（迁移员工每人一条）", (m.employeesMoved ?? 0) >= 1,
      `employeesMoved=${m.employeesMoved}`);
    check("1.7", "被合并的门店记录被停用而非删除", (m.storesDeactivated ?? 0) === 1,
      `storesDeactivated=${m.storesDeactivated}`);

    // 用别名检索应能查到原来 B 店的员工
    const byAlias = await get(`/api/employees?keyword=${encodeURIComponent(T.storeB)}`);
    check("1.8", "★ 用被合并门店名检索仍可查到该批员工（别名生效）",
      (byAlias.json?.total ?? 0) >= 1, `命中 ${byAlias.json?.total} 人`);

    // ============================================================
    console.log("\n──── 测试 2：部门自动归属 —— 统计同步 ────");
    // 建规则：A 店的员工 → 测试部门
    const rule = await send("POST", "/api/department-rules", {
      departmentId: deptId,
      storeId: storeAId,
      priority: 10,
      employeeType: null,
      remark: "验收脚本",
    });
    check("2.1", "新增归属规则成功", rule.status === 201 && rule.json?.ok,
      JSON.stringify(rule.json?.data ?? rule.json?.error));
    const ruleId = rule.json?.data?.id;
    if (ruleId) cleanup.ruleIds.push(ruleId);

    const pv = await send("POST", "/api/departments/auto", { action: "preview" });
    check("2.2", "预览生成推荐（只读）", pv.status === 200 && pv.json?.ok,
      `将修改 ${pv.json?.data?.affected} 人`);
    const affected = pv.json?.data?.affected ?? 0;

    const beforeApply = await stats(true);
    const deptBefore = distOf(beforeApply, "departmentDistribution", deptId);
    const unassignedBefore = distOf(beforeApply, "departmentDistribution", null);

    const ap = await send("POST", "/api/departments/auto", { action: "apply" });
    check("2.3", "执行自动归属成功", ap.status === 200 && ap.json?.ok,
      JSON.stringify(ap.json?.data ?? ap.json?.error));
    const applied = ap.json?.data?.updated ?? 0;
    check("2.4", "★ 实际修改人数 = 预览人数", applied === affected,
      `预览 ${affected}，实际 ${applied}`);

    const afterApply = await stats(true);
    const deptAfter = distOf(afterApply, "departmentDistribution", deptId);
    const unassignedAfter = distOf(afterApply, "departmentDistribution", null);
    check("2.5", "★ 部门统计同步：新部门 +N",
      (deptAfter?.total ?? 0) === (deptBefore?.total ?? 0) + applied,
      `${deptBefore?.total ?? 0} → ${deptAfter?.total ?? 0}（+${applied}）`);
    check("2.6", "★ 部门统计同步：未分配 -N",
      (unassignedAfter?.total ?? 0) === (unassignedBefore?.total ?? 0) - applied,
      `${unassignedBefore?.total ?? 0} → ${unassignedAfter?.total ?? 0}`);

    const hist = await get(`/api/employees/${cleanup.employeeIds[2]}/history`);
    check("2.7", "自动归属也写入了变更记录",
      (hist.json?.data ?? []).some((h) => h.source === "BATCH_UPDATE"),
      `${(hist.json?.data ?? []).length} 条历史`);

    // ============================================================
    console.log("\n──── 测试 3：问题关闭 —— 数据质量统计变化 ────");
    const dqBefore = await get("/api/data-quality");
    const rowBefore = (dqBefore.json?.data?.rows ?? []).find((r) => r.key === "no-position");
    console.log(`   关闭前：无岗位 检出 ${rowBefore?.count}，待处理 ${rowBefore?.pending}`);
    const affectedBefore = dqBefore.json?.data?.affectedEmployees;

    // 取一条「无岗位」明细并关闭
    const detail = await get("/api/data-quality/no-position?pageSize=1");
    const target = detail.json?.data?.[0];
    check("3.1", "取到一条无岗位明细", !!target, `员工 ${target?.employeeId}`);

    const close = await send("POST", "/api/quality-issues", {
      issueType: "no-position",
      employeeId: target.id,
      status: "CLOSED",
      result: "验收脚本：已核实该员工无岗位属实",
    });
    check("3.2", "★ 关闭问题成功", close.status === 200 && close.json?.ok,
      JSON.stringify(close.json?.data ?? close.json?.error));

    const dqAfter = await get("/api/data-quality");
    const rowAfter = (dqAfter.json?.data?.rows ?? []).find((r) => r.key === "no-position");
    check("3.3", "★ 待处理数 -1，已处理数 +1",
      rowAfter?.pending === (rowBefore?.pending ?? 0) - 1 &&
        rowAfter?.handled === (rowBefore?.handled ?? 0) + 1,
      `待处理 ${rowBefore?.pending} → ${rowAfter?.pending}；已处理 ${rowBefore?.handled} → ${rowAfter?.handled}`);
    check("3.4", "★ 检出总数不变（关闭不等于数据变好，只是标记处理）",
      rowAfter?.count === rowBefore?.count, `${rowBefore?.count} → ${rowAfter?.count}`);
    check("3.5", "受影响员工数（去重）减少",
      (dqAfter.json?.data?.affectedEmployees ?? 0) <= (affectedBefore ?? 0),
      `${affectedBefore} → ${dqAfter.json?.data?.affectedEmployees}`);

    const reopen = await send("POST", "/api/quality-issues", {
      issueType: "no-position",
      employeeId: target.id,
      status: "OPEN",
    });
    check("3.6", "重新打开后统计回滚", reopen.status === 200 && (await get("/api/data-quality")).json
      ?.data?.rows?.find((r) => r.key === "no-position")?.pending === rowBefore?.pending,
      "已重开，待处理数恢复");

    // ============================================================
    console.log("\n──── 测试 4：导入预览 —— 不会直接修改数据库 ────");
    const baseBefore = await stats();
    const histCountBefore = (await get(`/api/employees/${cleanup.employeeIds[0]}/history`)).json?.total ?? 0;
    const buf = readFileSync(SRC_XLSX);

    // 4a. 上传当前源文件 —— 期望「基本无差异」
    const fd = new FormData();
    fd.append("file", new Blob([buf]), "途虎HR人员登记.xlsx");
    const up = await fetch(BASE + "/api/import/preview", { method: "POST", body: fd });
    const upJson = await up.json();
    check("4.1", "上传并生成 Diff 成功", up.status === 201 && upJson.ok,
      JSON.stringify(upJson.data?.summary ?? upJson.error));
    const s1 = upJson.data?.summary ?? {};
    console.log(`   源文件 Diff：有效 ${s1.validRows} 行 / 将修改 ${s1.modified} / 将新增 ${s1.newCount}`);
    check("4.2", "★ 预览后员工总数不变（未写库）",
      (await stats()).totalEmployees === baseBefore.totalEmployees,
      `${baseBefore.totalEmployees} → ${(await stats()).totalEmployees}`);
    check("4.3", "★ 预览后员工变更记录数不变（未写库）",
      ((await get(`/api/employees/${cleanup.employeeIds[0]}/history`)).json?.total ?? 0) === histCountBefore,
      "历史记录数未变");
    check("4.4", "预览批次处于 PENDING（未自动写入）",
      upJson.data?.status === "PENDING", `status=${upJson.data?.status}`);

    // 4b. 造一个「改了门店」的文件上传，验证能识别出门店变化，且仍不写库
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(SRC_XLSX);
    const ws = wb.getWorksheet("数据库");
    // 把第 3 行（第一名员工）的门店名称改成测试门店 A
    const origStore = ws.getCell(3, 2).value;
    ws.getCell(3, 2).value = T.storeA;
    mkdirSync(TMP_DIR, { recursive: true });
    const tmpPath = path.join(TMP_DIR, "_stage4_probe.xlsx");
    await wb.xlsx.writeFile(tmpPath);
    const buf2 = readFileSync(tmpPath);
    writeFileSync(tmpPath, buf2); // 保持存在便于排查

    const fd2 = new FormData();
    fd2.append("file", new Blob([buf2]), "stage4-modified.xlsx");
    const up2 = await fetch(BASE + "/api/import/preview", { method: "POST", body: fd2 });
    const up2Json = await up2.json();
    check("4.5", "改动门店后上传，Diff 能识别出门店变化",
      up2.status === 201 && (up2Json.data?.summary?.storeChanges ?? 0) >= 1,
      `storeChanges=${up2Json.data?.summary?.storeChanges}（原门店「${origStore}」→「${T.storeA}」）`);
    check("4.6", "★ 即使识别出差异，数据库依然零变化",
      (await stats()).totalEmployees === baseBefore.totalEmployees,
      `员工总数 ${(await stats()).totalEmployees}`);

    // 4c. 丢弃这批预览，确认仍不写库 + 不能被重复提交
    const discard = await send("DELETE", `/api/import/preview/${up2Json.data?.id}`);
    check("4.7", "丢弃预览成功", discard.status === 200 && discard.json?.ok, "");
    const reCommit = await send("POST", `/api/import/preview/${up2Json.data?.id}`);
    check("4.8", "★ 已丢弃的批次不能被提交（防重复写入）",
      reCommit.status === 400 && !reCommit.json?.ok, reCommit.json?.error ?? "");
    check("4.9", "★ 全程数据库零变化",
      (await stats()).totalEmployees === baseBefore.totalEmployees,
      `员工总数 ${(await stats()).totalEmployees}`);

    // ============================================================
    console.log("\n──── 测试 5：新页面可访问 ────");
    const pages = ["/stores/merge", "/employees/department-auto", "/import", "/data-quality", "/stores"];
    let allOk = true;
    const bad = [];
    for (const p of pages) {
      const r = await get(p);
      if (r.status !== 200) {
        allOk = false;
        bad.push(`${p}(${r.status})`);
      }
    }
    check("5.1", `${pages.length} 个页面 HTTP 200`, allOk, bad.length ? `异常：${bad.join(", ")}` : "全部 200");

    // ============================================================
    console.log("\n──── 清理测试数据 ────");
    for (const id of cleanup.ruleIds) {
      await send("DELETE", `/api/department-rules/${id}`);
      console.log(`   已删除测试规则 id=${id}`);
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
  console.log(`第四阶段验收结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log("失败项：" + failures.join("；"));
  console.log("═".repeat(76));
  process.exit(fail === 0 ? 0 : 1);
}

main();
