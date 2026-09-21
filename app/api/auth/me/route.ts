import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me —— 返回当前登录用户信息；未登录返回 401。
 * 前端据此决定顶部栏显示、登出按钮、以及角色相关的功能开关。
 */
export async function GET(req: Request) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录或会话已过期" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, user });
}
