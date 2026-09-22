import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { clearLoginFailures, recordLoginFailure } from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/login
 * body: { username, password }
 *
 * 密码使用 scrypt 加盐哈希校验，绝不比对明文。
 * 校验通过后才由服务端创建 Session，并把 sessionId 写入 HttpOnly Cookie。
 * 无论用户名不存在还是密码错误，统一返回「用户名或密码错误」，避免用户枚举。
 *
 * Stage 6.1：
 * - 登录失败限流：同一来源 5 分钟内连续失败 10 次 → 429（成功清零，见 lib/login-rate-limit）；
 * - 登录审计：LOGIN_SUCCESS / LOGIN_FAILED 写入 AuditLog（失败审计**不记录密码**，
 *   只记用户名与来源）。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { username?: string; password?: string };
    const username = (body.username ?? "").toString().trim();
    const password = (body.password ?? "").toString();
    if (!username || !password) {
      return NextResponse.json({ ok: false, error: "请输入用户名和密码" }, { status: 400 });
    }

    // 登录失败限流（先于密码校验，避免被枚举/爆破放大开销）
    const fail = recordLoginFailure(req);
    if (fail.blocked) {
      await prisma.auditLog.create({
        data: {
          actor: username || "unknown",
          action: "LOGIN_FAILED",
          entity: "AppUser",
          entityId: username,
          summary: `登录失败（限流拦截：5 分钟内失败 ≥10 次）`,
        },
      }).catch(() => {});
      const res = NextResponse.json(
        { ok: false, error: "登录失败次数过多，请 5 分钟后再试" },
        { status: 429 }
      );
      res.headers.set("Retry-After", String(Math.ceil(fail.retryAfterMs / 1000)));
      return res;
    }

    const user = await prisma.appUser.findUnique({ where: { username } });
    if (!user || user.status !== "ACTIVE") {
      await prisma.auditLog.create({
        data: {
          actor: username,
          action: "LOGIN_FAILED",
          entity: "AppUser",
          entityId: username,
          summary: user ? "登录失败（账号已停用）" : "登录失败（账号不存在）",
        },
      }).catch(() => {});
      return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      // 失败审计：只记用户名，**绝不记录密码**
      await prisma.auditLog.create({
        data: {
          actor: username,
          action: "LOGIN_FAILED",
          entity: "AppUser",
          entityId: String(user.id),
          summary: "登录失败（密码错误）",
        },
      }).catch(() => {});
      return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
    }

    // 成功登录：清除该来源失败计数
    clearLoginFailures(req);

    const sid = await createSession({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
    await prisma.auditLog.create({
      data: {
        actor: user.username,
        action: "LOGIN_SUCCESS",
        entity: "AppUser",
        entityId: String(user.id),
        summary: `登录成功（角色 ${user.role}）`,
      },
    }).catch(() => {});
    await prisma.appUser
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {});

    const res = NextResponse.json({
      ok: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
    res.cookies.set(SESSION_COOKIE, sid, sessionCookieOptions());
    return res;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "登录失败：" + (e as Error).message },
      { status: 500 }
    );
  }
}
