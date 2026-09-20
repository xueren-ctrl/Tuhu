"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card } from "@/components/ui";

interface Summary {
  totalRows: number;
  validRows: number;
  skippedRows: number;
  matched: number;
  unchanged: number;
  modified: number;
  newCount: number;
  statusChanges: number;
  storeChanges: number;
  positionChanges: number;
  issueCount: number;
}

interface FieldChange {
  field: string;
  label: string;
  sensitive: boolean;
  /** 只用于展示的脱敏值；真实值保存在服务端，不随接口下发 */
  displayOldValue: string | null;
  displayNewValue: string | null;
}

interface ModifiedEmployee {
  employeeId: number;
  employeeCode: string;
  name: string;
  rowNo: number;
  changes: FieldChange[];
  hasStatusChange: boolean;
  hasStoreChange: boolean;
  hasPositionChange: boolean;
}

interface NewEmployeeRow {
  rowNo: number;
  name: string | null;
  storeName: string | null;
  hireDate: string | null;
  jobGrade: string | null;
  reason: string;
}

interface FailureItem {
  rowNo: number;
  employeeCode?: string | null;
  name?: string | null;
  kind: "update" | "create";
  message: string;
}

interface CommitResult {
  previewId: string;
  updated: number;
  created: number;
  unchanged: number;
  failed: number;
  attempted: number;
  failures: FailureItem[];
}

interface PreviewData {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  createdAt: string;
  sheetName: string;
  summary: Summary;
  diff: { summary: Summary; modified: ModifiedEmployee[]; created: NewEmployeeRow[] };
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: "待确认",
  COMMITTING: "写入中",
  SUCCESS: "全部成功",
  PARTIAL: "部分成功",
  FAILED: "写入失败",
  DISCARDED: "已丢弃",
};

/**
 * Excel 重新导入预览
 *
 * 流程固定：上传 → 解析 → Diff → 确认 → 写入。
 * 展示的一律是**脱敏值**；真实值只在服务端写库时使用，绝不下发浏览器。
 */
