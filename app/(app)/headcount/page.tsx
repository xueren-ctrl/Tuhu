import { getStoreHeadcount } from "@/lib/headcount-service";
import { Card, Alert } from "@/components/ui";
import HeadcountPlanEditor from "@/components/headcount/HeadcountPlanEditor";

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

const num = (v: number | null) => (v === null || v === undefined ? "—" : String(v));
/** 缺编用颜色标出：>0 红、=0 绿、<0（超编）蓝 */
const gapTone = (n: number) =>
  n > 0 ? "text-rose-600 font-semibold" : n === 0 ? "text-emerald-600" : "text-sky-600";

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
          <div className="text-[20px] font-semibold text-slate-800">{totals.manager + totals.techManager + totals.deputyManager + totals.serviceManager + totals.mechanic + totals.beauty + totals.logistics}</div>
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
            <strong>「现有」列是实时算出来的</strong>：直接来自「在职」表按「门店 + 工种」统计，
            员工一入职、一离职、一调岗，这里立刻变，不需要刷新或重新导入。
          </div>
          <div>
            <strong>「满编」列是人工设定的目标</strong>（点每行「调整」可改，改完立即重算缺编）。
            数据已从 Excel 一次性导入，<strong>不需要设的职位留空即可</strong>（不参与缺编计算）。
          </div>
        </div>
      </Alert>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1500px] border-collapse text-[12px]">
          {/* 第 1 层：分组 */}
          <thead>
            <tr className="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">
              <th rowSpan={2} className="sticky left-0 z-20 w-[46px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">
                序号
              </th>
              <th rowSpan={2} className="sticky left-[46px] z-20 w-[150px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">
                门店名称
              </th>
              <th rowSpan={2} className="w-[56px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">
                调整
              </th>
              <th colSpan={7} className="border-b border-r border-slate-300 px-2 py-1.5 text-center">
                各门店现有总人数
              </th>
              <th colSpan={3} className="border-b border-r border-slate-300 px-2 py-1.5 text-center">
                满编配制人数
              </th>
              <th colSpan={2} className="border-b border-r border-slate-300 px-2 py-1.5 text-center">
                美容配制人数
              </th>
              <th colSpan={2} className="border-b border-r border-slate-300 px-2 py-1.5 text-center">
                美容现有人数
              </th>
              <th rowSpan={2} className="w-[58px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">
                缺编
              </th>
              <th colSpan={3} className="border-b border-r border-slate-300 px-2 py-1.5 text-center">
                各职位缺编明细/人数
              </th>
              <th rowSpan={2} className="border-b border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">
                具体缺编明细
              </th>
            </tr>
            {/* 第 2 层：字段 */}
            <tr className="bg-[#f7f9fc] text-[11.5px] text-slate-600">
              {[
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
              ].map((h, i) => (
                <th
                  key={h + i}
                  className={`border-b border-r border-slate-200 px-2 py-1.5 text-center ${
                    i < 7 ? "bg-sky-50/60" : i < 13 ? "bg-indigo-50/60" : i < 15 ? "bg-violet-50/60" : i < 16 ? "bg-amber-50/60" : "bg-rose-50/60"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.storeId} className="hover:bg-brand-50/40">
                <td className="sticky left-0 z-10 border-b border-r border-slate-100 bg-white px-2 py-1.5 text-center text-slate-400">
                  {r.sortOrder}
                </td>
                <td className="sticky left-[46px] z-10 border-b border-r border-slate-100 bg-white px-2 py-1.5 font-medium text-slate-700">
                  {r.storeName}
                </td>
                <HeadcountPlanEditor storeId={r.storeId} row={r} />
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
                {/* 满编 */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{num(r.full.serviceManager)}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{num(r.full.mechanic)}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{num(r.full.beauty)}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{num(r.full.beautyMaster)}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{num(r.full.beautyJunior)}</td>
                {/* 美容现有 */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{r.current.beautyMaster || "—"}</td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center text-slate-600">{r.current.beautyJunior || "—"}</td>
                {/* 缺编汇总 */}
                <td className={`border-b border-slate-100 px-2 py-1.5 text-center ${gapTone(r.gap.total)}`}>
                  {r.gap.total === 0 ? "0" : r.gap.total}
                </td>
                {/* 各职位缺编 */}
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  <span className={r.gap.mechanic > 0 ? "text-rose-600" : "text-slate-300"}>
                    {r.gap.mechanic > 0 ? r.gap.mechanic : "—"}
                  </span>
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  <span className={r.gap.beauty > 0 ? "text-rose-600" : "text-slate-300"}>
                    {r.gap.beauty > 0 ? r.gap.beauty : "—"}
                  </span>
                </td>
                <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                  <span className={r.gap.serviceManager > 0 ? "text-rose-600" : "text-slate-300"}>
                    {r.gap.serviceManager > 0 ? r.gap.serviceManager : "—"}
                  </span>
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
              <td className="border-t-2 border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.manager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.techManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.deputyManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.serviceManager}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.mechanic}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beauty}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.logistics}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">
                {totals.manager + totals.techManager + totals.deputyManager + totals.serviceManager + totals.mechanic + totals.beauty + totals.logistics}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-500">
                {summary.fullTotal}
              </td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-400">—</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-400">—</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-slate-400">—</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beautyMaster}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center">{totals.beautyJunior}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2 text-center text-rose-600">{summary.gapTotal}</td>
              <td className="border-t-2 border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-slate-300 px-2 py-2" />
              <td className="border-t-2 border-slate-300 px-2 py-2 text-slate-500">
                {summary.storesWithGap} 家门店有缺编
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11.5px] leading-relaxed text-slate-400">
        口径说明：店长含「代理店长」；美容按职位是否含「师傅」拆分为「美容师傅」与「美容中小工」，
        两者之和即「美容现有」；缺编 = MAX(0, 满编 − 现有)，满编留空的职位不参与计算。
        满编数从 Excel 一次性导入后不再同步 Excel，如需批量更新请在软件里逐店调整。
      </p>
    </div>
  );
}
