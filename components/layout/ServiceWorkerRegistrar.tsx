"use client";

import { useEffect, useState } from "react";

/**
 * 注册 Service Worker（让本系统能装成手机 App）
 *
 * 顺带在用户已安装时什么都不显示；未安装且支持 PWA 时，
 * 给一个「装到手机主屏幕」的按钮 —— 这是用户最想要的入口。
 */

type PromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function ServiceWorkerRegistrar() {
  const [deferred, setDeferred] = useState<PromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [showIOSHelp, setShowIOSHelp] = useState(false);

  useEffect(() => {
    // 已经是「App 模式」运行（从主屏幕图标点进来的）→ 不显示任何安装提示
    const mqStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari 用的是另一个属性
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setStandalone(Boolean(mqStandalone));

    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
    setIsIOS(Boolean(ios));

    if ("serviceWorker" in navigator) {
      // 生产环境才注册，避免开发时缓存干扰调试
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
      }
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as PromptEvent);
    };
    const onInstalled = () => setInstalled(true);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setDeferred(null);
  }

  // 已经装成 App / 不需要提示
  if (standalone || installed || (!deferred && !isIOS)) return null;

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSHelp((v) => !v)}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-[13px] font-medium text-white shadow-lg active:bg-slate-700"
        >
          装到主屏幕
        </button>
        {showIOSHelp ? (
          <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 sm:items-center">
            <div className="w-full max-w-[420px] rounded-xl bg-white p-5 shadow-2xl">
              <h3 className="text-[15px] font-semibold text-slate-800">把系统装到 iPhone 主屏幕</h3>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-slate-600">
                <li>用 <strong>Safari</strong> 打开本系统（微信内置浏览器不行）</li>
                <li>
                  点底部中间的<strong>「分享」</strong>按钮（方框里一个向上箭头）
                </li>
                <li>
                  向下滑，选<strong>「添加到主屏幕」</strong>
                </li>
                <li>右上角点「添加」——桌面上就出现图标了，以后点它直接进</li>
              </ol>
              <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-500">
                装好后是独立窗口，没有浏览器地址栏，和 App 一样。
              </p>
              <button
                type="button"
                onClick={() => setShowIOSHelp(false)}
                className="mt-3 h-9 w-full rounded-md bg-slate-900 text-[13px] text-white"
              >
                知道了
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={install}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-[13px] font-medium text-white shadow-lg active:bg-slate-700"
    >
      装到手机主屏幕
    </button>
  );
}
