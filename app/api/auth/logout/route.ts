import { NextResponse } from "next/server";
import { SESSION_COOKIE, destroySession, sessionCookieOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 * 删除服务端 Session 并清空 HttpOnly Cookie。
 */
export async function POST(req: Request) {
  // 从 Cookie 头解析 sessionId（兼容标准 Request，不依赖 NextRequest.cookies）
  const header = req.headers.get("cookie") ?? "";
  let sid: string | undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      sid = part.slice(idx + 1).trim();
      break;
    }
  }
  await destroySession(sid);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
