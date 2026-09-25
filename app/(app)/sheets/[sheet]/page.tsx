import { notFound } from "next/navigation";
import Link from "next/link";
import {
  filterRows,
  loadSheet,
  maskRows,
  paginate,
  sortRows,
  type FilterOp,
} from "@/lib/sheet-service";
import { SHEET_MAP } from "@/lib/sheet-meta";
import { prisma } from "@/lib/prisma";
import SheetDataTable from "@/components/sheets/SheetDataTable";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /sheets/[sheet] —— Excel 某张 Sheet 的数据在软件里的「数据表」视图
 *
 * 数据来源与 Excel 该 Sheet 完全一致（导入时原样抓取），
 * 但展示方式是标准业务系统：搜索 / 按列筛选 / 排序 / 分页 / 行详情 / 手机卡片。
 * 页面本身只读，不修改任何数据。
 */

const PAGE_SIZES = [20, 50, 100, 200];
const DEFAULT_SIZE = 50;

const FILTER_OPS: FilterOp[] = ["contains", "equals", "neq", "empty", "notEmpty"];

function pick(sp: Record<string, string | string[] | undefined>, key: string): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return (s ?? "").toString();
}

export default async function SheetPage({
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

  const keyword = pick(sp, "q").trim();
  const colRaw = pick(sp, "col").trim();
  const col = colRaw === "" ? null : Number(colRaw);
  const opRaw = pick(sp, "op").trim() as FilterOp;
  const op: FilterOp = FILTER_OPS.includes(opRaw) ? opRaw : "contains";
  const val = pick(sp, "val");
  const sortRaw = pick(sp, "sort").trim();
  const sort = sortRaw === "" ? null : Number(sortRaw);
  const dir = pick(sp, "dir") === "desc" ? "desc" : "asc";
  const sizeRaw = Number(pick(sp, "size"));
  const size = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : DEFAULT_SIZE;
  const page = Math.max(1, Number(pick(sp, "page")) || 1);

  const { columns, rows } = loaded;
  const safeCol = col !== null && Number.isFinite(col) && col >= 0 && col < columns.length ? col : null;
  const safeSort = sort !== null && Number.isFinite(sort) && sort >= 0 && sort < columns.length ? sort : null;

  const matched = sortRows(
    filterRows(rows, { q: keyword, col: safeCol, op, val }),
    safeSort,
    dir
  );
  const pager = paginate(matched, page, size);

  // 敏感列默认在**服务端**打码后再下发（勾选「显示完整信息」时 ?reveal=1 才取完整值）
  const reveal = pick(sp, "reveal") === "1";
  const displayRows = reveal ? pager.slice : maskRows(pager.slice, columns);

  const lastImport = await prisma.sheetRow.findFirst({
    where: { sheet },
    orderBy: { importedAt: "desc" },
    select: { importedAt: true },
  });

  return (
    <div className="mx-auto max-w-[1700px] space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-800">{meta.label}</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            {meta.desc} · {columns.length} 个字段 · {rows.length} 行
            {lastImport ? (
              <span className="ml-2 text-slate-400">
                数据更新时间 {lastImport.importedAt.toLocaleString("zh-CN", { hour12: false })}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/employees/database"
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
          >
            在员工档案里改数据
          </Link>
          <Link
            href={`/sheets/${encodeURIComponent(sheet)}`}
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
          >
            重置条件
          </Link>
        </div>
      </div>

      <SheetDataTable
        sheet={sheet}
        columns={columns}
        rows={displayRows}
        reveal={reveal}
        hasSensitiveColumns={columns.some((c) => c.sensitive)}
        totalRows={rows.length}
        filtered={matched.length}
        page={pager.page}
        pageSize={pager.pageSize}
        totalPages={pager.totalPages}
        query={{ q: keyword, col: colRaw, op, val, sort: sortRaw, dir }}
      />

      <Alert tone="info">
        这里的每一行都来自 Excel「{meta.label}」Sheet 的原始数据（含历史脏值，不做任何自动修改）。
        敏感信息（身份证 / 银行卡 / 电话 / 地址 / 薪资）<strong>在服务端就已打码</strong>，页面源码里也拿不到完整值；
        需要查看时勾选右上角「显示完整信息」。
        要新增 / 修改员工，请到左侧「数据管理」里的员工档案页操作。
      </Alert>
    </div>
  );
}
