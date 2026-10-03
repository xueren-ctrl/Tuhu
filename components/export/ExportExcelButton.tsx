"use client";

import { useState } from "react";

/**
 * 导出 Excel 按钮（Stage 9.38 / 9.40）
 *
 * 导出的是「以原始 Excel 为底模 + 纯数据回填」的完整工作簿：
 * 表头 / 列顺序 / 合并单元格 / 样式与原表一致，**但 0 个公式、全是算好的数值**。
 * 这样手机打开、微信转发都不会出现「没找到」或公式重算出不同值。
 */
export default function ExportExcelButton({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  async function run() {
    setBusy(true);
    setErr("");
    setDone("");
    try {
      // 先取回文件名（顺便校验服务端能成功生成）
      const probe = await fetch("/api/export/excel?report=1", { cache: "no-store" });
      const pj = await probe.json();
      if (!probe.ok || !pj.ok) throw new Error(pj.error ?? "服务端生成失败");

      // 再下载文件（浏览器直接保存到"下载"目录）
      const res = await fetch("/api/export/excel", { cache: "no-store" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `导出失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pj.data.filename as string;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会让部分浏览器下载失败，延后释放
      setTimeout(() => URL.revokeObjectURL(url), 20_000);

      // 告诉用户压掉了多少公式 —— 「纯数据」这件事要看得见
      const f = pj.data.flattened?.total ?? 0;
      const cells = (pj.data.stats ?? []).reduce(
        (a: number, s: { written: number }) => a + s.written,
        0
      );
      setDone(
        `已导出 ${(blob.size / 1024 / 1024).toFixed(2)} MB · 纯数据 0 公式` +
          `（已把 ${f.toLocaleString()} 个公式替换成数值）· 写入 ${cells.toLocaleString()} 格`
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={`inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-60 ${className}`}
      >
        {busy ? "正在生成…" : "导出 Excel"}
      </button>
      {err ? <span className="text-[11.5px] text-rose-600">{err}</span> : null}
    </span>
  );
}
