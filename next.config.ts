import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 打包产物不暴露 SQLite 数据文件；所有数据访问必须经过服务端 API / ORM
  serverExternalPackages: ["@prisma/client", "exceljs"],
  eslint: {
    // 生产构建不因 lint 阻塞（lint 单独执行）
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
