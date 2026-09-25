/**
 * ============================================================
 * Stage 7.2C —— 单用户密码重置安全测试（S7-U1 ~ S7-U6）
 * scripts/seed-users-test.mjs
 *
 * 运行方式：
 *   npm run test:seed-users
 *
 * 安全模型：
 *   - data/hr.db 复制为 data/seed-users-test.db（副本）；
 *   - 全部 seed-users 调用都指向副本（DATABASE_URL 指向副本）；
 *   - **绝不修改生产 admin / hr 的 passwordHash**；
 *   - 结束后删副本。
 *
 * 覆盖：
 *   [S7-U1] --reset-password --only=admin → admin hash 变、hr hash 不变
 *   [S7-U2] --reset-password --only=hr    → hr hash 变、admin hash 不变
 *   [S7-U3] --reset-password（无 --only）  → exit 1，admin/hr 都不变
 *   [S7-U4] --reset-password --only=admin 但缺 SEED_ADMIN_PASSWORD → exit 1，DB 不变
 *   [S7-U5] --reset-password --only=xxx（未知用户名）→ exit 1，DB 不变
 *   [S7-U6] reset 成功后 stdout 不含密码明文
 *   [S7-U7] --only 参数冲突（同时 admin + hr）→ exit 1，DB 不变
 *   [S7-U8] 生产库 admin/hr passwordHash 全程未被本测试触碰（前后比对）
 * ============================================================
 */
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const ROOT = process.cwd();
const SRC_DB = path.resolve(ROOT, "data", "hr.db");
const TEST_DB = path.resolve(ROOT, "data", "seed-users-test.db");
const NODE = process.execPath;

/**
 * 测试密码**运行时随机生成**，绝不写入仓库 / 文件 / 日志。
 * （Stage 7.2C：测试脚本里硬编码密码等于把凭据提交进 Git。）
 * 这些密码只作用于一次性副本库，用完即随副本删除。
 */
