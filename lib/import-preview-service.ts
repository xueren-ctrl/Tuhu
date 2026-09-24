/**
 * Excel 重新导入 —— 预览批次服务（第五阶段重构）
 *
 * 流程固定：上传 → 解析 → 生成 Diff → 人工确认 → 才写入。
 *
 * 第五阶段修复的四件事：
 *  1. 【数据损坏】旧版把脱敏后的 displayNewValue 当写库值，会把「138****5678」
 *     写进数据库。现在展示值与写库值彻底分离：commit 重新解析后取 **raw** 值写入。
 *  2. 【假成功】旧版逐员工写入后无条件标记 COMMITTED。现在有
 *     PENDING→COMMITTING→SUCCESS/PARTIAL/FAILED 状态机，记录成功/失败明细，
 *     并支持「只重试失败项」。
 *  3. 【看到 A 写入 B】预览时冻结数据库版本指纹，提交前复核；
 *     预览之后数据被改动则拒绝提交，要求重新生成预览。
 *  4. 【两套解析】解析统一走 lib/excel-import，预览与正式导入不可能再漂移。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  parseBuffer,
  computeDiff,
  dateFromIso,
  type DiffResult,
  type EmployeeRecord,
  type FieldChange,
} from "./excel-import";
import { recordEmployeeHistory } from "./history-service";
import { DEFAULT_OPERATOR } from "./history-service";
import { SPEC_BY_FIELD } from "./excel-import/field-mapping";
import { resolveStoreByName, isStoreUsable } from "./store-service";

const IMPORT_DIR = path.join(process.cwd(), "data", "import");
const BATCH_KEY_PREFIX = "import-preview";

/** 状态机 */
export const PREVIEW_STATUS = {
  PENDING: "PENDING",
  COMMITTING: "COMMITTING",
  SUCCESS: "SUCCESS",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  DISCARDED: "DISCARDED",
} as const;

/** 允许再次提交（重试）的状态 */
const RETRYABLE: Set<string> = new Set([
  PREVIEW_STATUS.PARTIAL,
  PREVIEW_STATUS.FAILED,
  PREVIEW_STATUS.COMMITTING,
]);

/** 终态：不允许再次提交 */
const TERMINAL_OK: Set<string> = new Set([
  PREVIEW_STATUS.SUCCESS,
  PREVIEW_STATUS.DISCARDED,
]);

function newPreviewId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
  return `PREVIEW-${stamp}-${randomBytes(4).toString("hex")}`;
}

// ------------------------------------------------------------
// 数据库版本指纹
// ------------------------------------------------------------

/**
 * 冻结当前数据库状态。
 * 只要「员工档案 / 门店 / 职位 / 部门 / 部门规则 / 别名 / 变更历史」任一被改动，指纹就会变。
 * 用于阻止「预览之后有人改了数据，却仍按旧预览写入」。
 *
 * Stage 7.1.3：DepartmentRule 纳入版本指纹（count + max(updatedAt)）——
 * 新增/删除规则、或编辑任一规则字段（enabled/storeId/positionId/employeeType/
 * priority/departmentId 等，写库即刷新 updatedAt），都会改变 dbVersion，
 * 部门自动归属的旧预览随即失效（409 STALE_PREVIEW）。
 */
export async function computeDbVersion(): Promise<string> {
  const [emp, store, pos, dept, rule, alias, hist] = await Promise.all([
    prisma.employee.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.store.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.position.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.department.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.departmentRule.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.storeAlias.aggregate({ _count: { _all: true } }),
    prisma.employeeHistory.aggregate({ _count: { _all: true } }),
  ]);
  return JSON.stringify({
    e: [emp._count._all, emp._max.updatedAt?.toISOString() ?? ""],
    s: [store._count._all, store._max.updatedAt?.toISOString() ?? ""],
    p: [pos._count._all, pos._max.updatedAt?.toISOString() ?? ""],
    d: [dept._count._all, dept._max.updatedAt?.toISOString() ?? ""],
    r: [rule._count._all, rule._max.updatedAt?.toISOString() ?? ""],
    a: alias._count._all,
    h: hist._count._all,
  });
}

// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------

export interface PreviewSummary {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  createdAt: string;
  summary: DiffResult["summary"];
}

