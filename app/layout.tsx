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
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/icons/apple-touch-icon-167.png", sizes: "167x167", type: "image/png" },
      { url: "/icons/apple-touch-icon-152.png", sizes: "152x152", type: "image/png" },
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
      <head>
        {/*
         * ⚠️⚠️ Stage 9.34b —— 页面自愈脚本（**必须内联在 HTML 里**）
         *
         * 上一版把守卫做成 React 组件放在 (app)/layout 里，结果**它自己所在的
         * layout chunk 加载失败时，守卫也跟着没了**，完全派不上用场
         * （用户实测报错文件正是 app/(app)/layout-xxx.js）。
         *
         * 内联脚本不依赖任何 .js chunk —— 哪怕所有 JS 全挂，它照样能跑。
         *
         * 它做两件事：
         *   ① 识别「chunk 加载失败」特征 → 5 分钟内只触发一次，自动刷新
         *   ② 顺手**注销 ServiceWorker + 清空所有 Cache Storage**
         *      —— 这才是本次崩溃的元凶（PWA 缓存了已删除的旧 chunk）。
         *      一次性清掉，刷新后页面恢复正常，PWA 下次访问会重新注册。
         *
         * 为什么不放 .js 文件里？因为那个文件本身就是 chunk，同样可能加载失败。
         * 万一连这里都拿不到（SW 挡着新 HTML），还有 `/repair` 页面可手动清理。
         */}

      </head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  try {
    var KEY='tuhu_chunk_recovery_at', GAP=5*60*1000;
    window.addEventListener('error', function(e){
      var msg=(e && e.message||'')+' '+((e && e.error && e.error.message)||'');
      if(!/Loading chunk [\\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return;
      var last=Number(sessionStorage.getItem(KEY)||0), now=Date.now();
      if(last && now-last<GAP) return;
      sessionStorage.setItem(KEY, String(now));
      try{ if(window.caches&&window.caches.keys){ window.caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return window.caches.delete(k); })); }).catch(function(){}); } }catch(e){}
      try{ if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){ navigator.serviceWorker.getRegistrations().then(function(rs){ (rs||[]).forEach(function(r){ r.unregister(); }); }).catch(function(){}); } }catch(e){}
      setTimeout(function(){ location.reload(); }, 60);
    }, true);
  } catch(e){}
})();`,
          }}
        />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