const rnd = () => crypto.randomBytes(12).toString("hex");
const PWD_A1 = `S7u#A1_${rnd()}`;
const PWD_A2 = `S7u#A2_${rnd()}`;
const PWD_H1 = `S7u#H1_${rnd()}`;
const PWD_H2 = `S7u#H2_${rnd()}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(id, desc, ok, detail) {
  if (ok) {
    pass++;
    console.log(`✅ [${id}] ${desc}`);
    console.log(`       ${detail}`);
  } else {
    fail++;
    failures.push(`${id} ${desc}`);
    console.log(`❌ [${id}] ${desc}`);
    console.log(`       ${detail}`);
  }
}

/**
 * 运行 seed-users，返回 {status, stdout, stderr}（不 throw）。
 * ⚠️ 必须用**异步 spawn**：Windows 下同步 spawnSync 派生第二个 node.exe
 *    会触发 EBUSY（node.exe 句柄锁），输出完全丢失。参见项目长期约定。
 */
function runSeed(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      NODE,
      ["node_modules/tsx/dist/cli.mjs", "scripts/seed-users.ts", "--", ...args],
      {
        cwd: ROOT,
        env: { ...process.env, NODE_OPTIONS: "", ...env },
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      resolve({ status: -1, stdout, stderr: String(e), combined: stdout + String(e) })
    );
    child.on("close", (code) =>
      resolve({ status: code, stdout, stderr, combined: stdout + stderr })
    );
  });
}

const { PrismaClient } = await import("@prisma/client");

async function hashOf(prisma, username) {
  const u = await prisma.appUser.findUnique({
    where: { username },
    select: { passwordHash: true },
  });
  return u?.passwordHash ?? null;
}

async function main() {
  if (!existsSync(SRC_DB)) {
    console.error("❌ 找不到 data/hr.db");
    process.exit(2);
  }

  // ⚠️ DATABASE_URL 相对 prisma/ 目录解析 → 必须用**绝对路径**
  // （与 stage6 / stage6-security / stage7-1 测试脚本一致）
  const TEST_DB_URL = "file:" + TEST_DB;

  // ============ 生产库 passwordHash 前置快照（只读，用于 S7-U8） ============
  const prodClient = new PrismaClient({
    datasourceUrl: `file:${SRC_DB.replace(/\\/g, "/")}`,
  });
  const prodAdminBefore = await hashOf(prodClient, "admin");
  const prodHrBefore = await hashOf(prodClient, "hr");
  await prodClient.$disconnect();

  // ============ 建立副本 ============
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  copyFileSync(SRC_DB, TEST_DB);
  process.env.DATABASE_URL = TEST_DB_URL;

  console.log("═".repeat(72));
  console.log("Stage 7.2C 单用户密码重置安全测试   TEST_DB =", TEST_DB);
  console.log("═".repeat(72));

  const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

  // 先在副本上创建两个账号（普通初始化，不带 --reset-password）
  const init = await runSeed([], {
    DATABASE_URL: TEST_DB_URL,
    SEED_ADMIN_PASSWORD: PWD_A1,
    SEED_HR_PASSWORD: PWD_H1,
  });
  if (init.status !== 0) {
    console.error("❌ 副本账号初始化失败：", init.combined.slice(0, 800));
    process.exit(1);
  }

  // 记录基线哈希
  const baseAdmin = await hashOf(prisma, "admin");
  const baseHr = await hashOf(prisma, "hr");
  console.log(`副本基线：admin hash 长度=${baseAdmin?.length}  hr hash 长度=${baseHr?.length}`);

  // ---------- S7-U3：--reset-password 无 --only → 必须拒绝 ----------
  {
    const r = await runSeed(["--reset-password"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A2,
      SEED_HR_PASSWORD: PWD_H2,
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    check(
      "S7-U3",
      "--reset-password 未指定 --only → exit 1，admin/hr 密码哈希均不变",
      r.status === 1 && a === baseAdmin && h === baseHr,
      JSON.stringify({ exit: r.status, adminUnchanged: a === baseAdmin, hrUnchanged: h === baseHr })
    );
    // 提示文案必须明确告知必须指定 --only
    const hasHint =
      r.combined.includes("--only=admin") && r.combined.includes("--only=hr");
    check(
      "S7-U3b",
      "拒绝提示明确要求 --only=admin 或 --only=hr",
      hasHint,
      JSON.stringify({ hasHint })
    );
  }

  // ---------- S7-U5：未知 --only → 必须拒绝 ----------
  {
    const r = await runSeed(["--reset-password", "--only=xxx"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A2,
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    check(
      "S7-U5",
      "--reset-password --only=xxx（未知用户名）→ exit 1，数据库不变",
      r.status === 1 && a === baseAdmin && h === baseHr,
      JSON.stringify({ exit: r.status, adminUnchanged: a === baseAdmin, hrUnchanged: h === baseHr })
    );
  }

  // ---------- S7-U4：--only=admin 但缺 SEED_ADMIN_PASSWORD → 必须拒绝 ----------
  {
    const r = await runSeed(["--reset-password", "--only=admin"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: "",
      SEED_HR_PASSWORD: PWD_H2, // 给了 HR 密码也不该影响 admin-only 的判定
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    check(
      "S7-U4",
      "--reset-password --only=admin 但缺 SEED_ADMIN_PASSWORD → exit 1，数据库不变",
      r.status === 1 && a === baseAdmin && h === baseHr,
      JSON.stringify({ exit: r.status, adminUnchanged: a === baseAdmin, hrUnchanged: h === baseHr })
    );
  }

  // ---------- S7-U7：--only 冲突 → 必须拒绝 ----------
  {
    const r = await runSeed(["--reset-password", "--only=admin", "--only=hr"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A2,
      SEED_HR_PASSWORD: PWD_H2,
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    check(
      "S7-U7",
      "--only 参数冲突（同时 admin + hr）→ exit 1，数据库不变",
      r.status === 1 && a === baseAdmin && h === baseHr,
      JSON.stringify({ exit: r.status, adminUnchanged: a === baseAdmin, hrUnchanged: h === baseHr })
    );
  }

  // ---------- S7-U1：--only=admin → 只改 admin ----------
  let afterU1Admin = null;
  {
    const r = await runSeed(["--reset-password", "--only=admin"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A2,
      // 故意也提供 HR 密码：--only=admin 时不应被使用
      SEED_HR_PASSWORD: PWD_H2,
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    afterU1Admin = a;
    check(
      "S7-U1",
      "--reset-password --only=admin → admin hash 改变、hr hash 不变",
      r.status === 0 && a !== baseAdmin && h === baseHr,
      JSON.stringify({ exit: r.status, adminChanged: a !== baseAdmin, hrUnchanged: h === baseHr })
    );
  }

  // ---------- S7-U2：--only=hr → 只改 hr ----------
  {
    const r = await runSeed(["--reset-password", "--only=hr"], {
      DATABASE_URL: TEST_DB_URL,
      // 故意不提供 ADMIN 密码：--only=hr 时不应被要求
      SEED_ADMIN_PASSWORD: "",
      SEED_HR_PASSWORD: PWD_H2,
    });
    const a = await hashOf(prisma, "admin");
    const h = await hashOf(prisma, "hr");
    check(
      "S7-U2",
      "--reset-password --only=hr → hr hash 改变、admin hash 不变",
      r.status === 0 && h !== baseHr && a === afterU1Admin,
      JSON.stringify({
        exit: r.status,
        hrChanged: h !== baseHr,
        adminUnchanged: a === afterU1Admin,
      })
    );
  }

  // ---------- S7-U6：stdout 不含密码明文 ----------
  {
    // 用一个全新、绝不入仓库的随机测试密码跑一次，然后检查输出
    const secretPwd = `S7u#Never_${rnd()}`;
    const r = await runSeed(["--reset-password", "--only=admin"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: secretPwd,
    });
    const leaked =
      r.combined.includes(secretPwd) ||
      r.combined.includes(PWD_A1) ||
      r.combined.includes(PWD_A2) ||
      r.combined.includes(PWD_H1) ||
      r.combined.includes(PWD_H2);
    // 也不能输出 passwordHash 本体
    const hashNow = await hashOf(prisma, "admin");
    const leakedHash = hashNow ? r.combined.includes(hashNow) : false;
    check(
      "S7-U6",
      "reset 后 stdout/stderr 不含任何密码明文，也不含 passwordHash",
      r.status === 0 && !leaked && !leakedHash,
      JSON.stringify({ exit: r.status, leakedPlaintext: leaked, leakedHash })
    );
  }

  // ---------- S7-U8：生产库 passwordHash 全程未被触碰 ----------
  {
    const prodClient2 = new PrismaClient({
      datasourceUrl: `file:${SRC_DB.replace(/\\/g, "/")}`,
    });
    const prodAdminAfter = await hashOf(prodClient2, "admin");
    const prodHrAfter = await hashOf(prodClient2, "hr");
    const prodEmp = await prodClient2.employee.count();
    await prodClient2.$disconnect();
    check(
      "S7-U8",
      "生产库 admin/hr passwordHash 与员工数全程未被本测试修改",
      prodAdminAfter === prodAdminBefore &&
        prodHrAfter === prodHrBefore &&
        prodEmp === 1920,
      JSON.stringify({
        adminHashUnchanged: prodAdminAfter === prodAdminBefore,
        hrHashUnchanged: prodHrAfter === prodHrBefore,
        prodEmployee: prodEmp,
      })
    );
  }

  // ================================================================
  // Stage 7.2C.1 —— 重置语义（只改 passwordHash）+ Session 撤销 + 新旧密码认证
  // ================================================================

  // ---------- S7-U9：reset 只改 passwordHash，metadata 完全保留 ----------
  // 「重置密码 ≠ 自动重新激活账号」：INACTIVE 账号 reset 后仍必须是 INACTIVE。
  {
    // 先把 admin 改成一个有辨识度的自定义状态：停用 + 自定义显示名
    await prisma.appUser.update({
      where: { username: "admin" },
      data: { displayName: "自定义显示名U9", role: "ADMIN", status: "INACTIVE" },
    });
    const before9 = await prisma.appUser.findUnique({
      where: { username: "admin" },
      select: { passwordHash: true, displayName: true, role: true, status: true },
    });

    const r = await runSeed(["--reset-password", "--only=admin"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A2,
    });
    const after9 = await prisma.appUser.findUnique({
      where: { username: "admin" },
      select: { passwordHash: true, displayName: true, role: true, status: true },
    });

    check(
      "S7-U9a",
      "--only=admin reset：passwordHash 改变，但 displayName/role/status 完全不变（停用账号仍为 INACTIVE）",
      r.status === 0 &&
        after9.passwordHash !== before9.passwordHash &&
        after9.displayName === before9.displayName &&
        after9.role === before9.role &&
        after9.status === before9.status,
      JSON.stringify({
        exit: r.status,
        hashChanged: after9.passwordHash !== before9.passwordHash,
        displayNameUnchanged: after9.displayName === before9.displayName,
        roleUnchanged: after9.role === before9.role,
        statusUnchanged: after9.status === before9.status,
        statusValue: after9.status,
      })
    );

    // HR 同样验证（共用逻辑）
    await prisma.appUser.update({
      where: { username: "hr" },
      data: { displayName: "自定义显示名U9HR", role: "HR", status: "INACTIVE" },
    });
    const before9h = await prisma.appUser.findUnique({
      where: { username: "hr" },
      select: { passwordHash: true, displayName: true, role: true, status: true },
    });
    const rh = await runSeed(["--reset-password", "--only=hr"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_HR_PASSWORD: PWD_H2,
    });
    const after9h = await prisma.appUser.findUnique({
      where: { username: "hr" },
      select: { passwordHash: true, displayName: true, role: true, status: true },
    });
    check(
      "S7-U9b",
      "--only=hr reset：passwordHash 改变，但 displayName/role/status 完全不变",
      rh.status === 0 &&
        after9h.passwordHash !== before9h.passwordHash &&
        after9h.displayName === before9h.displayName &&
        after9h.role === before9h.role &&
        after9h.status === before9h.status,
      JSON.stringify({
        exit: rh.status,
        hashChanged: after9h.passwordHash !== before9h.passwordHash,
        displayNameUnchanged: after9h.displayName === before9h.displayName,
        roleUnchanged: after9h.role === before9h.role,
        statusUnchanged: after9h.status === before9h.status,
      })
    );
  }

  // ---------- S7-U10：密码重置必须撤销该账号全部 Session，且不波及其他账号 ----------
  {
    // 恢复为 ACTIVE 并造 2 条 admin Session + 1 条 hr Session
    const adminRow = await prisma.appUser.update({
      where: { username: "admin" },
      data: { displayName: "系统管理员", role: "ADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    const hrRow = await prisma.appUser.update({
      where: { username: "hr" },
      data: { displayName: "HR 操作员", role: "HR", status: "ACTIVE" },
      select: { id: true },
    });
    await prisma.session.deleteMany({});
    const exp = new Date(Date.now() + 8 * 3600 * 1000);
    for (let i = 1; i <= 2; i++) {
      await prisma.session.create({
        data: {
          id: `s7u10-admin-${i}-${rnd()}`,
          userId: adminRow.id,
          username: "admin",
          displayName: "系统管理员",
          role: "ADMIN",
          expiresAt: exp,
        },
      });
    }
    await prisma.session.create({
      data: {
        id: `s7u10-hr-1-${rnd()}`,
        userId: hrRow.id,
        username: "hr",
        displayName: "HR 操作员",
        role: "HR",
        expiresAt: exp,
      },
    });
    const adminSessBefore = await prisma.session.count({ where: { userId: adminRow.id } });
    const hrSessBefore = await prisma.session.count({ where: { userId: hrRow.id } });

    // reset admin
    const r10 = await runSeed(["--reset-password", "--only=admin"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_ADMIN_PASSWORD: PWD_A1,
    });
    const adminSessAfter = await prisma.session.count({ where: { userId: adminRow.id } });
    const hrSessAfterAdminReset = await prisma.session.count({ where: { userId: hrRow.id } });
    check(
      "S7-U10a",
      "--only=admin reset 后：admin Session 全部清零（2→0），hr Session 不受影响",
      r10.status === 0 &&
        adminSessBefore === 2 &&
        hrSessBefore === 1 &&
        adminSessAfter === 0 &&
        hrSessAfterAdminReset === hrSessBefore,
      JSON.stringify({
        exit: r10.status,
        adminSessBefore,
        adminSessAfter,
        hrSessBefore,
        hrSessAfterAdminReset,
      })
    );

    // reset hr
    const r10h = await runSeed(["--reset-password", "--only=hr"], {
      DATABASE_URL: TEST_DB_URL,
      SEED_HR_PASSWORD: PWD_H1,
    });
    const hrSessAfter = await prisma.session.count({ where: { userId: hrRow.id } });
    check(
      "S7-U10b",
      "--only=hr reset 后：hr Session 全部清零（1→0）",
      r10h.status === 0 && hrSessAfter === 0,
      JSON.stringify({ exit: r10h.status, hrSessBefore, hrSessAfter })
    );
  }

  // ---------- S7-U11：新密码可用于认证，旧密码失效 ----------
  {
    const { verifyPassword } = await import("../lib/password.ts");

    // admin：刚被 reset 成 PWD_A1
    const adminHash = await hashOf(prisma, "admin");
    const adminNewOk = await verifyPassword(PWD_A1, adminHash);
    const adminOldFail = (await verifyPassword(PWD_A2, adminHash)) === false;

    // hr：刚被 reset 成 PWD_H1
    const hrHash = await hashOf(prisma, "hr");
    const hrNewOk = await verifyPassword(PWD_H1, hrHash);
    const hrOldFail = (await verifyPassword(PWD_H2, hrHash)) === false;

    check(
      "S7-U11",
      "reset 后 verifyPassword：新密码校验通过、旧密码校验失败（admin 与 hr 均验证；不输出密码/hash）",
      adminNewOk && adminOldFail && hrNewOk && hrOldFail,
      JSON.stringify({ adminNewOk, adminOldRejected: adminOldFail, hrNewOk, hrOldRejected: hrOldFail })
    );
  }

  // ---------- 清理 ----------
  await prisma.session.deleteMany({});
  await prisma.$disconnect();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

  console.log("═".repeat(72));
  console.log(`通过 ${pass} · 失败 ${fail}${fail ? "：" + failures.join("；") : ""}`);
  console.log("═".repeat(72));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  process.exit(1);
});
