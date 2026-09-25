import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { maskObject } from "./mask";
import { EMPLOYEE_STATUS, UNASSIGNED, UNASSIGNED_LABEL } from "./constants";
import { nextEmployeeId } from "./employee-id";
import { genderFromIdCard } from "./format";
import type { EmployeeQueryInput } from "./validation";
import {
  DEFAULT_OPERATOR,
  diffFields,
  recordEmployeeEvent,
  recordEmployeeHistory,
} from "./history-service";

/**
 * 员工业务层 —— 全系统唯一的员工数据访问入口。
 * 所有页面 / API 都必须调用这里，禁止在别处直接写 SQL 或缓存员工数据。
 */

export interface EmployeeListRow {
  id: number;
  employeeId: string;
  name: string;
  gender: string | null;
  age: number | null;
  idCardNo: string | null;
  phone: string | null;
  storeName: string | null;
  storeNameRaw: string | null;
  departmentName: string | null;
  departmentNameRaw: string | null;
  positionName: string | null;
  jobGradeRaw: string | null;
  hireDate: string | null;
  resignDate: string | null;
  resignReason: string | null;
  status: string;
  remark: string | null;
  sourceRowNo: number | null;
  dataFlags: string | null;
  /** Stage 7.3：7 个「是否」类字段（在职侧只允许 是 / 否 / 空） */
  dormitory: string | null;
  socialInsurancePurchased: string | null;
  laborContract: string | null;
  socialInsuranceAgreement: string | null;
  fireSafetyCommitment: string | null;
  dormitoryWaiver: string | null;
  onboardingMedical: string | null;
  // Stage 7.3.5：「数据库」全表视图需要的完整字段
  storeId: number | null;
  departmentId: number | null;
  positionId: number | null;
  ageRaw: string | null;
  currentAddress: string | null;
  emergencyContact1: string | null;
  emergencyPhone1: string | null;
  emergencyContact2: string | null;
  emergencyPhone2: string | null;
  mentorName: string | null;
  positionNote: string | null;
  certificateLevel: string | null;
  salaryTerms: string | null;
  firstMonthGuarantee: string | null;
  bankBranch: string | null;
  bankAccountNo: string | null;
  docResume: string | null;
  docInterviewEvaluation: string | null;
  docOnboardingForm: string | null;
  docInterviewEvaluation2: string | null;
  resignDateRaw: string | null;
  recruiterName: string | null;
  interviewDate: string | null;
  interviewLocation: string | null;
  interviewResult: string | null;
  interviewerName: string | null;
  interviewHired: string | null;
  remark3: string | null;
  sourceSheet: string | null;
  importBatch: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const listSelect = {
  id: true,
  employeeId: true,
  name: true,
  gender: true,
  age: true,
  idCardNo: true,
  phone: true,
  storeNameRaw: true,
  departmentNameRaw: true,
  jobGradeRaw: true,
  hireDate: true,
  resignDate: true,
  resignReason: true,
  status: true,
  remark: true,
  sourceRowNo: true,
  dataFlags: true,
  // Stage 7.3：人员列表要直接展示/编辑 7 个「是否」字段
  dormitory: true,
  socialInsurancePurchased: true,
  laborContract: true,
  socialInsuranceAgreement: true,
  fireSafetyCommitment: true,
  dormitoryWaiver: true,
  onboardingMedical: true,
  // Stage 7.3.5：「数据库」全表视图需要的完整字段
  storeId: true,
  departmentId: true,
  positionId: true,
  ageRaw: true,
  currentAddress: true,
  emergencyContact1: true,
  emergencyPhone1: true,
  emergencyContact2: true,
  emergencyPhone2: true,
  mentorName: true,
  positionNote: true,
  certificateLevel: true,
  salaryTerms: true,
  firstMonthGuarantee: true,
  bankBranch: true,
  bankAccountNo: true,
  docResume: true,
  docInterviewEvaluation: true,
  docOnboardingForm: true,
  docInterviewEvaluation2: true,
  resignDateRaw: true,
  recruiterName: true,
  interviewDate: true,
  interviewLocation: true,
  interviewResult: true,
  interviewerName: true,
  interviewHired: true,
  remark3: true,
  sourceSheet: true,
  importBatch: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  store: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  position: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

type RawListRow = Prisma.EmployeeGetPayload<{ select: typeof listSelect }>;

function shapeListRow(r: RawListRow): EmployeeListRow {
  return {
    id: r.id,
    employeeId: r.employeeId,
    name: r.name,
    gender: r.gender ?? null,
    age: r.age ?? null,
    idCardNo: r.idCardNo ?? null,
    phone: r.phone ?? null,
    storeName: r.store?.name ?? null,
    storeNameRaw: r.storeNameRaw ?? null,
    departmentName: r.department?.name ?? null,
    departmentNameRaw: r.departmentNameRaw ?? null,
    positionName: r.position?.name ?? null,
    jobGradeRaw: r.jobGradeRaw ?? null,
    hireDate: r.hireDate ? r.hireDate.toISOString() : null,
    resignDate: r.resignDate ? r.resignDate.toISOString() : null,
    resignReason: r.resignReason ?? null,
    status: r.status,
    remark: r.remark ?? null,
    sourceRowNo: r.sourceRowNo ?? null,
    dataFlags: r.dataFlags ?? null,
    dormitory: r.dormitory ?? null,
    socialInsurancePurchased: r.socialInsurancePurchased ?? null,
    laborContract: r.laborContract ?? null,
    socialInsuranceAgreement: r.socialInsuranceAgreement ?? null,
    fireSafetyCommitment: r.fireSafetyCommitment ?? null,
    dormitoryWaiver: r.dormitoryWaiver ?? null,
    onboardingMedical: r.onboardingMedical ?? null,
    // Stage 7.3.5
    storeId: r.storeId,
    departmentId: r.departmentId,
    positionId: r.positionId,
    ageRaw: r.ageRaw ?? null,
    currentAddress: r.currentAddress ?? null,
    emergencyContact1: r.emergencyContact1 ?? null,
    emergencyPhone1: r.emergencyPhone1 ?? null,
    emergencyContact2: r.emergencyContact2 ?? null,
    emergencyPhone2: r.emergencyPhone2 ?? null,
    mentorName: r.mentorName ?? null,
    positionNote: r.positionNote ?? null,
    certificateLevel: r.certificateLevel ?? null,
    salaryTerms: r.salaryTerms ?? null,
    firstMonthGuarantee: r.firstMonthGuarantee ?? null,
    bankBranch: r.bankBranch ?? null,
    bankAccountNo: r.bankAccountNo ?? null,
    docResume: r.docResume ?? null,
    docInterviewEvaluation: r.docInterviewEvaluation ?? null,
    docOnboardingForm: r.docOnboardingForm ?? null,
    docInterviewEvaluation2: r.docInterviewEvaluation2 ?? null,
    resignDateRaw: r.resignDateRaw ?? null,
    recruiterName: r.recruiterName ?? null,
    interviewDate: r.interviewDate ? r.interviewDate.toISOString() : null,
    interviewLocation: r.interviewLocation ?? null,
    interviewResult: r.interviewResult ?? null,
    interviewerName: r.interviewerName ?? null,
    interviewHired: r.interviewHired ?? null,
    remark3: r.remark3 ?? null,
    sourceSheet: r.sourceSheet ?? null,
    importBatch: r.importBatch ?? null,
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

  // 通用关键词：姓名 / 手机号 / 身份证 / 员工编号 / 门店名（含别名）/ 工种
  // 「含别名」这一条很关键：同一家门店无论用标准名还是别名检索，
  // 结果必须完全一致 —— 这是门店别名功能的验收点。
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
        { store: { name: { contains: kw } } },
        { store: { aliases: { some: { alias: { contains: kw } } } } },
        { department: { name: { contains: kw } } },
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
    if (q.storeId === UNASSIGNED) and.push({ storeId: null });
    else {
      const id = Number(q.storeId);
      if (Number.isFinite(id) && id > 0) and.push({ storeId: id });
    }
  }
  // Stage 7.3.8：限定某几个门店（「南昌3店」页覆盖三家门店）
  if (q.storeIds?.trim()) {
    const ids = q.storeIds
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length > 0) and.push({ storeId: { in: ids } });
  }
  // Stage 7.3.8：排除指定门店，让各类人只出现在各自的页面上：
  //   在职页排除「其他」门店（归属待确认）+「南昌3店」三家门店
  // 用纯 notIn：storeId 为 null 的人（只挂部门的运营部员工、无门店的待确认人员）
  // 天然不满足 notIn，会被一起排除 —— 这正是「在职页 = 纯门店在职员工」想要的效果。
  if (q.excludeStoreIds?.trim()) {
    const ids = q.excludeStoreIds
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length > 0) and.push({ storeId: { notIn: ids } });
  }
  if (q.departmentId?.trim()) {
    if (q.departmentId === UNASSIGNED) and.push({ departmentId: null });
    else {
      const id = Number(q.departmentId);
      if (Number.isFinite(id) && id > 0) and.push({ departmentId: id });
    }
  }
  if (q.positionId?.trim()) {
    if (q.positionId === UNASSIGNED) and.push({ positionId: null });
    else {
      const id = Number(q.positionId);
      if (Number.isFinite(id) && id > 0) and.push({ positionId: id });
    }
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
      department: { select: { id: true, name: true, deptType: true } },
      position: { select: { id: true, name: true, category: true, level: true } },
    },
  });
  if (!r) return null;
  const out = {
    ...r,
    storeName: r.store?.name ?? null,
    departmentName: r.department?.name ?? null,
    positionName: r.position?.name ?? null,
  } as Record<string, unknown>;
  return opts?.mask ? maskObject(out) : out;
}

