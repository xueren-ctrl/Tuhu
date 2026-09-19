import Link from "next/link";
import { listEmployees } from "@/lib/employee-service";
import { getSelectOptions } from "@/lib/settings-service";
import { employeeQuerySchema } from "@/lib/validation";
import { Alert, Button, Card, EmptyState } from "@/components/ui";
import EmployeeFilterBar from "@/components/employees/EmployeeFilterBar";
import EmployeeTable from "@/components/employees/EmployeeTable";
import ListPagination from "@/components/employees/ListPagination";
import { EMPLOYEE_STATUS_LABEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * /employees 员工档案列表
 * 搜索 / 门店筛选 / 职位筛选 / 状态筛选 / 分页 / 排序 全部实时查询数据库。
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }

  const parsed = employeeQuerySchema.safeParse(flat);
  const q = parsed.success ? parsed.data : employeeQuerySchema.parse({});

  const [result, options] = await Promise.all([
    listEmployees(q),
    getSelectOptions(),
  ]);

  // 当前筛选条件的人话描述
  const chips: string[] = [];
  if (q.keyword) chips.push(`关键词「${q.keyword}」`);
  if (q.name) chips.push(`姓名「${q.name}」`);
  if (q.phone) chips.push(`手机号「${q.phone}」`);
  if (q.idCardNo) chips.push(`身份证「${q.idCardNo}」`);
  if (q.storeId)
    chips.push(
      `门店「${options.stores.find((s) => String(s.id) === q.storeId)?.name ?? q.storeId}」`
    );
  if (q.positionId)
    chips.push(
      `职位「${
        options.positions.find((p) => String(p.id) === q.positionId)?.name ?? q.positionId
      }」`
    );
  if (q.status) chips.push(`状态「${EMPLOYEE_STATUS_LABEL[q.status] ?? q.status}」`);
  if (q.includeDeleted) chips.push("包含已停用档案");

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <EmployeeFilterBar stores={options.stores} positions={options.positions} />

      {chips.length ? (
        <Alert tone="info">
          当前筛选：{chips.join(" · ")} —— 命中 <strong>{result.total}</strong> 条记录
        </Alert>
      ) : null}

      <Card
        title={`员工档案（${result.total} 条）`}
        extra={
          <Link href="/employees/new">
            <Button variant="primary" size="sm">
              ＋ 新增员工
            </Button>
          </Link>
        }
        bodyClassName="p-0"
      >
        {result.data.length === 0 ? (
          <EmptyState
            title="没有符合条件的员工"
            desc={
              result.total === 0 && chips.length === 0
                ? "数据库暂无员工记录。请先执行 npm run import:excel 迁移 Excel 数据，或点击「新增员工」手动录入。"
                : "请调整筛选条件后重试。"
            }
            action={
              <div className="flex gap-2">
                <Link href="/employees">
                  <Button>清除筛选</Button>
                </Link>
                <Link href="/employees/new">
                  <Button variant="primary">＋ 新增员工</Button>
                </Link>
              </div>
            }
          />
        ) : (
          <>
            <EmployeeTable rows={result.data} />
            <ListPagination
              page={result.page}
              totalPages={result.totalPages}
              total={result.total}
              pageSize={result.pageSize}
            />
          </>
        )}
      </Card>

      <p className="text-[11.5px] text-slate-400">
        说明：列表中的身份证号与手机号默认脱敏展示；点击「详情」查看完整字段（HR 敏感数据，
        请勿截图外传）。门店列标注「历史」表示该值仅存在于 Excel 原文，尚未匹配到门店主数据。
      </p>
    </div>
  );
}
