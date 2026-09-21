import { redirect } from "next/navigation";
import { getPageUser } from "@/lib/auth";
import LoginForm from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

/**
 * 登录页（位于 (app) 路由组之外，使用根布局，不套侧边栏外壳）。
 * 已登录用户访问本页直接跳走，避免重复登录。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const user = await getPageUser();
  const sp = await searchParams;
  const redirectTo = sp.redirect && sp.redirect.startsWith("/") ? sp.redirect : "/";
  if (user) redirect(redirectTo);
  return <LoginForm redirectTo={redirectTo} />;
}
