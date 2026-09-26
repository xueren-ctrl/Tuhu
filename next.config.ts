import type { NextConfig } from "next";

/**
 * 每次构建产出的 chunk 文件名里带内容哈希。新版本上线后，旧页面引用的
 * 旧 chunk 会 404 —— 浏览器里表现为「页面一直转圈 / 白屏 / 卡在加载」。
 * （本项目 2026-09-26 就因一天内重建多次构建而遇到过一次。）
 *
 * 这里给页面文档加「永不缓存」，保证浏览器刷新时一定拿到最新的 chunk 清单，
 * 不会拿旧 HTML 去引用已经不存在的 JS。
 */
const noStoreHtml = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
];

const nextConfig: NextConfig = {
  // 打包产物不暴露 SQLite 数据文件；所有数据访问必须经过服务端 API / ORM
  serverExternalPackages: ["@prisma/client", "exceljs"],
  eslint: {
    // 生产构建不因 lint 阻塞（lint 单独执行）
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: noStoreHtml,
      },
      {
        // 静态资源带内容哈希，可长期缓存
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
