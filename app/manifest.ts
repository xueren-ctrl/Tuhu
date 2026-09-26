import type { MetadataRoute } from "next";

/**
 * PWA manifest —— 让手机能把本系统「添加到主屏幕」，像 App 一样点开。
 *
 * 为什么用 PWA 而不是打包成 APK/IPA：
 *   - 不用应用商店、不用证书、不用审核，随时更新（改完刷新就生效）
 *   - iPhone / Android 都能装，iOS 用 Safari「添加到主屏幕」即可
 *   - 装完是独立窗口，没有浏览器地址栏，和原生 App 观感一致
 *
 * display: standalone —— 独立窗口（无地址栏）
 * start_url: /        —— 点图标从这里进
 * scope: /            —— 整个系统都在离线缓存范围内
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "途虎加盟店 · 人事管理",
    short_name: "人事管理",
    description: "途虎加盟店人事管理系统：员工档案、状态变更、增删改查。",
    lang: "zh-CN",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      // SVG 供支持矢量图标的浏览器使用
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      {
        name: "员工表·数据库",
        short_name: "数据库",
        url: "/sheets/" + encodeURIComponent("数据库"),
        description: "全部在册员工",
      },
      {
        name: "员工表·在职",
        short_name: "在职",
        url: "/sheets/" + encodeURIComponent("在职"),
        description: "当前在职员工",
      },
      {
        name: "新增员工",
        short_name: "新增",
        url: "/employees/new",
        description: "登记新员工",
      },
      {
        name: "更改员工状态",
        short_name: "改状态",
        url: "/employees/status",
        description: "批量或单个变更员工状态",
      },
    ],
  };
}
