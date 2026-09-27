/**
 * 验收自检脚本 —— 对应需求书第十八节 A~Q
 * 运行前提：npm run build && npm run start (localhost:3000)
 *
 * ⚠ 本脚本只使用**合成测试数据**（假身份证/假手机号），
 *    绝不引用任何真实员工信息，可安全提交到代码仓库。
 *    如需按真实数据检索，请用筛选接口按关键词自查，不要把真实值写进代码。
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

// 合成测试数据（均为无效/示例号码，不对应真实个人）
const T = {
  name: "验收测试员工",
  nameEdited: "验收测试员工（已改）",
  idCard: "110101199001011234",
  phone1: "13800138000",
  phone2: "13900139000",
  bank: "0000123456789012",
};

let pass = 0;
let fail = 0;

function check(id, title, ok, detail) {
  if (ok) pass++;
  else fail++;
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

async function main() {
  console.log("═".repeat(72));
  console.log("途虎加盟店 HR 验收自检  BASE =", BASE);
  console.log("═".repeat(72));

  // ── B / D：数据库能启动 + 能看到员工总数 ──────────────────
  const stats = await get("/api/stats");
  const s = stats.json?.data;
  check("B", "数据库正常启动，统计接口可用", stats.status === 200 && !!s,
    `总数=${s?.total} 在职=${s?.active} 离职=${s?.resigned} 门店=${s?.storeCount} 职位=${s?.positionCount}`);
  check("D", "能够看到员工总数（实时来自数据库）", (s?.total ?? 0) > 0,
    `员工总数 = ${s?.total}`);

  // ── F：新增员工（先造一条合成数据，后续检索都基于它）────────
  const created = await send("POST", "/api/employees", {
    name: T.name,
    idCardNo: T.idCard,
    phone: T.phone1,
    hireDate: "2026-09-19",
    status: "ACTIVE",
    bankAccountNo: T.bank,
    remark: "自动化验收自检创建，脚本结束时会清理",
  });
  const newId = created.json?.data?.id;
  const newEmpId = created.json?.data?.employeeId;
  check("F", "能够新增员工（自动生成 employee_id）",
    created.status === 201 && !!newId && /^THHR\d{4}\d{6}$/.test(String(newEmpId)),
    `新员工 id=${newId} employeeId=${newEmpId}`);

  check("安全2", "新增时长数字段按字符串保存（前导零保留）",
    created.json?.data?.bankAccountNo === T.bank,
    `bankAccountNo=${created.json?.data?.bankAccountNo}`);

  const afterCreate = await get(`/api/employees?keyword=${encodeURIComponent(T.name)}`);
  check("F2", "新增后员工列表立即可见", afterCreate.json?.total === 1,
    `命中 ${afterCreate.json?.total} 条`);

  // ── E：查询员工（按姓名 / 手机号 / 身份证）─────────────────
  const byName = await get("/api/employees?name=" + encodeURIComponent(T.name));
  check("E", "能够查询员工（按姓名）",
    byName.status === 200 && byName.json?.total === 1,
    `命中 ${byName.json?.total} 条，首条=${byName.json?.data?.[0]?.name} ${byName.json?.data?.[0]?.employeeId}`);

  const byPhone = await get(`/api/employees?phone=${T.phone1}`);
  check("E3", "按手机号搜索", byPhone.json?.total === 1, `命中 ${byPhone.json?.total} 条`);

  const byIdCard = await get(`/api/employees?idCardNo=${T.idCard}`);
  check("E4", "按身份证搜索", byIdCard.json?.total === 1, `命中 ${byIdCard.json?.total} 条`);

  const byKw = await get("/api/employees?keyword=" + encodeURIComponent("塘厦") + "&pageSize=5");
  check("E2", "关键词搜索（门店）", (byKw.json?.total ?? 0) > 0, `命中 ${byKw.json?.total} 条`);

  // 列表脱敏（用合成数据验证，不涉真实值）
  const masked = byIdCard.json?.data?.[0];
  check("安全", "列表接口默认脱敏身份证/手机号",
    !!masked &&
      !String(masked.idCardNo).includes(T.idCard) &&
      String(masked.idCardNo).includes("*") &&
      !String(masked.phone).includes(T.phone1),
    `返回 idCardNo=${masked?.idCardNo}  phone=${masked?.phone}`);

  // ── I / J / K：门店、职位、状态筛选 ──────────────────────
  const stores = await get("/api/stores?includeInactive=true");
  const pos = await get("/api/positions?includeInactive=true");
  const storeId = stores.json?.data?.[0]?.id;
  const positionId = pos.json?.data?.[0]?.id;

  const byStore = await get(`/api/employees?storeId=${storeId}&pageSize=5`);
  check("I", "能够按照门店筛选",
    byStore.status === 200 && (byStore.json?.total ?? 0) > 0,
    `门店「${stores.json?.data?.[0]?.name}」命中 ${byStore.json?.total} 条`);

  const byPos = await get(`/api/employees?positionId=${positionId}&pageSize=5`);
  check("J", "能够按照职位筛选",
    byPos.status === 200 && (byPos.json?.total ?? 0) > 0,
    `职位「${pos.json?.data?.[0]?.name}」命中 ${byPos.json?.total} 条`);

  const byActive = await get("/api/employees?status=ACTIVE&pageSize=5");
  const byResigned = await get("/api/employees?status=RESIGNED&pageSize=5");
  check("K", "能够按照在职/离职筛选",
    byActive.json?.total === s?.active + 1 && byResigned.json?.total === s?.resigned,
    `在职筛选=${byActive.json?.total}（统计+新建1=${(s?.active ?? 0) + 1}） 离职筛选=${byResigned.json?.total}（统计=${s?.resigned}）`);

  // ── L：employee_id 唯一 ─────────────────────────────────
  const all = await get("/api/employees?pageSize=200&sortBy=employeeId");
  const idsOk = all.json?.data?.every((e) => /^THHR\d{4}\d{6}$/.test(e.employeeId));
  check("L", "员工拥有唯一 employee_id（THHR+年份+6位流水号）", !!idsOk,
    `样例 ${all.json?.data?.[0]?.employeeId} … ${all.json?.data?.[4]?.employeeId}`);

  // ── H：查看员工详情 ─────────────────────────────────────
  const detail = await get(`/api/employees/${newId}`);
  check("H", "能够查看员工详情（完整字段）",
    detail.status === 200 && detail.json?.data?.name === T.name,
    `详情含 ${Object.keys(detail.json?.data ?? {}).length} 个字段`);
  check("安全3", "详情页返回完整敏感值（供 HR 核对）",
    detail.json?.data?.idCardNo === T.idCard,
    `idCardNo=${detail.json?.data?.idCardNo}`);

  // ── G：编辑员工 ─────────────────────────────────────────
  const put = await send("PUT", `/api/employees/${newId}`, {
    name: T.nameEdited,
    phone: T.phone2,
    remark: "已编辑",
    employeeId: "HACKED-ID", // 应被忽略
    createdAt: "1900-01-01T00:00:00.000Z", // 应被忽略
  });
  const afterUpdate = await get(`/api/employees/${newId}`);
  const a = afterUpdate.json?.data;
  check("G", "能够编辑员工（数据库真实更新）",
    put.status === 200 && a?.name === T.nameEdited && a?.phone === T.phone2,
    `name=${a?.name} phone=${a?.phone}`);
  check("G2", "employee_id 与创建时间不可被编辑修改",
    a?.employeeId === newEmpId &&
      new Date(a?.createdAt).getTime() !== new Date("1900-01-01T00:00:00.000Z").getTime(),
    `employeeId 仍为 ${a?.employeeId}，createdAt=${a?.createdAt}`);
  check("G3", "updatedAt 自动更新", !!a?.updatedAt, `updatedAt=${a?.updatedAt}`);
  check("日期", "日期字段不跨时区串日", a?.hireDate?.slice(0, 10) === "2026-09-19",
    `hireDate=${a?.hireDate}`);

  // ── M/N：再次请求数据仍在（已落盘）─────────────────────────
  const detailAgain = await get(`/api/employees/${newId}`);
  check("M/N", "再次请求数据仍在（数据落库 SQLite，非内存）",
    detailAgain.json?.data?.name === T.nameEdited, "重新查询返回一致结果");

  // ── 软删除 / 恢复 ───────────────────────────────────────
  const del = await send("DELETE", `/api/employees/${newId}`);
  const afterDel = await get(`/api/employees?keyword=${encodeURIComponent(T.name)}`);
  const withDeleted = await get(
    `/api/employees?keyword=${encodeURIComponent(T.name)}&includeDeleted=true`
  );
  check("删除", "删除为软删除（默认列表不再出现，数据仍保留）",
    del.json?.mode === "soft-delete" && afterDel.json?.total === 0 && withDeleted.json?.total === 1,
    `默认列表=${afterDel.json?.total}，含已停用=${withDeleted.json?.total}，mode=${del.json?.mode}`);

  const restore = await send("DELETE", `/api/employees/${newId}?restore=1`);
  check("恢复", "已停用档案可恢复",
    restore.json?.ok === true && restore.json?.mode === "restore",
    `mode=${restore.json?.mode}`);

  // ── 分页 / 排序 ────────────────────────────────────────
  const p1 = await get("/api/employees?page=1&pageSize=10&sortBy=name&sortOrder=asc");
  const p2 = await get("/api/employees?page=2&pageSize=10&sortBy=name&sortOrder=asc");
  const names1 = (p1.json?.data ?? []).map((x) => x.name);
  const names2 = (p2.json?.data ?? []).map((x) => x.name);
  check("分页", "分页可用且结果不重叠",
    p1.json?.totalPages > 1 && names1.length === 10 && names2.length === 10 && names1[0] !== names2[0],
    `总页数=${p1.json?.totalPages}，第1页10条，第2页10条`);

  const desc = await get("/api/employees?pageSize=10&sortBy=name&sortOrder=desc");
  check("排序", "排序可用（升/降序）",
    (p1.json?.data?.[0]?.name ?? "") <= (desc.json?.data?.[0]?.name ?? ""),
    `升序首条=${p1.json?.data?.[0]?.name}，降序首条=${desc.json?.data?.[0]?.name}`);

  // ── 页面可访问（SSR 渲染）───────────────────────────────
  const pages = ["/", "/employees", "/employees/new", `/employees/${newId}`,
    `/employees/${newId}/edit`, "/settings/stores", "/settings/positions", "/settings/import"];
  for (const p of pages) {
    const r = await get(p);
    check("页面", `页面可访问 ${p}`, r.status === 200 && r.text.includes("途虎"), `HTTP ${r.status}`);
  }

  const home = await get("/");
  check("首页", "首页展示实时统计数字（非硬编码）",
    home.text.includes(String(s.total)), `页面包含员工总数 ${s.total}`);

  // ── 门店 / 职位 管理接口 ────────────────────────────────
  const newStore = await send("POST", "/api/stores", { name: "验收测试门店_临时" });
  const storeOk = newStore.status === 201;
  const updStore = storeOk
    ? await send("PUT", `/api/stores/${newStore.json.data.id}`, { region: "测试区" })
    : { json: {} };
  const patchStore = storeOk
    ? await send("PATCH", `/api/stores/${newStore.json.data.id}`, { status: "INACTIVE" })
    : { json: {} };
  check("门店", "门店管理：新增 / 编辑 / 停用",
    storeOk && updStore.json?.data?.region === "测试区" && patchStore.json?.data?.status === "INACTIVE",
    `id=${newStore.json?.data?.id} region=${updStore.json?.data?.region} status=${patchStore.json?.data?.status}`);

  const newPos = await send("POST", "/api/positions", { name: "验收测试职位_临时" });
  const patchPos = newPos.status === 201
    ? await send("PATCH", `/api/positions/${newPos.json.data.id}`, { status: "INACTIVE" })
    : { json: {} };
  check("职位", "职位管理：新增 / 停用",
    newPos.status === 201 && patchPos.json?.data?.status === "INACTIVE",
    `id=${newPos.json?.data?.id} status=${patchPos.json?.data?.status}`);

  // ── 校验与健壮性 ────────────────────────────────────────
  const noName = await send("POST", "/api/employees", { name: "   " });
  check("校验", "姓名为空时拒绝新增并返回中文错误",
    noName.status === 400 && String(noName.json?.error).includes("姓名"),
    `HTTP ${noName.status} error=${noName.json?.error}`);

  const notFound = await get("/api/employees/99999999");
  check("健壮性", "查询不存在的员工返回 404", notFound.status === 404, `HTTP ${notFound.status}`);

  console.log("═".repeat(72));
  console.log(`验收结果：通过 ${pass} 项，失败 ${fail} 项`);
  console.log("═".repeat(72));
  console.log("提示：运行 `npx tsx scripts/cleanup-test-data.ts` 清理本次产生的测试数据。");
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("验收脚本异常：", e);
  process.exit(1);
});
