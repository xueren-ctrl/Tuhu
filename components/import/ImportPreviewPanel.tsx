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
}

interface FieldChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
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
  idCardNo: string | null;
  phone: string | null;
  jobGrade: string | null;
  reason: string;
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

/**
 * Excel 重新导入预览
 *
 * 流程固定：上传 → 解析 → Diff → 确认 → 写入。
 * 页面明确告知「上传不会改数据库」，且写入前必须点确认。
 */
export default function ImportPreviewPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) {
      setMsg({ tone: "warn", text: "请先选择 Excel 文件" });
      return;
    }
    setBusy(true);
    setMsg(null);
    setPreview(null);
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
          "解析完成，已生成 Diff（此时数据库未发生任何变化）。请核对差异后再决定是否写入。",
      });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
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
      const r = await fetch(`/api/import/preview/${preview.id}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "写入失败");
      const d = j.data;
      setMsg({
        tone: "ok",
        text: `已写入：修改 ${d.updated} 人、新增 ${d.created} 人、失败 ${d.failed} 人。所有人员视图与统计已同步。`,
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
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-[12.5px]"
          />
          <Button variant="secondary" disabled={busy} onClick={() => void upload()}>
            {busy ? "解析中…" : "上传并生成 Diff"}
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-slate-500">
          系统只读取「数据库」Sheet（表头在第 2 行）。上传后会先校验关键列表头文字，
          列顺序被改动过时会直接拒绝，避免把身份证号错位写进银行卡列。
        </p>
      </Card>

      {preview && (
        <>
          <Card
            title={`② 差异预览 · ${preview.fileName}`}
            extra={
              <span className="text-[12px] text-slate-500">
                批次 {preview.id} ｜ {preview.sheetName} Sheet ｜{" "}
                {(preview.fileSize / 1024).toFixed(0)} KB
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="有效数据行" value={preview.summary.validRows} />
              <Stat label="匹配到已有员工" value={preview.summary.matched} />
              <Stat label="将修改" value={preview.summary.modified} tone="amber" />
              <Stat label="将新增" value={preview.summary.newCount} tone="blue" />
              <Stat label="无变化" value={preview.summary.unchanged} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone="amber">状态变化 {preview.summary.statusChanges} 人</Badge>
              <Badge tone="blue">门店变化 {preview.summary.storeChanges} 人</Badge>
              <Badge tone="slate">岗位变化 {preview.summary.positionChanges} 人</Badge>
              <Badge tone="gray">跳过空行 {preview.summary.skippedRows}</Badge>
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
                本预览解析器对<strong>历史脏数据行</strong>的处理与导入脚本存在已知差异，
                主要出现在三类：Excel 里<strong>身份证号 / 联系电话列错位</strong>的行、
                <strong>离职日期写成文本</strong>的行、以及
                <strong>门店 / 岗位名称被手工改写过</strong>的行。
                <br />
                这些差异导入时已按各自规则处理并记录在导入报告中，
                <strong>预览未必能完全复现</strong>。请逐条核对后再确认写入；
                若只是要修正归属类字段，建议改用「批量编辑」或「部门自动归属」。
              </Alert>
              <div className="h-3" />
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">员工编号</th>
                      <th className="px-3 py-2 font-medium">姓名</th>
                      <th className="px-3 py-2 font-medium">行号</th>
                      <th className="px-3 py-2 font-medium">变更字段</th>
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
                                  {c.oldValue ?? "空"}
                                </span>
                                {" → "}
                                <span className="font-medium text-slate-800">
                                  {c.newValue ?? "空"}
                                </span>
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

          <Card title="⑤ 确认">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || (preview.summary.modified === 0 && preview.summary.newCount === 0)}
                onClick={() => void commit()}
              >
                {busy ? "写入中…" : "确认写入数据库"}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void discard()}>
                丢弃，不写入
              </Button>
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              写入会按上面的 Diff 逐条修改 / 新增，并记入员工变更记录。
              同一个预览批次只能提交一次，避免误点两次造成重复写入。
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
