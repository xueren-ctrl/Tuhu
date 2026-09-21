import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/login
 * body: { username, password }
 *
 * 密码使用 scrypt 加盐哈希校验，绝不比对明文。
 * 校验通过后才由服务端创建 Session，并把 sessionId 写入 HttpOnly Cookie。
 * 无论用户名不存在还是密码错误，统一返回「用户名或密码错误」，避免用户枚举。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { username?: string; password?: string };
    const username = (body.username ?? "").toString().trim();
    const password = (body.password ?? "").toString();
    if (!username || !password) {
      return NextResponse.json({ ok: false, error: "请输入用户名和密码" }, { status: 400 });
    }

    const user = await prisma.appUser.findUnique({ where: { username } });
    if (!user || user.status !== "ACTIVE") {
      return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
    }

    const sid = await createSession({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
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
