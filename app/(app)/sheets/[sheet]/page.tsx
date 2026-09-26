import { notFound } from "next/navigation";
import Link from "next/link";
import { loadEmployeeSheet, type SheetRowData } from "@/lib/employee-sheet-service";
import { parseSheetQuery, prepareSheetRows } from "@/lib/sheet-page-helpers";
import { EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";
import { SHEET_COLUMNS, SHEET_LABEL, sheetBase, statusesForSheet } from "@/lib/sheet-fields";
import SheetDataTable from "@/components/sheets/SheetDataTable";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /sheets/[sheet] —— 员工表（由员工数据实时生成，可增删改）
 *
 * 这张表里显示谁，完全由**员工状态**决定（lib/sheet-fields.ts 的 STATUS_SHEETS）：
 *   已入职 → 在职 / 招聘面试登记表 / 薪资表；离职 → 离职 / 招聘面试登记表 / 薪资表；
 *   南昌3店、运营部、运营部离职 各自成表 + 招聘面试登记表 + 薪资表；
 *   已面试 → 只进招聘面试登记表；候选中 → 哪都不出现；「数据库」= 全部员工。
 *
 * 因此：新增员工会立刻出现在对应表里；改状态会让他「搬家」；删除（停用）会立刻消失。
 */

export default async function EmployeeSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ sheet: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sheet: rawSheet } = await params;
  const sheet = decodeURIComponent(rawSheet);
  if (!SHEET_COLUMNS[sheet as keyof typeof SHEET_COLUMNS]) notFound();

  const sp = await searchParams;
  const loaded = await loadEmployeeSheet(sheet);
  if (!loaded) notFound();

  const label = SHEET_LABEL[sheet] ?? sheet;
  const statuses = statusesForSheet(sheet);
  const base = sheetBase(sheet);

  const q = parseSheetQuery(sp, loaded.columns.length);
  const prepared = prepareSheetRows(loaded.rows as SheetRowData[], loaded.columns, q);

  return (
    <div className="mx-auto max-w-[1700px] space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-800">{label}</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            {loaded.columns.length} 个字段 · {loaded.rows.length} 人
            {base === "excel" ? (
              <span className="ml-2 text-slate-400">
                （Excel 原始名单 {loaded.origin.excel} 人 + 软件新增 {loaded.origin.employee} 人）
              </span>
            ) : statuses === null ? (
              <span className="ml-2 text-slate-400">（全部员工，不受状态限制）</span>
            ) : (
              <span className="ml-2 text-slate-400">
                （包含状态：
                {statuses.map((s) => EMPLOYEE_STATUS_LABEL[s] ?? s).join(" / ")}）
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/employees/new"
            className="h-8 rounded-md bg-brand-600 px-3 text-[12.5px] leading-8 text-white hover:bg-brand-700"
          >
            ＋ 新增员工
          </Link>
          <Link
            href="/employees/status"
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-700 hover:bg-slate-50"
          >
            更改员工状态
          </Link>
          <Link
            href={`/excel/${encodeURIComponent(sheet)}`}
            className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-500 hover:bg-slate-50"
          >
            Excel 原始留档
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
        sheet={`emp:${sheet}`}
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
        rowLinkBase="/employees"
      />

      <Alert tone="info">
        <div className="space-y-1">
          {base === "excel" ? (
            <>
              <div>
                这张表<strong>以导入时的 Excel 原始名单为准</strong>（{loaded.origin.excel} 人，与你原来的表人数一致），
                后面追加的是<strong>在软件里新增的员工</strong>（当前 {loaded.origin.employee} 人）——
                历史上缺失的面试 / 薪资数据<strong>不做回补</strong>。
              </div>
              <div className="text-slate-600">
                新增员工按状态进入本表：当前状态
                {statuses?.length
                  ? `为「${statuses.map((s) => EMPLOYEE_STATUS_LABEL[s] ?? s).join(" / ")}」时会出现在这里`
                  : "为「候选中」时不出现在本表"}
                。原始名单行的「状态」列留空（Excel 里没有这个概念）。
              </div>
            </>
          ) : (
            <>
              <div>
                这张表由<strong>员工数据实时生成</strong>：点任意一行可看全部字段，并可从抽屉里打开该员工的完整档案修改资料。
                状态决定一个人出现在哪些表 —— 当前包含：{" "}
                <strong>
                  {statuses === null
                    ? "全部员工（含候选中）"
                    : statuses.map((s) => EMPLOYEE_STATUS_LABEL[s] ?? s).join(" / ")}
                </strong>
                。
              </div>
              <div className="text-slate-600">
                状态与表的对应关系：
                {EMPLOYEE_STATUS_OPTIONS.map((o) => `${o.label} → ${o.hint}`).join("；")}。
              </div>
            </>
          )}
          <div className="text-slate-600">
            「状态」列是系统加的（Excel 里没有），不需要时可在右上角「列」里把它隐藏。
            敏感信息（身份证 / 银行卡 / 电话 / 地址 / 薪资）在<strong>服务端就已打码</strong>；
            要看完整值请勾选右上角「显示完整信息」。
          </div>
        </div>
      </Alert>
    </div>
  );
}