/** 新增员工：自动生成 employee_id，写入数据库 */
export async function createEmployee(input: Record<string, unknown>, operator?: string) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("姓名必填");

  const storeId = (input.storeId as number | null) ?? null;
  const departmentId = (input.departmentId as number | null) ?? null;
  const positionId = (input.positionId as number | null) ?? null;

  // 门店/部门/职位：优先用选择的基础数据；同时保留 Excel 原文
  let storeNameRaw = (input.storeNameRaw as string | null) ?? null;
  if (storeId) {
    const s = await prisma.store.findUnique({ where: { id: storeId } });
    if (s) storeNameRaw = storeNameRaw ?? s.name;
  }
  let departmentNameRaw = (input.departmentNameRaw as string | null) ?? null;
  if (departmentId) {
    const d = await prisma.department.findUnique({ where: { id: departmentId } });
    if (d) departmentNameRaw = departmentNameRaw ?? d.name;
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
        departmentId,
        positionId,
        storeNameRaw,
        departmentNameRaw,
        jobGradeRaw,
      },
    });
    await tx.auditLog.create({
      data: {
        actor: operator ?? null,
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

  // 变更记录：新增事件（第三阶段）
  await recordEmployeeEvent({
    employeeId: created.id,
    employeeCode: created.employeeId,
    source: "CREATE",
    label: "新增员工",
    value: created.employeeId,
    operator,
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
  input: Record<string, unknown>,
  operator?: string
) {
  const existing = await prisma.employee.findUnique({ where: { id } });
  if (!existing) throw new Error("员工不存在");

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (IMMUTABLE_FIELDS.has(k)) continue; // 硬性拦截
    data[k] = v;
  }

  // 门店/部门/职位同步维护原文列
  if ("storeId" in data) {
    const sid = data.storeId as number | null;
    if (sid) {
      const s = await prisma.store.findUnique({ where: { id: sid } });
      if (s) data.storeNameRaw = data.storeNameRaw ?? s.name;
    }
  }
  if ("departmentId" in data) {
    const did = data.departmentId as number | null;
    if (did) {
      const d = await prisma.department.findUnique({ where: { id: did } });
      if (d) data.departmentNameRaw = data.departmentNameRaw ?? d.name;
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
      actor: operator ?? null,
      action: "UPDATE",
      entity: "Employee",
      entityId: String(id),
      summary: `编辑员工 ${existing.name}（${existing.employeeId}）`,
      detail: JSON.stringify({ changedFields: Object.keys(data) }),
    },
  });

  // 变更记录：逐字段 diff（第三阶段）—— 只写真正变化的字段
  const changes = diffFields(
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    Array.from(new Set([...Object.keys(data), ...HISTORY_TRACKED_FIELDS]))
  );
  await recordEmployeeHistory({
    employeeId: id,
    employeeCode: updated.employeeId,
    source: "UPDATE",
    operator,
    changes,
  });

  return updated;
}

/**
 * 参与变更记录比对的字段。
 *
 * 这里刻意把「外键」和「同名原文列」一起纳入：
 * 改门店时 storeId 与 storeNameRaw 会同时变，只记外键对业务同事不直观。
 * 敏感的原文列（身份证 / 银行卡 / 手机号 / 住址 / 薪资）会由
 * recordEmployeeHistory 统一脱敏，不会把明文写进历史表。
 */
const HISTORY_TRACKED_FIELDS: string[] = [
  "storeId",
  "storeNameRaw",
  "departmentId",
  "departmentNameRaw",
  "positionId",
  "jobGradeRaw",
  "status",
  "resignDate",
  "resignDateRaw",
  "resignReason",
];

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
  await recordEmployeeEvent({
    employeeId: id,
    employeeCode: existing.employeeId,
    source: "SOFT_DELETE",
    label: "停用档案",
    value: new Date().toISOString().slice(0, 10),
    operator: actor,
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
  await recordEmployeeEvent({
    employeeId: id,
    employeeCode: r.employeeId,
    source: "RESTORE",
    label: "恢复档案",
    value: null,
    operator: actor,
  });
  return r;
}

// ------------------------------------------------------------
// 批量编辑（第三阶段新增）
//
// ------------------------------------------------------------
// 批量编辑（第三阶段新增；Stage 7.1.1 事务收口）
//
// 需求：按「部门为空 / 岗位为空 / 门店为空」筛出员工，批量修改部门 / 岗位 / 门店。
// 约定：
// 1. 只允许改这三个归属字段 —— 状态、日期、身份信息一律不参与批量修改，
//    避免一次误操作改坏大量档案。
// 2. 逐条写 EmployeeHistory（来源 BATCH_UPDATE，同一次操作共享 batchKey）。
// 3. 原始溯源列（storeNameRaw / departmentNameRaw / jobGradeRaw）**保留不动**：
//    它们是 Excel 的历史证据（Stage 7.1 起），治理变更只动外键字段，
//    原文列继续可追溯「Excel 里当时写的到底是什么」。
// 4. **Stage 7.1.1 全批原子事务**：每个员工的「档案修改 + 变更历史」与
//    批次审计日志全部在同一个 prisma.$transaction 中完成 ——
//    任一步失败（含 History 写入失败、审计写入失败）→ 整批回滚，
//    绝不出现「员工改了一半、或员工改了但历史没写、或历史写了但审计没记」。
//    因此本函数的 failed 永远为 0：要么全部成功，要么整体抛错（调用方捕获）。
// ------------------------------------------------------------

export const BATCH_EDITABLE_FIELDS = ["storeId", "departmentId", "positionId"] as const;
export type BatchEditableField = (typeof BATCH_EDITABLE_FIELDS)[number];

/** 批量修改被事务回滚时抛出（API 层可据此返回 409/400） */
export class BatchUpdateAbortedError extends Error {
  constructor(detail: string) {
    super("批量修改已整体回滚（员工档案与变更历史均未保留任何改动）：" + detail);
    this.name = "BatchUpdateAbortedError";
  }
}

export interface BatchUpdateResult {
  matched: number;
  updated: number;
  unchanged: number;
  /** Stage 7.1.1 全批原子：0（无失败），或整批回滚后为被回滚的匹配数（仅用于调用方统计） */
  failed: number;
  batchKey: string;
  changedFields: string[];
  /** 全批原子模式下：true 表示发生过回滚（配合 failed>0 出现，调用方应视为整体失败） */
  aborted?: boolean;
  failures: { id: number; name: string; message: string }[];
}

/**
 * 批量修改员工的归属字段（**全批原子事务**，Stage 7.1.1）。
 *
 * @param ids 明确指定要修改的员工（与 filter 二选一）
 * @param filter 按查询条件筛选（复用列表页同一套 where 构造）
 * @param tx 可选：外部传入的事务客户端（部门自动归属整批复用时使用，
 *           不传则自动开一个独立事务）。**传入 tx 时本函数不再自行包事务**，
 *           原子性由外层事务保证。
 *
 * 返回口径（规格第三节）：
 *   - 成功：matched = 目标人数；updated = 实际值变化的；unchanged = 值未变的；
 *     failed = 0；批次审计 + 逐条历史全部落库。
 *   - 任一步失败：整批回滚（员工档案保持执行前状态、无任何历史、无审计），
 *     抛 BatchUpdateAbortedError；不返回「表面 failed 实际已部分修改」的结果。
 */
export async function batchUpdateEmployees(
  opts: {
    ids?: number[];
    filter?: EmployeeQueryInput;
    patch: Partial<Record<BatchEditableField, number | null>>;
    operator?: string;
    tx?: Prisma.TransactionClient;
  }
): Promise<BatchUpdateResult> {
  const { ids, filter, patch, tx } = opts;
  const db = tx ?? prisma;
  const operator = opts.operator ?? DEFAULT_OPERATOR;

  const cleanPatch: Record<string, number | null> = {};
  for (const f of BATCH_EDITABLE_FIELDS) {
    if (f in patch) cleanPatch[f] = patch[f] ?? null;
  }
  const changedFields = Object.keys(cleanPatch);
  if (!changedFields.length) throw new Error("没有选择要修改的字段");

  // 目标集合
  let targetIds: number[];
  if (ids?.length) {
    targetIds = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  } else if (filter) {
    const rows = await db.employee.findMany({
      where: buildEmployeeWhere(filter),
      select: { id: true },
    });
    targetIds = rows.map((r) => r.id);
  } else {
    throw new Error("必须指定要修改的员工或筛选条件");
  }

  const batchKey = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result: BatchUpdateResult = {
    matched: targetIds.length,
    updated: 0,
    unchanged: 0,
    failed: 0,
    batchKey,
    changedFields,
    failures: [],
  };
  if (!targetIds.length) return result;

  const runInTx = async (t: Prisma.TransactionClient): Promise<BatchUpdateResult> => {
    const employees = await t.employee.findMany({
      where: { id: { in: targetIds } },
      select: {
        id: true,
        employeeId: true,
        name: true,
        storeId: true,
        departmentId: true,
        positionId: true,
      },
    });

    for (const e of employees) {
      const data: Record<string, unknown> = { ...cleanPatch };

      const changed = changedFields.some((f) => e[f as BatchEditableField] !== cleanPatch[f]);
      if (!changed) {
        result.unchanged++;
        continue;
      }

      // ① 档案修改（事务内）
      await t.employee.update({
        where: { id: e.id },
        data,
        select: { storeId: true, departmentId: true, positionId: true },
      });
      // ② 变更历史（同一事务，写失败 → 整批回滚）
      await recordEmployeeHistory({
        employeeId: e.id,
        employeeCode: e.employeeId,
        source: "BATCH_UPDATE",
        batchKey,
        operator,
        changes: diffFields(
          e as unknown as Record<string, unknown>,
          {
            storeId: cleanPatch.storeId ?? e.storeId,
            departmentId: cleanPatch.departmentId ?? e.departmentId,
            positionId: cleanPatch.positionId ?? e.positionId,
          },
          ["storeId", "departmentId", "positionId"]
        ),
        tx: t,
      });
      result.updated++;
    }

    // ③ 批次审计（与业务修改同事务 —— 失败则整批回滚，不留「员工改了但没审计」）
    await t.auditLog.create({
      data: {
        actor: operator,
        action: "BATCH_UPDATE",
        entity: "Employee",
        entityId: batchKey,
        summary: `批量修改员工归属：匹配 ${result.matched} 人，实际修改 ${result.updated} 人`,
        detail: JSON.stringify({ changedFields, patch: cleanPatch, batchKey, at: new Date().toISOString() }),
      },
    });
    return result;
  };

  try {
    if (tx) {
      // 外层已提供事务（如部门自动归属整批），直接在其中执行
      await runInTx(tx);
    } else {
      await prisma.$transaction(async (t) => {
        await runInTx(t);
      });
    }
  } catch (err) {
    // 整批回滚：员工档案 / 变更历史 / 批次审计 全部恢复到执行前状态
    result.aborted = true;
    result.failed = result.matched;
    throw new BatchUpdateAbortedError((err as Error).message);
  }
  return result;
}

/** 首页 Dashboard 统计 —— 全部实时从数据库计算，禁止写死 */
export async function getDashboardStats() {
  const [
    total,
    active,
    resigned,
    candidate,
    storeCount,
    departmentCount,
    positionCount,
    deleted,
  ] = await Promise.all([
    prisma.employee.count({ where: { deletedAt: null } }),
    prisma.employee.count({ where: { deletedAt: null, status: "ACTIVE" } }),
    prisma.employee.count({ where: { deletedAt: null, status: "RESIGNED" } }),
    prisma.employee.count({ where: { deletedAt: null, status: "CANDIDATE" } }),
    prisma.store.count({ where: { status: "ACTIVE" } }),
    prisma.department.count({ where: { status: "ACTIVE" } }),
    prisma.position.count({ where: { status: "ACTIVE" } }),
    prisma.employee.count({ where: { NOT: { deletedAt: null } } }),
  ]);

  return {
    total,
    active,
    resigned,
    candidate,
    storeCount,
    departmentCount,
    positionCount,
    deleted,
    activeRate: total > 0 ? Math.round((active / total) * 1000) / 10 : 0,
  };
}

// ============================================================
// 人员分布统计（第二阶段）
// 全部实时聚合 Employee 表，不落任何中间表、不使用 mock 数据
// ============================================================

export interface DistributionRow {
  key: string;
  id: number | null;
  label: string;
  total: number;
  active: number;
  resigned: number;
  candidate: number;
}

type DistGroup = {
  id: number | null;
  label: string;
  total: number;
  active: number;
  resigned: number;
  candidate: number;
};

function toRows(groups: DistGroup[], unassignedLabel: string): DistributionRow[] {
  return groups
    .map((g) => ({
      key: g.id === null ? UNASSIGNED : String(g.id),
      id: g.id,
      label: g.id === null ? unassignedLabel : g.label,
      total: g.total,
      active: g.active,
      resigned: g.resigned,
      candidate: g.candidate,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "zh-CN"));
}

/** 按门店分布（含「未分配门店」） */
export async function getStoreDistribution(): Promise<DistributionRow[]> {
  const rows = await prisma.store.findMany({
    select: {
      id: true,
      name: true,
      employees: {
        where: { deletedAt: null },
        select: { status: true },
      },
    },
  });
  const groups: DistGroup[] = rows.map((s) => ({
    id: s.id,
    label: s.name,
    total: s.employees.length,
    active: s.employees.filter((e) => e.status === "ACTIVE").length,
    resigned: s.employees.filter((e) => e.status === "RESIGNED").length,
    candidate: s.employees.filter((e) => e.status === "CANDIDATE").length,
  }));
  const unassigned = await prisma.employee.count({
    where: { storeId: null, deletedAt: null },
  });
  if (unassigned > 0) {
    const [a, r, c] = await Promise.all([
      prisma.employee.count({ where: { storeId: null, deletedAt: null, status: "ACTIVE" } }),
      prisma.employee.count({ where: { storeId: null, deletedAt: null, status: "RESIGNED" } }),
      prisma.employee.count({ where: { storeId: null, deletedAt: null, status: "CANDIDATE" } }),
    ]);
    groups.push({ id: null, label: UNASSIGNED_LABEL, total: unassigned, active: a, resigned: r, candidate: c });
  }
  return toRows(groups, UNASSIGNED_LABEL);
}

/** 按部门分布（含「未分配部门」） */
export async function getDepartmentDistribution(): Promise<DistributionRow[]> {
  const rows = await prisma.department.findMany({
    select: {
      id: true,
      name: true,
      employees: { where: { deletedAt: null }, select: { status: true } },
    },
  });
  const groups: DistGroup[] = rows.map((d) => ({
    id: d.id,
    label: d.name,
    total: d.employees.length,
    active: d.employees.filter((e) => e.status === "ACTIVE").length,
    resigned: d.employees.filter((e) => e.status === "RESIGNED").length,
    candidate: d.employees.filter((e) => e.status === "CANDIDATE").length,
  }));
  const unassigned = await prisma.employee.count({
    where: { departmentId: null, deletedAt: null },
  });
  if (unassigned > 0) {
    const [a, r, c] = await Promise.all([
      prisma.employee.count({ where: { departmentId: null, deletedAt: null, status: "ACTIVE" } }),
      prisma.employee.count({ where: { departmentId: null, deletedAt: null, status: "RESIGNED" } }),
      prisma.employee.count({ where: { departmentId: null, deletedAt: null, status: "CANDIDATE" } }),
    ]);
    groups.push({ id: null, label: UNASSIGNED_LABEL, total: unassigned, active: a, resigned: r, candidate: c });
  }
  return toRows(groups, UNASSIGNED_LABEL);
}

/** 按岗位分布（含「未分配岗位」） */
export async function getPositionDistribution(): Promise<DistributionRow[]> {
  const rows = await prisma.position.findMany({
    select: {
      id: true,
      name: true,
      employees: { where: { deletedAt: null }, select: { status: true } },
    },
  });
  const groups: DistGroup[] = rows.map((p) => ({
    id: p.id,
    label: p.name,
    total: p.employees.length,
    active: p.employees.filter((e) => e.status === "ACTIVE").length,
    resigned: p.employees.filter((e) => e.status === "RESIGNED").length,
    candidate: p.employees.filter((e) => e.status === "CANDIDATE").length,
  }));
  const unassigned = await prisma.employee.count({
    where: { positionId: null, deletedAt: null },
  });
  if (unassigned > 0) {
    const [a, r, c] = await Promise.all([
      prisma.employee.count({ where: { positionId: null, deletedAt: null, status: "ACTIVE" } }),
      prisma.employee.count({ where: { positionId: null, deletedAt: null, status: "RESIGNED" } }),
      prisma.employee.count({ where: { positionId: null, deletedAt: null, status: "CANDIDATE" } }),
    ]);
    groups.push({ id: null, label: UNASSIGNED_LABEL, total: unassigned, active: a, resigned: r, candidate: c });
  }
  return toRows(groups, UNASSIGNED_LABEL);
}

/**
 * 指定门店的岗位分布 + 人数汇总。
 * 用于「门店人员查询」页：选择门店后展示在职/离职人数与岗位分布。
 */
export async function getStoreSummary(storeId: number) {
  const where = { storeId, deletedAt: null } as const;
  const [total, active, resigned, candidate, byPosition] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.count({ where: { ...where, status: "ACTIVE" } }),
    prisma.employee.count({ where: { ...where, status: "RESIGNED" } }),
    prisma.employee.count({ where: { ...where, status: "CANDIDATE" } }),
    prisma.employee.groupBy({
      by: ["positionId", "status"],
      where,
      _count: { _all: true },
    }),
  ]);

  const posIds = Array.from(
    new Set(byPosition.map((g) => g.positionId).filter((v): v is number => v !== null))
  );
  const positions = await prisma.position.findMany({
    where: { id: { in: posIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(positions.map((p) => [p.id, p.name]));

  const acc = new Map<string, DistributionRow>();
  for (const g of byPosition) {
    const key = g.positionId === null ? UNASSIGNED : String(g.positionId);
    const label = g.positionId === null ? UNASSIGNED_LABEL : (nameById.get(g.positionId) ?? `#${g.positionId}`);
    const cur =
      acc.get(key) ??
      { key, id: g.positionId, label, total: 0, active: 0, resigned: 0, candidate: 0 };
    cur.total += g._count._all;
    if (g.status === "ACTIVE") cur.active += g._count._all;
    else if (g.status === "RESIGNED") cur.resigned += g._count._all;
    else if (g.status === "CANDIDATE") cur.candidate += g._count._all;
    acc.set(key, cur);
  }

  return {
    total,
    active,
    resigned,
    candidate,
    positionDistribution: Array.from(acc.values()).sort(
      (a, b) => b.active - a.active || b.total - a.total || a.label.localeCompare(b.label, "zh-CN")
    ),
  };
}

/** 指定部门的岗位分布 + 人数汇总。用于「部门人员查询」页。 */
export async function getDepartmentSummary(departmentId: number) {
  const where = { departmentId, deletedAt: null } as const;
  const [total, active, resigned, candidate, byPosition] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.count({ where: { ...where, status: "ACTIVE" } }),
    prisma.employee.count({ where: { ...where, status: "RESIGNED" } }),
    prisma.employee.count({ where: { ...where, status: "CANDIDATE" } }),
    prisma.employee.groupBy({
      by: ["positionId", "status"],
      where,
      _count: { _all: true },
    }),
  ]);

  const posIds = Array.from(
    new Set(byPosition.map((g) => g.positionId).filter((v): v is number => v !== null))
  );
  const positions = await prisma.position.findMany({
    where: { id: { in: posIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(positions.map((p) => [p.id, p.name]));

  const acc = new Map<string, DistributionRow>();
  for (const g of byPosition) {
    const key = g.positionId === null ? UNASSIGNED : String(g.positionId);
    const label = g.positionId === null ? UNASSIGNED_LABEL : (nameById.get(g.positionId) ?? `#${g.positionId}`);
    const cur =
      acc.get(key) ??
      { key, id: g.positionId, label, total: 0, active: 0, resigned: 0, candidate: 0 };
    cur.total += g._count._all;
    if (g.status === "ACTIVE") cur.active += g._count._all;
    else if (g.status === "RESIGNED") cur.resigned += g._count._all;
    else if (g.status === "CANDIDATE") cur.candidate += g._count._all;
    acc.set(key, cur);
  }

  return {
    total,
    active,
    resigned,
    candidate,
    positionDistribution: Array.from(acc.values()).sort(
      (a, b) => b.active - a.active || b.total - a.total || a.label.localeCompare(b.label, "zh-CN")
    ),
  };
}

// ------------------------------------------------------------
// 首页 Dashboard 专用查询
//
// 说明：首页原本直连 prisma 查这两项，违反「employee-service 是员工数据
// 唯一访问入口」的约定（虽然查的是同一张 Employee 表，不构成第二份数据源）。
// 现统一收敛到本文件，页面不再直接访问 prisma.employee。
// ------------------------------------------------------------

/** 员工表总行数（含已软删除档案），供首页「数据库概览」展示 */
export async function countEmployeeRows(): Promise<number> {
  return prisma.employee.count();
}

/** 最近新增员工（默认 6 条），供首页「最近新增」列表 */
export async function getRecentEmployees(take = 6) {
  const rows = await prisma.employee.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      employeeId: true,
      name: true,
      status: true,
      hireDate: true,
      storeNameRaw: true,
      jobGradeRaw: true,
      store: { select: { name: true } },
      position: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    ...r,
    storeName: r.store?.name ?? null,
    positionName: r.position?.name ?? null,
  }));
}
