/**
 * 从备份库**只读搬回** admin 的 passwordHash（不整库回滚）
 *
 * 用途：排查故障时用 seed-users.ts --reset-password 临时改了 admin 密码，
 *      排查完必须把原密码恢复，否则用户登不进系统。
 *
 * 严格只改 AppUser.passwordHash 这一个字段，绝不碰其他表、绝不整库覆盖。
 *
 * 用法：node scripts/restore-admin-password.mjs
 */
import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";

const BACKUP = String.raw`D:/Tuhu-HR/backup/stage9.14-before-headcount-20260926-215926.db`;
const ACCOUNTS = ["admin"]; // 只恢复被本次排查改动的账号

if (!existsSync(BACKUP)) {
  console.error(`备份不存在：${BACKUP}`);
  process.exit(1);
}

const live = new PrismaClient();
const bak = new PrismaClient({ datasources: { db: { url: `file:${BACKUP}` } } });

// ① 先只读打印两份名单，核对清楚再动手
const liveList = await live.appUser.findMany({
  select: { id: true, username: true, role: true, status: true },
  orderBy: { id: "asc" },
});
console.log("当前库账号名单：");
for (const u of liveList) console.log(`  id=${u.id} ${u.username} ${u.role} ${u.status}`);

for (const username of ACCOUNTS) {
  const b = await bak.appUser.findUnique({ where: { username }, select: { passwordHash: true, role: true, status: true } });
  const l = await live.appUser.findUnique({ where: { username }, select: { id: true, passwordHash: true, role: true, status: true } });
  if (!b) { console.log(`  ✗ 备份里没有 ${username}，跳过`); continue; }
  if (!l) { console.log(`  ✗ 当前库里没有 ${username}，跳过`); continue; }
  if (b.passwordHash === l.passwordHash) { console.log(`  · ${username} 密码本就一致，无需恢复`); continue; }

  await live.appUser.update({
    where: { username },
    data: { passwordHash: b.passwordHash },
  });
  const after = await live.appUser.findUnique({ where: { username }, select: { passwordHash: true } });
  console.log(`  ✓ ${username} 密码已从备份恢复（hash 一致：${after?.passwordHash === b.passwordHash}）`);

  // 撤销该账号全部会话，强制重新登录
  const del = await live.session.deleteMany({ where: { userId: l.id } });
  console.log(`    已撤销该账号会话 ${del.count} 条（下次需重新登录）`);
}

const finalList = await live.appUser.findMany({ select: { username: true, role: true, status: true }, orderBy: { id: "asc" } });
console.log("恢复后账号名单：");
for (const u of finalList) console.log(`  ${u.username} ${u.role} ${u.status}`);

await live.$disconnect();
await bak.$disconnect();
