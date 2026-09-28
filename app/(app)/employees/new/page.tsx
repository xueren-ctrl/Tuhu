import Link from "next/link";
import { getSelectOptions } from "@/lib/settings-service";
import { prisma } from "@/lib/prisma";
import { NEW_EMPLOYEE_KINDS, type NewEmployeeKind } from "@/lib/sheet-fields";
import NewEmployeeForm from "@/components/employees/NewEmployeeForm";
import { Alert, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * /employees/new —— 新增员工
 *
 * 先选类型（门店员工 / 运营部员工），再填该类型对应的字段。
 * 字段 = 三张表列名的合并去重（门店：在职+招聘面试登记表+薪资表；运营部：运营部+招聘面试登记表+薪资表）。
 */
export default async function NewEmployeePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.kind) ? sp.kind[0] : sp.kind;
  const kind = (raw === "STORE" || raw === "OPS" ? raw : null) as NewEmployeeKind | null;

  const [options, opsDept] = await Promise.all([
    getSelectOptions(),
    prisma.department.findFirst({ where: { name: "运营部" }, select: { id: true } }),
  ]);

  if (!kind) {
    return (
      <div className="mx-auto max-w-[900px] space-y-4">
        <Alert tone="info">
          新增员工分两类。<strong>先选类型</strong>，系统只显示这一类需要用到的字段
          （三张表的列名合并去重，同一份数据只填一次）。
        </Alert>
        <div className="grid gap-4 sm:grid-cols-2">
          {NEW_EMPLOYEE_KINDS.map((k) => (
            <Link key={k.kind} href={`/employees/new?kind=${k.kind}`} className="block">
              <Card title={k.label} className="h-full transition hover:border-brand-300">
                <p className="text-[12.5px] leading-relaxed text-slate-600">{k.desc}</p>
                <div className="mt-3 text-[12px] text-slate-500">
                  共 <strong className="text-slate-700">{k.fields.length}</strong> 个填写项 ·
                  默认状态：
                  <strong className="text-slate-700">
                    {k.kind === "OPS" ? "运营部" : "已入职"}
                  </strong>
                </div>
                <div className="mt-3 text-[12.5px] font-medium text-brand-600">开始填写 ›</div>
              </Card>
            </Link>
          ))}
        </div>
        <Card title="说明">
          <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-slate-600">
            <li>
              「门店员工」覆盖 <strong>在职 / 南昌3店 / 离职</strong> 这类门店人员；
              「运营部员工」覆盖 <strong>运营部 / 运营部离职</strong>。
            </li>
            <li>
              两类都可以在表单最上方改「员工状态」—— 例如还没入职的可以先建为
              <strong>候选中</strong>（不出现任何表）或<strong>已面试</strong>（只出现在招聘面试登记表）。
            </li>
            <li>保存后系统自动生成员工编号（THHR…），无需手填。</li>
          </ul>
        </Card>
      </div>
    );
  }

  const meta = NEW_EMPLOYEE_KINDS.find((k) => k.kind === kind)!;

  return (
    <div className="mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12.5px] text-slate-500">
          正在新增：<strong className="text-slate-800">{meta.label}</strong> · {meta.desc}
        </div>
        <Link
          href="/employees/new"
          className="h-8 rounded-md border border-slate-300 bg-white px-3 text-[12.5px] leading-8 text-slate-600 hover:bg-slate-50"
        >
          ← 换一种类型
        </Link>
      </div>

      <NewEmployeeForm
        kind={kind}
        fields={meta.fields}
        defaultStatus={meta.defaultStatus}
        stores={options.stores}
        storeScopeRaw={options.storeScope}
        positionScopeRaw={options.positionScope}
        departments={options.departments}
        positions={options.positions}
        opsDepartmentId={opsDept?.id ?? null}
      />
    </div>
  );
}
