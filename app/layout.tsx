import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";

export const metadata: Metadata = {
  title: "途虎加盟店 HR 人事管理系统",
  description: "员工档案 · 门店 · 职位 —— 以数据库为唯一数据源的 HR 管理系统",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex h-screen overflow-hidden">
          {/* 左侧导航栏 */}
          <Sidebar />
          {/* 右侧：顶部系统栏 + 内容区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar />
            <main className="min-w-0 flex-1 overflow-auto p-5">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
