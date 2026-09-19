import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { maskObject } from "./mask";
import { EMPLOYEE_STATUS } from "./constants";
import { nextEmployeeId } from "./employee-id";
import { genderFromIdCard } from "./format";
import type { EmployeeQueryInput } from "./validation";

/**
 * 员工业务层 —— 全系统唯一的员工数据访问入口。
 * 所有页面 / API 都必须调用这里，禁止在别处直接写 SQL 或缓存员工数据。
 */

export interface EmployeeListRow {
  id: number;
  employeeId: string;
  name: string;
  idCardNo: string | null;
  phone: string | null;
  storeName: string | null;
  storeNameRaw: string | null;
  positionName: string | null;
  jobGradeRaw: string | null;
  hireDate: string | null;
  resignDate: string | null;
  resignReason: string | null;
  status: string;
  remark: string | null;
  sourceRowNo: number | null;
  dataFlags: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const listSelect = {
  id: true,
  employeeId: true,
  name: true,
  idCardNo: true,
  phone: true,
  storeNameRaw: true,
  jobGradeRaw: true,
  hireDate: true,
  resignDate: true,
  resignReason: true,
  status: true,
  remark: true,
  sourceRowNo: true,
  dataFlags: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  store: { select: { id: true, name: true } },
  position: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

type RawListRow = Prisma.EmployeeGetPayload<{ select: typeof listSelect }>;

function shapeListRow(r: RawListRow): EmployeeListRow {
  return {
    id: r.id,
    employeeId: r.employeeId,
    name: r.name,
    idCardNo: r.idCardNo ?? null,
    phone: r.phone ?? null,
    storeName: r.store?.name ?? null,
    storeNameRaw: r.storeNameRaw ?? null,
    positionName: r.position?.name ?? null,
    jobGradeRaw: r.jobGradeRaw ?? null,
    hireDate: r.hireDate ? r.hireDate.toISOString() : null,
    resignDate: r.resignDate ? r.resignDate.toISOString() : null,
    resignReason: r.resignReason ?? null,
    status: r.status,
    remark: r.remark ?? null,
    sourceRowNo: r.sourceRowNo ?? null,
    dataFlags: r.dataFlags ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

/** 构造查询条件 —— 所有筛选都走数据库实时查询，不做前端过滤 */
export function buildEmployeeWhere(
  q: EmployeeQueryInput
): Prisma.EmployeeWhereInput {
  const and: Prisma.EmployeeWhereInput[] = [];

  if (!q.includeDeleted) {
    and.push({ deletedAt: null });
  }

  // 通用关键词：姓名 / 手机号 / 身份证 / 员工编号
  if (q.keyword?.trim()) {
    const kw = q.keyword.trim();
    and.push({
      OR: [
        { name: { contains: kw } },
        { phone: { contains: kw } },
        { idCardNo: { contains: kw } },
        { employeeId: { contains: kw } },
        { storeNameRaw: { contains: kw } },
        { jobGradeRaw: { contains: kw } },
      ],
    });
  }

  if (q.name?.trim()) and.push({ name: { contains: q.name.trim() } });
  if (q.phone?.trim()) {
    const p = q.phone.trim().replace(/\D/g, "");
    and.push({ phone: { contains: p } });
  }
  if (q.idCardNo?.trim()) {
    const i = q.idCardNo.trim().replace(/[^\dXx]/g, "").toUpperCase();
    and.push({ idCardNo: { contains: i } });
  }
  if (q.storeId?.trim()) {
    const id = Number(q.storeId);
    if (Number.isFinite(id) && id > 0) and.push({ storeId: id });
  }
  if (q.positionId?.trim()) {
    const id = Number(q.positionId);
    if (Number.isFinite(id) && id > 0) and.push({ positionId: id });
  }
  if (q.status) and.push({ status: q.status });

  return and.length ? { AND: and } : {};
}

/** 员工列表（分页 + 排序 + 脱敏） */
export async function listEmployees(q: EmployeeQueryInput) {
  const where = buildEmployeeWhere(q);
  const skip = (q.page - 1) * q.pageSize;

  const [total, rows] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      select: listSelect,
      orderBy: { [q.sortBy]: q.sortOrder },
      skip,
      take: q.pageSize,
    }),
  ]);

  const data: EmployeeListRow[] = rows
    .map((r) => shapeListRow(r))
    // 列表默认脱敏（身份证 / 手机），详情页才是完整值
    .map((r) => maskObject(r, ["idCardNo", "phone"]));

  return {
    data,
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

/** 员工详情（完整字段，含关联门店/职位名称） */
export async function getEmployeeById(id: number, opts?: { mask?: boolean }) {
  const r = await prisma.employee.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true, code: true, region: true } },
      position: { select: { id: true, name: true, category: true, level: true } },
    },
  });
  if (!r) return null;
  const out = {
    ...r,
    storeName: r.store?.name ?? null,
    positionName: r.position?.name ?? null,
  } as Record<string, unknown>;
  return opts?.mask ? maskObject(out) : out;
}

