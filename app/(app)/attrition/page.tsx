import Link from "next/link";
import { getAttrition, defaultMonth } from "@/lib/attrition-service";
import { Card, Alert } from "@/components/ui";
import MonthPicker from "@/components/attrition/MonthPicker";

export const dynamic = "force-dynamic";

/**
 * /attrition —— 人员流失率（Stage 9.18）
 *
 * 复刻 Excel「人员流失率」Sheet（2026 年门店考核指标数据），10 列：
 *   序号 | 门店名称 | 店长 | 技术店长 | 副店长 | 月初人数 | 当月离职 | 当月入职 | 流失率 | 邀约数量
 *
 * 口径（用户给的公式）：
 *   流失率   =（当月离职人数 − 当月入职人数）/ 月初人数
 *   当月离职 = 当月离职 **且入职满三个月**
 *   当月入职 = 当月入职
 *   月初人数 = 1 号在职人数 **且入职时间满 3 个月**
 *
 * ⚠️ 月初人数（Stage 9.22）：该月有「人工核对快照」就用快照，没有才按公式实时算。
 *   原因见 lib/attrition-service.ts 的说明（库里 273 条档案缺离职日期，公式会少算）。
 *
 * 「店长/技术店长/副店长」是考核指标里的手填姓名（`AttritionIndicator` 表），
 * 「邀约数量」靠这些姓名去招聘面试登记表匹配；其余全部实时统计。
 */

const pct = (v: number | null) => (v === null ? "—" : (v * 100).toFixed(1) + "%");
/** 流失率配色：>0 流失（红）、=0 持平（绿）、<0 净流入（蓝） */
const rateTone = (v: number | null) =>
  v === null ? "text-slate-300" : v > 0 ? "text-rose-600 font-semibold" : v === 0 ? "text-emerald-600" : "text-sky-600 font-semibold";

