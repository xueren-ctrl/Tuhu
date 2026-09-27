import { getStoreHeadcount } from "@/lib/headcount-service";
import { Card, Alert } from "@/components/ui";
import HeadcountPlanEditor from "@/components/headcount/HeadcountPlanEditor";
import HeadcountFullCell from "@/components/headcount/HeadcountFullCell";

export const dynamic = "force-dynamic";

/**
 * /headcount —— 门店人员编制（Stage 9.14）
 *
 * 复刻 Excel「门店人员编制」Sheet 的三层表头结构：
 *
 *   |            | 各门店现有总人数       | 满编配制人数     | 美容配制人数     | 美容现有人数   | 缺编汇总 | 各职位缺编明细/人数      | 具体缺编明细 |
 *   | 序号 | 门店 | 店长 | 技术店长 | … | 当前合计 | 客服经理满编 | … | 缺编 | 机修 | 美容 | 客服经理 | 文字说明 |
 *
 * 「现有」全部实时统计自「在职」表；「满编」是人工维护的目标值，可行内调整。
 */

/**
 * 表头 HTML（原生小写 colspan / rowspan —— 原因见页面里 dangerouslySetInnerHTML 处的注释）。
 * 字段顺序与 Excel「门店人员编制」Sheet 第 3 行逐列一致。
 */
const HEAD_FIELDS = [
  "店长",
  "技术店长",
  "副店长",
  "客服经理",
  "机修现有",
  "美容现有",
  "后勤",
  "当前合计人数",
  "客服经理满编",
  "机修满编",
  "美容满编",
  "美容师傅满编",
  "美容中小工满编",
  "现有美容师傅",
  "现有美容中小工",
  "机修",
  "美容",
  "客服经理",
] as const;

/** 分组配色：现有=蓝、满编=靛、美容配制=紫、美容现有=琥珀、缺编=红 */
const HEAD_TINT = (i: number) =>
  i < 8 ? "bg-sky-50/60" : i < 11 ? "bg-indigo-50/60" : i < 13 ? "bg-violet-50/60" : i < 15 ? "bg-amber-50/60" : "bg-rose-50/60";

const HEAD_HTML =
  [
    '<tr class="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">',
    '<th rowspan="2" class="sticky left-0 z-20 w-[46px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">序号</th>',
    '<th rowspan="2" class="sticky left-[46px] z-20 w-[150px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">名称</th>',
    '<th colspan="8" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">各门店现有总人数</th>',
    '<th colspan="3" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">满编配制人数</th>',
    '<th colspan="2" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">美容配制人数</th>',
    '<th colspan="2" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">美容现有人数</th>',
    '<th rowspan="2" class="w-[58px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">缺编</th>',
    '<th colspan="3" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">各职位缺编明细/人数</th>',
    '<th rowspan="2" class="border-b border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">具体缺编明细</th>',
    "</tr>",
    '<tr class="bg-[#f7f9fc] text-[11.5px] text-slate-600">',
    HEAD_FIELDS.map((h, i) => `<th class="border-b border-r border-slate-200 px-2 py-1.5 text-center ${HEAD_TINT(i)}">${h}</th>`).join(""),
    "</tr>",
  ].join("");

/** 缺编用颜色标出：>0 缺人（红）、=0 刚好（绿）、<0 超编（蓝，显示负数） */
const gapTone = (n: number) =>
  n > 0 ? "text-rose-600 font-semibold" : n === 0 ? "text-emerald-600" : "text-sky-600 font-semibold";
/**
 * 缺编明细单元格：Excel 原样显示负数（超编），不再一律打「—」。
 * 0 显示 0，负数显示 -N。
 */
const gapCell = (n: number) => <span className={gapTone(n)}>{n}</span>;

