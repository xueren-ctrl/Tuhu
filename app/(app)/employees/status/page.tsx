import Link from "next/link";
import { listEmployees } from "@/lib/employee-service";
import { employeeQuerySchema } from "@/lib/validation";
import { EMPLOYEE_STATUS_OPTIONS } from "@/lib/constants";
import StatusChangePanel, { type StatusRow } from "@/components/employees/StatusChangePanel";
import { Alert, Card } from "@/components/ui";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * /employees/status —— 更改员工状态（批量 + 单个入口）
 *
 * 状态决定一个人出现在哪些表；这里可以筛选、勾选一批人、一次性改成目标状态，
 * 并给出「会从哪些表移出 / 进入哪些表」的影响预览。
 * 单个修改也可以在员工详情页直接改。
 */
export default async function StatusChangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  flat.pageSize = flat.pageSize || "100";

  const parsed = employeeQuerySchema.safeParse(flat);
  const q = parsed.success ? parsed.data : employeeQuerySchema.parse({});
  const result = await listEmployees({ ...q, pageSize: Math.min(200, q.pageSize) });

  const rows: StatusRow[] = result.data.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    name: r.name,
    status: r.status,
    storeName: r.storeName ?? r.storeNameRaw ?? null,
    positionName: r.positionName ?? r.jobGradeRaw ?? null,
    hireDate: r.hireDate ? String(r.hireDate).slice(0, 10) : null,
  }));

  const counts = await prisma.employee.groupBy({
    by: ["status"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.status, c._count._all]));

  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(flat)) if (v) p.set(k, v);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    p.delete("page");
    const s = p.toString();
    return s ? `/employees/status?${s}` : "/employees/status";
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-800">更改员工状态</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            状态决定一个人出现在哪些表；改完立刻生效（各「表」的人数会跟着变）。
            当前筛选命中 <strong className="text-slate-700">{result.total}</strong> 人。
          </p>
        </div>
        <Link
          href="/sheets/在职"
          className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
        >
          去看「在职」表
        </Link>
      </div>

      <Alert tone="info">
        <div className="space-y-1">
          <div className="font-medium">状态 ↔ 表 的对应关系（改状态就是让这个人「搬家」）</div>
          <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {EMPLOYEE_STATUS_OPTIONS.map((o) => (
              <div key={o.value} className="flex items-center gap-2">
                <span className="w-[76px] shrink-0 text-slate-700">{o.label}</span>
                <span className="text-slate-500">{o.hint}</span>
                <span className="ml-auto text-slate-400">
                  {countMap.get(o.value) ?? 0} 人
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="w-[76px] shrink-0 text-slate-700">数据库</span>
              <span className="text-slate-500">全部员工，不受状态影响</span>
            </div>
          </div>
        </div>
      </Alert>

      {/* 筛选 */}
      <Card title="① 找到要改的人">
        <form action="/employees/status" method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-slate-500">姓名 / 手机号 / 身份证 / 编号</span>
            <input
              name="keyword"
              defaultValue={flat.keyword ?? ""}
              placeholder="输入任意关键词"
              className="h-8 w-[200px] rounded-md border border-slate-300 px-2.5 text-[12.5px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-slate-500">当前状态</span>
            <select
              name="status"
              defaultValue={flat.status ?? ""}
              className="h-8 rounded-md border border-slate-300 px-2 text-[12.5px]"
            >
              <option value="">全部状态</option>
              {EMPLOYEE_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}（{countMap.get(o.value) ?? 0}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-slate-500">每页</span>
            <select
              name="pageSize"
              defaultValue={String(q.pageSize)}
              className="h-8 rounded-md border border-slate-300 px-2 text-[12.5px]"
            >
              {[50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-8 rounded-md bg-brand-600 px-3.5 text-[12.5px] font-medium text-white hover:bg-brand-700"
          >
            查询
          </button>
          <Link
            href="/employees/status"
            className="h-8 rounded-md border border-slate-300 px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
          >
            重置
          </Link>
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            { label: "在职类（已入职/南昌3店/运营部）", status: "ACTIVE" },
            { label: "已面试", status: "INTERVIEWED" },
            { label: "候选中", status: "CANDIDATE" },
            { label: "其他", status: "OTHER" },
            { label: "离职类", status: "RESIGNED" },
          ].map((s) => (
            <Link
              key={s.label}
              href={qs({ status: s.status })}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-[11.5px] text-slate-600 hover:bg-slate-200"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </Card>

      <Card title="② 勾选人员并改成目标状态" bodyClassName="p-0">
        <div className="p-3">
          <StatusChangePanel rows={rows} />
        </div>
        {result.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-[var(--hr-border)] px-4 py-2.5 text-[12.5px] text-slate-500">
            <span>
              第 {result.page} / {result.totalPages} 页 · 共 {result.total} 人
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={`${qs({})}&page=${result.page - 1}`}
                  className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
                >
                  上一页
                </Link>
              ) : null}
              {result.page < result.totalPages ? (
                <Link
                  href={`${qs({})}&page=${result.page + 1}`}
                  className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
                >
                  下一页
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      <Alert tone="info">
        提示：本页一次最多显示 200 人。要改的人很多时，可先按「当前状态」筛选再分批处理；
        每次改动都会写入该员工的变更历史和系统审计（谁、什么时候、从什么状态改成什么状态）。
      </Alert>
    </div>
  );
}
