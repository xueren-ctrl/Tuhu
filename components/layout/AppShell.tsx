"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

/**
 * 应用外壳（客户端）：侧边栏 + 顶部栏 + 内容区
 *
 * 桌面（≥768px）：左侧导航常驻。
 * 手机 / 平板：左侧导航收进抽屉，由顶部栏的「☰」按钮打开，点任意菜单项自动关闭。
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // 路由变化后自动收起抽屉（手机上很关键）
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 抽屉打开时锁定背景滚动
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 桌面侧边栏 */}
      <div className="hidden w-60 shrink-0 md:block">
        <Sidebar />
      </div>

      {/* 手机端抽屉 */}
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 w-[262px] max-w-[82vw] bg-white shadow-2xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setOpen(true)} />
        <main className="min-w-0 flex-1 overflow-auto p-3 md:p-5">{children}</main>
      </div>
    </div>
  );
}
