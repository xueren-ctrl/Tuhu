import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 路由守卫（Edge 运行时）
 *
 * 仅做「粗筛」：判断 HttpOnly Cookie 里是否携带 sessionId。
 * 真正的身份 / 角色校验在 API 路由（requireApiUser）与页面 Server Component
 * （requirePageUser）里完成 —— 那里能访问数据库，Edge 运行时不能。
 *
 * 行为：
 *  - /api/auth/*           放行（登录 / 登出 / 取自身信息）
 *  - 其它 /api/* 无会话    → 401 JSON（未登录）
 *  - 其它 /api/* 有会话    → 放行（具体权限由路由内 requireApiUser 判定）
 *  - /login /unauthorized 放行（已登录访问 /login 直接跳首页）
 *  - 其它页面无会话        → 重定向 /login?redirect=当前路径
 */

export const SESSION_COOKIE = "hr_session";

const PUBLIC_PAGES = new Set(["/login", "/unauthorized"]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api");
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  // 认证接口：放行（内部自行校验）
  if (isApi) {
    if (pathname.startsWith("/api/auth/")) return NextResponse.next();
    if (!hasSession) {
      return NextResponse.json(
        { ok: false, error: "未登录或会话已过期" },
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    return NextResponse.next();
  }

  // 公开页面
  if (PUBLIC_PAGES.has(pathname)) {
    if (hasSession && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  // 受保护页面：未登录一律跳登录页
  if (!hasSession) {
    const url = new URL("/login", req.url);
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // 排除静态资源与图片，其余全部过中间件
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
