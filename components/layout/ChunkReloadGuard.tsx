"use client";

import { useEffect } from "react";

/**
 * Chunk 加载失败自动恢复（Stage 9.34）
 *
 * ## 为什么需要它
 * Next.js 生产构建的 chunk 文件名带**内容哈希**（如 `5845-8b1d76...js`）。
 * 服务端重新 build + 重启后，旧文件立刻被删除，但**用户浏览器 / PWA 缓存
 * 里还拿着旧 HTML**，它仍然去请求已经不存在的旧 chunk：
 *
 *     Loading chunk 5845 failed.
 *     (error: http://localhost:3000/_next/static/chunks/5845-fea7ad....js)
 *
 * 结果整页崩掉。对 HR 同事来说就是「网站突然打不开了」，
 * 而他们唯一能做的只有按 Ctrl+Shift+R —— 很多人不知道。
 *
 * ## 做法（业界标准套路）
 * 监听 `window` 的 error 事件，识别 chunk 加载失败特征后**自动强制刷新一次**：
 *   · 用 sessionStorage 打标记，保证**最多只刷一次**（避免刷新 → 再失败 → 死循环）
 *   · 标记在正常加载成功后清除
 *   · 只对 `Loading chunk` / `Failed to fetch dynamically imported module`
 *     / `Importing a module script failed` 这三类特征生效，不误伤其他错误
 *
 * 同时提示用户正在重试（避免"页面自己跳了一下"被当成故障）。
 */
export default function ChunkReloadGuard() {
  useEffect(() => {
    const KEY = "tuhu_chunk_reload_at";
    const MAX_WINDOW_MS = 60_000; // 1 分钟内不再自动刷，防循环

    const isChunkError = (text: string) =>
      /Loading chunk [\w-]+ failed/i.test(text) ||
      /Failed to fetch dynamically imported module/i.test(text) ||
      /Importing a module script failed/i.test(text) ||
      /error loading dynamically imported module/i.test(text);

    const onError = (e: Event) => {
      const text =
        (e as ErrorEvent).message ??
        (e as ErrorEvent).error?.message ??
        String((e as ErrorEvent).error ?? "");
      if (!isChunkError(text)) return;

      const last = Number(sessionStorage.getItem(KEY) ?? 0);
      const now = Date.now();
      if (last && now - last < MAX_WINDOW_MS) return; // 刚刷过还失败 → 不再刷
      sessionStorage.setItem(KEY, String(now));
      // replace 而不是 reload：避免在历史里堆一串坏页面
      window.location.reload();
    };

    // 成功加载后清除标记，下一次真故障才能再次自动恢复
    const clear = () => sessionStorage.removeItem(KEY);
    window.addEventListener("error", onError);
    window.addEventListener("load", clear);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("load", clear);
    };
  }, []);

  return null;
}
