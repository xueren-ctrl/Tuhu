import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Button, Card, StatusBadge } from "@/components/ui";
import {
  DQ_CATEGORIES,
  getDataQualityDetail,
  listRehireGroups,
  type DqCategoryKey,
} from "@/lib/data-quality-service";
import { EMPLOYEE_STATUS_LABEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

const KEY_TO_PRESET: Partial<Record<DqCategoryKey, string>> = {
  "no-department": "no-department",
  "no-position": "no-position",
  "no-store": "no-store",
};

interface Props {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DataQualityDetailPage({ params, searchParams }: Props) {
  const { key } = await params;
  const sp = await searchParams;
  const meta = DQ_CATEGORIES.find((c) => c.key === key);
  if (!meta) notFound();

  const page = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page ?? 1) || 1;
  const pageSize = 20;
  const result = await getDataQualityDetail(key as DqCategoryKey, { page, pageSize });
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));

  // 「重复员工」类额外展示合法的重新入职参考，帮助 HR 区分
  const rehire = key === "duplicate" ? await listRehireGroups(20) : [];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-slate-800">{meta.label}</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            共 <strong className="text-slate-700">{result.total}</strong> 条
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/data-quality">
            <Button size="sm" variant="ghost">
              ← 返回数据质量中心
            </Button>
          </Link>
          {KEY_TO_PRESET[key as DqCategoryKey] && (
            <Link href={`/employees/batch?preset=${KEY_TO_PRESET[key as DqCategoryKey]}`}>
              <Button size="sm" variant="primary">
                去批量修改
              </Button>
            </Link>
          )}
        </div>
      </div>

      <Alert tone="info">
        <strong>判定口径：</strong>
        {meta.rule}
        <br />
        <strong>处理方式：</strong>
        {meta.fix}
      </Alert>

      <Card title={`明细（第 ${result.page} / ${totalPages} 页）`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2 font-medium">员工编号</th>
                <th className="px-3 py-2 font-medium">姓名</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">门店</th>
                <th className="px-3 py-2 font-medium">部门</th>
                <th className="px-3 py-2 font-medium">岗位</th>
                <th className="px-3 py-2 font-medium">入职日期</th>
                <th className="px-3 py-2 font-medium">手机号</th>
                <th className="px-3 py-2 font-medium">身份证号</th>
                <th className="px-3 py-2 font-medium">问题说明</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link
                      href={`/employees/${r.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {r.employeeId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                    <span className="ml-1 text-slate-400">
                      {EMPLOYEE_STATUS_LABEL[r.status] ?? ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.storeName ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{r.departmentName ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{r.positionName ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{r.hireDate ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{r.phone ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{r.idCardNo ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.reason}
                    {r.sourceRowNo !== null && (
                      <span className="ml-1 text-slate-400">（Excel 第 {r.sourceRowNo} 行）</span>
                    )}
                  </td>
                </tr>
              ))}
              {result.data.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-slate-400">
                    ✅ 该类问题当前为 0 条
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between text-[12.5px]">
            <span className="text-slate-500">
              第 {result.page} / {totalPages} 页，共 {result.total} 条
            </span>
            <div className="flex gap-2">
              {result.page > 1 && (
                <Link href={`/data-quality/${key}?page=${result.page - 1}`}>
                  <Button size="sm" variant="secondary">
                    上一页
                  </Button>
                </Link>
              )}
              {result.page < totalPages && (
                <Link href={`/data-quality/${key}?page=${result.page + 1}`}>
                  <Button size="sm" variant="secondary">
                    下一页
                  </Button>
                </Link>
              )}
            </div>
          </div>
        )}
      </Card>

      {key === "duplicate" && (
        <Card title={`参考：合法「重新入职」记录（${rehire.length} 组，不算重复）`}>
          <Alert tone="warn">
            下面这些人<strong>不是重复员工</strong> —— 同一身份证号出现多条记录，
            代表同一人多次入职（离职后再次入职），是真实的任职历史。
            系统按「身份证号 + 入职日期」区分保留，<strong>请勿合并</strong>。
            这里列出来只是为了让 HR 一眼区分「真重复」和「重新入职」。
          </Alert>
          <div className="mt-3 space-y-3">
            {rehire.map((g) => (
              <div key={g.idCardMasked} className="rounded-md border border-slate-200 p-3">
                <div className="text-[12.5px] text-slate-600">
                  <strong className="text-slate-800">{g.name}</strong>
                  <span className="ml-2 text-slate-400">身份证 {g.idCardMasked}</span>
                  <span className="ml-2">共 {g.count} 条任职记录</span>
                </div>
                <ul className="mt-2 space-y-1 text-[12px] text-slate-600">
                  {g.records.map((r) => (
                    <li key={r.id} className="flex flex-wrap gap-3">
                      <Link href={`/employees/${r.id}`} className="text-brand-700 hover:underline">
                        {r.employeeId}
                      </Link>
                      <StatusBadge status={r.status} />
                      <span>入职 {r.hireDate ?? "—"}</span>
                      <span>离职 {r.resignDate ?? "—"}</span>
                      <span>{r.storeName ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
