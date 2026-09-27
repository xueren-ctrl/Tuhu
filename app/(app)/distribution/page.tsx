import { getDistribution, DISTRIBUTION_GRADES } from "@/lib/distribution-service";
import { Card, Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /distribution —— 门店人员分布明细（Stage 9.23）
 *
 * 复刻 Excel「门店人员分布明细」Sheet，10 列：
 *   序号 | 门店 | 门店人数 | 店长 | 副店长 | 技术店长 | 客服经理 | 后勤 | 机修 | 美容
 *
 * 7 个工种列各用「、」拼接该店该工种的全部在职人名。
 * **全部实时统计** —— 员工入职/离职/调店/改工种，这里立刻变。
 *
 * 门店名单与顺序取自编制表（与 Excel 分布明细表完全一致）。
 */

/** 人名单元格：无人显示「—」（与 Excel 的 TEXTJOIN 空结果一致） */
const Names = ({ list }: { list: string[] }) =>
  list.length === 0 ? (
    <span className="text-slate-300">—</span>
  ) : (
    <span className="text-slate-700">{list.join("、")}</span>
  );

export default async function DistributionPage() {
  const { rows, summary } = await getDistribution();

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[18px] font-semibold text-slate-800">门店人员分布明细</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          共 {summary.storeCount} 家门店 · 在职 {summary.headcountTotal} 人 · 人名按工种实时统计
        </p>
      </div>

      {/* 顶部速览：7 个工种各有多少人 */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        {DISTRIBUTION_GRADES.map((g) => (
          <Card key={g.key} title={g.label}>
            <div className="text-[20px] font-semibold text-slate-800">{summary.gradeTotals[g.key]}</div>
            <div className="truncate text-[11.5px] text-slate-400" title={summary.topByGrade.find((t) => t.key === g.key)?.stores.map((s) => s.storeName).join("、") || "—"}>
              {summary.topByGrade.find((t) => t.key === g.key)?.stores
                .map((s) => `${s.storeName.slice(0, 4)} ${s.count}`)
                .join(" · ") || "—"}
            </div>
          </Card>
        ))}
      </div>

      <Alert tone="info">
        <div className="space-y-1">
          <div>
            <strong>人名是实时统计的</strong>：直接来自「在职」表按「门店 + 工种」分组，
            员工一入职、一离职、一调店、一改工种，这里立刻变，不需要刷新或重新导入。
            各工种的人名用「、」连接，与 Excel 原文（<code className="rounded bg-slate-100 px-1">TEXTJOIN("、",…)</code>）一致。
          </div>
          <div>
            <strong>工种严格按「工种」字段原文匹配</strong>：店长含「代理店长」；
            「机修」列<strong>只含机修</strong>、不含技术店长
            （与「门店人员编制」表的机修口径不同，那里技术店长算在机修里）。
            无人时显示「—」。
          </div>
        </div>
      </Alert>

      {summary.uncoveredGrades.length > 0 && (
        <Alert tone="warn">
          <strong>有 {summary.uncoveredGrades.length} 种工种不在 7 个列里</strong>：
          {summary.uncoveredGrades.map((g) => `${g.grade}（${g.count} 人）`).join("、")}
          。这些人的门店人数会计入「门店人数」列，但不会出现在任何工种列里。
        </Alert>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1100px] border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">
              <th className="w-[46px] border-b border-r border-slate-200 px-2 py-1.5 text-center">序号</th>
              <th className="w-[150px] border-b border-r border-slate-200 px-2 py-1.5 text-left">门店</th>
              <th className="w-[64px] border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center">门店人数</th>
              {DISTRIBUTION_GRADES.map((g) => (
                <th
                  key={g.key}
                  className="border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center"
                >
                  {g.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.storeName} className="align-top hover:bg-brand-50/40">
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center text-slate-400">
                  {r.sortOrder}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 font-medium text-slate-700">
                  {r.storeName}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center font-semibold text-slate-800">
                  {r.headcount}
                </td>
                {DISTRIBUTION_GRADES.map((g) => (
                  <td
                    key={g.key}
                    className="border-b border-r border-slate-100 px-2 py-1.5 leading-relaxed"
                  >
                    <Names list={r.people[g.key]} />
                  </td>
                ))}
              </tr>
            ))}
            {/* 合计行 */}
            <tr className="bg-[#f7f9fc] text-[12px] font-semibold text-slate-700">
              <td className="border-t-2 border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">所有门店合计</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">
                {summary.headcountTotal}
              </td>
              {DISTRIBUTION_GRADES.map((g) => (
                <td key={g.key} className="border-t-2 border-slate-300 px-2 py-2 text-center">
                  {summary.gradeTotals[g.key]}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] leading-relaxed text-slate-400">
        口径说明：门店名单与顺序取自「门店人员编制」（与 Excel 分布明细表 36 家完全一致）。
        全部数字与人名从「在职」表实时统计，不落库 —— 员工一入职、离职、调岗，这里立刻变。
        合计行的人数按门店求和；各工种列的合计可能小于总人数
        （若库中存在 7 列覆盖不到的工种，页面会在上方黄条里列出来）。
      </p>
    </div>
  );
}
