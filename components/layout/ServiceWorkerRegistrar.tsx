"use client";

import { useEffect } from "react";

/**
 * 注册 Service Worker（让本系统能装成手机 App）
 *
 * ⚠️ 只做注册，**不再弹右下角浮动按钮**（Stage 9.13）：
 *     那个 `fixed bottom-4 right-4` 的按钮会和「保存修改」等页脚操作按钮重叠，
 *     手机上点不到还挡视线。安装引导改为放在
 *     「基础设置 → 访问入口 → ③ 装到手机主屏幕」卡片里（图文步骤，位置固定、不挡操作）。
 *
 * 没有安装引导提示的例外：iOS Safari 不会触发 beforeinstallprompt，
 * 只能由用户手动「分享 → 添加到主屏幕」，所以也不做自动提示。
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // 生产环境才注册，避免开发时缓存干扰调试
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);

  return null;
}
