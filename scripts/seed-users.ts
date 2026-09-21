/**
 * 初始化系统登录账号（第六阶段新增）
 *
 * 幂等：按 username upsert，重复执行只更新密码 / 角色 / 显示名，不会新建重复账号。
 * 密码使用 scrypt 加盐哈希，绝不写入明文。
 *
 * 默认账号（建议首次部署后立即改密；也可用环境变量覆盖）：
 *   ADMIN：admin / ${SEED_ADMIN_PASSWORD:-Tuhu@Admin2026}
 *   HR   ：hr    / ${SEED_HR_PASSWORD:-Tuhu@Hr2026}
 *
 * 运行：npm run db:seed:users
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
  const adminPwd = process.env.SEED_ADMIN_PASSWORD || "Tuhu@Admin2026";
  const hrPwd = process.env.SEED_HR_PASSWORD || "Tuhu@Hr2026";
  return [
    { username: "admin", displayName: "系统管理员", role: "ADMIN", password: adminPwd },
    { username: "hr", displayName: "HR 操作员", role: "HR", password: hrPwd },
  ];
}

async function main() {
  const users = resolveUsers();
  for (const u of users) {
    const data = {
      displayName: u.displayName,
      role: u.role,
      passwordHash: hashPassword(u.password),
      status: "ACTIVE",
    };
    const existing = await prisma.appUser.findUnique({ where: { username: u.username } });
    if (existing) {
      await prisma.appUser.update({ where: { username: u.username }, data });
      console.log(`↻ 已更新账号 ${u.username}（角色 ${u.role}）`);
    } else {
      await prisma.appUser.create({ data: { username: u.username, ...data } });
      console.log(`✓ 已创建账号 ${u.username}（角色 ${u.role}）`);
    }
    // 打印账号信息（明文密码仅在此处一次性输出，便于首次登录；不写库、不写日志文件）
    console.log(`    用户名：${u.username}    密码：${u.password}`);
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