export default async function AttritionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.month === "string" ? sp.month : defaultMonth();
  // 月份非法时回落到默认月，绝不抛错打断页面
  let month = raw;
  try {
    await getAttrition({ month: raw });
  } catch {
    month = defaultMonth();
  }
  const { rows, summary, monthList } = await getAttrition({ month });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-800">人员流失率</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            2026 年门店考核指标 · 共 {rows.length} 家门店 · 数字随员工资料实时变化
          </p>
        </div>
        <MonthPicker options={monthList} current={month} />
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Card title="月初人数">
          <div className="text-[20px] font-semibold text-slate-800">{summary.monthStartTotal}</div>
          <div className="text-[11.5px] text-slate-400">1 号在职且入职满 3 个月</div>
        </Card>
        <Card title="当月离职">
          <div className="text-[20px] font-semibold text-rose-600">{summary.resignedTotal}</div>
          <div className="text-[11.5px] text-slate-400">且入职满 3 个月</div>
        </Card>
        <Card title="当月入职">
          <div className="text-[20px] font-semibold text-emerald-600">{summary.hiredTotal}</div>
          <div className="text-[11.5px] text-slate-400">入职日期落在当月</div>
        </Card>
        <Card title="整体流失率">
          <div className={`text-[20px] font-semibold ${rateTone(summary.overallRate).split(" ")[0]}`}>
            {pct(summary.overallRate)}
          </div>
          <div className="text-[11.5px] text-slate-400">（离职 − 入职）÷ 月初</div>
        </Card>
        <Card title="有离职门店">
          <div className="text-[20px] font-semibold text-amber-600">{summary.storesWithResign}</div>
          <div className="text-[11.5px] text-slate-400">家</div>
        </Card>
        <Card title="净流失门店">
          <div className="text-[20px] font-semibold text-slate-800">
            {rows.filter((r) => r.role === "STORE_MANAGER" && (r.rate ?? 0) > 0).length}
          </div>
          <div className="text-[11.5px] text-slate-400">家 · 蓝色为净流入</div>
        </Card>
      </div>

      <Alert tone="info">
        <div className="space-y-1">
          <div>
            <strong>流失率 =（当月离职人数 − 当月入职人数）/ 月初人数</strong>。
            <strong>当月离职</strong>只算「当月离职<strong>且入职满 3 个月</strong>」的人
            （刚入职不满 3 个月就走的，不计入流失，避免把试用期离职算成流失）。
          </div>
          <div>
            <strong>「月初人数」是流失率的分母</strong>，口径是「1 号在职<strong>且入职满 3 个月</strong>」。
            {summary.usesSnapshot ? (
              <>
                {" "}
                <strong className="text-brand-700">本月用的是人工核对的数据</strong>
                （{summary.month} 导入的权威值，合计 {summary.monthStartTotal} 人）——
                {" "}因为历史档案里有大量「标记离职却没填离职日期」的记录，
                直接按公式算会少算约 35 人。
              </>
            ) : (
              <>
                {" "}
                <strong className="text-brand-700">本月按公式自动计算</strong>
                （该月没有导入人工数据）—— 每月 1 号自动重算一次，无需手工维护。
              </>
            )}
          </div>
          <div>
            <strong>「店长」与「技术店长」是两种不同的店，职位性质不同</strong>：
            <strong>店长 = 全职店长</strong>；<strong>技术店长 = 由机修晋升的店长</strong>。
            一家店只会填其中一列 —— 看这一列就知道这家店是哪种店（36 家里 21 家店长、13 家技术店长）。
            <strong>「邀约数量」取该行填了名字的那一列</strong>：店长取店长、技术店长行取技术店长。
          </div>
          <div>
            <strong>有副店长的门店会多出一行</strong>，排法与 Excel 一致：
            店名重复、<strong>店长/技术店长列留空</strong>、只在「副店长」列填副店长姓名。
            该行的<strong>人数与流失率和上面店长行完全相同</strong>（都是按门店算的），
            只有<strong>「邀约数量」取副店长本人</strong>当月面试的人数 —— 副店长是独立考核对象。
            合计行的人数只按门店算一次，邀约数量两条都计。
          </div>
          <div>
            <strong>门店之间调动频繁，所以按「统计月 1 号那天他在哪家店」归属</strong>：
            从 A 店调到 B 店帮忙，A 店就减、B 店就加，<strong>不会两边重复计</strong>。
            今后在软件里改员工门店时会自动记下这段任职历史；早于建档的历史数据按当前门店近似。
          </div>
        </div>
      </Alert>

      {summary.topWorst.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          <div className="rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2">
            <div className="mb-1 text-[12px] font-medium text-rose-800">当月流失率最高</div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-slate-700">
              {summary.topWorst.map((t) => (
                <span key={t.storeName}>
                  {t.storeName} <strong className="text-rose-600">{pct(t.rate)}</strong>
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-sky-200 bg-sky-50/50 px-3 py-2">
            <div className="mb-1 text-[12px] font-medium text-sky-800">当月流失率最低（含净流入）</div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-slate-700">
              {summary.topBest.map((t) => (
                <span key={t.storeName}>
                  {t.storeName} <strong className="text-sky-600">{pct(t.rate)}</strong>
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1100px] border-collapse text-[12px]">
          <thead>
            <tr className="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">
              <th className="w-[46px] border-b border-r border-slate-200 px-2 py-1.5 text-center">序号</th>
              <th className="w-[160px] border-b border-r border-slate-200 px-2 py-1.5 text-left">门店名称</th>
              <th className="w-[76px] border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center">店长</th>
              <th className="w-[76px] border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center">技术店长</th>
              <th className="w-[76px] border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center">副店长</th>
              <th className="w-[84px] border-b border-r border-slate-200 bg-sky-50/60 px-2 py-1.5 text-center">月初人数</th>
              <th className="w-[84px] border-b border-r border-slate-200 bg-rose-50/60 px-2 py-1.5 text-center">当月离职</th>
              <th className="w-[84px] border-b border-r border-slate-200 bg-emerald-50/60 px-2 py-1.5 text-center">当月入职</th>
              <th className="w-[90px] border-b border-r border-slate-200 bg-amber-50/60 px-2 py-1.5 text-center">流失率</th>
              <th className="w-[84px] border-b border-slate-200 bg-violet-50/60 px-2 py-1.5 text-center">邀约数量</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sortOrder + "-" + r.storeName + "-" + r.role} className="hover:bg-brand-50/40">
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center text-slate-400">
                  {r.sortOrder}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 font-medium text-slate-700">
                  {r.storeName}
                </td>
                {/* 店长 / 技术店长：两者互斥（用户确认）
                    —— 店长 = 全职店长；技术店长 = 由机修晋升的店长，职位性质不同。
                    一家店只会填其中一列，据此可判断这家店是哪种店。
                    Excel 原文 36 家里 21 家有店长、13 家有技术店长、0 家两者都有。 */}
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center text-slate-600">
                  {r.role === "STORE_MANAGER" ? r.managers.storeManager || "—" : "—"}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center text-slate-600">
                  {r.role === "STORE_MANAGER" ? r.managers.techManager || "—" : "—"}
                </td>
                {/* 副店长：只在本行是「副店长行」时显示（同 Excel） */}
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center text-slate-600">
                  {r.role === "DEPUTY_MANAGER" ? r.managers.deputyManager || "—" : "—"}
                </td>
                {/* 月初人数（流失率的分母）。
                    SNAPSHOT = 该月用了人工核对的权威值；COMPUTED = 按公式实时算。
                    视觉上不加任何标记（保持表格干净），来源在页面上方说明里讲。 */}
                <td
                  className="border-b border-r border-slate-100 px-2 py-1.5 text-center font-semibold text-slate-800"
                  title={r.headcountSource === "SNAPSHOT" ? "该月使用人工核对的月初人数" : "按公式自动计算：1 号在职且入职满 3 个月"}
                >
                  {r.monthStartHeadcount}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center">
                  {r.monthResigned > 0 ? (
                    <span className="font-semibold text-rose-600">{r.monthResigned}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center">
                  {r.monthHired > 0 ? (
                    <span className="font-semibold text-emerald-600">{r.monthHired}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center">
                  <span className={rateTone(r.rate)}>{pct(r.rate)}</span>
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">
                  {r.invites > 0 ? r.invites : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            ))}

            {/* 合计行 */}
            <tr className="bg-[#f7f9fc] font-semibold text-slate-800">
              <td className="border-t-2 border-r border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-r border-slate-300 px-2 py-2">所有门店合计</td>
              <td className="border-t-2 border-r border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-r border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-r border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-r border-slate-300 px-2 py-2 text-center">
                {summary.monthStartTotal}
              </td>
              <td className="border-t-2 border-r border-slate-300 px-2 py-2 text-center text-rose-600">
                {summary.resignedTotal}
              </td>
              <td className="border-t-2 border-r border-slate-300 px-2 py-2 text-center text-emerald-600">
                {summary.hiredTotal}
              </td>
              <td className={`border-t-2 border-r border-slate-300 px-2 py-2 text-center ${rateTone(summary.overallRate)}`}>
                {pct(summary.overallRate)}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {summary.invitesTotal}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] leading-relaxed text-slate-400">
        口径说明：全部数字从「在职 / 离职」实时统计，不落库 —— 员工一入职、离职、调岗，这里立刻变。
        「入职满 3 个月」按<strong>自然月加法</strong>判定（入职日 + 3 个自然月 ≤ 统计月 1 号）。
        ⚠️ 此口径比 Excel 更准确：Excel 靠解析「在职年限」文本列（如「3年2个月」）判断，
        而那个文本列是<strong>算到今天</strong>的时长，会把「8 月才入职、但到 9 月已满 3 个月」的人
        错误计入 8 月的月初人数。        负数流失率表示当月净流入。
        <strong>店长与技术店长互斥</strong>：店长 = 全职店长，技术店长 = 由机修晋升的店长，
        职位性质不同，一家店只填其中一列；「邀约数量」取该行填了名字的那一列
        （Excel 公式逐行核对：店长行 <code className="rounded bg-slate-100 px-1">$C</code>、
        技术店长行 <code className="rounded bg-slate-100 px-1">$D</code>、
        副店长行 <code className="rounded bg-slate-100 px-1">$E</code>）。
        需要改管理者姓名请到 <Link href="/settings/stores" className="text-brand-600 underline">基础设置</Link> 维护。
      </p>
    </div>
  );
}