export default async function HeadcountPage() {
  const { rows, summary } = await getStoreHeadcount();

  const totals = rows.reduce(
    (acc, r) => {
      acc.manager += r.current.manager;
      acc.techManager += r.current.techManager;
      acc.deputyManager += r.current.deputyManager;
      acc.serviceManager += r.current.serviceManager;
      acc.mechanic += r.current.mechanic;
      acc.beauty += r.current.beauty;
      acc.logistics += r.current.logistics;
      acc.beautyMaster += r.current.beautyMaster;
      acc.beautyJunior += r.current.beautyJunior;
      return acc;
    },
    {
      manager: 0,
      techManager: 0,
      deputyManager: 0,
      serviceManager: 0,
      mechanic: 0,
      beauty: 0,
      logistics: 0,
      beautyMaster: 0,
      beautyJunior: 0,
    }
  );

  const fullTotals = rows.reduce(
    (acc, r) => {
      acc.serviceManager += r.full.serviceManager ?? 0;
      acc.mechanic += r.full.mechanic ?? 0;
      acc.beauty += r.full.beauty ?? 0;
      acc.beautyMaster += r.full.beautyMaster ?? 0;
      acc.beautyJunior += r.full.beautyJunior ?? 0;
      return acc;
    },
    { serviceManager: 0, mechanic: 0, beauty: 0, beautyMaster: 0, beautyJunior: 0 }
  );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[18px] font-semibold text-slate-800">门店人员编制</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          2026 年各店人员编制及预算 · 共 {summary.stores} 家门店
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Card title="在编人数">
          <div className="text-[20px] font-semibold text-slate-800">
            {totals.manager + totals.deputyManager + totals.serviceManager + totals.mechanic + totals.beauty + totals.logistics}
          </div>
          <div className="text-[11.5px] text-slate-400">实时统计自「在职」表</div>
        </Card>
        <Card title="满编目标合计">
          <div className="text-[20px] font-semibold text-slate-800">{summary.fullTotal}</div>
          <div className="text-[11.5px] text-slate-400">客服+机修+美容，人工设定</div>
        </Card>
        <Card title="缺编合计">
          <div className="text-[20px] font-semibold text-rose-600">{summary.gapTotal}</div>
          <div className="text-[11.5px] text-slate-400">人</div>
        </Card>
        <Card title="有缺编门店">
          <div className="text-[20px] font-semibold text-amber-600">{summary.storesWithGap}</div>
          <div className="text-[11.5px] text-slate-400">家</div>
        </Card>
        <Card title="满编门店">
          <div className="text-[20px] font-semibold text-emerald-600">{summary.storesFull}</div>
          <div className="text-[11.5px] text-slate-400">家</div>
        </Card>
        <Card title="美容 / 机修">
          <div className="text-[20px] font-semibold text-slate-800">
            {totals.beauty} / {totals.mechanic}
          </div>
          <div className="text-[11.5px] text-slate-400">现有人数</div>
        </Card>
      </div>

      <Alert tone="info">
        <div className="space-y-1">
          <div>
            <strong className="text-amber-700">满编配制人数 = 你自己设定的目标</strong>：
            带虚线下划线的数字<strong>直接点击就能改</strong>（点任意一格，5 项一起编辑、一起保存）。
            经营调整随时改，改完立即重算缺编。留空 = 该职位不设满编、不参与缺编计算。
          </div>
          <div>
            <strong>「现有」列是实时算出来的</strong>：直接来自「在职」表按「门店 + 工种」统计，
            员工一入职、一离职、一调岗，这里立刻变，不需要刷新或重新导入。
          </div>
        </div>
      </Alert>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1500px] border-collapse text-[12px]">
          {/**
           * 第 1 层：分组表头 —— 用原生 HTML 字符串注入，**不能**写成 <th colSpan={8}>。
           *
           * ⚠️ 踩坑记录（Stage 9.14.1，定位耗时很长，务必记住）：
           *   React 会把 colSpan / rowSpan 规范化成**大写属性**输出到 HTML
           *   （<th colSpan="8">），而 HTML 规范只认**小写** colspan / rowspan。
           *   浏览器忽略未知的大写属性 → 每个 th 被当成 1 列 →
           *   表头只还原出 18 列，而表体有 22 个 <td> → **整张表整体错位**，
           *   表现就是「客服经理」列下面显示的竟是「具体缺编明细」。
           *
           *   试过且**无效**的写法：<th {...{ colSpan: 8 }}>（展开小写键同样被规范化）。
           *   只有直接注入原生小写属性的 HTML 才有效。
           *
           * 列数核算（与 Excel 严格一致，共 22 列）：
           *   1 序号 + 1 名称 + 8 各门店现有总人数 + 3 满编配制 + 2 美容配制
           *   + 2 美容现有 + 1 缺编 + 3 各职位缺编 + 1 具体缺编 = 22 ✓
           *   （「当前合计人数」归属「各门店现有总人数」组，故该组 colSpan=8）
           */}
          <thead dangerouslySetInnerHTML={{ __html: HEAD_HTML }} />
          <tbody>
            {rows.map((r) => (
              <tr key={r.storeId} className="hover:bg-brand-50/40">
                <td className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-2 py-1.5 text-center text-slate-400">
                  {r.sortOrder}
                </td>
                <td className="sticky left-[46px] z-10 border-b border-r border-slate-100 bg-white px-2 py-1.5 font-medium text-slate-700">
                  <HeadcountPlanEditor storeId={r.storeId} row={r} />
                </td>
                {/* 现有 */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.manager || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.techManager || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.deputyManager || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.serviceManager || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.mechanic || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.beauty || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">{r.current.logistics || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center font-semibold text-slate-800">
                  {r.current.total}
                </td>
                {/* 满编（人工设置：数字本身即入口，点击就地编辑） */}
                <td className="border-b border-slate-100 px-1 py-1.5">
                  <HeadcountFullCell storeId={r.storeId} row={r} field="serviceManagerFull" />
                </td>
                <td className="border-b border-slate-100 px-1 py-1.5">
                  <HeadcountFullCell storeId={r.storeId} row={r} field="mechanicFull" />
                </td>
                <td className="border-b border-slate-100 px-1 py-1.5">
                  <HeadcountFullCell storeId={r.storeId} row={r} field="beautyFull" />
                </td>
                <td className="border-b border-slate-100 px-1 py-1.5">
                  <HeadcountFullCell storeId={r.storeId} row={r} field="beautyMasterFull" />
                </td>
                <td className="border-b border-slate-100 px-1 py-1.5">
                  <HeadcountFullCell storeId={r.storeId} row={r} field="beautyJuniorFull" />
                </td>
                {/* 美容现有 */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{r.current.beautyMaster || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{r.current.beautyJunior || "—"}</td>
                {/* 缺编汇总 */}
                <td className={`border-b border-slate-100 px-2 py-1.5 text-center ${gapTone(r.gap.total)}`}>
                  {r.gap.total}
                </td>
                {/* 各职位缺编（可为负 = 超编，与 Excel 一致） */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  {gapCell(r.gap.mechanic)}
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  {gapCell(r.gap.beauty)}
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  {gapCell(r.gap.serviceManager)}
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-slate-600">{r.gap.detail || "—"}</td>
              </tr>
            ))}

            {/* 合计行 */}
            <tr className="bg-[#f7f9fc] font-semibold text-slate-800">
              <td className="sticky left-0 z-10 border-t-2 border-r border-slate-300 bg-[#f7f9fc] px-2 py-2" />
              <td className="sticky left-[46px] z-10 border-t-2 border-r border-slate-300 bg-[#f7f9fc] px-2 py-2">
                所有店铺合计
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.manager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.techManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.deputyManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.serviceManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.mechanic}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beauty}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.logistics}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center font-semibold text-slate-800">
                {totals.manager + totals.deputyManager + totals.serviceManager + totals.mechanic + totals.beauty + totals.logistics}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {fullTotals.serviceManager}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {fullTotals.mechanic}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {fullTotals.beauty}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {fullTotals.beautyMaster}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-600">
                {fullTotals.beautyJunior}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beautyMaster}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beautyJunior}</td>
              <td className={`border-t-2 border-slate-300 px-2 py-2 text-center ${gapTone(summary.gapTotal)}`}>
                {summary.gapTotal}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-rose-600">
                {rows.reduce((s, r) => s + Math.max(0, r.gap.mechanic), 0)}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-rose-600">
                {rows.reduce((s, r) => s + Math.max(0, r.gap.beauty), 0)}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-rose-600">
                {rows.reduce((s, r) => s + Math.max(0, r.gap.serviceManager), 0)}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-slate-500">
                {summary.storesWithGap} 家门店有缺编
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] leading-relaxed text-slate-400">
        口径说明（与 Excel「门店人员编制」Sheet 的 COUNTIFS 公式逐条对齐）：
        店长含「代理店长」；<strong>「机修现有」含「技术店长」</strong>（Excel 公式为
        <code className="rounded bg-slate-100 px-1">COUNTIFS(工种, 机修 / 技术店长)</code>），
        因此「当前合计人数」= 各列之和 <strong>− 技术店长</strong>，避免重复计一次；
        「美容现有」是全部美容工种人数，<strong>不等于</strong>师傅 + 中小工 ——
        「现有美容师傅」按<strong>职位备注 = 师傅</strong>统计，
        「现有美容中小工」按<strong>职位备注 = 学徒 或 中工</strong>统计，职位备注为空的人两边都不计。
        缺编明细 = 满编 − 现有，<strong className="text-sky-600">负数表示超编</strong>（如 −2），
        「缺编」汇总列只累加正数。满编数从 Excel 一次性导入后不再同步 Excel，如需批量更新请在软件里逐店调整。
      </p>
    </div>
  );
}
