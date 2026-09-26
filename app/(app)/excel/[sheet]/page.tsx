import { notFound } from "next/navigation";
import Link from "next/link";
import { loadSheet } from "@/lib/sheet-service";
import { parseSheetQuery, prepareSheetRows } from "@/lib/sheet-page-helpers";
import { SHEET_MAP } from "@/lib/sheet-meta";
import { prisma } from "@/lib/prisma";
import SheetDataTable from "@/components/sheets/SheetDataTable";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /excel/[sheet] —— Excel 原始镜像（只读留档）
 *
 * 数据来自导入时逐格抓取的 SheetRow，与 Excel 该 Sheet 完全一致（公式取缓存结果、
 * 日期按 YYYY-MM-DD、历史脏值原样保留），**不受员工状态影响、也不可在此编辑**。
 * 日常使用的是 /sheets/<表>（由员工数据实时生成）。
 */

export default async function ExcelArchivePage({
  params,
  searchParams,
}: {
  params: Promise<{ sheet: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sheet: rawSheet } = await params;
  const sheet = decodeURIComponent(rawSheet);
  const meta = SHEET_MAP[sheet];
  if (!meta) notFound();

  const sp = await searchParams;
  const loaded = await loadSheet(sheet);
  if (!loaded) notFound();

  const q = parseSheetQuery(sp, loaded.columns.length);
  const prepared = prepareSheetRows(loaded.rows, loaded.columns, q);

  const lastImport = await prisma.sheetRow.findFirst({
    where: { sheet },
    orderBy: { importedAt: "desc" },
    select: { importedAt: true },
  });

  return (
    <div className="mx-auto max-w-[1700px] space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-800">
            {meta.label} <span className="text-[13px] font-normal text-slate-400">· Excel 原始留档</span>
          </h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            导入时逐格抓取的原样数据 · {loaded.columns.length} 个字段 · {loaded.rows.length} 行
            {lastImport ? (
              <span className="ml-2 text-slate-400">
                导入于 {lastImport.importedAt.toLocaleString("zh-CN", { hour12: false })}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/sheets/${encodeURIComponent(sheet)}`}
            className="h-8 rounded-md bg-brand-600 px-3 text-[12.5px] leading-8 text-white hover:bg-brand-700"
          >
            回到「{meta.label}」员工表（可增删改）
          </Link>
          <Link
            href={`/excel/${encodeURIComponent(sheet)}`}
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
          >
            重置条件
          </Link>
        </div>
      </div>

      <Alert tone="warn">
        这是 <strong>Excel 原始数据的只读留档</strong>，用于与当前数据对照，不参与日常增删改；
        新增员工、改状态、删除员工请到「员工表（对应 Excel 各 Sheet）」里操作。
      </Alert>

      <SheetDataTable
        sheet={`excel:${sheet}`}
        columns={loaded.columns}
        rows={prepared.rows}
        reveal={q.reveal}
        hasSensitiveColumns={loaded.columns.some((c) => c.sensitive)}
        totalRows={loaded.rows.length}
        filtered={prepared.matchedCount}
        page={prepared.page}
        pageSize={prepared.pageSize}
        totalPages={prepared.totalPages}
        query={{
          q: q.keyword,
          col: q.colRaw,
          op: q.op,
          val: q.val,
          sort: q.sortRaw,
          dir: q.dir,
        }}
      />

      <Alert tone="info">
        敏感信息（身份证 / 银行卡 / 电话 / 地址 / 薪资）在<strong>服务端就已打码</strong>，
        页面源码里也拿不到完整值；需要查看时勾选右上角「显示完整信息」。
      </Alert>
    </div>
  );
}
