import { prisma } from "./prisma";

/**
 * 基础设置 —— 门店 / 职位
 * 员工的门店、职位字段优先从这些基础数据中选择；
 * 但迁移 Excel 时保留的历史门店/职位原文（storeNameRaw / jobGradeRaw）不会被覆盖。
 */

// ---------------------------- 门店 ----------------------------

export async function listStores(opts?: {
  keyword?: string;
  status?: string;
  includeInactive?: boolean;
}) {
  const and: Record<string, unknown>[] = [];
  if (opts?.status && opts.status !== "") and.push({ status: opts.status });
  else if (!opts?.includeInactive) and.push({ status: "ACTIVE" });
  if (opts?.keyword?.trim()) {
    const kw = opts.keyword.trim();
    and.push({
      OR: [{ name: { contains: kw } }, { code: { contains: kw } }, { region: { contains: kw } }],
    });
  }
  const rows = await prisma.store.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { _count: { select: { employees: true } } },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    code: s.code,
    region: s.region,
    address: s.address,
    plannedHeadcount: s.plannedHeadcount,
    status: s.status,
    remark: s.remark,
    employeeCount: s._count.employees,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}

export async function createStore(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("门店名称必填");
  const dup = await prisma.store.findUnique({ where: { name } });
  if (dup) throw new Error(`门店「${name}」已存在`);
  const s = await prisma.store.create({ data: input as never });
  await prisma.auditLog.create({
    data: {
      action: "CREATE",
      entity: "Store",
      entityId: String(s.id),
      summary: `新增门店 ${name}`,
    },
  });
  return s;
}

export async function updateStore(id: number, input: Record<string, unknown>) {
  const existing = await prisma.store.findUnique({ where: { id } });
  if (!existing) throw new Error("门店不存在");
  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  if (!name) throw new Error("门店名称必填");
  if (name !== existing.name) {
    const dup = await prisma.store.findUnique({ where: { name } });
    if (dup) throw new Error(`门店「${name}」已存在`);
  }
  const s = await prisma.store.update({ where: { id }, data: input as never });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Store",
      entityId: String(id),
      summary: `编辑门店 ${existing.name} -> ${s.name}`,
    },
  });
  return s;
}

/** 停用门店（软停用，不删除，保留历史关联） */
export async function setStoreStatus(id: number, status: "ACTIVE" | "INACTIVE") {
  const s = await prisma.store.update({ where: { id }, data: { status } });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Store",
      entityId: String(id),
      summary: `${status === "ACTIVE" ? "启用" : "停用"}门店 ${s.name}`,
    },
  });
  return s;
}

// ---------------------------- 职位 ----------------------------

export async function listPositions(opts?: {
  keyword?: string;
  status?: string;
  includeInactive?: boolean;
}) {
  const and: Record<string, unknown>[] = [];
  if (opts?.status && opts.status !== "") and.push({ status: opts.status });
  else if (!opts?.includeInactive) and.push({ status: "ACTIVE" });
  if (opts?.keyword?.trim()) {
    const kw = opts.keyword.trim();
    and.push({
      OR: [{ name: { contains: kw } }, { category: { contains: kw } }, { level: { contains: kw } }],
    });
  }
  const rows = await prisma.position.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { employees: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    level: p.level,
    sortOrder: p.sortOrder,
    status: p.status,
    remark: p.remark,
    employeeCount: p._count.employees,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

export async function createPosition(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("职位名称必填");
  const dup = await prisma.position.findUnique({ where: { name } });
  if (dup) throw new Error(`职位「${name}」已存在`);
  const p = await prisma.position.create({ data: input as never });
  await prisma.auditLog.create({
    data: {
      action: "CREATE",
      entity: "Position",
      entityId: String(p.id),
      summary: `新增职位 ${name}`,
    },
  });
  return p;
}

export async function updatePosition(id: number, input: Record<string, unknown>) {
  const existing = await prisma.position.findUnique({ where: { id } });
  if (!existing) throw new Error("职位不存在");
  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  if (!name) throw new Error("职位名称必填");
  if (name !== existing.name) {
    const dup = await prisma.position.findUnique({ where: { name } });
    if (dup) throw new Error(`职位「${name}」已存在`);
  }
  const p = await prisma.position.update({ where: { id }, data: input as never });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Position",
      entityId: String(id),
      summary: `编辑职位 ${existing.name} -> ${p.name}`,
    },
  });
  return p;
}

export async function setPositionStatus(
  id: number,
  status: "ACTIVE" | "INACTIVE"
) {
  const p = await prisma.position.update({ where: { id }, data: { status } });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Position",
      entityId: String(id),
      summary: `${status === "ACTIVE" ? "启用" : "停用"}职位 ${p.name}`,
    },
  });
  return p;
}

/** 门店 / 职位 下拉选项（表单用） */
export async function getSelectOptions() {
  const [stores, positions] = await Promise.all([
    prisma.store.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.position.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, category: true, level: true },
    }),
  ]);
  return { stores, positions };
}
