import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegistrar from "@/components/layout/ServiceWorkerRegistrar";

export const metadata: Metadata = {
  title: "途虎加盟店 HR 人事管理系统",
  description: "员工档案 · 门店 · 职位 —— 以数据库为唯一数据源的 HR 管理系统",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "人事管理",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
      { url: "/icons/apple-touch-icon-167.png", sizes: "167x167" },
      { url: "/icons/apple-touch-icon-152.png", sizes: "152x152" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 装成 App 后按手机状态栏高度留出空间，避免标题被刘海遮住
  viewportFit: "cover",
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
