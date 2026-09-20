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

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Alert tone="info">
        这里汇总 Excel 历史数据留下的质量问题。<strong>所有数字都是实时计算的</strong>，
        修好一条这里就少一条 —— 修完「无部门」后，人员视图与分布统计会立刻反映出来。
        <br />
        系统对这些问题的处理原则是<strong>如实呈现、绝不静默修正</strong>：
        可以修，但必须由人确认后再改，且每次修改都会写入员工的变更记录。
      </Alert>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="员工总数" value={s.totalEmployees} tone="blue" />
        <StatCard label="问题条目合计" value={s.totalIssues} sub="同一人可能落在多类" tone="amber" />
        <StatCard label="受影响员工（去重）" value={s.affectedEmployees} tone="red" />
        <StatCard
          label="数据完整率"
          value={`${(
            ((s.totalEmployees - s.affectedEmployees) / Math.max(1, s.totalEmployees)) *
            100
          ).toFixed(1)}%`}
          sub={`${s.totalEmployees - s.affectedEmployees} / ${s.totalEmployees} 人无任何问题`}
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
                  {r.count}
                </span>
                <span className="text-[12.5px] text-slate-500">条</span>
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

      <Alert tone="warn">
        当前版本<strong>没有自动修复按钮</strong>（按需求本阶段只做数据治理的「看见 + 可修」，
        不做批量清洗）。可批量修的三类（无部门 / 无岗位 / 无门店）请用
        <Link href="/employees/batch" className="mx-1 underline">
          批量编辑
        </Link>
        工具处理；状态冲突需要 HR 逐人确认口径。
      </Alert>
    </div>
  );
}
