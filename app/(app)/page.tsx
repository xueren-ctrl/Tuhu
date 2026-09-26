import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getDashboardStats, countEmployeeRows, getRecentEmployees } from "@/lib/employee-service";
import { Button, Card, StatCard, Alert, Badge, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * 首页 HR Dashboard
 * 所有数字均实时从 SQLite 计算，禁止写死。
 */
export default async function DashboardPage() {
  const stats = await getDashboardStats();

  // 数据库概览（技术侧可观测性，不属于业务 KPI）
  // 员工相关的计数统一走 employee-service，页面不直连 prisma.employee
  const [storeRows, deptRows, positionRows, dictRows, employeeRows, auditRows, lastBatch] =
    await Promise.all([
      prisma.store.count(),
      prisma.department.count(),
      prisma.position.count(),
      prisma.dictOption.count(),
      countEmployeeRows(),
      prisma.auditLog.count(),
      prisma.importBatch.findFirst({ orderBy: { startedAt: "desc" } }),
    ]);

  // 最近新增员工（实时查询，走 employee-service）
  const recent = await getRecentEmployees(6);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      {/* 6 个核心统计卡片 —— 全部实时计算 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard
          label="员工总数"
          value={stats.total}
          sub={`已停用档案 ${stats.deleted} 人`}
          tone="blue"
        />
        <StatCard
          label="在职人数"
          value={stats.onJob}
          sub={`已入职 ${stats.active} · 南昌3店 ${stats.nc3} · 运营部 ${stats.ops}`}
          tone="green"
        />
        <StatCard
          label="离职人数"
          value={stats.resigned + stats.opsResigned}
          sub={`门店离职 ${stats.resigned} · 运营部离职 ${stats.opsResigned}`}
          tone="red"
        />
        <StatCard
          label="门店数量"
          value={stats.storeCount}
          sub="启用中的门店"
          tone="slate"
        />
        <StatCard
          label="部门数量"
          value={stats.departmentCount}
          sub="启用中的部门"
          tone="amber"
        />
        <StatCard
          label="职位数量"
          value={stats.positionCount}
          sub="启用中的职位"
          tone="blue"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-[12.5px] text-brand-800">
        <span>
          第二阶段已上线：<strong>人员视图</strong>（在职 / 离职 / 门店 / 部门 / 分布统计），
          替代 Excel 的分表视图，全部实时查询员工表。
        </span>
        <Link href="/employees/views">
          <Button size="sm" variant="primary">
            进入人员视图 →
          </Button>
        </Link>
      </div>

      <Alert tone="info">
        状态分布：已入职 <strong>{stats.active}</strong> · 南昌3店 <strong>{stats.nc3}</strong> ·
        运营部 <strong>{stats.ops}</strong> · 离职 <strong>{stats.resigned}</strong> ·
        运营部离职 <strong>{stats.opsResigned}</strong> · 已面试 <strong>{stats.interviewed}</strong> ·
        候选中 <strong>{stats.candidate}</strong> · 其他 <strong>{stats.other}</strong>。
        状态决定一个人出现在哪些表，可在「更改员工状态」页批量调整。
      </Alert>

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
            <Row label="部门表 Department" value={deptRows} />
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

      <Card title="状态 ↔ 表 对应关系（状态决定一个人出现在哪些表）">
        <div className="grid gap-3 text-[12.5px] leading-relaxed text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          {EMPLOYEE_STATUS_OPTIONS.map((o) => (
            <div key={o.value} className="rounded-md border border-[var(--hr-border)] p-3">
              <div className="mb-1 flex items-center gap-2">
                <StatusBadge status={o.value} />
                <code className="text-[11px] text-slate-400">{o.value}</code>
              </div>
              <p className="text-[12px] text-slate-500">出现在：{o.hint}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-slate-500">
          「数据库」表包含全部员工，不受状态限制。状态在「更改员工状态」页批量修改，
          也可在员工详情页单个修改；修改会写入变更历史与审计。各表的行数随状态实时变化。
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
