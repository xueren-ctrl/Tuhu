import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getDashboardStats } from "@/lib/employee-service";
import { Button, Card, StatCard, Alert, Badge, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { EMPLOYEE_STATUS_LABEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * 首页 HR Dashboard
 * 所有数字均实时从 SQLite 计算，禁止写死。
 */
export default async function DashboardPage() {
  const stats = await getDashboardStats();

  // 数据库概览（技术侧可观测性，不属于业务 KPI）
  const [storeRows, positionRows, dictRows, employeeRows, auditRows, lastBatch] =
    await Promise.all([
      prisma.store.count(),
      prisma.position.count(),
      prisma.dictOption.count(),
      prisma.employee.count(),
      prisma.auditLog.count(),
      prisma.importBatch.findFirst({ orderBy: { startedAt: "desc" } }),
    ]);

  // 最近新增员工（实时查询）
  const recent = await prisma.employee.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: {
      id: true,
      employeeId: true,
      name: true,
      status: true,
      hireDate: true,
      storeNameRaw: true,
      jobGradeRaw: true,
      store: { select: { name: true } },
      position: { select: { name: true } },
    },
  });

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      {/* 5 个核心统计卡片 —— 全部实时计算 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="员工总数"
          value={stats.total}
          sub={`已停用档案 ${stats.deleted} 人`}
          tone="blue"
        />
        <StatCard
          label="在职人数"
          value={stats.active}
          sub={`占比 ${stats.activeRate}%`}
          tone="green"
        />
        <StatCard
          label="离职人数"
          value={stats.resigned}
          sub="含历史离职档案"
          tone="red"
        />
        <StatCard
          label="门店数量"
          value={stats.storeCount}
          sub={`启用中的门店`}
          tone="slate"
        />
        <StatCard
          label="职位数量"
          value={stats.positionCount}
          sub={`启用中的职位`}
          tone="amber"
        />
      </div>

      {stats.candidate > 0 ? (
        <Alert tone="warn">
          另有 <strong>{stats.candidate}</strong> 名候选人（状态 CANDIDATE）。候选人状态已预留，本阶段不开发完整招聘系统。
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 最近新增 */}
        <Card
          className="lg:col-span-2"
          title="最近新增员工"
          extra={
            <Link href="/employees">
              <Button size="sm" variant="ghost">
                查看全部 →
              </Button>
            </Link>
          }
          bodyClassName="p-0"
        >
          {recent.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-slate-400">
              暂无员工数据，请先执行 Excel 导入或
              <Link href="/employees/new" className="text-brand-600 underline">
                新增员工
              </Link>
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="px-4 py-2 font-medium">员工编号</th>
                  <th className="px-3 py-2 font-medium">姓名</th>
                  <th className="px-3 py-2 font-medium">门店</th>
                  <th className="px-3 py-2 font-medium">职位</th>
                  <th className="px-3 py-2 font-medium">入职日期</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id} className="text-[12.5px]">
                    <td className="px-4 py-2 font-mono text-[11.5px] text-slate-600">
                      <Link href={`/employees/${e.id}`} className="hover:text-brand-600 hover:underline">
                        {e.employeeId}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-medium">{e.name}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {e.store?.name ?? e.storeNameRaw ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {e.position?.name ?? e.jobGradeRaw ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(e.hireDate)}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* 数据库概览 */}
        <Card title="数据库概览（实时）">
          <dl className="space-y-2.5 text-[12.5px]">
            <Row label="员工主表 Employee" value={employeeRows} />
            <Row label="门店表 Store" value={storeRows} />
            <Row label="职位表 Position" value={positionRows} />
            <Row label="字典表 DictOption" value={dictRows} />
            <Row label="审计日志 AuditLog" value={auditRows} />
          </dl>

          <div className="mt-4 border-t border-[var(--hr-border)] pt-3">
            <div className="mb-1.5 text-[11.5px] text-slate-400">最近一次 Excel 导入</div>
            {lastBatch ? (
              <div className="space-y-1.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      lastBatch.status === "SUCCESS"
                        ? "green"
                        : lastBatch.status === "PARTIAL"
                          ? "amber"
                          : "red"
                    }
                  >
                    {lastBatch.status}
                  </Badge>
                  <span className="font-mono text-[11px] text-slate-500">
                    {lastBatch.id}
                  </span>
                </div>
                <div className="text-slate-600">
                  新增 {lastBatch.inserted} · 跳过 {lastBatch.skipped} · 重复{" "}
                  {lastBatch.duplicated} · 异常 {lastBatch.issueCount}
                </div>
                <Link
                  href="/settings/import"
                  className="text-brand-600 hover:underline"
                >
                  查看导入报告 →
                </Link>
              </div>
            ) : (
              <div className="text-[12px] text-slate-400">尚未执行导入</div>
            )}
          </div>

          <div className="mt-4 border-t border-[var(--hr-border)] pt-3 text-[11px] leading-relaxed text-slate-400">
            数据唯一来源：<code className="text-slate-500">data/hr.db</code>（SQLite）。
            所有页面均实时查询数据库，不做前端硬编码。
          </div>
        </Card>
      </div>

      <Card title="状态口径说明">
        <div className="grid gap-3 text-[12.5px] leading-relaxed text-slate-600 sm:grid-cols-3">
          {["ACTIVE", "RESIGNED", "CANDIDATE"].map((s) => (
            <div key={s} className="rounded-md border border-[var(--hr-border)] p-3">
              <div className="mb-1 flex items-center gap-2">
                <StatusBadge status={s} />
                <code className="text-[11px] text-slate-400">{s}</code>
              </div>
              <p className="text-[12px] text-slate-500">
                {s === "ACTIVE" && "当前在职，员工档案默认统计口径。"}
                {s === "RESIGNED" && "已离职，保留历史档案，包含离职日期与原因。"}
                {s === "CANDIDATE" && "候选人状态已预留，本阶段不开发完整招聘系统。"}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-slate-500">
          状态由 Excel「备注（离职日期）」「离职原因」以及「离职」「在职」名册共同判定，
          判定规则与冲突明细见 docs/import-report.md。
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
