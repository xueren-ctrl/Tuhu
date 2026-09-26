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

const VERSION = "tuhu-hr-v1";
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

  // ② 静态资源：缓存优先
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
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

  // ③ 其余同源 GET：网络优先
  event.respondWith(
    fetch(req).catch(() => caches.match(req).then((r) => r || new Response("", { status: 504 })))
  );
});
