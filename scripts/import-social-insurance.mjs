/**
 * 导入「社保总名单」Sheet → SocialInsuranceEntry（Stage 9.37）
 *
 * 用法：
 *   node scripts/import-social-insurance.mjs            # 预览，不写库
 *   node scripts/import-social-insurance.mjs --apply    # 真正写入
 *
 * 设计原则（与项目既有约定一致）：
 *  - **默认预览，--apply 才写**（生产数据订正三步走）
 *  - **幂等**：按 sourceRowNo upsert，重复执行只更新不新增
 *  - **不猜**：员工/门店关联有歧义就留空 + 打印告警，绝不静默挂靠
 *  - **原始证据不删**：Excel 原值一律存 dateRaw / storeNameRaw
 *
 * 用户 2026-09-29 明确的四条口径：
 *  ① 已离职员工全部保留（用 insured 开关控制，不由在职状态推导）
 *  ② 库中查无此人的全部保留，employeeId 留空
 *  ③ 参保日期只到月的按当月 1 号存，datePrecision=MONTH 标记
 *  ④ 门店名对不上的做候选清单，等用户逐条确认（生成本表，不自动关联）
 */
import ExcelJS from "exceljs";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const XLSX = "途虎HR人员登记.xlsx";
const SHEET = "社保总名单";

/** ---------- 日期解析：把 Excel 里 5 种写法统一成 UTC 零点 ---------- */
// Excel 1900 日期系统：1899-12-30 为第 0 天
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function excelSerialToUTC(n) {
  return new Date(EXCEL_EPOCH + n * 86400000);
}

function parseInsuredDate(raw) {
  /** @returns {{date: Date|null, precision: string, raw: string|null}} */
  if (raw === null || raw === undefined || raw === "") {
    return { date: null, precision: "UNKNOWN", raw: null };
  }
  // ① 真 Date 对象（ExcelJS 对标准日期会直接给 Date）
  if (raw instanceof Date) {
    return { date: new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate())), precision: "DAY", raw: null };
  }
  const s = String(raw).trim();
  if (!s) return { date: null, precision: "UNKNOWN", raw: null };
  // ② Excel 序列号（45352 这种纯数字，5 位左右）
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    const d = excelSerialToUTC(n);
    if (!Number.isNaN(d.getTime())) return { date: d, precision: "DAY", raw: s };
  }
  // ③ 标准日期 2025-12-01 / 2025/12/1
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), precision: "DAY", raw: s };
  // ④ 2025/5月 / 2025年5月 / 2025-5月  → 只到月，按当月 1 号
  m = s.match(/^(\d{4})[-/年](\d{1,2})月?$/);
  if (m) return { date: new Date(Date.UTC(+m[1], +m[2] - 1, 1)), precision: "MONTH", raw: s };
  // ⑤ 202510月 / 202510（6 位数字 + 月）→ 只到月
  m = s.match(/^(\d{4})(\d{2})月?$/);
  if (m) {
    const mo = +m[2];
    if (mo >= 1 && mo <= 12) return { date: new Date(Date.UTC(+m[1], mo - 1, 1)), precision: "MONTH", raw: s };
  }
  // ⑥ 完全不认识 → 留空但保留原值，绝不瞎猜
  return { date: null, precision: "UNKNOWN", raw: s };
}

function cellText(row, c) {
  let v = row.getCell(c).value;
  if (v && typeof v === "object") {
    if (v.richText) v = v.richText.map((t) => t.text).join("");
    else if (v.text) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else v = "";
  }
  return v === null || v === undefined ? "" : String(v).trim();
}

// ---------- ① 读 Excel ----------
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX);
const ws = wb.getWorksheet(SHEET);
if (!ws) {
  console.log(`❌ Excel 里没有「${SHEET}」这个 Sheet`);
  process.exit(1);
}

const rows = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const name = cellText(row, 3);
  if (!name) continue; // 空行跳过
  const d = parseInsuredDate(row.getCell(4).value);
  const seqRaw = cellText(row, 1);
  rows.push({
    sourceRowNo: r,
    name,
    seqNo: /^\d+$/.test(seqRaw) ? Number(seqRaw) : null,
    storeNameRaw: cellText(row, 2) || null,
    insuredDate: d.date,
    datePrecision: d.precision,
    dateRaw: d.raw,
    baseAmount: cellText(row, 5) || null,
    note: cellText(row, 6) || null,
  });
}
console.log(`「${SHEET}」读到 ${rows.length} 人（R2~R${ws.rowCount}）`);