export interface PreviewDetail extends PreviewSummary {
  sheetName: string;
  committedAt: string | null;
  operator: string | null;
  diff: DiffResult;
  dbVersion: string;
  fileSha256: string | null;
  lastCommitDbVersion: string | null;
  attemptCount: number;
  successCount: number;
  failedCount: number;
  unchangedCount: number;
  result: CommitResult | null;
}

export interface FailureItem {
  rowNo: number;
  employeeCode?: string | null;
  name?: string | null;
  kind: "update" | "create";
  message: string;
}

export interface CommitResult {
  previewId: string;
  /** 真正写入数据库的条数（修改） */
  updated: number;
  /** 真正写入数据库的条数（新增） */
  created: number;
  /** 无变化、未写入 */
  unchanged: number;
  /** 失败条数 */
  failed: number;
  /** 本次处理的条数（重试时只含失败项） */
  attempted: number;
  failures: FailureItem[];
  /** 是否因版本冲突被拒绝 */
  versionConflict?: boolean;
}

type PreviewRow = {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  createdAt: Date;
  committedAt: Date | null;
  operator: string | null;
  summaryJson: string;
  sheetName: string;
  diffJson: string;
  dbVersion: string;
  fileSha256: string | null;
  lastCommitDbVersion: string | null;
  attemptCount: number;
  successCount: number;
  failedCount: number;
  unchangedCount: number;
  resultJson: string | null;
};

function shape(row: PreviewRow): PreviewDetail {
  return {
    id: row.id,
    fileName: row.fileName,
    fileSize: row.fileSize,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
    operator: row.operator,
    sheetName: row.sheetName,
    summary: JSON.parse(row.summaryJson) as DiffResult["summary"],
    diff: JSON.parse(row.diffJson) as DiffResult,
    dbVersion: row.dbVersion,
    fileSha256: row.fileSha256,
    lastCommitDbVersion: row.lastCommitDbVersion,
    attemptCount: row.attemptCount,
    successCount: row.successCount,
    failedCount: row.failedCount,
    unchangedCount: row.unchangedCount,
    result: row.resultJson ? (JSON.parse(row.resultJson) as CommitResult) : null,
  };
}

const DETAIL_SELECT = {
  id: true,
  fileName: true,
  fileSize: true,
  status: true,
  createdAt: true,
  committedAt: true,
  operator: true,
  summaryJson: true,
  sheetName: true,
  diffJson: true,
  dbVersion: true,
  fileSha256: true,
  lastCommitDbVersion: true,
  attemptCount: true,
  successCount: true,
  failedCount: true,
  unchangedCount: true,
  resultJson: true,
} satisfies Prisma.ImportPreviewSelect;

// ------------------------------------------------------------
// 创建预览
// ------------------------------------------------------------

/**
 * 创建预览：**完全不碰 Employee 表**。
 * 落库的 diffJson 只含脱敏后的 display 值 —— 服务端绝不保存/外发原始敏感值。
 */
export async function createPreview(opts: {
  buffer: Buffer;
  fileName: string;
  operator?: string;
}): Promise<PreviewDetail> {
  const parsed = await parseBuffer(opts.buffer);
  if (!parsed.ok) throw new Error(parsed.error ?? "解析失败");

  const diff = await computeDiff(parsed, { includeRaw: false });
  const dbVersion = await computeDbVersion();
  const fileSha256 = createHash("sha256").update(opts.buffer).digest("hex");

  await fs.mkdir(IMPORT_DIR, { recursive: true });
  const id = newPreviewId();
  const safeName = opts.fileName.replace(/[^\w.\-一-龥]/g, "_");
  const storedName = `${id}__${safeName}`;
  await fs.writeFile(path.join(IMPORT_DIR, storedName), opts.buffer);

  const row = await prisma.importPreview.create({
    data: {
      id,
      fileName: opts.fileName,
      fileSize: opts.buffer.length,
      fileSha256,
      storedPath: path.join("data", "import", storedName),
      sheetName: parsed.sheetName,
      totalRows: parsed.totalRows,
      validRows: parsed.validRows,
      skippedRows: parsed.skippedRows,
      diffJson: JSON.stringify(diff),
      summaryJson: JSON.stringify(diff.summary),
      status: PREVIEW_STATUS.PENDING,
      operator: opts.operator ?? DEFAULT_OPERATOR,
      dbVersion,
    },
    select: DETAIL_SELECT,
  });
  return shape(row);
}

