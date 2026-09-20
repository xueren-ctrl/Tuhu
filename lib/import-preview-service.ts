/**
 * Excel 重新导入 —— 预览批次服务（第四阶段）
 *
 * 流程固定为：上传 → 解析 → 生成 Diff → 人工确认 → 才写入。
 * 关键保证（验收点）：**预览阶段数据库零变化**。
 *
 * 实现要点：
 * 1. 上传的文件原样落到 data/import/，记录元信息与 Diff；
 * 2. 确认时基于同一份文件**重新解析**再写入，保证「所见即所写」；
 * 3. 写入走标准的 updateEmployee / createEmployee，因此自带变更记录；
 * 4. 已提交 / 已丢弃的批次不能重复提交（状态机收敛，避免误点两次造成重复写入）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { computeDiff, parseDatabaseSheet, type DiffResult } from "./import-parser";
import { updateEmployee, createEmployee } from "./employee-service";
import { DEFAULT_OPERATOR } from "./history-service";

const IMPORT_DIR = path.join(process.cwd(), "data", "import");

function newPreviewId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
  return `PREVIEW-${stamp}-${randomBytes(4).toString("hex")}`;
}

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
}

function shape(row: {
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
}): PreviewDetail {
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
  };
}

/**
 * 创建预览批次：解析 + 生成 Diff + 落盘，**完全不碰 Employee 表**
 */
export async function createPreview(opts: {
  buffer: Buffer;
  fileName: string;
  operator?: string;
}): Promise<PreviewDetail> {
  const parsed = await parseDatabaseSheet(opts.buffer);
  if (!parsed.ok) throw new Error(parsed.error ?? "解析失败");

  const diff = await computeDiff(parsed);

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
      storedPath: path.join("data", "import", storedName),
      sheetName: parsed.sheetName,
      totalRows: parsed.totalRows,
      validRows: parsed.validRows,
      skippedRows: parsed.skippedRows,
      diffJson: JSON.stringify(diff),
      summaryJson: JSON.stringify(diff.summary),
      status: "PENDING",
      operator: opts.operator ?? DEFAULT_OPERATOR,
    },
  });
  return shape(row);
}

export async function getPreview(id: string): Promise<PreviewDetail | null> {
  const row = await prisma.importPreview.findUnique({ where: { id } });
  return row ? shape(row) : null;
}

export async function listPreviews(take = 20): Promise<PreviewSummary[]> {
  const rows = await prisma.importPreview.findMany({
    orderBy: { createdAt: "desc" },
    take,
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

export interface CommitResult {
  previewId: string;
  updated: number;
  created: number;
  failed: number;
  failures: { rowNo: number; name: string | null; message: string }[];
}

/**
 * 确认写入：基于同一份文件重新解析后写入。
 * 只允许 PENDING 批次提交一次。
 */
export async function commitPreview(opts: {
  id: string;
  operator?: string;
}): Promise<CommitResult> {
  const row = await prisma.importPreview.findUnique({ where: { id: opts.id } });
  if (!row) throw new Error("预览批次不存在");
  if (row.status !== "PENDING") {
    throw new Error(`该批次已${row.status === "COMMITTED" ? "提交" : "丢弃"}，不能重复操作`);
  }

  const buf = await fs.readFile(path.join(process.cwd(), row.storedPath));
  const parsed = await parseDatabaseSheet(buf);
  if (!parsed.ok) throw new Error(parsed.error ?? "重新解析失败");
  const diff = await computeDiff(parsed);

  const operator = opts.operator ?? row.operator ?? DEFAULT_OPERATOR;
  const result: CommitResult = {
    previewId: row.id,
    updated: 0,
    created: 0,
    failed: 0,
    failures: [],
  };

  for (const m of diff.modified) {
    const patch: Record<string, unknown> = {};
    for (const c of m.changes) {
      // 跳过只用于展示的名称化字段（storeId/positionId 在 diff 里存的是名称，
      // 这里重新按名称解析成 id，避免把字符串写进外键列）
      if (c.field === "storeId") {
        const name = c.newValue;
        const store = name
          ? await prisma.store.findFirst({ where: { name } })
          : null;
        if (!store) {
          const alias = name ? await prisma.storeAlias.findUnique({ where: { alias: name } }) : null;
          patch.storeId = alias ? alias.storeId : null;
        } else {
          patch.storeId = store.id;
        }
        continue;
      }
      if (c.field === "positionId") {
        const pos = c.newValue
          ? await prisma.position.findFirst({ where: { name: c.newValue } })
          : null;
        patch.positionId = pos ? pos.id : null;
        continue;
      }
      patch[c.field] = c.newValue;
    }
    if (!Object.keys(patch).length) continue;
    try {
      await updateEmployee(m.employeeId, patch, operator);
      result.updated++;
    } catch (e) {
      result.failed++;
      result.failures.push({
        rowNo: m.rowNo,
        name: m.name,
        message: (e as Error).message,
      });
    }
  }

  for (const c of diff.created) {
    if (!c.name) {
      result.failed++;
      result.failures.push({ rowNo: c.rowNo, name: null, message: "姓名为空，跳过" });
      continue;
    }
    try {
      const store = c.storeName
        ? await prisma.store.findFirst({ where: { name: c.storeName } })
        : null;
      const pos = c.jobGrade
        ? await prisma.position.findFirst({ where: { name: c.jobGrade } })
        : null;
      await createEmployee(
        {
          name: c.name,
          idCardNo: c.idCardNo ?? null,
          phone: c.phone ?? null,
          hireDate: c.hireDate ?? null,
          storeId: store?.id ?? null,
          storeNameRaw: c.storeName ?? null,
          positionId: pos?.id ?? null,
          jobGradeRaw: c.jobGrade ?? null,
        },
        operator
      );
      result.created++;
    } catch (e) {
      result.failed++;
      result.failures.push({ rowNo: c.rowNo, name: c.name, message: (e as Error).message });
    }
  }

  await prisma.importPreview.update({
    where: { id: row.id },
    data: {
      status: "COMMITTED",
      committedAt: new Date(),
      summaryJson: JSON.stringify(diff.summary),
      diffJson: JSON.stringify(diff),
    },
  });

  await prisma.auditLog.create({
    data: {
      actor: operator,
      action: "IMPORT_COMMIT",
      entity: "ImportPreview",
      entityId: row.id,
      summary: `确认导入：修改 ${result.updated} 人、新增 ${result.created} 人、失败 ${result.failed} 人`,
    },
  });

  return result;
}

/** 丢弃预览批次（不写入任何数据） */
export async function discardPreview(id: string): Promise<{ id: string }> {
  const row = await prisma.importPreview.findUnique({ where: { id } });
  if (!row) throw new Error("预览批次不存在");
  if (row.status !== "PENDING") throw new Error("该批次已处理，不能丢弃");
  await prisma.importPreview.update({ where: { id }, data: { status: "DISCARDED" } });
  return { id };
}
