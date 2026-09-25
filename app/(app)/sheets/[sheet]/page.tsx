import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /sheets/[sheet] —— Excel 某张 Sheet 的原样镜像
 *
 * 数据来自 SheetRow（导入时从 Excel 原样抓取，公式取缓存结果、日期格式化为 YYYY-MM-DD），
 * 列名与顺序严格按 Excel 的表头，不做任何加工 —— 用户在软件里看到的就是 Excel 里的样子。
 */

const PAGE_SIZE = 100;

/** 支持的 Sheet（与导入脚本一致）+ 中文名 */
const SHEETS: Record<string, { label: string; desc: string }> = {
  在职: { label: "在职", desc: "各门店在职人员统计汇总明细表" },
  离职: { label: "离职", desc: "离职人员登记表" },
  南昌3店: { label: "南昌3店", desc: "南昌抚河中路店 / 南昌崇仁人民大道店 / 抚州乐安新二中店" },
  运营部: { label: "运营部", desc: "公司管理层（非门店人员）" },
  招聘面试登记表: { label: "招聘面试登记表", desc: "2026 年招聘面试登记" },
  运营部离职: { label: "运营部离职", desc: "运营部离职人员" },
  薪资表: { label: "薪资表", desc: "薪资待遇与首月保障登记" },
  数据库: { label: "数据库", desc: "全部历史数据（所有 Sheet 的来源）" },
};

export default async function SheetMirrorPage({
  params,
  searchParams,
}: {
  params: Promise<{ sheet: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sheet: rawSheet } = await params;
  const sheet = decodeURIComponent(rawSheet);
  const sp = await searchParams;

  if (!SHEETS[sheet]) notFound();
  const meta = SHEETS[sheet];

  const keyword = (Array.isArray(sp.keyword) ? sp.keyword[0] : sp.keyword)?.trim() ?? "";
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);

  // 取表头（每行都存了一份，取第一行即可）
  const first = await prisma.sheetRow.findFirst({
    where: { sheet },
    orderBy: { rowNo: "asc" },
    select: { headersJson: true },
  });
  if (!first) notFound();
  const headers: string[] = JSON.parse(first.headersJson);

  // 关键词过滤：在服务端按整行 JSON 文本匹配
  const where = keyword ? { sheet, cellsJson: { contains: keyword } } : { sheet };
  const total = await prisma.sheetRow.count({ where });
  const rows = await prisma.sheetRow.findMany({
    where,
    orderBy: { rowNo: "asc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: { id: true, rowNo: true, cellsJson: true },
  });

  const data = rows.map((r) => ({
    id: r.id,
    rowNo: r.rowNo,
    cells: JSON.parse(r.cellsJson) as string[],
  }));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (over: Record<string, string | number>) => {
    const u = new URLSearchParams();
    if (keyword) u.set("keyword", keyword);
    for (const [k, v] of Object.entries(over)) u.set(k, String(v));
    return `/sheets/${encodeURIComponent(sheet)}?${u.toString()}`;
  };

  return (
    <div className="mx-auto max-w-[1900px] px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[17px] font-semibold text-slate-800">{meta.label}</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {meta.desc} · 共 <strong className="text-slate-700">{total}</strong> 行
            {keyword ? `（筛选「${keyword}」）` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form action={`/sheets/${encodeURIComponent(sheet)}`} method="get" className="flex items-center gap-1.5">
            <input
              type="text"
              name="keyword"
              defaultValue={keyword}
              placeholder="搜索这一页的内容…"
              className="h-8 w-56 rounded-md border border-[var(--hr-border)] px-2.5 text-[12.5px] outline-none focus:border-brand-500"
            />
            <button
              type="submit"
              className="h-8 rounded-md bg-brand-600 px-3 text-[12.5px] font-medium text-white hover:bg-brand-700"
            >
              搜索
            </button>
            {keyword ? (
              <Link
                href={`/sheets/${encodeURIComponent(sheet)}`}
                className="h-8 rounded-md border border-[var(--hr-border)] px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
              >
                清除
              </Link>
            ) : null}
          </form>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-slate-50 text-left text-[11.5px] font-medium text-slate-500">
                <th className="sticky left-0 z-10 border-b border-[var(--hr-border)] bg-slate-50 px-2 py-2 text-center">
                  #
                </th>
                {headers.map((h, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap border-b border-[var(--hr-border)] px-3 py-2"
                    title={h || `第 ${i + 1} 列（Excel 中无表头）`}
                  >
                    {h || <span className="text-slate-300">—</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.length === 0 ? (
                <tr>
                  <td colSpan={headers.length + 1} className="px-4 py-16 text-center text-[13px] text-slate-400">
                    {keyword ? "没有匹配的行" : "这张表还没有数据"}
                  </td>
                </tr>
              ) : (
                data.map((row, ri) => (
                  <tr key={row.id} className="hover:bg-brand-50/40">
                    <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-2 py-1.5 text-center font-mono text-[11px] text-slate-400">
                      {(page - 1) * PAGE_SIZE + ri + 1}
                    </td>
                    {row.cells.map((c, ci) => (
                      <td
                        key={ci}
                        className="whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-700"
                        title={c}
                      >
                        {c || <span className="text-slate-200">·</span>}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between text-[12.5px] text-slate-500">
          <div>
            第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 行
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={qs({ page: page - 1 })}
                className="rounded-md border border-[var(--hr-border)] px-3 py-1 hover:bg-slate-50"
              >
                上一页
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={qs({ page: page + 1 })}
                className="rounded-md border border-[var(--hr-border)] px-3 py-1 hover:bg-slate-50"
              >
                下一页
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 text-[11.5px] leading-relaxed text-slate-400">
        本页内容为 Excel 原样镜像（公式取计算结果、日期按 YYYY-MM-DD 显示），列名与顺序与 Excel 完全一致。
        如需按员工编号 / 门店等条件检索并修改，请使用左侧「数据管理」里的对应页面。
      </div>
    </div>
  );
}
