#!/usr/bin/env node
/**
 * 导入「人员流失率」Sheet 的门店清单与考核管理岗姓名（Stage 9.18）
 *
 * 只导入 Excel 里**人工维护的常量**：
 *   门店名称（+ 序号排序）、店长、技术店长、副店长
 *
 * **不导入任何计算结果**（实时人数 / 当月离职 / 当月入职 / 流失率 / 邀约数量）
 * —— 那些在 `lib/attrition-service.ts` 里每次请求实时统计，
 *    员工一入职/离职/调岗，流失率立刻变，不存在两份数据打架。
 *
 * 门店匹配（与项目既有约定一致）：
 *   1. 精确匹配 Store.name
 *   2. 匹配 StoreAlias（原名）
 *   3. 都找不到 → 新建 Store（status=ACTIVE）
 *
 * 用法：
 *   node scripts/import-attrition.mjs            预演（只报告，不写库）
 *   node scripts/import-attrition.mjs --apply    真正写入
 */
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

const CANDIDATES = [
  "C:/Users/Administrator/Desktop/人事z资料9.19.xlsx",
  path.join(ROOT, "途虎HR人员登记.xlsx"),
];

const prisma = new PrismaClient();

function text(cell) {
  let v = cell.value;
  if (v && typeof v === "object") {
    if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if (v.result !== undefined) v = v.result;
    else if (v.text) v = v.text;
    else v = "";
  }
  return String(v ?? "").trim();
}

function num(cell) {
  const t = text(cell);
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

/** "无" / "-" 等占位值一律视为空 */
function personName(cell) {
  const t = text(cell);
  if (t === "" || t === "无" || t === "-" || t === "—") return null;
  return t;
}

async function loadSheet() {
  for (const f of CANDIDATES) {
    if (!existsSync(f)) continue;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(f);
    const ws = wb.getWorksheet("人员流失率");
    if (!ws) continue;
    console.log(`读取：${f}`);
    const rows = [];
    for (let r = 4; r <= ws.rowCount; r++) {
      const name = text(ws.getRow(r).getCell(2));
      if (!name) continue;
      if (name.includes("合计")) continue;
      rows.push({
        excelRow: r,
        sortOrder: num(ws.getRow(r).getCell(1)),
        name,
        storeManager: personName(ws.getRow(r).getCell(3)), // C 店长
        techManager: personName(ws.getRow(r).getCell(4)), // D 技术店长
        deputyManager: personName(ws.getRow(r).getCell(5)), // E 副店长
      });
    }
    // ⚠️ Excel 里有**同名门店的多行**：分店把「店长」和「副店长」分填在两行
    //   （如「常平朗贝社区店」R4=店长何小亮、R5=副店长王成龙）。
    //   若逐行 upsert 会互相覆盖 → 这里**按门店名合并**，三个岗位取并集、
    //   排序取最小值，保持 Excel 原本的展示位置。
    const merged = new Map();
    for (const r of rows) {
      const cur = merged.get(r.name);
      if (!cur) {
        merged.set(r.name, { ...r });
        continue;
      }
      cur.storeManager ??= r.storeManager;
      cur.techManager ??= r.techManager;
      cur.deputyManager ??= r.deputyManager;
      if (r.sortOrder > 0 && (cur.sortOrder === 0 || r.sortOrder < cur.sortOrder)) cur.sortOrder = r.sortOrder;
      cur.mergedFrom = [...(cur.mergedFrom ?? [cur.excelRow]), r.excelRow];
    }
    return { file: f, rows: [...merged.values()], rawCount: rows.length };
  }
  throw new Error("未找到含「人员流失率」Sheet 的 Excel");
}

const { file, rows, rawCount } = await loadSheet();
console.log(`\nExcel 原始 ${rawCount} 行 → 合并同名后 ${rows.length} 家门店\n`);

const stores = await prisma.store.findMany({ select: { id: true, name: true, status: true } });
const aliases = await prisma.storeAlias.findMany({ select: { id: true, alias: true, storeId: true } });
const byName = new Map(stores.map((s) => [s.name.trim(), s]));
const aliasMap = new Map();
for (const a of aliases) if (!aliasMap.has(a.alias.trim())) aliasMap.set(a.alias.trim(), a.storeId);

const plan = rows.map((r) => {
  const hit = byName.get(r.name);
  if (hit) return { ...r, storeId: hit.id, how: "Store 精确匹配" };
  if (aliasMap.has(r.name)) return { ...r, storeId: aliasMap.get(r.name), how: "StoreAlias 匹配" };
  return { ...r, storeId: null, how: "★ 新建门店" };
});

const byHow = plan.reduce((m, p) => ((m[p.how] = (m[p.how] ?? 0) + 1), m), {});
console.log("匹配结果：");
for (const [k, v] of Object.entries(byHow)) console.log(`  ${k}：${v} 家`);

const dupNames = plan
  .map((p) => p.name)
  .filter((n, i, a) => a.indexOf(n) !== i);
if (dupNames.length) {
  console.log(`⚠️ 仍有 ${dupNames.length} 组同名门店（合并后不应出现，请检查）：${[...new Set(dupNames)].join("、")}`);
}

const newStores = plan.filter((p) => p.storeId === null);
if (newStores.length) {
  console.log("\n以下门店在系统里还不存在，将新建：");
  for (const s of newStores) console.log(`  · ${s.name}`);
}

const missingName = plan.filter((p) => !p.storeManager && !p.techManager && !p.deputyManager);
console.log(`\n三个管理岗都为空（邀约数量将算 0）：${missingName.length} 家`);
for (const s of missingName) console.log(`  · ${s.name}`);

console.log("\n样例（前 8 家）：");
console.log("  " + "门店".padEnd(20) + "店长   技术店长 副店长   来源");
for (const p of plan.slice(0, 8)) {
  console.log(
    "  " + p.name.padEnd(18) +
      String(p.storeManager ?? "-").padEnd(7) +
      String(p.techManager ?? "-").padEnd(9) +
      String(p.deputyManager ?? "-").padEnd(8) +
      "  " + p.how
  );
}

if (!APPLY) {
  console.log("\n（预演模式，未写库。确认无误后加 --apply 执行）\n");
  await prisma.$disconnect();
  process.exit(0);
}

let created = 0;
let written = 0;
for (const p of plan) {
  let storeId = p.storeId;
  if (storeId === null) {
    const s = await prisma.store.create({
      data: { name: p.name, status: "ACTIVE", remark: "由「人员流失率」导入时自动创建" },
      select: { id: true },
    });
    storeId = s.id;
    created++;
  }
  const data = {
    storeManager: p.storeManager,
    techManager: p.techManager,
    deputyManager: p.deputyManager,
    sortOrder: p.sortOrder,
  };
  await prisma.attritionIndicator.upsert({
    where: { storeId },
    create: { storeId, ...data },
    update: data,
  });
  written++;
}

console.log(`\n✓ 写入完成：新建门店 ${created} 家，考核指标 ${written} 条`);
console.log(`  AttritionIndicator 共 ${await prisma.attritionIndicator.count()} 条`);

await prisma.$disconnect();
