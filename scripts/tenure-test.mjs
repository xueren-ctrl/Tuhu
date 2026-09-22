/**
 * 「满 2 个月」自然月口径专项测试（Stage 6.1 新增）
 *
 * 验证 lib/tenure.ts：
 *   - getTwoMonthDate：hireDate + 2 个自然月，月末落到目标月最后一天；
 *   - hasCompletedTwoMonths：today >= hireDate + 2 自然月（不用 60 天近似）；
 *   - 边界：目标日前一天 false / 当天 true / 后一天 true；
 *   - hireDate 为 null / 空 → null（不能判断）；
 *   - 非法日期（"not-a-date"、"2026-13-45"、"2026-02-29" 非闰年等）→ 抛错，不静默；
 *   - computeTenure.past2Months 与 hasCompletedTwoMonths 同源一致。
 *
 * 运行：npm run test:tenure   （纯单元，不连数据库、不碰生产数据）
 */
import assert from "node:assert";

// 项目无 "type":"module"，tsx 把 .ts 按 CJS 解析，静态具名 import 取不到具名导出；
// 改用动态 import()（与 stage6-test.mjs 同一可行模式）解构出全部导出。
const {
  addNaturalMonths,
  getTwoMonthDate,
  hasCompletedTwoMonths,
  computeTenure,
} = await import("../lib/tenure.ts");

let pass = 0;
let fail = 0;
const failures = [];
function check(id, title, fn) {
  try {
    fn();
    pass++;
    console.log(`✅ [${id}] ${title}`);
  } catch (e) {
    fail++;
    failures.push(`${id} ${title}`);
    console.log(`❌ [${id}] ${title}\n   ${e.message}`);
  }
}

function fmt(d) {
  if (!d) return "null";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

console.log("═".repeat(70));
console.log("「满 2 个月」自然月口径专项测试（getTwoMonthDate / hasCompletedTwoMonths）");
console.log("═".repeat(70));

// ---------- 规格书给定的 5 个自然月加法用例 ----------
check("T-01", "2026-01-10 → 2026-03-10", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2026-01-10")), "2026-03-10");
});
check("T-02", "2026-01-31 → 2026-03-31", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2026-01-31")), "2026-03-31");
});
check("T-03", "2026-02-28 → 2026-04-28", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2026-02-28")), "2026-04-28");
});
check("T-04", "2024-02-29 → 2024-04-29（真闰年 2 月 29 日；规格示例 2026-02-29 因 2026 非闰年不存在，见 T-17b）", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2024-02-29")), "2024-04-29");
});
check("T-05", "2026-11-30 → 2027-01-30", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2026-11-30")), "2027-01-30");
});

// ---------- 月末落尾规则（补强） ----------
check("T-06", "2025-12-31 + 2 = 2026-02-28（非闰年 2 月无 31 → 落尾 28）", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2025-12-31")), "2026-02-28");
});
check("T-07", "2024-12-31 + 2 = 2025-02-28", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2024-12-31")), "2025-02-28");
});
check("T-08", "2026-04-30 + 2 = 2026-06-30", () => {
  assert.strictEqual(fmt(getTwoMonthDate("2026-04-30")), "2026-06-30");
});
check("T-09", "addNaturalMonths 支持 n>2（2025-11-30 + 14 = 2027-01-30）", () => {
  assert.strictEqual(fmt(addNaturalMonths(new Date(Date.UTC(2025, 10, 30)), 14)), "2027-01-30");
});

