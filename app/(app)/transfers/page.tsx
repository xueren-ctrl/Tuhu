import Link from "next/link";
import { getTransfers } from "@/lib/transfer-service";
import { foldRoundTrips } from "@/lib/transfer-fold";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { STATUS_LABEL } from "@/lib/transfer-order-service";
import TransferOrderPanel from "@/components/transfers/TransferOrderPanel";
import { Card, Alert, Button } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /transfers —— 调店记录（Stage 9.26）
 *
 * 回答：**谁、哪天、从哪家店调到了哪家店、谁操作的。**
 * 数据来自 `EmployeeHistory` 里 `fieldName="storeId"` 的行 —— 每次改门店
 * （单个编辑 / 批量编辑）都会自动写一条，实时。
 *
 * ⚠️ 数据来源分两类，页面**如实标注**（不让用户误以为都是真实调店）：
 *   · 真实调店 —— 操作人是真人
 *   · 测试/治理 —— 操作人含「临时验收账号」「测试」「Stage 7.3.x」，
 *     是往期验收与门店治理时产生的记录（历史事实，不删，但明确标出）
 */

/**
 * 时间显示用项目统一的 `formatDateTime`（**本地时区**取值）。
 *
 * ⚠️ 别自己写 `getUTCHours()` —— 那是 UTC，会比北京时间少 8 小时。
 * 库里 `operatedAt` 存的是标准 UTC 瞬时值（如 `2026-09-27T14:28:58Z`，
 * 对应北京时间 22:28），本地取值才对。
 * 纯日期字段才用 UTC 取值（见 `lib/format.ts` 的 `formatDate`）。
 */
