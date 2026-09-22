/**
 * 鉴权核心（第六阶段新增）
 *
 * 设计要点：
 * 1. 密码使用 Node 内置 crypto.scrypt 做加盐哈希，绝不存明文。
 * 2. 登录成功后服务端创建 Session（落 Session 表），HttpOnly Cookie 里
 *    **只存 sessionId**。真实身份一律来自 Session，绝不信任前端 localStorage
 *    或客户端伪造的 x-operator 头。
 * 3. 不引入任何第三方依赖（bcrypt/session 库都不需要）。
 * 4. 提供两类守卫：
 *    - requireApiUser(req, opts?)  —— API 路由用，未登录返回 401 / 无权限返回 403；
 *    - requirePageUser(opts?)      —— 页面（Server Component）用，未登录重定向 /login，
 *                                    无权限重定向 /unauthorized。
 *
 * 注意：middleware.ts（Edge 运行时）**不能** import 本文件（会连带拉入 prisma /
 * node:crypto），它只做「Cookie 是否存在」的粗筛；真正的身份与角色校验都在
 * API 路由 / 页面 Server Component 里通过本文件完成。
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { hashPassword, verifyPassword } from "./password";

/** Cookie 名称（仅存 sessionId） */
export const SESSION_COOKIE = "hr_session";

/** 会话有效期：8 小时 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** 角色常量（取值与 AppUser.role / lib/constants.ts 一致） */
export const ROLE = {
  ADMIN: "ADMIN",
  HR: "HR",
} as const;

export interface SessionUser {
  userId: number;
  username: string;
  displayName: string | null;
  role: string; // ADMIN | HR
}

export { hashPassword, verifyPassword };

// ------------------------------------------------------------
// 会话 ID 解析（从 Cookie 头，兼容标准 Request / NextRequest）
// ------------------------------------------------------------

/**
 * 从请求的 Cookie 头里读取 sessionId。
 * 用标准 Request 即可（无需 NextRequest），避免在 20+ 个路由里改签名。
 */
function getSessionIdFromRequest(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE) return value;
  }
  return undefined;
}

// ------------------------------------------------------------
// 服务端会话
// ------------------------------------------------------------

export async function createSession(opts: {
  userId: number;
  username: string;
  displayName: string | null;
  role: string;
}): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      id,
      userId: opts.userId,
      username: opts.username,
      displayName: opts.displayName,
      role: opts.role,
      expiresAt,
    },
  });
  return id;
}

/** 读会话；过期或不存在返回 null（顺便清理过期会话）。
 *
 * Stage 6.1 实时生效要求：Session 里缓存的 role/status 不可信，
 * 每次验证都重新读取 AppUser：
 *   - AppUser.status !== "ACTIVE"（停用）→ 会话立即失效（null）；
 *   - 角色 / 显示名变更 → 直接采用数据库最新值（旧 Session 下次请求即生效）。
 */
export async function getSession(sessionId: string | undefined | null): Promise<SessionUser | null> {
  if (!sessionId) return null;
  let s;
  try {
    s = await prisma.session.findUnique({ where: { id: sessionId } });
  } catch {
    return null;
  }
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  // 关键：以 AppUser 当前状态为准，而不是 Session 缓存的快照
  const user = await prisma.appUser.findUnique({ where: { id: s.userId } }).catch(() => null);
  if (!user || user.status !== "ACTIVE") {
    // 用户被删除或停用：立即销毁该会话
    await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export async function destroySession(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId) return;
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

export async function touchSession(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId) return;
  await prisma.session
    .update({ where: { id: sessionId }, data: { lastActiveAt: new Date() } })
    .catch(() => {});
}

// ------------------------------------------------------------
// Cookie 选项
// ------------------------------------------------------------

export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: string;
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 生产环境（HTTPS）才开 Secure；本地开发（http://localhost）保持 false 以免登录失败
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

// ------------------------------------------------------------
// API 守卫
// ------------------------------------------------------------

/** 从请求里取已认证用户；无则返回 null（不做角色判断） */
export async function getApiUser(req: Request): Promise<SessionUser | null> {
  const sid = getSessionIdFromRequest(req);
  return getSession(sid);
}

/**
 * API 路由守卫。
 * @returns 成功返回 SessionUser；失败返回 NextResponse 风格的 Response（401 / 403）。
 * 调用方： `const u = await requireApiUser(req, { roles: ["ADMIN"] }); if (u instanceof Response) return u;`
 */
export async function requireApiUser(
  req: Request,
  opts?: { roles?: string[] }
): Promise<SessionUser | Response> {
  const sid = getSessionIdFromRequest(req);
  const user = await getSession(sid);
  if (!user) {
    return new Response(JSON.stringify({ error: "未登录或会话已过期" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (opts?.roles && !opts.roles.includes(user.role)) {
    return new Response(JSON.stringify({ error: "权限不足：需要 " + (opts.roles.join(" / ")) + " 角色" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  void touchSession(sid);
  return user;
}

// ------------------------------------------------------------
// 页面守卫（Server Component）
// ------------------------------------------------------------

/** 页面里取已认证用户；无则返回 null */
export async function getPageUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  return getSession(sid);
}

/**
 * 页面守卫。未登录 → 重定向 /login；角色不足 → 重定向 /unauthorized。
 * 必须在 Server Component 顶层 await 调用。
 */
export async function requirePageUser(opts?: { roles?: string[] }): Promise<SessionUser> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  const user = await getSession(sid);
  if (!user) redirect("/login");
  if (opts?.roles && !opts.roles.includes(user.role)) redirect("/unauthorized");
  return user;
}
