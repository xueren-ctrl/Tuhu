"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Input } from "@/components/ui";
import type { StoreWithCounts } from "@/lib/store-service";

interface Props {
  stores: StoreWithCounts[];
}

/**
 * 门店别名管理（客户端组件）
 *
 * 交互：每个门店一行，可展开别名区；新增别名后立即调用后端，
 * 后端会把「原文列写着该别名」的员工统一挂到本门店，然后刷新页面。
 */
export default function StoreAliasPanel({ stores }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<number | null>(null);
  const [alias, setAlias] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState("");

  const filtered = keyword.trim()
    ? stores.filter(
        (s) =>
          s.name.includes(keyword.trim()) ||
          (s.code ?? "").includes(keyword.trim()) ||
          s.aliases.some((a) => a.alias.includes(keyword.trim()))
      )
    : stores;

  async function addAlias(store: StoreWithCounts) {
    if (!alias.trim()) {
      setMsg({ tone: "err", text: "请先填写别名" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/stores/${store.id}/aliases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: alias.trim(), note: note.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "新增失败");
      const moved = j.data?.applied?.repointed ?? 0;
      setMsg({
        tone: "ok",
        text:
          `已为「${store.name}」新增别名「${alias.trim()}」。` +
          (moved > 0
            ? `同时把原文列写着该别名的 ${moved} 名员工统一归属到本门店（只改外键，原文保留）。`
            : "暂无员工的门店原文列使用该别名，无需重挂。"),
      });
      setAlias("");
      setNote("");
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function removeAlias(aliasId: number, aliasText: string) {
    if (!confirm(`确认删除别名「${aliasText}」？\n\n已归属到本门店的员工不会被退回（只删别名，不动员工）。`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/store-aliases/${aliasId}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "删除失败");
      setMsg({ tone: "ok", text: `已删除别名「${aliasText}」（员工的归属保持不变）` });
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {msg && <Alert tone={msg.tone === "ok" ? "success" : "error"}>{msg.text}</Alert>}

      <Card
        title={`门店列表（${filtered.length} 家）`}
        extra={
          <div className="w-64">
            <Input
              placeholder="搜索门店名 / 编码 / 别名"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2 font-medium">门店名称</th>
                <th className="px-3 py-2 font-medium">门店编码</th>
                <th className="px-3 py-2 font-medium">区域</th>
                <th className="px-3 py-2 text-right font-medium">员工数量</th>
                <th className="px-3 py-2 text-right font-medium">在职</th>
                <th className="px-3 py-2 text-right font-medium">离职</th>
                <th className="px-3 py-2 font-medium">别名</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-800">{s.name}</span>
                    {s.status !== "ACTIVE" && (
                      <span className="ml-2">
                        <Badge tone="slate">已停用</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{s.code ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{s.region ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                    {s.active}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                    {s.resigned}
                  </td>
                  <td className="px-3 py-2">
                    {s.aliases.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {s.aliases.map((a) => (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11.5px] text-slate-700"
                          >
                            {a.alias}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => removeAlias(a.id, a.alias)}
                              className="text-slate-400 hover:text-red-600"
                              title="删除别名"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpenId(openId === s.id ? null : s.id);
                        setAlias("");
                        setNote("");
                        setMsg(null);
                      }}
                    >
                      {openId === s.id ? "收起" : "管理别名"}
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                    没有匹配的门店
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 展开的别名编辑区 */}
        {openId !== null &&
          (() => {
            const s = stores.find((x) => x.id === openId);
            if (!s) return null;
            return (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-[12.5px] text-slate-600">
                  为「<strong className="text-slate-800">{s.name}</strong>」新增别名。
                  别名用于把历史 Excel 里的其他写法统一归属到本门店
                  —— <strong>不会复制任何员工数据</strong>，只会把员工的门店外键指向本门店，
                  门店原文列照原样保留。
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-56">
                    <label className="mb-1 block text-[11.5px] text-slate-500">别名</label>
                    <Input
                      placeholder="如：XX路、XX路分店"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                    />
                  </div>
                  <div className="w-64">
                    <label className="mb-1 block text-[11.5px] text-slate-500">备注（可选）</label>
                    <Input
                      placeholder="如：2024 年前的旧写法"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                  <Button onClick={() => addAlias(s)} disabled={busy || pending}>
                    {busy ? "处理中…" : "新增别名并统一归属"}
                  </Button>
                </div>
              </div>
            );
          })()}
      </Card>
    </div>
  );
}
