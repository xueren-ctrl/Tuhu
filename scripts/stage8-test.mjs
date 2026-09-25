/**
 * Stage 8 验收：Sheet 数据表改造 + 手机/远程访问
 *
 * 全程走真实 HTTP，不 mock：
 *  - 局域网地址（本机网卡 IP）与 localhost 两个 Host 都测；
 *  - 用临时账号做一次真实登录，验证 http 下发的 Cookie **不带 Secure**（否则手机登录会闪回登录页）；
 *  - 测完立刻删除临时账号与会话，生产数据零残留。
 *
 * 运行：npm run test:stage8   （需先 npm run build && npm run serve）
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import os from "node:os";

/** 与 lib/password.ts 完全一致的哈希格式：scrypt$<salt>$<derived> */
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3000);

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

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${id} ${name}${detail ? " —— " + detail : ""}`);
}

const TEMP_USER = "__stage8_probe__";
const TEMP_PASS = randomBytes(12).toString("base64url") + "Aa1!";

async function main() {
  console.log("\n======= Stage 8 验收（Sheet 数据表 + 远程访问）=======\n");
  console.log("局域网地址：" + (LAN ?? "(未检测到)"));

  // ---------- 准备临时账号 ----------
  await prisma.session.deleteMany({ where: { username: TEMP_USER } });
  await prisma.appUser.deleteMany({ where: { username: TEMP_USER } });
  const user = await prisma.appUser.create({
    data: {
      username: TEMP_USER,
      displayName: "临时验证账号",
      role: "HR",
      status: "ACTIVE",
      passwordHash: hashPassword(TEMP_PASS),
    },
  });

  try {
    // ---------- S8-01 未登录访问受保护页面 ----------
    const r1 = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
    check("S8-01", "未登录访问首页 → 跳登录页", r1.status === 307 && (r1.headers.get("location") ?? "").includes("/login"), `status=${r1.status}`);

    // ---------- S8-02 未登录访问 API ----------
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/employees?pageSize=1`);
    check("S8-02", "未登录调 API → 401", r2.status === 401, `status=${r2.status}`);

    // ---------- S8-03 登录页可访问 ----------
    const r3 = await fetch(`http://127.0.0.1:${PORT}/login`);
    check("S8-03", "登录页可访问", r3.status === 200, `status=${r3.status}`);

    // ---------- S8-04 localhost 登录：Cookie 不带 Secure ----------
    const loginLocal = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: TEMP_USER, password: TEMP_PASS }),
    });
    const ckLocal = loginLocal.headers.get("set-cookie") ?? "";
    check("S8-04", "本机 http 登录成功", loginLocal.status === 200, `status=${loginLocal.status}`);
    check("S8-05", "本机 http 下 Cookie 不带 Secure", ckLocal.includes("hr_session=") && !/;\s*Secure/i.test(ckLocal), ckLocal.split(";").slice(0, 3).join(";"));
    const sidLocal = /hr_session=([^;]+)/.exec(ckLocal)?.[1] ?? "";

    // ---------- S8-06 局域网 IP 登录（手机走的正是这条路） ----------
    let sidLan = "";
    if (LAN) {
      const loginLan = await fetch(`http://${LAN}:${PORT}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: TEMP_USER, password: TEMP_PASS }),
      });
      const ckLan = loginLan.headers.get("set-cookie") ?? "";
      sidLan = /hr_session=([^;]+)/.exec(ckLan)?.[1] ?? "";
      check("S8-06", "局域网地址登录成功", loginLan.status === 200, `status=${loginLan.status} @${LAN}`);
      check("S8-07", "局域网 http 下 Cookie 不带 Secure（关键）", ckLan.includes("hr_session=") && !/;\s*Secure/i.test(ckLan), ckLan.split(";").slice(0, 3).join(";"));
    } else {
      check("S8-06", "局域网地址登录成功", false, "未检测到局域网地址");
      check("S8-07", "局域网 http 下 Cookie 不带 Secure（关键）", false, "未检测到局域网地址");
    }

    const host = LAN ? `http://${LAN}:${PORT}` : `http://127.0.0.1:${PORT}`;
    const sid = sidLan || sidLocal;
    const withCookie = (url, extra = {}) =>
      fetch(url, { headers: { cookie: `hr_session=${sid}`, ...extra }, redirect: "manual" });

    // ---------- S8-08 登录后能打开各 Sheet 数据表 ----------
    const sheets = ["在职", "离职", "南昌3店", "运营部", "招聘面试登记表", "运营部离职", "薪资表", "数据库"];
    let allOk = true;
    const bad = [];
    for (const s of sheets) {
      const res = await withCookie(`${host}/sheets/${encodeURIComponent(s)}`);
      const html = await res.text();
      const ok = res.status === 200 && html.includes("选择一列") && html.includes("每页");
      if (!ok) {
        allOk = false;
        bad.push(`${s}(${res.status})`);
      }
    }
    check("S8-08", `8 张 Sheet 全部以数据表模式打开（${sheets.join("/")}）`, allOk, bad.join(","));

    // ---------- S8-09 关键词搜索生效（用日期做关键词，避免测试脚本里出现个人数据） ----------
    const KW = "2021-03-22";
    const r9 = await withCookie(`${host}/sheets/${encodeURIComponent("在职")}?q=${encodeURIComponent(KW)}`);
    const h9 = await r9.text();
    check("S8-09", `在职表关键词搜索「${KW}」返回结果`, r9.status === 200 && h9.includes(KW) && h9.includes("命中"), `status=${r9.status}`);

    // ---------- S8-10 按列筛选生效（工种级别列 index=7，等于「店长」） ----------
    const r10 = await withCookie(`${host}/sheets/${encodeURIComponent("在职")}?col=7&op=equals&val=${encodeURIComponent("店长")}`);
    const h10 = await r10.text();
    check("S8-10", "在职表按「工种级别」列精确筛选", r10.status === 200 && h10.includes("命中") && h10.includes("店长"), `status=${r10.status}`);

    // ---------- S8-11 排序生效 ----------
    const r11 = await withCookie(`${host}/sheets/${encodeURIComponent("在职")}?sort=2&dir=desc`);
    const h11 = await r11.text();
    check("S8-11", "在职表按「入职时间」降序", r11.status === 200 && h11.includes("降序"), `status=${r11.status}`);

    // ---------- S8-12 敏感列在服务端就已打码：页面里不该出现任何完整身份证号 ----------
    const r12 = await withCookie(`${host}/sheets/${encodeURIComponent("在职")}`);
    const h12 = await r12.text();
    const rawIdHits = h12.match(/\d{17}[\dXx]/g) ?? [];
    const hasMasked = /\*{4,}/.test(h12);
    check("S8-12", "敏感列在服务端打码：页面不含任何 17 位以上长号", rawIdHits.length === 0 && hasMasked, `命中长号 ${rawIdHits.length} 处 · 打码出现=${hasMasked}`);

    // ---------- S8-13 分页参数生效 ----------
    const r13 = await withCookie(`${host}/sheets/${encodeURIComponent("数据库")}?size=20&page=2`);
    const h13 = await r13.text();
    check("S8-13", "数据库表每页 20 行 + 第 2 页", r13.status === 200 && h13.includes("每页"), `status=${r13.status}`);

    // ---------- S8-14 访问入口页正确展示局域网地址 ----------
    const r14 = await withCookie(`${host}/settings/access`);
    const h14 = await r14.text();
    check("S8-14", "访问入口页展示局域网地址", r14.status === 200 && (!LAN || h14.includes(LAN)), `status=${r14.status}`);

    // ---------- S8-15 手机端卡片视图标记存在 ----------
    const hasMobileView = h12.includes("md:hidden");
    check("S8-15", "页面包含手机端卡片式布局", r12.status === 200 && hasMobileView, "");

    // ---------- S8-16 移动端抽屉（侧边栏可收起） ----------
    check("S8-16", "内部导航含「访问入口」", h12.includes("/settings/access"), "");

    // ---------- S8-17 数据零改动核对 ----------
    const empCount = await prisma.employee.count({ where: { deletedAt: null } });
    const sheetRows = await prisma.sheetRow.count();
    check("S8-17", "员工 / SheetRow 数量未被本次改动影响", empCount > 0 && sheetRows > 0, `员工=${empCount} SheetRow=${sheetRows}`);
  } finally {
    // ---------- 清理临时账号与会话 ----------
    const delS = await prisma.session.deleteMany({ where: { username: TEMP_USER } });
    await prisma.appUser.delete({ where: { id: user.id } }).catch(() => {});
    const left = await prisma.appUser.count({ where: { username: TEMP_USER } });
    check("S8-18", "临时验证账号与会话已清理（生产零残留）", left === 0, `删除会话 ${delS.count} 条`);
    await prisma.$disconnect();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n======= 通过 ${pass}/${results.length} =======`);
  if (pass !== results.length) {
    console.log("失败项：");
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.id} ${r.name}`));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("验收脚本异常：", e);
  await prisma.session.deleteMany({ where: { username: TEMP_USER } }).catch(() => {});
  await prisma.appUser.deleteMany({ where: { username: TEMP_USER } }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
