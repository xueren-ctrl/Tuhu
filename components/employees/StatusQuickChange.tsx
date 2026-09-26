"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Select } from "@/components/ui";
import {
  EMPLOYEE_STATUS_LABEL,
  EMPLOYEE_STATUS_OPTIONS,
  EMPLOYEE_STATUS_TONE,
} from "@/lib/constants";
import { STATUS_SHEETS, SHEET_LABEL } from "@/lib/sheet-fields";

/** 员工详情页的「一键改状态」 */
export default function StatusQuickChange({
  employeeId,
  status,
}: {
  employeeId: number;
  status: string;
}) {
  const router = useRouter();
  const [target, setTarget] = useState(status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "warn"; text: string } | null>(null);

  const sheetsOf = (s: string) => (STATUS_SHEETS[s] ?? []).map((x) => SHEET_LABEL[x] ?? x);

  async function apply() {
    if (target === status) return setMsg({ tone: "warn", text: "状态没有变化" });
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/employees/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [employeeId], status: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setMsg({ tone: "error", text: data.error ?? `执行失败（HTTP ${res.status}）` });
        return;
      }
      setMsg({
        tone: "success",
        text: `已改为「${EMPLOYEE_STATUS_LABEL[target]}」，将出现在：${
          sheetsOf(target).join(" / ") || "（不出现在任何表）"
        }`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: "执行失败：" + (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-medium text-slate-700">员工状态</span>
        <Badge tone={EMPLOYEE_STATUS_TONE[status] ?? "gray"}>
          {EMPLOYEE_STATUS_LABEL[status] ?? status}
        </Badge>
        <span className="text-[12px] text-slate-500">
          当前出现在：<strong className="text-slate-700">{sheetsOf(status).join(" / ") || "（无）"}</strong>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 w-[170px]">
            {EMPLOYEE_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {target !== status ? (
            <span className="text-[11.5px] text-slate-500">
              → {sheetsOf(target).join(" / ") || "不出现在任何表"}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            onClick={apply}
            loading={busy}
            disabled={target === status}
          >
            更改状态
          </Button>
        </div>
      </div>
      {msg ? (
        <div className="mt-2">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      ) : null}
      <div className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
        状态决定这个人出现在哪些表：候选中 → 哪都不出现；已面试 → 招聘面试登记表；
        已入职 → 在职 + 招聘面试登记表 + 薪资表；离职 → 离职 + 招聘面试登记表 + 薪资表；
        南昌3店 / 运营部 / 运营部离职 → 各自的表 + 招聘面试登记表 + 薪资表；其他 → 只出现在「其他」表。
        「数据库」表包含全部员工。
      </div>
    </div>
  );
}