export async function getPreview(id: string): Promise<PreviewDetail | null> {
  const row = await prisma.importPreview.findUnique({ where: { id }, select: DETAIL_SELECT });
  return row ? shape(row as PreviewRow) : null;
}

export async function listPreviews(take = 20): Promise<PreviewSummary[]> {
  const rows = await prisma.importPreview.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      status: true,
      createdAt: true,
      summaryJson: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    fileSize: r.fileSize,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    summary: JSON.parse(r.summaryJson) as DiffResult["summary"],
  }));
}

// ------------------------------------------------------------
// 提交
// ------------------------------------------------------------

/** 把 Diff 里的**真实值**还原成可写入 Prisma 的值 */
function toWriteValue(c: FieldChange): unknown {
  if (c.kind === "fk") return c.newFkId ?? null;
  const raw = c.rawNewValue;
  if (raw === undefined) {
    throw new Error(
      `字段 ${c.field} 缺少写库所需的原始值（rawNewValue）。这属于程序错误，已中止写入以保护数据。`
    );
  }
  if (raw === null) return null;
  if (c.kind === "date") return dateFromIso(raw);
  if (c.kind === "int") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return raw;
}

/**
 * 确认写入。
 *
 * 关键点：
 *  - 重新解析同一份文件，用 **raw** 值写库（绝不用 display 值）；
 *  - 提交前复核数据库版本，不一致直接拒绝；
 *  - 逐条处理并统计，失败不清零：最终状态 SUCCESS / PARTIAL / FAILED；
 *  - 支持「只重试失败项」。
 */
