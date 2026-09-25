/**
 * 初始化系统登录账号（Stage 6.1 整改：禁止固定生产默认密码）
 *
 * 规则：
 *   1. 密码**必须**由环境变量提供，绝不内置固定生产默认密码：
 *        - SEED_ADMIN_PASSWORD  —— admin 账号密码
 *        - SEED_HR_PASSWORD     —— hr 账号密码
 *   2. 账号已存在时：**默认不修改密码**，只补齐 displayName/role/status；
 *      只有显式传 `--reset-password` 才允许重置密码。
 *   3. 幂等：重复执行不会产生重复账号。
 *
 * Stage 7.2C（单用户密码重置）：
 *   - 新增 `--only=admin` / `--only=hr`，**密码重置必须精确指定单个账号**。
 *   - `--reset-password` **缺少 `--only` 时直接拒绝执行（exit 1）**，
 *     避免一次误操作同时改掉 admin + hr 两个生产账号的密码。
 *   - 环境变量按 `--only` 精确要求：`--only=admin` 只要 SEED_ADMIN_PASSWORD，
 *     `--only=hr` 只要 SEED_HR_PASSWORD；普通首次初始化仍需两者都提供。
 *   - **绝不向 stdout 打印密码明文**（Stage 7.2C：避免密码进入终端日志/审计）。
 *   - 参数冲突（同时给两个 --only / 未知用户名）一律拒绝。
 *
 * Stage 7.2C.1（重置语义 + 会话失效收口）：
 *   - `--reset-password --only=<user>` **只修改 passwordHash**，
 *     绝不修改 displayName / role / status。
 *     「重置密码」≠「重新激活账号」：停用账号（INACTIVE）重置后仍为 INACTIVE。
 *   - 密码重置成功后**立即删除该账号的全部 Session**
 *     （`prisma.session.deleteMany({ where: { userId } })`），
 *     旧凭据签发的会话立刻失效；只影响被重置的账号，不波及其他账号。
 *
 * 用法：
 *   # 首次部署（生产/正式环境）：两个账号一起初始化
 *   SEED_ADMIN_PASSWORD="<强密码1>" SEED_HR_PASSWORD="<强密码2>" npm run db:seed:users
 *
 *   # 只重置 admin 的密码（生产密码重置的唯一推荐形式）
 *   SEED_ADMIN_PASSWORD="<新密码>" npm run db:seed:users -- --reset-password --only=admin
 *
 *   # 只重置 hr 的密码
 *   SEED_HR_PASSWORD="<新密码>" npm run db:seed:users -- --reset-password --only=hr
 *
 * 密码使用 scrypt 加盐哈希，绝不写入明文。
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/password";

const prisma = new PrismaClient();

type Username = "admin" | "hr";

interface SeedUser {
  username: Username;
  displayName: string;
  role: "ADMIN" | "HR";
  password: string;
}

const KNOWN_USERNAMES: Username[] = ["admin", "hr"];

function fail(lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(1);
}

/**
 * 解析 `--only=<username>`。
 * 规则：
 *   - 不传          → null（仅普通初始化允许）
 *   - 传 0 个或多个 → 多个视为冲突，拒绝
 *   - 值不在白名单 → 拒绝（大小写不敏感）
 */
function parseOnly(argv: string[]): Username | null {
  const flags = argv.filter((a) => a.startsWith("--only="));
  if (flags.length === 0) return null;
  if (flags.length > 1) {
    fail([
      "❌ 拒绝执行：--only 参数冲突。",
      "",
      "   --only 只能出现一次。当前收到：",
      ...flags.map((f) => `     ${f}`),
      "",
      "   请只指定一个账号，例如：",
      '     --reset-password --only=admin',
      '     --reset-password --only=hr',
    ]);
  }
  const raw = flags[0].slice("--only=".length).trim().toLowerCase();
  if (!(KNOWN_USERNAMES as string[]).includes(raw)) {
    fail([
      `❌ 拒绝执行：未知的 --only 取值 "${flags[0].slice("--only=".length)}"。`,
      "",
      `   合法取值：${KNOWN_USERNAMES.map((u) => `--only=${u}`).join("  /  ")}`,
    ]);
  }
  return raw as Username;
}