// ---------- ② 员工匹配（歧义就留空，绝不猜）----------
const emps = await prisma.employee.findMany({
  where: { deletedAt: null },
  select: { id: true, name: true, status: true, storeId: true, hireDate: true, resignDate: true },
});
const byName = new Map();
for (const e of emps) {
  if (!byName.has(e.name)) byName.set(e.name, []);
  byName.get(e.name).push(e);
}

const matchStats = { unique: 0, ambiguous: 0, none: 0 };
for (const r of rows) {
  const hit = byName.get(r.name) ?? [];
  if (hit.length === 1) {
    r.employeeId = hit[0].id;
    r.empStatus = hit[0].status;
    matchStats.unique++;
  } else if (hit.length > 1) {
    // 重名：先试「唯一在职的那个」，仍不唯一就留空
    const active = hit.filter((e) => e.status === "ACTIVE" || e.status === "NC3" || e.status === "OPS");
    if (active.length === 1) {
      r.employeeId = active[0].id;
      r.empStatus = active[0].status;
      matchStats.unique++;
      r.matchNote = `重名 ${hit.length} 人，按在职唯一命中`;
    } else {
      r.employeeId = null;
      r.empStatus = null;
      r.matchNote = `重名 ${hit.length} 人且在职不唯一，需人工确认`;
      matchStats.ambiguous++;
    }
  } else {
    r.employeeId = null;
    r.empStatus = null;
    r.matchNote = "员工库中查无此人";
    matchStats.none++;
  }
}
console.log(
  `员工匹配：唯一命中 ${matchStats.unique}，重名待确认 ${matchStats.ambiguous}，查无此人 ${matchStats.none}`
);

// ---------- ②b 挑中的员工档案与名单门店是否一致（不一致要提醒，不自动改）----------
const stores = await prisma.store.findMany({ select: { id: true, name: true, status: true } });
const storePlanPre = [];
{
  const exact0 = new Map(stores.map((s) => [s.name, s]));
  for (const raw of [...new Set(rows.map((r) => r.storeNameRaw).filter(Boolean))]) {
    const e = exact0.get(raw);
    storePlanPre.push({ rawName: raw, storeId: e?.id ?? null });
  }
}
const mismatch = [];
for (const r of rows) {
  if (!r.employeeId || !r.storeNameRaw) continue;
  const sp = storePlanPre.find((s) => s.rawName === r.storeNameRaw);
  if (!sp?.storeId) continue; // 门店还没确认，跳过比对
  const e = emps.find((x) => x.id === r.employeeId);
  if (e && e.storeId && e.storeId !== sp.storeId) {
    const empStore = stores.find((s) => s.id === e.storeId)?.name ?? "无门店";
    const siStore = stores.find((s) => s.id === sp.storeId)?.name ?? r.storeNameRaw;
    mismatch.push({ r, name: r.name, siStore, empStore });
  }
}
if (mismatch.length) {
  console.log(`\n⚠️ 名单门店与该员工档案当前门店不一致 ${mismatch.length} 人（**未自动改动任何数据**，请你判断）：`);
  for (const m of mismatch) {
    console.log(`    R${m.r.sourceRowNo} ${m.name}：名单写「${m.siStore}」，档案现在在「${m.empStore}」`);
  }
}

// ---------- ③ 门店：精确匹配 + 生成待确认候选（绝不自动关联）----------
const exactStore = new Map();
for (const s of stores) exactStore.set(s.name, s);

const rawStoreNames = [];
for (const r of rows) if (r.storeNameRaw && !rawStoreNames.includes(r.storeNameRaw)) rawStoreNames.push(r.storeNameRaw);

const norm = (s) => String(s).replace(/[店路号街道镇村社市区县]/g, "").trim();
function genCandidates(name) {
  return stores
    .filter((s) => {
      const a = norm(name), b = norm(s.name);
      return a && b && (a === b || a.includes(b) || b.includes(a));
    })
    .slice(0, 5)
    .map((s) => ({ id: s.id, name: s.name, status: s.status }));
}

const storePlan = [];
for (const raw of rawStoreNames) {
  const exact = exactStore.get(raw);
  if (exact) {
    storePlan.push({ rawName: raw, storeId: exact.id, status: "CONFIRMED", candidates: [], auto: true, note: "名单名与门店主数据完全一致" });
  } else {
    const cands = genCandidates(raw);
    storePlan.push({
      rawName: raw, storeId: null, status: "PENDING", candidates: cands, auto: false,
      note: cands.length ? "名字有差异，待人工确认" : "门店主数据里找不到相近门店",
    });
  }
}
const autoCnt = storePlan.filter((s) => s.auto).length;
console.log(`门店：${autoCnt} 家完全一致可直接关联，${storePlan.length - autoCnt} 家需人工确认`);

