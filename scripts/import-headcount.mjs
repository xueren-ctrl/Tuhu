#!/usr/bin/env node
/**
 * 导入「门店人员编制」的满编预算（Stage 9.14）
 *
 * 只导入 Excel 里**人工手填的常量**：
 *   客服经理满编 / 机修满编 / 美容满编 / 美容师傅满编 / 美容中小工满编
 * 「现有」各类人数不导入 —— 那是「在职」表按 门店+工种 实时统计出来的。
 *
 * 门店清单与顺序也取自 Excel（37 家门店，另有 1 行「所有店铺合计」不导入）。
 *
 * 门店名匹配策略（与项目既有约定一致）：
 *   1. 精确匹配 Store.name
 *   2. 匹配 ACTIVE 的 StoreAlias（原名）
 *   3. 都找不到 → 新建 Store（status=ACTIVE）
 *   ⚠️ 绝不修改已有 Store.name，也不合并门店 —— 名称统一是治理阶段的事。
 *
 * 用法：
 *   node scripts/import-headcount.mjs            预演（只报告，不写库）
 *   node scripts/import-headcount.mjs --apply    真正写入
 */
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

// 候选 Excel 路径：优先桌面最新版
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
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function loadSheet() {
  for (const f of CANDIDATES) {
    if (!existsSync(f)) continue;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(f);
    const ws = wb.getWorksheet("门店人员编制");
    if (!ws) continue;
    console.log(`读取：${f}`);
    const rows = [];
    for (let r = 4; r <= ws.rowCount; r++) {
      const name = text(ws.getRow(r).getCell(2));
      if (!name) continue;
      if (name.includes("合计")) continue; // 跳过「所有店铺合计」行
      rows.push({
        excelRow: r,
        sortOrder: num(ws.getRow(r).getCell(1)) ?? rows.length + 1,
        name,
        serviceManagerFull: num(ws.getRow(r).getCell(11)), // 客服经理满编
        mechanicFull: num(ws.getRow(r).getCell(12)), // 机修满编
        beautyFull: num(ws.getRow(r).getCell(13)), // 美容满编
        beautyMasterFull: num(ws.getRow(r).getCell(14)), // 美容师傅满编
        beautyJuniorFull: num(ws.getRow(r).getCell(15)), // 美容中小工满编
      });
    }
    return { file: f, rows };
  }
  throw new Error("未找到含「门店人员编制」Sheet 的 Excel");
}

const { file, rows } = await loadSheet();
console.log(`\n读到 ${rows.length} 家门店的满编数据\n`);

const stores = await prisma.store.findMany({ select: { id: true, name: true, status: true } });
const aliases = await prisma.storeAlias.findMany({ select: { id: true, alias: true, storeId: true } });
const byName = new Map(stores.map((s) => [s.name.trim(), s]));
const aliasMap = new Map();
for (const a of aliases) {
  if (!aliasMap.has(a.alias.trim())) aliasMap.set(a.alias.trim(), a.storeId);
}

const plan = [];
for (const r of rows) {
  let storeId = null;
  let how = "";
  const hit = byName.get(r.name);
  if (hit) {
    storeId = hit.id;
    how = "Store 精确匹配";
  } else if (aliasMap.has(r.name)) {
    storeId = aliasMap.get(r.name);
    how = "StoreAlias 匹配";
  } else {
    how = "★ 新建门店";
  }
  plan.push({ ...r, storeId, how });
}

const byHow = plan.reduce((m, p) => {
  m[p.how] = (m[p.how] ?? 0) + 1;
  return m;
}, {});
console.log("匹配结果：");
for (const [k, v] of Object.entries(byHow)) console.log(`  ${k}：${v} 家`);

const newStores = plan.filter((p) => p.storeId === null);
if (newStores.length) {
  console.log("\n以下门店在系统里还不存在，将新建：");
  for (const s of newStores) console.log(`  · ${s.name}`);
}

console.log("\n样例（前 5 家）：");
console.log("  门店".padEnd(20) + "客服满编 机修满编 美容满编 师傅满编 中小工满编  来源");
for (const p of plan.slice(0, 5)) {
  console.log(
    "  " + p.name.padEnd(18) +
    String(p.serviceManagerFull ?? "-").padStart(6) +
    String(p.mechanicFull ?? "-").padStart(8) +
    String(p.beautyFull ?? "-").padStart(8) +
    String(p.beautyMasterFull ?? "-").padStart(8) +
    String(p.beautyJuniorFull ?? "-").padStart(10) +
    "  " + p.how
  );
}

if (!APPLY) {
  console.log("\n（预演模式，未写库。确认无误后加 --apply 执行）\n");
  await prisma.$disconnect();
  process.exit(0);
}

// ---------- 写入 ----------
let created = 0;
let updated = 0;
for (const p of plan) {
  let storeId = p.storeId;
  if (storeId === null) {
    const s = await prisma.store.create({
      data: { name: p.name, status: "ACTIVE", remark: "由「门店人员编制」导入时自动创建" },
      select: { id: true },
    });
    storeId = s.id;
    created++;
  }
  const exists = await prisma.storeHeadcount.findUnique({ where: { storeId }, select: { id: true } });
  const data = {
    serviceManagerFull: p.serviceManagerFull,
    mechanicFull: p.mechanicFull,
    beautyFull: p.beautyFull,
    beautyMasterFull: p.beautyMasterFull,
    beautyJuniorFull: p.beautyJuniorFull,
    sortOrder: p.sortOrder,
  };
  if (exists) {
    await prisma.storeHeadcount.update({ where: { storeId }, data });
    updated++;
  } else {
    await prisma.storeHeadcount.create({ data: { storeId, ...data } });
    updated++;
  }
}

console.log(`\n✓ 写入完成：新建门店 ${created} 家，编制记录 ${updated} 条`);
console.log(`  StoreHeadcount 共 ${await prisma.storeHeadcount.count()} 条`);

await prisma.$disconnect();