export default function ImportPreviewPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) {
      setMsg({ tone: "warn", text: "请先选择 Excel 文件" });
      return;
    }
    setBusy(true);
    setMsg(null);
    setPreview(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/import/preview", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "解析失败");
      setPreview(j.data as PreviewData);
      setMsg({
        tone: "ok",
        text:
          "解析完成，已生成 Diff（此时数据库未发生任何变化）。差异中的敏感字段已脱敏展示，" +
          "确认写入时系统会重新解析同一份文件并写入完整真实值。",
      });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function commit(retry: boolean) {
    if (!preview) return;
    const s = preview.summary;
    if (
      !confirm(
        `确认写入数据库？\n\n修改 ${s.modified} 人、新增 ${s.newCount} 人。\n` +
          `其中：状态变化 ${s.statusChanges} 人、门店变化 ${s.storeChanges} 人、岗位变化 ${s.positionChanges} 人。\n\n` +
          `写入后每一步都会记入员工变更记录。此操作不可撤销。`
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/import/preview/${preview.id}${retry ? "?retry=1" : ""}`, {
        method: "POST",
      });
      const j = await r.json();

      if (r.status === 409) {
        setMsg({ tone: "warn", text: `⚠ ${j.error ?? "数据库已发生变化，请重新生成预览。"}` });
        setPreview(null);
        setFile(null);
        router.refresh();
        return;
      }
      if (r.status === 207 || !j.ok) {
        // 部分成功：明确展示失败明细，并允许只重试失败项
        const d = j.data as CommitResult;
        setResult(d);
        setMsg({
          tone: "warn",
          text: `⚠ 未全部成功：成功写入 ${d.updated + d.created} 条，失败 ${d.failed} 条。` +
            `批次状态已标记为「部分成功」，不会有「假成功」。可点「只重试失败项」继续。`,
        });
        router.refresh();
        return;
      }

      const d = j.data as CommitResult;
      setResult(d);
      setMsg({
        tone: "ok",
        text: `已写入：修改 ${d.updated} 人、新增 ${d.created} 人、无变化 ${d.unchanged} 人、失败 ${d.failed} 人。所有人员视图与统计已同步。`,
      });
      setPreview(null);
      setFile(null);
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!preview) return;
    if (!confirm("确认丢弃这个预览批次？不会写入任何数据。")) return;
    setBusy(true);
    try {
      await fetch(`/api/import/preview/${preview.id}`, { method: "DELETE" });
      setMsg({ tone: "ok", text: "已丢弃，数据库未发生任何变化" });
      setPreview(null);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {msg && (
        <Alert tone={msg.tone === "ok" ? "success" : msg.tone === "warn" ? "warn" : "error"}>
          {msg.text}
        </Alert>
      )}

      <Card title="① 上传 Excel（此步骤不会修改数据库）">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-[12.5px]"
          />
          <Button variant="secondary" disabled={busy} onClick={() => void upload()}>
            {busy ? "解析中…" : "上传并生成 Diff"}
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-slate-500">
          仅接受 <strong>.xlsx</strong>（上限 20MB）—— ExcelJS 无法解析旧版 .xls 二进制格式，
          与其假装支持不如明确拒绝。系统只读取「数据库」Sheet（表头在第 2 行），
          上传后会先校验关键列表头文字，列顺序被改动过时会直接拒绝，
          避免把身份证号错位写进银行卡列。
        </p>
      </Card>

      {preview && (
        <>
          <Card
            title={`② 差异预览 · ${preview.fileName}`}
            extra={
              <span className="text-[12px] text-slate-500">
                批次 {preview.id} ｜ {preview.sheetName} Sheet ｜{" "}
                {(preview.fileSize / 1024 / 1024).toFixed(2)} MB ｜{" "}
                {STATUS_TEXT[preview.status] ?? preview.status}
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="有效数据行" value={preview.summary.validRows} />
              <Stat label="匹配到已有员工" value={preview.summary.matched} />
              <Stat label="将修改" value={preview.summary.modified} tone="amber" />
              <Stat label="将新增" value={preview.summary.newCount} tone="blue" />
              <Stat label="无变化" value={preview.summary.unchanged} />
              <Stat label="解析异常" value={preview.summary.issueCount} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="amber">状态变化 {preview.summary.statusChanges} 人</Badge>
              <Badge tone="blue">门店变化 {preview.summary.storeChanges} 人</Badge>
              <Badge tone="slate">岗位变化 {preview.summary.positionChanges} 人</Badge>
              <Badge tone="gray">跳过行 {preview.summary.skippedRows}</Badge>
            </div>
            {preview.summary.modified === 0 && preview.summary.newCount === 0 && (
              <p className="mt-3 text-[12.5px] text-emerald-700">
                ✅ 与数据库完全一致，没有需要写入的差异。
              </p>
            )}
          </Card>

          {preview.diff.modified.length > 0 && (
            <Card title={`③ 将会被修改的员工（${preview.diff.modified.length} 人）`}>
              <Alert tone="warn">
                差异中的<strong>身份证号 / 手机号 / 银行卡 / 地址 / 薪资</strong>已脱敏展示。
                确认写入时系统会<strong>重新解析同一份 Excel</strong> 并写入完整真实值，
                数据库里绝不会存脱敏后的残缺数据。
              </Alert>
              <div className="h-3" />
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">员工编号</th>
                      <th className="px-3 py-2 font-medium">姓名</th>
                      <th className="px-3 py-2 font-medium">行号</th>
                      <th className="px-3 py-2 font-medium">变更字段（脱敏展示）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.diff.modified.slice(0, 200).map((m) => (
                      <tr key={m.employeeId} className="border-b border-slate-100 align-top">
                        <td className="px-3 py-2">{m.employeeCode}</td>
                        <td className="px-3 py-2 font-medium text-slate-800">{m.name}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-500">{m.rowNo}</td>
                        <td className="px-3 py-2">
                          <ul className="space-y-0.5">
                            {m.changes.map((c, i) => (
                              <li key={i} className="text-slate-600">
                                <span className="text-slate-500">{c.label}：</span>
                                <span className="line-through text-slate-400">
                                  {c.displayOldValue ?? "空"}
                                </span>
                                {" → "}
                                <span className="font-medium text-slate-800">
                                  {c.displayNewValue ?? "空"}
                                </span>
                                {c.sensitive && (
                                  <span className="ml-1 rounded bg-amber-50 px-1 text-[10.5px] text-amber-700">
                                    敏感·脱敏显示
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.diff.modified.length > 200 && (
                  <p className="mt-2 text-[12px] text-slate-400">
                    仅显示前 200 条，共 {preview.diff.modified.length} 人
                  </p>
                )}
              </div>
            </Card>
          )}

          {preview.diff.created.length > 0 && (
            <Card title={`④ 将会新增的员工（${preview.diff.created.length} 人）`}>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">行号</th>
                      <th className="px-3 py-2 font-medium">姓名</th>
                      <th className="px-3 py-2 font-medium">门店</th>
                      <th className="px-3 py-2 font-medium">入职日期</th>
                      <th className="px-3 py-2 font-medium">工种</th>
                      <th className="px-3 py-2 font-medium">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.diff.created.slice(0, 200).map((c) => (
                      <tr key={c.rowNo} className="border-b border-slate-100">
                        <td className="px-3 py-2 tabular-nums">{c.rowNo}</td>
                        <td className="px-3 py-2 font-medium text-slate-800">{c.name ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-600">{c.storeName ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-600">{c.hireDate ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-600">{c.jobGrade ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-500">{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {result && result.failures.length > 0 && (
            <Card title={`⑤ 失败明细（${result.failures.length} 条）`}>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">行号</th>
                      <th className="px-3 py-2 font-medium">员工编号</th>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failures.map((f, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="px-3 py-2 tabular-nums">{f.rowNo}</td>
                        <td className="px-3 py-2">{f.employeeCode ?? "—"}</td>
                        <td className="px-3 py-2">{f.kind === "create" ? "新增" : "修改"}</td>
                        <td className="px-3 py-2 text-red-700">{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3">
                <Button variant="secondary" disabled={busy} onClick={() => void commit(true)}>
                  只重试失败项
                </Button>
              </div>
            </Card>
          )}

          <Card title="⑥ 确认">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || (preview.summary.modified === 0 && preview.summary.newCount === 0)}
                onClick={() => void commit(false)}
              >
                {busy ? "写入中…" : "确认写入数据库"}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void discard()}>
                丢弃，不写入
              </Button>
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              提交前会复核数据库版本：若预览生成之后有人改过员工 / 门店 / 职位 / 部门，
              系统会拒绝提交并要求重新生成预览，避免「页面看到 A、实际写入 B」。
              写入结果分 新增 / 修改 / 无变化 / 失败 四类记录，只要有一条失败，
              批次就标记为「部分成功」或「失败」，不会伪装成成功。
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "blue";
}) {
  const cls =
    tone === "amber"
      ? "text-amber-700"
      : tone === "blue"
        ? "text-brand-700"
        : "text-slate-800";
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <div className="text-[11.5px] text-slate-500">{label}</div>
      <div className={`text-[20px] font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
