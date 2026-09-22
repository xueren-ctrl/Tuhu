import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import { requirePageUser } from "@/lib/auth";

/**
 * (app) 路由组布局：所有业务页面都套用「侧边栏 + 顶部系统栏 + 内容区」外壳。
 * 登录页 / 无权限页在 (app) 之外，使用根布局（仅 html/body），不套此外壳。
 *
 * Stage 6.1：middleware 只是第一层「Cookie 是否存在」的粗筛（Edge 不能查库），
 * 这里才是页面层的真校验 —— 每次进入业务页面都重新验证服务端 Session
 * （Session 过期 / 用户被停用 / 角色变更 都会在这里被拦截并重定向）。
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageUser();
  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧导航栏 */}
      <Sidebar />
      {/* 右侧：顶部系统栏 + 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-w-0 flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}
