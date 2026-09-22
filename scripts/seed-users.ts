/**
 * 初始化系统登录账号（Stage 6.1 整改：禁止固定生产默认密码）
 *
 * 规则：
 *   1. 密码**必须**由环境变量提供，绝不内置固定生产默认密码：
 *        - SEED_ADMIN_PASSWORD  —— admin 账号密码
 *        - SEED_HR_PASSWORD     —— hr 账号密码
 *      任一未设置 → 直接报错退出（退出码 1），提示如何设置。
 *   2. 账号已存在时：**默认不修改密码**，只补齐 displayName/role/status；
 *      只有显式传 `--reset-password` 才允许重置密码。
 *   3. 幂等：重复执行不会产生重复账号。
 *
 * 用法：
 *   # 首次部署（生产/正式环境）：
 *   SEED_ADMIN_PASSWORD="你的强密码" SEED_HR_PASSWORD="你的强密码" npm run db:seed:users
 *
 *   # 已存在账号想重置密码（显式操作）：
 *   SEED_ADMIN_PASSWORD="新密码" SEED_HR_PASSWORD="新密码" npm run db:seed:users -- --reset-password
 *
 *   # 测试环境（测试脚本 spawn 时自行注入测试密码 + --reset-password 或首装场景）
 *
 * 密码使用 scrypt 加盐哈希，绝不写入明文；明文仅在执行输出中一次性打印。
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/password";

const prisma = new PrismaClient();

interface SeedUser {
  username: string;
  displayName: string;
  role: "ADMIN" | "HR";
  password: string;
}

function resolveUsers(): SeedUser[] {
  const adminPwd = process.env.SEED_ADMIN_PASSWORD;
  const hrPwd = process.env.SEED_HR_PASSWORD;
  if (!adminPwd || !hrPwd) {
    console.error(
      [
        "❌ 拒绝执行：未提供登录密码环境变量。",
        "",
        "   Stage 6.1 起禁止内置固定生产默认密码。请设置后再运行：",
        '     SEED_ADMIN_PASSWORD="强密码1" SEED_HR_PASSWORD="强密码2" npm run db:seed:users',
        "",
        "   若账号已存在且需要重置密码，请追加 --reset-password：",
        '     SEED_ADMIN_PASSWORD="新密码1" SEED_HR_PASSWORD="新密码2" npm run db:seed:users -- --reset-password',
      ].join("\n")
    );
    process.exit(1);
  }
  // 最低 8 位，避免过短密码被误设
  for (const [name, pwd] of [
    ["SEED_ADMIN_PASSWORD", adminPwd],
    ["SEED_HR_PASSWORD", hrPwd],
  ] as const) {
    if (pwd.length < 8) {
      console.error(`❌ ${name} 太短（<8 位），请设置更强的密码。`);
      process.exit(1);
    }
  }
  return [
    { username: "admin", displayName: "系统管理员", role: "ADMIN", password: adminPwd },
    { username: "hr", displayName: "HR 操作员", role: "HR", password: hrPwd },
  ];
}

async function main() {
  const resetPassword = process.argv.includes("--reset-password");
  const users = resolveUsers();
  for (const u of users) {
    const existing = await prisma.appUser.findUnique({ where: { username: u.username } });
    if (existing) {
      if (resetPassword) {
        await prisma.appUser.update({
          where: { username: u.username },
          data: {
            displayName: u.displayName,
            role: u.role,
            status: "ACTIVE",
            passwordHash: hashPassword(u.password),
          },
        });
        console.log(`↻ 已重置账号 ${u.username} 的密码（--reset-password），角色 ${u.role}`);
        console.log(`    用户名：${u.username}    密码：${u.password}`);
      } else {
        // 默认：不碰密码，只补齐元数据
        await prisma.appUser.update({
          where: { username: u.username },
          data: { displayName: u.displayName, role: u.role, status: "ACTIVE" },
        });
        console.log(
          `· 账号 ${u.username} 已存在：保留原密码不变（如需重置请传 --reset-password），元数据已同步（角色 ${u.role}）`
        );
      }
    } else {
      await prisma.appUser.create({
        data: {
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          status: "ACTIVE",
          passwordHash: hashPassword(u.password),
        },
      });
      console.log(`✓ 已创建账号 ${u.username}（角色 ${u.role}）`);
      console.log(`    用户名：${u.username}    密码：${u.password}`);
    }
  }
  const total = await prisma.appUser.count();
  console.log(`✓ 账号初始化完成，当前账号总数 ${total}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
