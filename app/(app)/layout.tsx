import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";

/**
 * (app) 路由组布局：所有业务页面都套用「侧边栏 + 顶部系统栏 + 内容区」外壳。
 * 登录页 / 无权限页在 (app) 之外，使用根布局（仅 html/body），不套此外壳。
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