// ---------- 边界：前一天 false / 当天 true / 后一天 true ----------
// hireDate = 2026-01-10 → 满 2 个月日 = 2026-03-10
check("T-10", "边界：2026-03-09（前一天）→ false", () => {
  assert.strictEqual(hasCompletedTwoMonths("2026-01-10", "2026-03-09"), false);
});
check("T-11", "边界：2026-03-10（当天）→ true", () => {
  assert.strictEqual(hasCompletedTwoMonths("2026-01-10", "2026-03-10"), true);
});
check("T-12", "边界：2026-03-11（后一天）→ true", () => {
  assert.strictEqual(hasCompletedTwoMonths("2026-01-10", "2026-03-11"), true);
});
// 月末口径边界：hireDate = 2026-01-31 → 满 2 个月日 = 2026-03-31
check("T-13", "月末边界：2026-03-30 → false；2026-03-31 → true", () => {
  assert.strictEqual(hasCompletedTwoMonths("2026-01-31", "2026-03-30"), false);
  assert.strictEqual(hasCompletedTwoMonths("2026-01-31", "2026-03-31"), true);
});
// 与 60 天近似会产生分歧的场景（证明已不是 days>=60）：
// hireDate = 2026-01-05：60 天 ≈ 3-06；自然月 = 3-05
check("T-14", "反 60 天近似：2026-01-05 入职，2026-03-05（自然月当天）→ true（60 天算法会判 false）", () => {
  assert.strictEqual(hasCompletedTwoMonths("2026-01-05", "2026-03-05"), true);
  assert.strictEqual(hasCompletedTwoMonths("2026-01-05", "2026-03-04"), false);
});

// ---------- null / 空 ----------
check("T-15", "hireDate 为 null → null（不能判断，不产生错误结论）", () => {
  assert.strictEqual(hasCompletedTwoMonths(null, "2026-03-10"), null);
  assert.strictEqual(getTwoMonthDate(null), null);
});
check("T-16", "hireDate 为 undefined / 空串 → null", () => {
  assert.strictEqual(hasCompletedTwoMonths(undefined, "2026-03-10"), null);
  assert.strictEqual(hasCompletedTwoMonths("", "2026-03-10"), null);
});

// ---------- 非法日期 → 抛错（不静默）----------
check("T-17", "非法日期字符串 → 抛错", () => {
  assert.throws(() => hasCompletedTwoMonths("not-a-date", "2026-03-10"), /非法日期/);
  assert.throws(() => hasCompletedTwoMonths("2026-13-45", "2026-03-10"), /非法日期/);
  assert.throws(() => getTwoMonthDate("2026-01-01X"), /非法日期/);
});
check("T-17b", "不可能日期 2026-02-29（非闰年 2 月无 29 日）→ 严格校验抛错，不静默滚成 3-01", () => {
  assert.throws(() => hasCompletedTwoMonths("2026-02-29", "2026-04-29"), /非法日期/);
  assert.throws(() => getTwoMonthDate("2026-02-29"), /非法日期/);
});

// ---------- computeTenure 一致性 ----------
check("T-18", "computeTenure.past2Months 与 hasCompletedTwoMonths 同源一致（注入 now 为 UTC 零点）", () => {
  const t1 = computeTenure("2026-01-10", null, new Date(Date.UTC(2026, 2, 9)));
  assert.strictEqual(t1.past2Months, false);
  assert.strictEqual(fmt(t1.twoMonthDate), "2026-03-10");
  const t2 = computeTenure("2026-01-10", null, new Date(Date.UTC(2026, 2, 10)));
  assert.strictEqual(t2.past2Months, true);
});
check("T-19", "离职员工：参考日 = 离职日，同样走自然月口径", () => {
  const t = computeTenure("2026-01-10", "2026-03-01");
  assert.strictEqual(t.past2Months, false);
  assert.strictEqual(t.active, false);
  const t2 = computeTenure("2025-01-10", "2025-04-10");
  assert.strictEqual(t2.past2Months, true); // 4-10 = 1-10 + 3 个月 > 2 个月
});
check("T-20", "缺入职日：computeTenure 全字段 null / —（无静默错误结果）", () => {
  const t = computeTenure(null, "2026-06-01");
  assert.strictEqual(t.days, null);
  assert.strictEqual(t.past7Days, null);
  assert.strictEqual(t.past2Months, null);
  assert.strictEqual(t.twoMonthDate, null);
  assert.strictEqual(t.tenureText, "—");
});
check("T-21", "computeTenure 对非法 hireDate 抛错（不静默）", () => {
  assert.throws(() => computeTenure("2026-02-29", null, new Date()), /非法日期/);
});

console.log("─".repeat(70));
console.log(`✅ 通过 ${pass} / ${pass + fail}${fail ? `   ❌ 失败 ${fail}` : ""}`);
if (fail > 0) {
  console.log("失败项：\n  " + failures.join("\n  "));
  process.exit(1);
}
