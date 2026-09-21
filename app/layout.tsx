import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