/** 新增员工：自动生成 employee_id，写入数据库 */
export async function createEmployee(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("姓名必填");

  const storeId = (input.storeId as number | null) ?? null;
  const positionId = (input.positionId as number | null) ?? null;

  // 门店/职位：优先用选择的基础数据；同时保留 Excel 原文
  let storeNameRaw = (input.storeNameRaw as string | null) ?? null;
  if (storeId) {
    const s = await prisma.store.findUnique({ where: { id: storeId } });
    if (s) storeNameRaw = storeNameRaw ?? s.name;
  }
  let jobGradeRaw = (input.jobGradeRaw as string | null) ?? null;
  if (positionId) {
    const p = await prisma.position.findUnique({ where: { id: positionId } });
    if (p) jobGradeRaw = jobGradeRaw ?? p.name;
  }

  const idCardNo = (input.idCardNo as string | null) ?? null;
  const gender = (input.gender as string | null) ?? genderFromIdCard(idCardNo);

  const created = await prisma.$transaction(async (tx) => {
    const employeeId = await nextEmployeeId(tx);
    const emp = await tx.employee.create({
      data: {
        ...(input as Prisma.EmployeeUncheckedCreateInput),
        employeeId,
        name,
        idCardNo,
        gender,
        storeId,
        positionId,
        storeNameRaw,
        jobGradeRaw,
      },
    });
    await tx.auditLog.create({
      data: {
        action: "CREATE",
        entity: "Employee",
        entityId: String(emp.id),
        summary: `新增员工 ${name}（${employeeId}）`,
        detail: JSON.stringify(
          maskObject({
            name,
            employeeId,
            idCardNo,
            phone: emp.phone,
          })
        ),
      },
    });
    return emp;
  });

  return created;
}

const IMMUTABLE_FIELDS = new Set([
  "employeeId",
  "id",
  "createdAt",
  "updatedAt",
  "importBatch",
  "sourceSheet",
  "sourceRowNo",
]);

/** 编辑员工：employee_id / createdAt 不可改，updatedAt 自动更新 */
export async function updateEmployee(
  id: number,
  input: Record<string, unknown>
) {
  const existing = await prisma.employee.findUnique({ where: { id } });
  if (!existing) throw new Error("员工不存在");

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (IMMUTABLE_FIELDS.has(k)) continue; // 硬性拦截
    data[k] = v;
  }

  // 门店/职位同步维护原文列
  if ("storeId" in data) {
    const sid = data.storeId as number | null;
    if (sid) {
      const s = await prisma.store.findUnique({ where: { id: sid } });
      if (s) data.storeNameRaw = data.storeNameRaw ?? s.name;
    }
  }
  if ("positionId" in data) {
    const pid = data.positionId as number | null;
    if (pid) {
      const p = await prisma.position.findUnique({ where: { id: pid } });
      if (p) data.jobGradeRaw = data.jobGradeRaw ?? p.name;
    }
  }
  if ("idCardNo" in data && !("gender" in data)) {
    const g = genderFromIdCard(data.idCardNo as string | null);
    if (g) data.gender = g;
  }

  // 状态与离职日期联动（离职则必须有状态，在职则清空离职字段）
  if (data.status === EMPLOYEE_STATUS.ACTIVE) {
    data.resignDate = null;
    data.resignReason = null;
    data.resignDateRaw = null;
  }

  const updated = await prisma.employee.update({ where: { id }, data });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Employee",
      entityId: String(id),
      summary: `编辑员工 ${existing.name}（${existing.employeeId}）`,
      detail: JSON.stringify({ changedFields: Object.keys(data) }),
    },
  });
  return updated;
}

/** 软删除（停用）——不做物理删除，保留历史档案 */
export async function softDeleteEmployee(id: number, actor?: string) {
  const existing = await prisma.employee.findUnique({ where: { id } });
  if (!existing) throw new Error("员工不存在");
  const r = await prisma.employee.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      actor,
      action: "SOFT_DELETE",
      entity: "Employee",
      entityId: String(id),
      summary: `停用员工 ${existing.name}（${existing.employeeId}）`,
    },
  });
  return r;
}

/** 恢复（撤销停用） */
export async function restoreEmployee(id: number, actor?: string) {
  const r = await prisma.employee.update({
    where: { id },
    data: { deletedAt: null },
  });
  await prisma.auditLog.create({
    data: {
      actor,
      action: "RESTORE",
      entity: "Employee",
      entityId: String(id),
      summary: `恢复员工 ${r.name}（${r.employeeId}）`,
    },
  });
  return r;
}

/** 首页 Dashboard 统计 —— 全部实时从数据库计算，禁止写死 */
export async function getDashboardStats() {
  const [total, active, resigned, candidate, storeCount, positionCount, deleted] =
    await Promise.all([
      prisma.employee.count({ where: { deletedAt: null } }),
      prisma.employee.count({ where: { deletedAt: null, status: "ACTIVE" } }),
      prisma.employee.count({ where: { deletedAt: null, status: "RESIGNED" } }),
      prisma.employee.count({ where: { deletedAt: null, status: "CANDIDATE" } }),
      prisma.store.count({ where: { status: "ACTIVE" } }),
      prisma.position.count({ where: { status: "ACTIVE" } }),
      prisma.employee.count({ where: { NOT: { deletedAt: null } } }),
    ]);

  return {
    total,
    active,
    resigned,
    candidate,
    storeCount,
    positionCount,
    deleted,
    activeRate: total > 0 ? Math.round((active / total) * 1000) / 10 : 0,
  };
}