const ymd = (d: Date) => formatDateTime(d);

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const keyword = one("q");
  const storeKeyword = one("store");
  const onlyReal = one("real") === "1";

  const { records, summary, allCount } = await getTransfers({
    keyword,
    storeKeyword,
    onlyReal,
    limit: 300,
  });

  const hasFilter = Boolean(keyword || storeKeyword || onlyReal);

  /**
   * 折叠「改过去又改回」的往返噪音（Stage 9.28）。
   * 判定：同一人、A→B 之后紧接着 B→A，**间隔 ≤ 48 小时** → 净变动为 0。
   * 数据一条不删，只是合并成一行显示，让真实调店能被看见。
   *
   * `?raw=1` 可展开全部往返明细（审计/排查时需要）。
   */
  const showRaw = one("raw") === "1";
  const rawRecords = records;
  const folded = showRaw ? [] : foldRoundTrips(records);
  const displayRows = showRaw
    ? rawRecords.map((r) => ({ ...r, at: r.operatedAt, isRoundTrip: false as const, tripCount: 0, minutes: 0 }))
    : folded.map((r) =>
        r.kind === "roundtrip"
          ? {
              id: r.id,
              at: r.at,
              employeeId: r.employeeId,
              employeeName: r.employeeName,
              employeeCode: r.employeeCode,
              fromStore: r.store,
              toStore: null,
              operator: r.operators,
              source: r.source,
              isNoise: r.isNoise,
              batchKey: null,
              isRoundTrip: true as const,
              tripCount: r.tripCount,
              minutes: r.minutes,
            }
          : r
      );
  const roundTripCount = showRaw ? 0 : folded.filter((r) => r.kind === "roundtrip").length;

  // 调店单 + 登记需要的员工/门店下拉
  const [orders, empOpts, storeOpts] = await Promise.all([
    prisma.transferOrder.findMany({
      orderBy: [{ status: "asc" }, { effectiveDate: "desc" }],
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        fromStore: { select: { id: true, name: true } },
        toStore: { select: { id: true, name: true } },
      },
    }),
    prisma.employee.findMany({
      where: { deletedAt: null, status: "ACTIVE" },
      select: { id: true, name: true, employeeId: true, storeId: true, store: { select: { name: true } } },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.store.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const pendingCount = orders.filter((o) => o.status === "PENDING").length;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q: keyword, store: storeKeyword, real: onlyReal ? "1" : undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/transfers?${s}` : "/transfers";
  };

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[18px] font-semibold text-slate-800">调店记录</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          共 {summary.total} 条 · 涉及 {summary.employeeCount} 人 · 单个编辑与批量编辑都会自动记录
        </p>
      </div>

      {/* ① 调店单（登记 / 待生效 / 作废 / 撤销）—— Stage 9.28 */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-slate-700">调店单</h2>
          {pendingCount > 0 ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
              {pendingCount} 张待生效
            </span>
          ) : null}
        </div>
        <TransferOrderPanel
          orders={orders.map((o) => ({
            id: o.id,
            status: o.status as "PENDING" | "EFFECTED" | "CANCELLED" | "REVERSED",
            statusLabel: STATUS_LABEL[o.status as keyof typeof STATUS_LABEL] ?? o.status,
            employee: { id: o.employee.id, name: o.employee.name, code: o.employee.employeeId },
            fromStore: o.fromStore,
            toStore: o.toStore,
            effectiveDate: o.effectiveDate.toISOString().slice(0, 10),
            reason: o.reason,
            voidReason: o.voidReason,
            createdBy: o.createdBy,
          }))}
          employees={empOpts.map((e) => ({
            id: e.id,
            name: e.name,
            code: e.employeeId,
            storeId: e.storeId,
            storeName: e.store?.name ?? null,
          }))}
          stores={storeOpts}
        />
      </div>

      {/* 速览 */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Card title="记录总数">
          <div className="text-[20px] font-semibold text-slate-800">{summary.total}</div>
          <div className="text-[11.5px] text-slate-400">{hasFilter ? `当前筛选出 ${records.length} 条` : "全部记录"}</div>
        </Card>
        <Card title="真实调店">
          <div className={`text-[20px] font-semibold ${summary.realCount > 0 ? "text-emerald-600" : "text-slate-400"}`}>
            {summary.realCount}
          </div>
          <div className="text-[11.5px] text-slate-400">操作人为真人账号</div>
        </Card>
        <Card title="测试/治理记录">
          <div className="text-[20px] font-semibold text-amber-600">{summary.noiseCount}</div>
          <div className="text-[11.5px] text-slate-400">验收与数据治理产生</div>
        </Card>
        <Card title="涉及员工">
          <div className="text-[20px] font-semibold text-slate-800">{summary.employeeCount}</div>
          <div className="text-[11.5px] text-slate-400">有过门店变动</div>
        </Card>
        <Card title="最频繁路线">
          <div className="truncate text-[13px] font-semibold text-slate-800" title={summary.topRoutes[0] ? `${summary.topRoutes[0].from} → ${summary.topRoutes[0].to}` : ""}>
            {summary.topRoutes[0] ? summary.topRoutes[0].count : "—"}
          </div>
          <div className="truncate text-[11.5px] text-slate-400" title={summary.topRoutes[0] ? `${summary.topRoutes[0].from} → ${summary.topRoutes[0].to}` : ""}>
            {summary.topRoutes[0] ? `${summary.topRoutes[0].from} → ${summary.topRoutes[0].to}` : "—"}
          </div>
        </Card>
      </div>

      <Alert tone={summary.realCount === 0 ? "warn" : "info"}>
        <div className="space-y-1">
          <div>
            <strong>记录是自动产生的</strong>：在软件里改员工的门店时（无论单个编辑还是批量编辑），
            系统会同时写一条调店记录，含<strong>时间、变动前后、操作人</strong>。
            <strong>历史数据不会追溯</strong> —— 只记从启用该功能之后发生的调店。
          </div>
          {summary.realCount === 0 ? (
            <div>
              <strong>目前还没有真实业务调店记录</strong>（{summary.noiseCount} 条全部来自往期的
              验收测试与数据治理脚本，所以被标成「测试/治理」）。
              <strong>从现在起你在软件里改门店，这里就会实时出现记录</strong>——
              这也正是「今后调动要及时在软件里改」的意义所在。
            </div>
          ) : (
            <div>
              <strong>「测试/治理」标签</strong>：往期做验收和门店治理时也改过门店，
              那些记录照样保留在库里（历史事实不能删），但用标签明确区分，
              避免把治理过程误当成真实调店。可勾选「只看真实调店」过滤。
            </div>
          )}
        </div>
      </Alert>

      {/* 筛选 */}
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500">姓名 / 工号</label>
          <input
            name="q"
            defaultValue={keyword}
            placeholder="如：陈增"
            className="w-[150px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500">门店（含调出/调入）</label>
          <input
            name="store"
            defaultValue={storeKeyword}
            placeholder="如：东坑角社"
            className="w-[170px] rounded border border-slate-300 px-2 py-1 text-[12.5px] outline-none focus:border-brand-500"
          />
        </div>
        <label className="flex items-center gap-1.5 pb-1 text-[12.5px] text-slate-600">
          <input
            type="checkbox"
            name="real"
            value="1"
            defaultChecked={onlyReal}
            className="h-3.5 w-3.5 accent-brand-600"
          />
          只看真实调店
        </label>
        <div className="flex items-center gap-1.5 pb-0.5">
          <Button type="submit" size="sm">筛选</Button>
          {hasFilter ? (
            <Link href="/transfers">
              <Button type="button" size="sm" variant="ghost">重置</Button>
            </Link>
          ) : null}
        </div>
        {hasFilter ? (
          <span className="pb-1 text-[11.5px] text-slate-400">
            命中 <strong className="text-slate-600">{records.length}</strong> / 全部 {allCount} 条
          </span>
        ) : null}
      </form>

      {/* 调动路线 Top 5 */}
      {summary.topRoutes.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-slate-600">调动最频繁的路线</div>
          <div className="flex flex-wrap gap-1.5">
            {summary.topRoutes.map((r) => (
              <Link
                key={`${r.from}→${r.to}`}
                href={qs({ store: r.from })}
                className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11.5px] text-slate-600 hover:border-brand-400 hover:text-brand-700"
              >
                {r.from} → {r.to}
                <span className="ml-1 font-semibold text-slate-800">{r.count}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* ② 历史明细（「改过去又改回」的往返已折叠合并成一行） */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-medium text-slate-700">历史调店明细</h2>
          {roundTripCount > 0 ? (
            <Link
              href={qs({ raw: showRaw ? undefined : "1" })}
              className="text-[11.5px] text-brand-600 underline hover:text-brand-700"
            >
              {showRaw ? "按折叠方式显示" : `展开 ${roundTripCount} 组往返明细`}
            </Link>
          ) : null}
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">
              <th className="w-[140px] border-b border-r border-slate-200 px-2 py-1.5 text-center">时间</th>
              <th className="w-[130px] border-b border-r border-slate-200 px-2 py-1.5 text-left">员工</th>
              <th className="w-[190px] border-b border-r border-slate-200 px-2 py-1.5 text-left">调出门店</th>
              <th className="w-[34px] border-b border-r border-slate-200 px-1 py-1.5 text-center">→</th>
              <th className="w-[190px] border-b border-r border-slate-200 px-2 py-1.5 text-left">调入门店</th>
              <th className="w-[120px] border-b border-r border-slate-200 px-2 py-1.5 text-left">操作人</th>
              <th className="w-[88px] border-b border-slate-200 px-2 py-1.5 text-center">来源</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  {hasFilter ? "没有符合条件的记录" : "暂无调店记录"}
                </td>
              </tr>
            ) : (
              displayRows.map((r) =>
                r.isRoundTrip ? (
                  <tr key={`rt-${r.id}`} className="bg-slate-50/60">
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center tabular-nums text-slate-400">
                      {ymd(r.at)}
                    </td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5">
                      <Link
                        href={`/employees/${r.employeeId}`}
                        className="font-medium text-slate-500 hover:text-brand-600 hover:underline"
                      >
                        {r.employeeName}
                      </Link>
                    </td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-500">
                      {r.fromStore ?? "（未挂门店）"}
                    </td>
                    <td className="border-b border-r border-slate-100 px-1 py-1.5 text-center text-slate-300">↔</td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-500">
                      去了又调回（净变动 = 0 · {r.tripCount} 次 · {r.minutes} 分钟内）
                    </td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-400">{r.operator}</td>
                    <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">往返</span>
                    </td>
                  </tr>
                ) : (
                <tr key={r.id} className="hover:bg-brand-50/40">
                  <td className="border-b border-r border-slate-100 px-2 py-1.5 text-center tabular-nums text-slate-500">
                    {ymd(r.operatedAt)}
                  </td>
                  <td className="border-b border-r border-slate-100 px-2 py-1.5">
                    <Link
                      href={`/employees/${r.employeeId}`}
                      className="font-medium text-slate-700 hover:text-brand-600 hover:underline"
                    >
                      {r.employeeName}
                    </Link>
                    {r.employeeCode ? (
                      <span className="ml-1 text-[11px] text-slate-400">{r.employeeCode}</span>
                    ) : null}
                  </td>
                  <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">
                    {r.fromStore ?? <span className="text-slate-300">（未挂门店）</span>}
                  </td>
                  <td className="border-b border-r border-slate-100 px-1 py-1.5 text-center text-slate-300">
                    →
                  </td>
                  <td className="border-b border-r border-slate-100 px-2 py-1.5 font-medium text-slate-700">
                    {r.toStore ?? <span className="text-slate-300">（未挂门店）</span>}
                  </td>
                  <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">
                    {r.operator}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5 text-center">
                    {r.isNoise ? (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">测试/治理</span>
                    ) : (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">真实调店</span>
                    )}
                  </td>
                </tr>
                )
              )
            )}
          </tbody>
        </table>
        </div>
      </div>

      {records.length >= 300 ? (
        <p className="text-[11.5px] text-amber-600">
          ⚠️ 已显示前 300 条（全部 {allCount} 条）。请用上方筛选缩小范围。
        </p>
      ) : null}

      <p className="text-[11.5px] leading-relaxed text-slate-400">
        口径说明：数据来自每次改门店时自动写入的变更记录，<strong>实时</strong>，不额外落库。
        「测试/治理」= 操作人为往期验收账号或数据治理脚本（历史事实保留但明确标注），
        真实业务调店请勾选「只看真实调店」。
        早期版本的记录里门店存的是<strong>店名文本</strong>而非编号，页面会原样显示店名。
      </p>
    </div>
  );
}
