import { Alert } from "@/components/ui";
import ImportPreviewPanel from "@/components/import/ImportPreviewPanel";
import { listPreviews } from "@/lib/import-preview-service";

export const dynamic = "force-dynamic";

/**
 * /import Excel 重新导入预览（第四阶段）
 *
 * 流程：上传 → 解析 → 生成 Diff → 人工确认 → 才写入。
 * 明确禁止「上传即覆盖」。
 */
export default async function ImportPage() {
  const history = await listPreviews(10);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="warn">
        本页<strong>不会在你上传文件的瞬间修改数据库</strong>。
        上传后系统只做解析与比对，把「哪些人会被改、改什么、哪些人是新增」完整列出来，
        <strong>你点过「确认写入」之后才会真正落库</strong>。
      </Alert>
      <ImportPreviewPanel />

      {history.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-[13.5px] font-semibold text-slate-800">最近预览批次</h2>
          <ul className="space-y-1 text-[12.5px] text-slate-600">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-2">
                <span className="font-mono text-slate-500">{h.id}</span>
                <span>{h.fileName}</span>
                <span>
                  修改 {h.summary.modified} / 新增 {h.summary.newCount}
                </span>
                <span
                  className={
                    h.status === "COMMITTED"
                      ? "text-emerald-700"
                      : h.status === "DISCARDED"
                        ? "text-slate-400"
                        : "text-amber-700"
                  }
                >
                  {h.status === "COMMITTED"
                    ? "已写入"
                    : h.status === "DISCARDED"
                      ? "已丢弃"
                      : "待确认"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
