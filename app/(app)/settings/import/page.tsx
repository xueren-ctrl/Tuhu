import Link from "next/link";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import ExportExcelButton from "@/components/export/ExportExcelButton";

export const dynamic = "force-dynamic";

/** 极简 Markdown 渲染（仅覆盖报告实际用到的语法：标题/表格/列表/加粗/行内代码/引用） */
function renderInline(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-[11.5px]">$1</code>');
}

function Markdown({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr className="text-left text-[11.5px] text-slate-500">
                {header.map((h, hi) => (
                  <th key={hi} className="px-2.5 py-2 font-medium" dangerouslySetInnerHTML={{ __html: renderInline(h) }} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="text-[12px]">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 align-top" dangerouslySetInnerHTML={{ __html: renderInline(c) }} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls =
        level === 1
          ? "mt-5 mb-2 text-[17px] font-semibold"
          : level === 2
            ? "mt-5 mb-2 border-b border-[var(--hr-border)] pb-1.5 text-[15px] font-semibold"
            : "mt-4 mb-1.5 text-[13.5px] font-semibold text-slate-700";
      out.push(<div key={key++} className={cls} dangerouslySetInnerHTML={{ __html: renderInline(h[2]) }} />);
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="my-2 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-600">
          {items.map((it, ii) => (
            <li key={ii} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={key++} className="my-2 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-600">
          {items.map((it, ii) => (
            <li key={ii} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
          ))}
        </ol>
      );
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      out.push(
        <blockquote
          key={key++}
          className="my-2 border-l-2 border-brand-300 bg-brand-50/50 px-3 py-2 text-[12.5px] text-slate-600"
          dangerouslySetInnerHTML={{ __html: renderInline(line.replace(/^>\s?/, "")) }}
        />
      );
      i++;
      continue;
    }

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }

    out.push(
      <p
        key={key++}
        className="my-1.5 text-[12.5px] leading-relaxed text-slate-600"
        dangerouslySetInnerHTML={{ __html: renderInline(line) }}
      />
    );
    i++;
  }

  return <div>{out}</div>;
}

/** /settings/import 导入与报告 */
export default async function ImportReportPage() {
  const docPath = path.join(process.cwd(), "docs", "import-report.md");
  let markdown = "";
  let readError = "";
  try {
    markdown = await readFile(docPath, "utf8");
  } catch {
    readError = `未找到 ${docPath}，请先执行 npm run import:excel 生成导入报告。`;
  }

  const batches = await prisma.importBatch.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
    include: { _count: { select: { issues: true } } },
  });

  const issueStats = await prisma.importIssue.groupBy({
    by: ["issueType"],
    _count: { _all: true },
    orderBy: { _count: { issueType: "desc" } },
  });

  return (
    <div className="mx-auto max-w-[1300px] space-y-4">
      <Alert tone="info">
        本页内容来自 <code>docs/import-report.md</code>（由导入脚本自动生成）与数据库中的导入批次记录。
        原始 Excel 文件位于项目根目录，程序<strong>只读</strong>，绝不写入或覆盖。
      </Alert>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-[760px]">
            <div className="text-[14px] font-medium text-slate-800">导出 Excel</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
              下载的文件<strong>以你原始那份 Excel 为底模</strong>，但里面是<strong>纯数据、一个公式都没有</strong> ——
              表头位置、列顺序、合并单元格、样式原样保留，数据全部换成点击那一刻软件里的最新值。
              用手机打开、微信传给别人都能直接看数值，不会因为公式重算出别的结果。
            </p>
            <ul className="mt-2 space-y-1 text-[12px] text-slate-500">
              <li>· 共 12 个 Sheet：在职 / 离职 / 南昌3店 / 运营部 / 运营部离职 / 招聘面试登记表 / 薪资表 / 数据库 / 门店人员编制 / 社保总名单 / 人员流失率 / 门店人员分布明细</li>
              <li>· <strong>原文件 <code>途虎HR人员登记.xlsx</code> 只读</strong>，导出永远是生成一份新文件，绝不覆盖</li>
              <li>· <strong>0 公式、纯数值</strong>：原表里「在职」等表的列是 <code>XLOOKUP</code> 公式（靠姓名+入职日期去「数据库」表取值），很容易因为日期格式对不上而显示「没找到」；导出会把这些公式全部替换成算好的数值，全表不会出现「没找到」</li>
              <li>· <strong>12 个 Sheet 全部是实时数据</strong>：人员流失率、门店人员分布明细、门店人员编制用的是软件里同一套计算服务，你在网页上看到的数字与导出文件逐格一致；招聘面试登记表（478 人）、薪资表（290 人）沿用 Excel 原始名单，并把已建档人员的最新档案数据写回</li>
              <li>· 库里有值才写；本来没填的（如没交简历表）保持空白，不会凭空造数据</li>
            </ul>
          </div>
          <ExportExcelButton />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="导入批次历史（来自数据库）" bodyClassName="p-0">
          {batches.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-slate-400">
              数据库中还没有导入批次记录
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr className="text-left text-[11.5px] text-slate-500">
                    <th className="px-4 py-2.5 font-medium">批次号</th>
                    <th className="px-3 py-2.5 font-medium">扫描行</th>
                    <th className="px-3 py-2.5 font-medium">新增</th>
                    <th className="px-3 py-2.5 font-medium">更新</th>
                    <th className="px-3 py-2.5 font-medium">重复</th>
                    <th className="px-3 py-2.5 font-medium">异常</th>
                    <th className="px-3 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">完成时间</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="text-[12.5px]">
                      <td className="px-4 py-2 font-mono text-[11px] text-slate-600">
                        {b.id}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{b.totalRows}</td>
                      <td className="px-3 py-2 tabular-nums text-emerald-700">
                        {b.inserted}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-brand-700">{b.updated}</td>
                      <td className="px-3 py-2 tabular-nums text-amber-700">{b.duplicated}</td>
                      <td className="px-3 py-2 tabular-nums text-red-600">
                        {b._count.issues}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={
                            b.status === "SUCCESS"
                              ? "green"
                              : b.status === "PARTIAL"
                                ? "amber"
                                : b.status === "RUNNING"
                                  ? "blue"
                                  : "red"
                          }
                        >
                          {b.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-[11.5px] text-slate-500">
                        {formatDateTime(b.finishedAt) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="异常分类统计（来自数据库）">
          {issueStats.length === 0 ? (
            <p className="text-[12.5px] text-slate-400">暂无异常记录</p>
          ) : (
            <ul className="space-y-2 text-[12.5px]">
              {issueStats.map((s) => (
                <li key={s.issueType} className="flex items-center justify-between gap-3">
                  <code className="text-[11.5px] text-slate-600">{s.issueType}</code>
                  <span className="font-medium tabular-nums">{s._count._all}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-[var(--hr-border)] pt-3 text-[11.5px] leading-relaxed text-slate-400">
            异常明细全部落库在 <code>ImportIssue</code> 表，可在 prisma studio 中逐条查看。
            任何异常都不会被静默处理。
          </div>
        </Card>
      </div>

      <Card
        title="导入报告 import-report.md"
        extra={
          <Link href="/employees">
            <Button size="sm">前往员工档案</Button>
          </Link>
        }
      >
        {readError ? (
          <Alert tone="warn">{readError}</Alert>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <Markdown source={markdown} />
          </div>
        )}
      </Card>
    </div>
  );
}