// ---------- ④ 打印明细 ----------
console.log("\n========== 明细 ==========");
const byPrecision = {};
for (const r of rows) byPrecision[r.datePrecision] = (byPrecision[r.datePrecision] || 0) + 1;
console.log("日期精度分布:", JSON.stringify(byPrecision));
const resigned = rows.filter((r) => r.empStatus === "RESIGNED");
console.log(`名单里库中已离职 ${resigned.length} 人（按你的决定：全部保留，insured 默认 true）:`);
for (const r of resigned) console.log(`    R${r.sourceRowNo} ${r.name}（${r.storeNameRaw}）`);
const noEmp = rows.filter((r) => !r.employeeId);
console.log(`\n未关联到员工档案 ${noEmp.length} 人（页面会高亮提醒）:`);
for (const r of noEmp) console.log(`    R${r.sourceRowNo} ${r.name}（${r.storeNameRaw}）${r.note ? " 备注:" + r.note : ""} — ${r.matchNote ?? ""}`);

if (!APPLY) {
  console.log("\n（预览模式，未写库。加 --apply 执行）");
  await prisma.$disconnect();
  process.exit(0);
}

// ---------- ⑤ 写入 ----------
console.log("\n========== 写入 ==========");
let created = 0, updated = 0, unchanged = 0;
for (const r of rows) {
  const storeLink = storePlan.find((s) => s.rawName === r.storeNameRaw);
  const storeId = storeLink?.auto ? storeLink.storeId : null;
  const existing = await prisma.socialInsuranceEntry.findUnique({ where: { sourceRowNo: r.sourceRowNo } });
  if (existing) {
    // 只更新 Excel 来源的字段，**绝不覆盖人工维护的 insured / employeeId**
    await prisma.socialInsuranceEntry.update({
      where: { id: existing.id },
      data: {
        name: r.name,
        seqNo: r.seqNo,
        storeNameRaw: r.storeNameRaw,
        storeId: storeId ?? existing.storeId,
        insuredDate: r.insuredDate,
        datePrecision: r.datePrecision,
        dateRaw: r.dateRaw,
        baseAmount: r.baseAmount,
        note: r.note,
      },
    });
    updated++;
  } else {
    await prisma.socialInsuranceEntry.create({
      data: {
        sourceRowNo: r.sourceRowNo,
        name: r.name,
        seqNo: r.seqNo,
        storeNameRaw: r.storeNameRaw,
        storeId,
        employeeId: r.employeeId ?? null,
        insuredDate: r.insuredDate,
        datePrecision: r.datePrecision,
        dateRaw: r.dateRaw,
        baseAmount: r.baseAmount,
        note: r.note,
        insured: true,
      },
    });
    created++;
  }
}
console.log(`  名单：新增 ${created}，更新 ${updated}（合计 ${rows.length}）`);

// 门店映射
let mCreated = 0, mUpdated = 0;
for (const s of storePlan) {
  const ex = await prisma.socialInsuranceStoreMapping.findUnique({ where: { rawName: s.rawName } });
  if (ex) {
    // 已人工确认过的绝不覆盖
    if (ex.status === "PENDING") {
      await prisma.socialInsuranceStoreMapping.update({
        where: { id: ex.id },
        data: { candidatesJson: JSON.stringify(s.candidates) },
      });
      mUpdated++;
    }
  } else {
    await prisma.socialInsuranceStoreMapping.create({
      data: {
        rawName: s.rawName,
        storeId: s.storeId,
        status: s.status,
        candidatesJson: JSON.stringify(s.candidates),
        note: s.note,
        decidedBy: s.auto ? "系统（名单名与主数据完全一致）" : null,
        decidedAt: s.auto ? new Date() : null,
      },
    });
    mCreated++;
  }
}
console.log(`  门店映射：新增 ${mCreated}，候选刷新 ${mUpdated}（已确认的不覆盖）`);

const total = await prisma.socialInsuranceEntry.count();
const insured = await prisma.socialInsuranceEntry.count({ where: { insured: true } });
const pendingStore = await prisma.socialInsuranceStoreMapping.count({ where: { status: "PENDING" } });
console.log(`\n库内现状：名单 ${total} 人，参保中 ${insured} 人，门店待确认 ${pendingStore} 家`);
console.log("✅ 导入完成");
await prisma.$disconnect();
