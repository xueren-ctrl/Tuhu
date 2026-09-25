import Link from "next/link";
import { listEmployees } from "@/lib/employee-service";
import { getSelectOptions } from "@/lib/settings-service";
import { employeeQuerySchema } from "@/lib/validation";
import { Alert, Button, Card } from "@/components/ui";
import EmployeeFilterPanel, {
  type FilterField,
} from "@/components/employees/EmployeeFilterPanel";
import EmployeeViewTable, {
  type ViewColumnKey,
} from "@/components/employees/EmployeeViewTable";
import ListPagination from "@/components/employees/ListPagination";
import { EMPLOYEE_STATUS_LABEL, UNASSIGNED } from "@/lib/constants";

/**
 * 人员视图通用外壳（服务端组件）
 * 各视图页只需声明：路径、锁定条件、要显示的列、标题与说明。
 * 数据一律实时查询 Employee 表。
 */
export default async function PersonnelListView({
  basePath,
  searchParams,
  locked = {},
  hiddenLocked = {},
  columns,
  title,
  hint,
  labelOverrides,
  advanced = false,
  deletable = false,
  emptyText,
  header,
  footer,
}: {
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  /** 锁定条件：固定写入查询（如在职视图固定 status=ACTIVE） */
  locked?: Partial<Record<FilterField, string>>;
  /**
   * Stage 7.3.1：额外锁定条件（不显示在筛选面板里）。
   * 用于「在职员工」页排除「其他」门店 —— 那些待确认归属的人只该出现在「其他员工」页。
   */
  hiddenLocked?: Record<string, string>;
  columns: ViewColumnKey[];
  title: string;
  hint?: string;
  labelOverrides?: Partial<Record<ViewColumnKey, string>>;
  advanced?: boolean;
  deletable?: boolean;
  emptyText?: string;
  /** 表格上方的自定义区块（统计卡片、分布图等） */
  header?: React.ReactNode;
  /** 表格下方的说明 */
  footer?: React.ReactNode;
}) {
  // 扁平化 searchParams
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(searchParams)) {
    flat[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }
  // 锁定条件优先级最高，防止被 URL 覆盖
  for (const [k, v] of Object.entries(locked)) {
    if (v !== undefined && v !== null && v !== "") flat[k] = String(v);
  }
  // Stage 7.3.1：隐藏锁定（不显示在筛选面板，但生效）
  for (const [k, v] of Object.entries(hiddenLocked)) {
    if (v !== undefined && v !== null && v !== "") flat[k] = String(v);
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
      q.storeId === UNASSIGNED
        ? "未分配门店"
        : `门店「${options.stores.find((s) => String(s.id) === q.storeId)?.name ?? q.storeId}」`
    );
  if (q.departmentId)
    chips.push(
      q.departmentId === UNASSIGNED
        ? "未分配部门"
        : `部门「${options.departments.find((d) => String(d.id) === q.departmentId)?.name ?? q.departmentId}」`
    );
  if (q.positionId)
    chips.push(
      q.positionId === UNASSIGNED
        ? "未分配职位"
        : `职位「${options.positions.find((p) => String(p.id) === q.positionId)?.name ?? q.positionId}」`
    );
  if (q.status) chips.push(`状态「${EMPLOYEE_STATUS_LABEL[q.status] ?? q.status}」`);
  if (q.includeDeleted) chips.push("包含已停用档案");

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {header}

      <EmployeeFilterPanel
        basePath={basePath}
        stores={options.stores}
        departments={options.departments}
        positions={options.positions}
        locked={locked}
        advanced={advanced}
        deletable={deletable}
        hint={hint}
      />

      {chips.length ? (
        <Alert tone="info">
          当前筛选：{chips.join(" · ")} —— 命中 <strong>{result.total}</strong> 条记录
        </Alert>
      ) : null}

      <Card
        title={`${title}（${result.total} 条）`}
        extra={
          <div className="flex items-center gap-2">
            <Link href="/employees/views">
              <Button size="sm" variant="ghost">
                ← 人员视图总览
              </Button>
            </Link>
            <Link href="/employees/new">
              <Button size="sm" variant="primary">
                ＋ 新增员工
              </Button>
            </Link>
          </div>
        }
        bodyClassName="p-0"
      >
        <EmployeeViewTable
          rows={result.data}
          columns={columns}
          basePath={basePath}
          labelOverrides={labelOverrides}
          emptyText={emptyText}
        />
        {result.data.length > 0 ? (
          <ListPagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            pageSize={result.pageSize}
            basePath={basePath}
          />
        ) : null}
      </Card>

      {footer}
    </div>
  );
}
