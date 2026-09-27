/**
 * 导入「月初人数」快照 —— Stage 9.22
 *
 * 用法：
 *   node scripts/import-attrition-baseline.mjs              预演（只打印，不写库）
 *   node scripts/import-attrition-baseline.mjs --apply      写入
 *
 * 数据源：《9月月初人数.xlsx》的「人员流失率」Sheet，F 列 = 月初人数。
 *
 * ⚠️ 为什么需要这个（重要，别当成冗余功能删掉）：
 *   流失率公式的分母是「月初人数 = 1 号在职 且 入职满 3 个月」。
 *   但库里 273 条历史档案「标记离职却没有离职日期」（Stage 7.3 治理事故遗留），
 *   这批人在 9/1 时点其实还在职、按公式应该计入 —— 实测系统只能算出 220 人，
 *   而人工核对的真实值是 255 人，差 35 人。
 *   所以**有快照的月份用人工核对的权威值，没有快照的月份按公式实时算**。
 *
 * ⚠️ 快照只覆盖「月初人数」一项。当月离职 / 当月入职始终实时统计
 *    （用户明确说过：表里那两列不对，不要用）。
 */
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

/** 统计月：命令行第一个位置参数，或默认 2026-09 */
const MONTH = (() => {
  const i = process.argv.indexOf("--month");
  const raw = i > -1 ? process.argv[i + 1] : process.argv.find((a) => /^\d{4}-\d{2}$/.test(a));
  return raw || "2026-09";
})();

/** 候选数据源（按优先级）—— 用户的权威文件在前 */
const CANDIDATES = [
  String.raw`C:/Users/Administrator/Desktop/9月月初人数.xlsx`,
  String.raw`C:/Users/Administrator/Desktop/人事z资料9.19.xlsx`,
];

const SHEET = "人员流失率";

/** 解析 Excel 单元格：公式取缓存 result，合并单元格取 master 的值 */
function cellText(cell) {
  const v = cell.value;
  if (v && typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result !== undefined && v.result !== null) return String(v.result);
    if (v.formula !== undefined || v.sharedFormula) return "";
    if (v.text !== undefined) return String(v.text);
    return "";
  }
  return v === null || v === undefined ? "" : String(v);
}

function cellNum(cell) {
  const v = cell.value;
  if (v && typeof v === "object") {
    if (v.result === undefined || v.result === null || v.result === "") return null;
    const n = Number(v.result);
    return Number.isFinite(n) ? n : null;
  }
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadSheet() {
  const { existsSync } = await import("node:fs");
  for (const f of CANDIDATES) {
    if (!existsSync(f)) {
      console.log(`  跳过（不存在）：${f}`);
      continue;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(f);
    const ws = wb.getWorksheet(SHEET);
    if (!ws) {
      console.log(`  跳过（无「${SHEET}」Sheet）：${f}`);
      continue;
    }

    // B 列 = 门店名称，F 列 = 月初人数（第 3 行是二级表头）
    const byStore = new Map();
    const dup = [];
    for (let r = 4; r <= ws.rowCount; r++) {
      const name = cellText(ws.getRow(r).getCell(2)).trim();
      if (!name || name.includes("合计")) continue;
      const n = cellNum(ws.getRow(r).getCell(6));
      if (n === null) {
        console.log(`  ⚠️ R${r} ${name}：F 列（月初人数）为空`);
        continue;
      }
      // 同店多行（副店长追加行）→ 取第一个非空值，值应相同
      if (byStore.has(name)) {
        dup.push(name);
        if (byStore.get(name) !== n) {
          console.log(`  ⚠️ ${name} 有多行且 F 值不一致（${byStore.get(name)} vs ${n}），取第一个`);
        }
        continue;
      }
      byStore.set(name, n);
    }
    return { file: f, byStore, dup, title: cellText(ws.getRow(1).getCell(1)) };
  }
  throw new Error("未找到含「人员流失率」Sheet 的 Excel");
}

const { file, byStore, dup, title } = await loadSheet();
console.log(`\n数据源：${file}`);
console.log(`  表内标题：${title}`);
console.log(`  读到 ${byStore.size} 家门店的月初人数（统计月 ${MONTH}）`);
if (dup.length) console.log(`  合并了 ${dup.length} 家重复行（副店长追加行）：${[...new Set(dup)].join("、")}`);

const monthDate = new Date(`${MONTH}-01T00:00:00.000Z`);

// 匹配门店 + 查现有快照
const plan = [];
const unmatched = [];
for (const [name, n] of byStore) {
  const store = await prisma.store.findFirst({ where: { name }, select: { id: true, name: true, status: true } });
  if (!store) {
    unmatched.push(name);
    continue;
  }
  const old = await prisma.attritionBaseline.findUnique({
    where: { storeId_month: { storeId: store.id, month: monthDate } },
    select: { headcount: true, source: true },
  });
  plan.push({ store, headcount: Math.round(n), old });
}

// 只在考核指标里（流失率表覆盖的门店）才写
const inScope = new Set(
  (await prisma.attritionIndicator.findMany({ select: { storeId: true } })).map((x) => x.storeId)
);
const toWrite = plan.filter((p) => inScope.has(p.store.id));
const outOfScope = plan.filter((p) => !inScope.has(p.store.id));

console.log(`\n匹配门店 ${plan.length} 家；其中在流失率考核范围内 ${toWrite.length} 家`);
if (outOfScope.length) console.log(`  ⚠️ 不在考核范围内、跳过：${outOfScope.map((p) => p.store.name).join("、")}`);
if (unmatched.length) console.log(`  ⚠️ 库里找不到同名门店：${unmatched.join("、")}`);

const changed = toWrite.filter((p) => p.old && p.old.headcount !== p.headcount);
const created = toWrite.filter((p) => !p.old);
const same = toWrite.filter((p) => p.old && p.old.headcount === p.headcount);

console.log(`\n新增 ${created.length} · 更新 ${changed.length} · 已一致 ${same.length}`);
if (changed.length) {
  console.log("  将被修改的：");
  for (const c of changed) console.log(`    ${c.store.name}：${c.old.headcount} → ${c.headcount}`);
}

const total = toWrite.reduce((s, p) => s + p.headcount, 0);
console.log(`\n写入后该月月初人数合计 = ${total}`);

if (!APPLY) {
  console.log("\n（预演模式，未写库。确认无误后加 --apply 执行）");
  await prisma.$disconnect();
  process.exit(0);
}

for (const p of toWrite) {
  await prisma.attritionBaseline.upsert({
    where: { storeId_month: { storeId: p.store.id, month: monthDate } },
    create: { storeId: p.store.id, month: monthDate, headcount: p.headcount, source: "MANUAL", remark: `导入自 ${file.split("/").pop()}` },
    update: { headcount: p.headcount, source: "MANUAL", remark: `导入自 ${file.split("/").pop()}` },
  });
}
console.log(`\n✅ 已写入 ${toWrite.length} 条快照（统计月 ${MONTH}）`);

await prisma.$disconnect();
