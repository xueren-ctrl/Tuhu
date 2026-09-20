"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";

interface Props {
  issueType: string;
  employeeId: number;
  employeeCode: string;
  status: string;
  handler: string | null;
  result: string | null;
}

/**
 * 单个数据质量问题的处理动作
 *
 * 关闭 / 忽略必须填「处理结果说明」——
 * 否则后人看到「已关闭」却不知道为什么关，等于把问题藏起来。
 */
export default function IssueActions({
  issueType,
  employeeId,
  employeeCode,
  status,
  handler,
  result,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(next: "CLOSED" | "IGNORED" | "OPEN") {
    setErr(null);
    let text: string | null = null;
    if (next !== "OPEN") {
      text = prompt(
        `请填写处理结果说明（必填）：\n\n员工：${employeeCode}\n操作：${next === "CLOSED" ? "关闭" : "忽略"}`
      );
      if (text === null) return; // 取消
      if (!text.trim()) {
        setErr("必须填写处理结果说明");
        return;
      }
    }
    setBusy(true);
    try {
      const r = await fetch("/api/quality-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueType, employeeId, status: next, result: text ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "操作失败");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (status !== "OPEN") {
    return (
      <div className="text-[11.5px] leading-tight">
        <Badge tone={status === "CLOSED" ? "green" : "slate"}>
          {status === "CLOSED" ? "已关闭" : "已忽略"}
        </Badge>
        <div className="mt-1 text-slate-500">
          {result ? `结果：${result}` : null}
          {handler ? ` ｜ ${handler}` : null}
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("OPEN")}>
          重新打开
        </Button>
        {err && <div className="text-red-600">{err}</div>}
      </div>
    );
  }

  return (
    <div>
      <Badge tone="amber">待处理</Badge>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("CLOSED")}>
          关闭
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("IGNORED")}>
          忽略
        </Button>
      </div>
      {err && <div className="text-[11.5px] text-red-600">{err}</div>}
    </div>
  );
}