export async function commitPreview(opts: {
  id: string;
  operator?: string;
  /** 只处理上一次失败的项目 */
  retry?: boolean;
}): Promise<CommitResult> {
  const row = await prisma.importPreview.findUnique({
    where: { id: opts.id },
    select: { ...DETAIL_SELECT, storedPath: true },
  });
  if (!row) throw new Error("预览批次不存在");

  const isRetry = opts.retry === true;
  if (row.status === PREVIEW_STATUS.PENDING) {
    // 首次提交
  } else if (RETRYABLE.has(row.status)) {
    if (!isRetry) {
      throw new Error(
        `该批次当前状态为 ${row.status}，存在 ${row.failedCount} 条失败记录。请确认后使用「重试失败项」继续，或重新生成预览。`
      );
    }
  } else if (TERMINAL_OK.has(row.status)) {
    throw new Error(`该批次已${row.status === "SUCCESS" ? "成功提交" : "丢弃"}，不能重复操作`);
  } else {
    throw new Error(`该批次状态为 ${row.status}，不能提交`);
  }

  // ---- ① 版本复核（每一次提交都做，含重试） ----
  // 首次提交以预览创建时冻结的 dbVersion 为基线；
  // 重试以「上一次提交后的数据库指纹」为基线（防止「预览后→首次提交→又被别人改」）。
  const versionBaseline =
    row.status === PREVIEW_STATUS.PENDING
      ? row.dbVersion
      : (row.lastCommitDbVersion ?? row.dbVersion);
  if (versionBaseline) {
    const now = await computeDbVersion();
    if (now !== versionBaseline) {
      await prisma.importPreview.update({
        where: { id: row.id },
        data: { resultJson: JSON.stringify({
          previewId: row.id,
          updated: 0, created: 0, unchanged: 0, failed: 0, attempted: 0,
          failures: [],
          versionConflict: true,
        } satisfies CommitResult) },
      });
      throw new VersionConflictError(
        "数据库在生成预览 / 上次提交后发生变化（员工 / 门店 / 职位 / 部门 / 别名被修改过），为避免「页面看到 A、实际写入 B」已拒绝提交。请重新生成预览。"
      );
    }
  }

  // ---- ② 重新解析（与预览同一套解析器，取真实值） ----
  const buf = await fs.readFile(path.join(process.cwd(), row.storedPath));
  // ②-a 文件完整性校验：重新读取的文件必须和预览时一致，防止「预览 A、写入 B」
  if (row.fileSha256) {
    const currentHash = createHash("sha256").update(buf).digest("hex");
    if (currentHash !== row.fileSha256) {
      throw new FileChangedError(
        "上传文件在预览后发生了变化（SHA256 不匹配）。为防止「预览 A、写入 B」，已拒绝提交。请重新上传并生成预览。"
      );
    }
  }
  const parsed = await parseBuffer(buf);
  if (!parsed.ok) throw new Error(parsed.error ?? "重新解析失败");
  const diff = await computeDiff(parsed, { includeRaw: true });

  const operator = opts.operator ?? row.operator ?? DEFAULT_OPERATOR;
  const batchKey = `${BATCH_KEY_PREFIX}-${row.id}-${row.attemptCount + 1}`;

  // ---- ③ 标记 COMMITTING（进程崩溃也不会留下「假成功」） ----
  await prisma.importPreview.update({
    where: { id: row.id },
    data: { status: PREVIEW_STATUS.COMMITTING, attemptCount: { increment: 1 } },
  });

  // ---- ④ 失败项过滤（重试时） ----
  let failedRowNos: Set<number> | null = null;
  if (isRetry && row.resultJson) {
    try {
      const prev = JSON.parse(row.resultJson) as CommitResult;
      failedRowNos = new Set(prev.failures.map((f) => f.rowNo));
    } catch {
      failedRowNos = null;
    }
  }
  const shouldProcess = (rowNo: number) => failedRowNos === null || failedRowNos.has(rowNo);

  const result: CommitResult = {
    previewId: row.id,
    updated: 0,
    created: 0,
    unchanged: 0,
    failed: 0,
    attempted: 0,
    failures: [],
  };

  const rowsByNo = new Map<number, EmployeeRecord>(parsed.rows.map((r) => [r.rowNo, r]));

  // ---- ⑤ 修改已有员工 ----
  for (const m of diff.modified) {
    if (!shouldProcess(m.rowNo)) continue;
    result.attempted++;

    const patch: Record<string, unknown> = {};
    const historyChanges: { field: string; oldValue: unknown; newValue: unknown }[] = [];
    try {
      for (const c of m.changes) {
        const v = toWriteValue(c);
        patch[c.field] = v;
        historyChanges.push({ field: c.field, oldValue: c.rawOldValue, newValue: c.rawNewValue });
      }
      if (Object.keys(patch).length === 0) {
        result.unchanged++;
        continue;
      }
      // 同一员工的「档案更新 + 变更历史」必须落在同一个事务里：
      // 任一步失败整体回滚（仅回滚该员工），不影响其他员工。
      await prisma.$transaction(async (tx) => {
        await tx.employee.update({ where: { id: m.employeeId }, data: patch as never });
        await recordEmployeeHistory({
          employeeId: m.employeeId,
          employeeCode: m.employeeCode,
          source: "BATCH_UPDATE",
          batchKey,
          operator,
          changes: historyChanges,
          tx,
        });
      });
      result.updated++;
    } catch (e) {
      result.failed++;
      result.failures.push({
        rowNo: m.rowNo,
        employeeCode: m.employeeCode,
        name: m.name,
        kind: "update",
        message: (e as Error).message,
      });
    }
  }

  // ---- ⑥ 新增员工 ----
  for (const c of diff.created) {
    if (!shouldProcess(c.rowNo)) continue;
    result.attempted++;

    if (!c.name) {
      result.failed++;
      result.failures.push({ rowNo: c.rowNo, name: null, kind: "create", message: "姓名为空，跳过" });
      continue;
    }
    try {
      const rec = rowsByNo.get(c.rowNo);
      if (!rec) throw new Error("无法定位该行的解析结果");

      const data: Record<string, unknown> = {};
      for (const [field, v] of Object.entries(rec.values)) {
        const spec = SPEC_BY_FIELD.get(field);
        if (!spec) continue;
        if (spec.kind === "date") data[field] = dateFromIso(v as string | null);
        else data[field] = v;
      }
      data.sourceSheet = parsed.sheetName;
      data.sourceRowNo = rec.rowNo;
      data.dataFlags = rec.dataFlags.length ? JSON.stringify(rec.dataFlags) : null;

      // 门店 / 岗位按名称解析外键
      // Stage 7.1.5（P0）：门店解析改走统一 resolver（与预览 diff.ts、import-excel.ts
      // 完全同一套规则）：ACTIVE 同名门店 > 指向 ACTIVE 门店的别名 > null。
      // 预览与提交绝不漂移：不会出现「预览挂 ACTIVE 主店、提交却挂 INACTIVE 旧店」。
      if (rec.storeNameRaw) {
        const res = await resolveStoreByName(rec.storeNameRaw);
        data.storeId = isStoreUsable(res) ? res.storeId : null;
      }
      if (rec.jobGradeRaw) {
        const p = await prisma.position.findFirst({ where: { name: rec.jobGradeRaw } });
        data.positionId = p ? p.id : null;
      }

      // 编号分配与「建档 + 溯源映射 + 变更历史」整体落在一个事务里
      const employeeId = await nextEmployeeIdSafe();
      await prisma.$transaction(async (tx) => {
        const created = await tx.employee.create({
          data: { ...data, employeeId } as never,
        });
        await tx.employeeSourceRow.upsert({
          where: { sheet_rowNo: { sheet: parsed.sheetName, rowNo: rec.rowNo } },
          create: { sheet: parsed.sheetName, rowNo: rec.rowNo, employeeId: created.id },
          update: { employeeId: created.id },
        });
        await recordEmployeeHistory({
          employeeId: created.id,
          employeeCode: created.employeeId,
          source: "CREATE",
          batchKey,
          operator,
          changes: [{ field: "__CREATED__", oldValue: null, newValue: created.employeeId }],
          tx,
        });
      });
      result.created++;
    } catch (e) {
      result.failed++;
      result.failures.push({
        rowNo: c.rowNo,
        name: c.name,
        kind: "create",
        message: (e as Error).message,
      });
    }
  }

  // ---- ⑦ 收敛状态：有失败就绝不写成成功 ----
  const base = isRetry
    ? { successCount: row.successCount, unchangedCount: row.unchangedCount }
    : { successCount: 0, unchangedCount: diff.summary.unchanged };
  const finalStatus =
    result.failed === 0
      ? PREVIEW_STATUS.SUCCESS
      : result.updated + result.created > 0
        ? PREVIEW_STATUS.PARTIAL
        : PREVIEW_STATUS.FAILED;

  // 提交本身改变了数据库：把「提交后指纹」同时写回 dbVersion 与
  // lastCommitDbVersion，后者作为下一次重试的版本基线。
  const newDbVersion = await computeDbVersion();

  await prisma.importPreview.update({
    where: { id: row.id },
    data: {
      status: finalStatus,
      committedAt: new Date(),
      successCount: base.successCount + result.updated + result.created,
      failedCount: result.failed,
      unchangedCount: base.unchangedCount + result.unchanged,
      resultJson: JSON.stringify(result),
      summaryJson: JSON.stringify(diff.summary),
      dbVersion: newDbVersion,
      lastCommitDbVersion: newDbVersion,
    },
  });

  await prisma.auditLog.create({
    data: {
      actor: operator,
      action: "IMPORT_COMMIT",
      entity: "ImportPreview",
      entityId: row.id,
      summary: `确认导入：修改 ${result.updated} 人、新增 ${result.created} 人、失败 ${result.failed} 人（状态 ${finalStatus}）`,
    },
  });

  return result;
}

/** 分配员工编号（与正式导入同一生成器） */
async function nextEmployeeIdSafe(): Promise<string> {
  const { nextEmployeeId } = await import("./employee-id");
  return nextEmployeeId(prisma);
}

/** 丢弃预览批次（不写入任何数据） */
export async function discardPreview(id: string): Promise<{ id: string }> {
  const row = await prisma.importPreview.findUnique({ where: { id } });
  if (!row) throw new Error("预览批次不存在");
  if (row.status !== PREVIEW_STATUS.PENDING) throw new Error("该批次已处理，不能丢弃");
  await prisma.importPreview.update({
    where: { id },
    data: { status: PREVIEW_STATUS.DISCARDED },
  });
  return { id };
}

/** 版本冲突专用错误，便于 API 层返回 409 */
export class VersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

/** 文件被替换专用错误，便于 API 层返回 409（FILE_CHANGED） */
export class FileChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChangedError";
  }
}