function resolveUsers(only: Username | null): SeedUser[] {
  const adminPwd = process.env.SEED_ADMIN_PASSWORD;
  const hrPwd = process.env.SEED_HR_PASSWORD;

  // 环境变量按 only 精确要求
  const needAdmin = only === null || only === "admin";
  const needHr = only === null || only === "hr";

  const missing: string[] = [];
  if (needAdmin && !adminPwd) missing.push("SEED_ADMIN_PASSWORD");
  if (needHr && !hrPwd) missing.push("SEED_HR_PASSWORD");
  if (missing.length > 0) {
    fail([
      "❌ 拒绝执行：未提供登录密码环境变量。",
      "",
      `   Stage 6.1 起禁止内置固定生产默认密码。${only ? `（本次 --only=${only}）` : ""}`,
      `   缺少：${missing.join("  ")}`,
      "",
      "   首次部署（两个账号一起初始化）：",
      '     SEED_ADMIN_PASSWORD="<强密码1>" SEED_HR_PASSWORD="<强密码2>" npm run db:seed:users',
      "",
      "   只重置单个账号的密码（生产推荐）：",
      '     SEED_ADMIN_PASSWORD="<新密码>" npm run db:seed:users -- --reset-password --only=admin',
      '     SEED_HR_PASSWORD="<新密码>" npm run db:seed:users -- --reset-password --only=hr',
    ]);
  }

  // 最低 8 位，避免过短密码被误设
  for (const [name, pwd] of [
    ["SEED_ADMIN_PASSWORD", adminPwd],
    ["SEED_HR_PASSWORD", hrPwd],
  ] as const) {
    if (pwd && pwd.length < 8) {
      fail([`❌ ${name} 太短（<8 位），请设置更强的密码。`]);
    }
  }

  const all: SeedUser[] = [
    {
      username: "admin",
      displayName: "系统管理员",
      role: "ADMIN",
      password: adminPwd ?? "",
    },
    {
      username: "hr",
      displayName: "HR 操作员",
      role: "HR",
      password: hrPwd ?? "",
    },
  ];
  return only ? all.filter((u) => u.username === only) : all;
}

async function main() {
  const resetPassword = process.argv.includes("--reset-password");
  const only = parseOnly(process.argv);

  // Stage 7.2C 生产安全闸门：密码重置必须精确指定单个账号
  if (resetPassword && only === null) {
    fail([
      "❌ 拒绝执行：生产密码重置必须明确指定 --only=admin 或 --only=hr。",
      "",
      "   原因：不指定 --only 会同时修改 admin 与 hr 两个账号的密码，",
      "        生产环境下一次误操作可能同时锁死两个账号。",
      "",
      "   正确用法：",
      '     SEED_ADMIN_PASSWORD="<新密码>" npm run db:seed:users -- --reset-password --only=admin',
      '     SEED_HR_PASSWORD="<新密码>"   npm run db:seed:users -- --reset-password --only=hr',
      "",
      "   如需初始化/补齐两个账号的元数据（不重置密码），不要传 --reset-password：",
      '     SEED_ADMIN_PASSWORD="<强密码1>" SEED_HR_PASSWORD="<强密码2>" npm run db:seed:users',
    ]);
  }

  const users = resolveUsers(only);
  const scope = only ? `--only=${only}` : "（全部账号）";

  for (const u of users) {
    const existing = await prisma.appUser.findUnique({ where: { username: u.username } });
    if (existing) {
      if (resetPassword) {
        // Stage 7.2C.1：**只改 passwordHash**。
        // 最小权限语义 —— 重置密码绝不能顺带改角色、账号状态或显示名：
        //   · 停用账号（status=INACTIVE）重置密码后必须**仍是 INACTIVE**，
        //     绝不能被「顺手激活」；
        //   · role / displayName 属于账号治理字段，只能通过专用的账号管理入口修改。
        await prisma.appUser.update({
          where: { username: u.username },
          data: { passwordHash: hashPassword(u.password) },
        });

        // Stage 7.2C.1：密码变了 → 该账号已签发的所有 Session 必须立即失效，
        // 否则旧 Session 会继续以旧凭据代表的身份存活。
        // 只删被重置账号自己的 Session，绝不波及其他账号。
        const revoked = await prisma.session.deleteMany({
          where: { userId: existing.id },
        });

        // Stage 7.2C：绝不输出密码明文
        console.log(
          `↻ 账号 ${u.username} 密码已重置（--reset-password ${scope}），角色 ${u.role}；` +
            `已撤销该账号 Session ${revoked.count} 条（角色/状态/显示名保持不变）`
        );
      } else {
        // 默认：不碰密码，只补齐元数据
        await prisma.appUser.update({
          where: { username: u.username },
          data: { displayName: u.displayName, role: u.role, status: "ACTIVE" },
        });
        console.log(
          `· 账号 ${u.username} 已存在：保留原密码不变（如需重置请传 --reset-password ${scope}），元数据已同步（角色 ${u.role}）`
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
      // Stage 7.2C：绝不输出密码明文
      console.log(`✓ 账号 ${u.username} 已创建（角色 ${u.role}）`);
    }
  }
  const total = await prisma.appUser.count();
  console.log(`✓ 账号初始化完成，处理范围 ${scope}，当前账号总数 ${total}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
