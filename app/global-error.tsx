"use client";

/**
 * 全局错误边界（兜 root layout）。
 *
 * 为什么要有它：
 *   Next.js 遇到渲染期异常时，默认给用户的就是一个白屏
 *   「Application error: a client-side exception has occurred while loading …」，
 *   既不说明哪个页面挂了，也没有任何可点的东西，只能自己猜、自己翻控制台。
 *
 *   有了这个文件，异常会落到这里，给出**可读中文**提示 + 重试/回首页按钮，
 *   并把详细信息打到控制台便于定位。
 *
 * 约定：
 *   - global-error 会**替换掉** root layout，所以必须自带 <html> / <body>。
 *   - 必须是 Client Component。
 *   - 只捕获**渲染期间**异常；事件回调里的错误请在回调内 try/catch。
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[TuhuHR] 页面渲染异常：", error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
          padding: 24,
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
          color: "#1e293b",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 560,
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            background: "#fff",
            padding: 24,
            boxShadow: "0 1px 2px rgba(15,23,42,.06)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>页面出错了</div>
          <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7, color: "#475569" }}>
            这个功能页面刚才没能加载出来。<strong>你的数据没有丢</strong>
            ——人员信息都存在本机数据库里，点「重试」一般就能继续用。
          </p>

          <div
            style={{
              marginTop: 12,
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              background: "#f8fafc",
              padding: "8px 12px",
            }}
          >
            <div style={{ fontSize: 11, color: "#64748b" }}>错误提示</div>
            <div style={{ marginTop: 2, fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>
              {error?.message || "未知错误"}
            </div>
            {error?.digest ? (
              <div style={{ marginTop: 4, fontSize: 11, color: "#94a3b8" }}>编号：{error.digest}</div>
            ) : null}
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                borderRadius: 6,
                background: "#2563eb",
                color: "#fff",
                border: 0,
                padding: "6px 14px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              重试
            </button>
            <a
              href="/"
              style={{
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                padding: "6px 14px",
                fontSize: 13,
                color: "#334155",
                textDecoration: "none",
              }}
            >
              回首页
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
