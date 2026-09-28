export const dynamic = "force-dynamic";

/**
 * 一键修复页（Stage 9.34b）
 *
 * ## 什么时候需要
 * 更新系统后，页面报 `Loading chunk xxx failed` —— 浏览器/PWA 缓存了
 * **已被删除的旧 JS 文件**。正常情况下根布局里的内联自愈脚本会自动清理并刷新；
 * 但如果连新的 HTML 都拿不到（被 Service Worker 挡着），就需要打开这个页面手动清一次。
 *
 * ## 为什么这个页面「一定打得开」
 * - 它不在 `(app)` 路由组里 → **不依赖任何业务 chunk**；
 * - 交互用的是**内联 onclick 字符串**，不是 React 客户端组件 → 不加载任何 .js；
 * - 页面本身是网络优先的（SW 对未缓存路径走网络），所以能拿到最新的 HTML。
 *
 * 用法：浏览器打开 `http://localhost:3000/repair` → 点「立即修复」→ 自动回到登录页。
 */
export default function RepairPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-[520px] rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[16px] font-semibold text-slate-800">页面修复工具</div>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
          如果你看到「Loading chunk … failed」或「页面出错了」，点下面的按钮即可。
          它会清掉浏览器与 PWA 里的旧缓存并重新加载。
          <strong className="text-slate-700">你的数据不会受影响</strong>（都在本机数据库里）。
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            // ⚠️ 内联脚本只能走 dangerouslySetInnerHTML，**不能同时写 children**
            //    （React 会抛 "Can only set one of `children` or `props.dangerouslySetInnerHTML""），
            //    所以按钮文字也放进同一个 __html 里。
            dangerouslySetInnerHTML={{
              __html: `onclick="(function(){this.textContent='已清理，正在重新加载…';this.disabled=true;try{if(sessionStorage)sessionStorage.removeItem('tuhu_chunk_recovery_at')}catch(e){};try{if(window.caches&&caches.keys){caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k)})})})}}catch(e){};try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(rs){(rs||[]).forEach(function(r){try{r.unregister()}catch(e){}})})}}catch(e){};setTimeout(function(){location.replace('/')},900);})()">立即修复</button>`,
            }}
            className="h-10 rounded-md bg-brand-600 px-4 text-[13.5px] text-white hover:bg-brand-700"
          />
          <a
            href="/"
            className="inline-flex h-10 items-center rounded-md border border-slate-300 px-4 text-[13.5px] text-slate-700 hover:bg-slate-50"
          >
            返回首页
          </a>
        </div>

        <details className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2">
          <summary className="cursor-pointer text-[12.5px] text-slate-600">打不开这一页？试试这两招</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-600">
            <li>
              按 <kbd className="rounded border border-slate-300 px-1">Ctrl</kbd> +{" "}
              <kbd className="rounded border border-slate-300 px-1">Shift</kbd> +{" "}
              <kbd className="rounded border border-slate-300 px-1">R</kbd> 强制刷新；
            </li>
            <li>用浏览器的「无痕 / 隐私窗口」打开 <code>http://localhost:3000</code>，登录一次即可。</li>
          </ol>
        </details>
      </div>
    </div>
  );
}
