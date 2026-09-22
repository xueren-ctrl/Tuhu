import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, destroySession, getApiUser, sessionCookieOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 * 删除服务端 Session 并清空 HttpOnly Cookie。
 *
 * Stage 6.1：写 LOGOUT 审计（actor = 当前真实会话用户；会话已失效时记 unknown）。
 */
export async function POST(req: Request) {
  const user = await getApiUser(req); // 实时读 Session + AppUser，取真实用户名
  const sid = sidFromHeader(req);
  await destroySession(sid);
  await prisma.auditLog.create({
    data: {
      actor: user?.username ?? "unknown",
      action: "LOGOUT",
      entity: "AppUser",
      entityId: user ? String(user.userId) : null,
      summary: "退出登录",
    },
  }).catch(() => {});
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}

/** 从 Cookie 头解析 sessionId（复用 auth 内部的同款逻辑，避免导出私有函数） */
function sidFromHeader(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}
