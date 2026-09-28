import AppShell from "@/components/layout/AppShell";
import ChunkReloadGuard from "@/components/layout/ChunkReloadGuard";
import { requirePageUser } from "@/lib/auth";

/**
 * (app) 路由组布局：所有业务页面都套用「侧边栏 + 顶部系统栏 + 内容区」外壳。
 * 登录页 / 无权限页在 (app) 之外，使用根布局（仅 html/body），不套此外壳。
 *
 * Stage 6.1：middleware 只是第一层「Cookie 是否存在」的粗筛（Edge 不能查库），
 * 这里才是页面层的真校验 —— 每次进入业务页面都重新验证服务端 Session
 * （Session 过期 / 用户被停用 / 角色变更 都会在这里被拦截并重定向）。
 *
 * 手机适配：外壳（AppShell）是客户端组件，负责把侧边栏收进抽屉。
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageUser();
  return (
    <AppShell>
      {/* Stage 9.34：chunk 加载失败（build 后旧缓存）时自动强制刷新一次，避免整页崩 */}
      <ChunkReloadGuard />
      {children}
    </AppShell>
  );
}
