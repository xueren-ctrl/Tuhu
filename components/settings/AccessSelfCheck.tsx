"use client";

import { useState } from "react";

/**
 * 访问自检（Stage 9.7）
 *
 * 用户报「打不开 / 一直加载 / 请检查网络」时，最快的定位手段：
 * 在出问题的那个设备上点一下，直接告诉他是哪一环断了。
 *
 * 检测顺序（每一环都能独立失败，结论要能区分开）：
 *   ① 当前地址能不能拿到本系统的页面（区分「网络不通」和「服务器没响应」）
 *   ② 登录状态是否还有效（有没有被踢回登录页 / 8 小时超时）
 *   ③ 页面自带的 JS 能不能下载（这才是「一直转圈」的真正原因 —— 缓存了旧版本）
 */

type Step = { key: string; label: string; ok: boolean | null; detail: string };

export default function AccessSelfCheck() {
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);

  async function run() {
    setRunning(true);
    setVerdict(null);
    setSteps([]);
    const out: Step[] = [];

    // ① 页面能不能打开
    let html = "";
    let pageOk = false;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      const t0 = Date.now();
      const r = await fetch(window.location.href, { cache: "no-store", signal: ctl.signal });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const body = await r.text();
      html = body;
      pageOk = r.ok && body.length > 500;
      out.push({
        key: "page",
        label: "① 能否打开本系统",
        ok: pageOk,
        detail: pageOk
          ? `正常（${ms} 毫秒，返回 ${body.length} 字节）`
          : `HTTP ${r.status}，只拿到 ${body.length} 字节`,
      });
    } catch (e) {
      out.push({
        key: "page",
        label: "① 能否打开本系统",
        ok: false,
        detail: `连不上：${(e as Error).name === "AbortError" ? "20 秒超时" : (e as Error).message}`,
      });
    }

    // ② 登录状态
    if (pageOk) {
      if (html.includes('name="password"') || html.includes("请输入密码")) {
        out.push({ key: "auth", label: "② 登录状态", ok: null, detail: "当前是登录页 —— 先登录再自检" });
      } else {
        out.push({ key: "auth", label: "② 登录状态", ok: true, detail: "仍然有效，没有被踢回登录页" });
      }
    }

    // ③ 静态资源（这才是「一直转圈」的真正原因）
    if (pageOk) {
      const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => m[1]))];
      const bad: string[] = [];
      for (const a of assets) {
        try {
          const r = await fetch(a, { cache: "no-store" });
          if (!r.ok) bad.push(`${r.status} ${a}`);
        } catch {
          bad.push(`中断 ${a}`);
        }
      }
      out.push({
        key: "js",
        label: "③ 页面脚本能否下载",
        ok: bad.length === 0,
        detail:
          bad.length === 0
            ? `${assets.length} 个脚本全部正常`
            : `${bad.length} 个脚本加载失败（浏览器缓存了旧版本）：${bad.slice(0, 2).join("；")}`,
      });

      if (bad.length > 0) {
        out.push({
          key: "fix",
          label: "怎么办",
          ok: null,
          detail: "按 Ctrl+Shift+R 强制刷新；手机请清缓存后重开页面",
        });
      }
    }

    setSteps(out);

    const pageFail = out.find((s) => s.key === "page")?.ok === false;
    const jsFail = out.find((s) => s.key === "js")?.ok === false;
    const authInfo = out.find((s) => s.key === "auth");
    if (pageFail) {
      setVerdict({
        tone: "bad",
        text: "打不开是网络或服务的问题，不是浏览器缓存。请确认这台电脑上的服务窗口还开着。",
      });
    } else if (jsFail) {
      setVerdict({ tone: "warn", text: "网络是通的，但浏览器缓存了旧版本脚本 —— 强制刷新即可。" });
    } else if (authInfo?.ok === null) {
      setVerdict({ tone: "warn", text: "一切正常，只是当前停在登录页 —— 登录后就能用。" });
    } else {
      setVerdict({ tone: "ok", text: "一切正常，当前这个入口是可以用的。" });
    }

    setRunning(false);
  }

  const toneClass = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    bad: "border-rose-200 bg-rose-50 text-rose-800",
  }[verdict?.tone ?? "ok"];

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {running ? "检测中…" : "检测当前这个入口是否正常"}
        </button>
        <span className="text-[11.5px] text-slate-400">
          在打不开的那个设备上点，能直接看出是哪一环断了
        </span>
      </div>

      {steps.length > 0 ? (
        <ul className="space-y-1">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-[12px] leading-relaxed">
              <span
                className={
                  s.ok === true
                    ? "text-emerald-600"
                    : s.ok === false
                      ? "text-rose-600"
                      : "text-amber-600"
                }
              >
                {s.ok === true ? "✓" : s.ok === false ? "✗" : "!"}
              </span>
              <span>
                <strong className="text-slate-700">{s.label}</strong>
                <span className="ml-1.5 text-slate-500">{s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {verdict ? (
        <div className={`rounded-md border px-3 py-2 text-[12.5px] leading-relaxed ${toneClass}`}>{verdict.text}</div>
      ) : null}
    </div>
  );
}
