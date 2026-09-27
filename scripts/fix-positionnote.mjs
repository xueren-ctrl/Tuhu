#!/usr/bin/env node
/**
 * 修正「数据库 Sheet 与 在职 Sheet 职位备注不一致」的员工（Stage 9.15.1）
 *
 * 背景：用户亲自核对 Excel 后指出「骆作豪职位备注不是空的」。
 * 查证结果 —— 两表确实不一致，且全表仅此 1 例：
 *   - 数据库 Sheet  R1685  I列(职位备注) = 空   （骆作豪）
 *   - 在职  Sheet  R239   I列(职位备注) = 师傅  ← **手填常量**，非 XLOOKUP 公式
 *   其余 289 行的 I 列都是 XLOOKUP 公式，缓存值直接取自「数据库」Sheet。
 *
 * 为什么以「在职表」为准：
 *   门店人员编制表的 COUNTIFS 公式读的正是 **在职!I:I**（职位备注），
 *   而不是 数据库!I:I。所以在职表的这 1 个手填值才是该员工的真实工种细分。
 *
 * 口径：只改**在职表与数据库表不一致**的行，且必须两表都有明确值才改；
 *       绝不覆盖任何单边有值的原始数据（保守，避免二次污染）。
 *
 * 用法：
 *   node scripts/fix-positionnote.mjs          预演（只报告）
 *   node scripts/fix-positionnote.mjs --apply  写入（含 ImportIssue + AuditLog 留痕）
 */
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const FILE = String.raw`C:/Users/Administrator/Desktop/人事z资料9.19.xlsx`;

if (!existsSync(FILE)) {
  console.error(`未找到权威 Excel：${FILE}`);
  process.exit(1);
}

const prisma = new PrismaClient();

const plain = (v) => {
  if (v && typeof v === "object") {
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.formula !== undefined || v.sharedFormula !== undefined) return { __f: v.formula ?? "shared" };
  }
  return v;
};
const txt = (v) => {
  const p = plain(v);
  return p && typeof p === "object" ? null : String(p ?? "").trim();
};
const dateKey = (v) => {
  const p = plain(v);
  const d = p instanceof Date ? p : new Date(String(p ?? ""));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);

// 1) 数据库 Sheet → 姓名+入职日期 → 职位备注
const db = wb.getWorksheet("数据库");
const dbMap = new Map();
for (let r = 3; r <= db.rowCount; r++) {
  const row = db.getRow(r);
  const nm = txt(row.getCell(5).value);
  if (!nm) continue;
  const key = `${nm}|${dateKey(row.getCell(3).value)}`;
  if (!dbMap.has(key)) dbMap.set(key, []);
  dbMap.get(key).push({ row: r, note: txt(row.getCell(9).value) ?? "" });
}

// 2) 在职 Sheet → 逐行比对
const act = wb.getWorksheet("在职");
const fixes = [];
for (let r = 3; r <= act.rowCount; r++) {
  const row = act.getRow(r);
  const nm = txt(row.getCell(5).value);
  if (!nm || nm === "没找到") continue;
  const key = `${nm}|${dateKey(row.getCell(3).value)}`;
  const actNote = txt(row.getCell(9).value) ?? "";
  const cands = dbMap.get(key) ?? [];
  if (!cands.length) continue;
  const dbNote = cands[0].note ?? "";
  if (actNote === dbNote) continue;
  // 保守：只有「在职表有值、数据库为空」才修（反向不动，避免覆盖原始证据）
  if (actNote && !dbNote) {
    fixes.push({ actRow: r, dbRow: cands[0].row, name: nm, from: dbNote, to: actNote });
  }
}

console.log(`发现 ${fixes.length} 处「在职表有值 / 数据库为空」的职位备注差异\n`);
for (const f of fixes) {
  console.log(`  · ${f.name}：在职R${f.actRow} I列=「${f.to}」，数据库R${f.dbRow} I列=空`);
}

if (!APPLY) {
  console.log("\n（预演模式，未写库。确认无误后加 --apply 执行）\n");
  await prisma.$disconnect();
  process.exit(0);
}

const OPERATOR = "system:fix-positionnote";
for (const f of fixes) {
  const emp = await prisma.employee.findFirst({
    where: { name: f.name, deletedAt: null },
    orderBy: { id: "desc" },
    select: { id: true, employeeId: true, positionNote: true, storeId: true, jobGradeRaw: true },
  });
  if (!emp) {
    console.log(`  ✗ ${f.name}：库中查不到未删除档案，跳过`);
    continue;
  }
  // 只在「库里当前为空」时才写，绝不覆盖已有值
  if (emp.positionNote) {
    console.log(`  · ${f.name}：库中已有职位备注「${emp.positionNote}」，跳过（不覆盖）`);
    continue;
  }
  const before = { positionNote: emp.positionNote };
  await prisma.employee.update({ where: { id: emp.id }, data: { positionNote: f.to } });
  await prisma.auditLog.create({
    data: {
      action: "UPDATE",
      entity: "Employee",
      entityId: String(emp.id),
      actor: OPERATOR,
      detail:
        `${f.name}(${emp.employeeId}) 职位备注：空 → ${f.to}` +
        `（依据：在职表 R${f.actRow} I列手填值；数据库表 R${f.dbRow} I列为空，` +
        `门店人员编制表 COUNTIFS 读的是在职!I:I）`,
    },
  });
  console.log(`  ✓ ${f.name}(${emp.employeeId}) 职位备注：${before.positionNote ?? "空"} → ${f.to}（已写审计）`);
}

await prisma.$disconnect();
console.log("\n完成。刷新「门店人员编制」页即可看到师傅数变化。");
