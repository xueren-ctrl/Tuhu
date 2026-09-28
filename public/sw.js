/* eslint-disable no-restricted-globals */
/**
 * Service Worker —— 让本系统能「装到手机主屏幕当 App 用」。
 *
 * 策略（刻意保守，避免看到过期的人事数据）：
 *   ① 导航请求（打开页面）→ 一律走网络，失败才回退到缓存的首页。
 *      **绝不用缓存兜底业务页面** —— 员工薪资 / 身份证这类数据，
 *      宁可让用户看到「网络错误」，也不能给他看三天前的旧数据。
 *   ② 静态资源（图标 / 图片）→ 缓存优先（cache-first），离线也能显示。
 *   ③ 其他同源 GET 请求（API 列表）→ 网络优先，成功则顺手更新缓存。
 *
 * 注意：本系统的敏感信息在服务端就已打码，缓存里也只是打码后的内容；
 * 但业务页面本身仍走「网络优先」，保证改完数据刷新就能看到。
 */

// ⚠️ Stage 9.34 升到 v2：强制清掉 v1 缓存（里面存着已删除的旧 chunk，会导致白屏）
const VERSION = "tuhu-hr-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_FILES = [
  "/offline",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ① 导航请求：网络优先，失败才回退
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/offline", copy)).catch(() => undefined);
          return res;
        })
        .catch(() =>
          caches
            .match("/offline")
            .then((r) => r || new Response("离线，且没有可用的缓存页面。", { status: 503 }))
        )
    );
    return;
  }

  // ② 静态资源
  //
  // ⚠️⚠️ Stage 9.34 重大修正（2026-09-28）：
  //    **`/_next/static/` 绝不能缓存优先**。
  //    Next 的 chunk 文件名里带内容哈希（`5845-8b1d76...js`），一旦重新 build，
  //    旧 HTML 引用的旧 chunk 会立刻消失；而 SW 缓存里还留着旧 chunk，
  //    浏览器去缓存里找一个已被删除的文件 → 页面直接崩：
  //      「Loading chunk 5845 failed」
  //    这类"缓存优先"对哈希资源是**有害的**：缓存命中反而给出过期/已删除的内容。
  //
  //    正确分工：
  //      · 带哈希的 chunk 由浏览器 HTTP 缓存负责（响应头已带 immutable 一年）
  //      · SW 一律**网络优先**（不额外缓存），失败再回退到缓存
  if (url.pathname.startsWith("/icons/")) {
    // 图标文件名不带哈希，缓存优先没问题（离线也能显示）
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            return res;
          })
      )
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    // 网络优先，不写入缓存：让浏览器的 HTTP 缓存（immutable）去管
    event.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || new Response("", { status: 504 }))));
    return;
  }

  // ③ 其余同源 GET：网络优先
  event.respondWith(
    fetch(req).catch(() => caches.match(req).then((r) => r || new Response("", { status: 504 })))
  );
});
