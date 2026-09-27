"use client";

/**
 * 「已登录区域」的错误边界。
 *
 * 与 app/global-error.tsx 的区别：
 *   global-error 会顶掉整页（连 <html> 都重建）；
 *   这个 error.tsx 只替换 (app)/layout 里的内容，侧边栏导航还在，
 *   用户可以直接跳去别的页面继续干活，不至于被卡死在一个点上。
 *
 * 典型收益场景：某个页面组件抛异常 → 只这一页降级成提示卡片，
 *   其他功能照常可用（过去会整页白屏「Application error…」）。
 */

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[TuhuHR] 功能页渲染异常：", error);
  }, [error]);

  return (
    <div className="p-6">
      <div className="mx-auto max-w-[640px] rounded-lg border border-rose-200 bg-rose-50/60 p-5">
        <div className="text-[15px] font-medium text-rose-900">这个页面刚才没加载出来</div>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-700">
          人员数据都还在本机数据库里，<strong>没有丢失</strong>。
          可以先点「重试」；不想重试也能直接用左边的菜单去别的页面。
        </p>

        <div className="mt-3 rounded border border-white bg-white/70 px-3 py-2">
          <div className="text-[11px] text-slate-500">错误提示</div>
          <div className="mt-0.5 break-all font-mono text-[12px] text-slate-700">
            {error?.message || "未知错误"}
          </div>
          {error?.digest ? (
            <div className="mt-1 text-[11px] text-slate-400">编号：{error.digest}</div>
          ) : null}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded bg-brand-600 px-3 py-1.5 text-[13px] text-white hover:bg-brand-700"
          >
            重试
          </button>
          <a
            href="/"
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
          >
            回首页
          </a>
        </div>
      </div>
    </div>
  );
}
