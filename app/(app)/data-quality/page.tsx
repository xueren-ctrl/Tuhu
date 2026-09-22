import Link from "next/link";
import { Alert, Card, StatCard } from "@/components/ui";
import {
  DQ_CATEGORIES,
  getDataQualitySummary,
} from "@/lib/data-quality-service";

export const dynamic = "force-dynamic";

const SEVERITY_LABEL: Record<string, { text: string; cls: string }> = {
  high: { text: "高", cls: "bg-red-50 text-red-600" },
  medium: { text: "中", cls: "bg-amber-50 text-amber-700" },
  low: { text: "低", cls: "bg-slate-100 text-slate-600" },
};

/**
 * /data-quality 数据质量中心（第三阶段）
 *
 * 五类问题全部实时从 Employee / ImportIssue 计算，点击可下钻到明细。
 */
export default async function DataQualityPage() {
  const s = await getDataQualitySummary();
  const meta = new Map(DQ_CATEGORIES.map((c) => [c.key, c]));
  const noDeptRow = s.rows.find((r) => r.key === "no-department");

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        这里汇总 Excel 历史数据留下的质量问题。<strong>所有数字都是实时计算的</strong>，
        修好一条这里就少一条 —— 修完「无部门」后，人员视图与分布统计会立刻反映出来。
        <br />
        系统对这些问题的处理原则是<strong>如实呈现、绝不静默修正</strong>：
        可以修，但必须由人确认后再改，且每次修改都会写入员工的变更记录。
      </Alert>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="员工总数" value={s.totalEmployees} tone="blue" />
        <StatCard label="检出问题" value={s.totalIssues} sub="各类相加，可重复" tone="slate" />
        <StatCard label="待处理" value={s.pendingTotal} sub={`已处理 ${s.handledTotal} 条`} tone="amber" />
        <StatCard label="受影响员工（去重）" value={s.affectedEmployees} sub="已关闭的不计" tone="red" />
        <StatCard
          label="数据完整率"
          value={`${(
            ((s.totalEmployees - s.affectedEmployees) / Math.max(1, s.totalEmployees)) *
            100
          ).toFixed(1)}%`}
          sub={`${s.totalEmployees - s.affectedEmployees} / ${s.totalEmployees} 人无待处理问题`}
          tone="green"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {s.rows.map((r) => {
          const m = meta.get(r.key)!;
          const sev = SEVERITY_LABEL[r.severity];
          return (
            <Card
              key={r.key}
              title={
                <span className="flex items-center gap-2">
                  {r.label}
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${sev.cls}`}>
                    严重度 {sev.text}
                  </span>
                  {r.batchFixable && (
                    <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">
                      可批量修
                    </span>
                  )}
                </span>
              }
              extra={
                <Link
                  href={`/data-quality/${r.key}`}
                  className="text-[12.5px] text-brand-700 hover:underline"
                >
                  查看详情 →
                </Link>
              }
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[28px] font-semibold tabular-nums text-slate-800">
                  {r.pending}
                </span>
                <span className="text-[12.5px] text-slate-500">条待处理</span>
                {r.handled > 0 && (
                  <span className="ml-1 text-[12px] text-slate-400">
                    （检出 {r.count}，已处理 {r.handled}）
                  </span>
                )}
              </div>
              <div className="mt-2 text-[12.5px] leading-relaxed text-slate-600">
                <div>
                  <span className="text-slate-400">判定口径：</span>
                  {m.rule}
                </div>
                <div className="mt-1">
                  <span className="text-slate-400">处理方式：</span>
                  {m.fix}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="参考信息（以下不算问题，避免误判）">
        <ul className="space-y-2 text-[12.5px] leading-relaxed text-slate-600">
          <li>
            <strong className="text-slate-800">同一身份证号多条记录：{s.notes.rehireGroups} 组</strong>
            {" —— "}
            这是<strong>合法的「重新入职」</strong>，属于真实的多次任职记录，由「身份证号 + 入职日期」
            区分保留，<strong>绝不能当作重复员工合并</strong>（合并会直接丢失历史任职）。
          </li>
          <li>
            <strong className="text-slate-800">
              只挂部门、没有门店的记录：{s.notes.departmentOnly} 人
            </strong>
            {" —— "}
            如「运营部」员工，本身就不属于任何门店，因此<strong>不计入「无门店员工」</strong>。
          </li>
        </ul>
      </Card>

      <Card title="处理入口（从「发现问题」走向「解决问题」）">
        <ul className="space-y-2 text-[12.5px] leading-relaxed text-slate-600">
          <li>
            <strong className="text-slate-800">无部门 / 无岗位 / 无门店</strong>：
            量少用
            <Link href="/employees/batch" className="mx-1 underline">
              批量编辑
            </Link>
            ；量大（当前 {noDeptRow?.count ?? 0} 人无部门）用
            <Link href="/employees/department-auto" className="mx-1 underline">
              部门自动归属
            </Link>
            按规则批量生成。
          </li>
          <li>
            <strong className="text-slate-800">状态冲突</strong>：属于口径问题，需要 HR 逐人确认，
            在明细页逐条关闭并写明处理结果。
          </li>
          <li>
            <strong className="text-slate-800">门店被拆成多条</strong>：用
            <Link href="/stores/merge" className="mx-1 underline">
              门店合并
            </Link>
            把同义写法归到同一家店（员工只改门店外键，不删数据）。
          </li>
          <li>
            <strong className="text-slate-800">Excel 数据更新</strong>：用
            <Link href="/import" className="mx-1 underline">
              导入预览
            </Link>
            ，先看清 Diff 再决定写不写，绝不会「上传即覆盖」。
          </li>
        </ul>
      </Card>
    </div>
  );
}
