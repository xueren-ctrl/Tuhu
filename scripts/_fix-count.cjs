const fs = require("fs");
const p = "app/(app)/sheets/[sheet]/page.tsx";
let s = fs.readFileSync(p, "utf8");

const old = `            {loaded.columns.length} 个字段 · {loaded.rows.length} 人`;

const neu = `            {loaded.columns.length} 个字段 ·{" "}
            {/**
             * 顶部人数必须是「当前筛选/搜索后的命中数」，不是全表人数。
             * 之前固定显示 loaded.rows.length（全表 290 人），
             * 表格虽然已经筛到 1 行，顶部却还是 290 —— 用户会以为筛选没生效。
             */}
            {hasFilter ? (
              <>
                <strong className="text-brand-700">{prepared.matchedCount}</strong>
                <span className="text-slate-400"> / {loaded.rows.length} 人（已筛选）</span>
              </>
            ) : (
              <>{loaded.rows.length} 人</>
            )}`;

if (!s.includes(old)) {
  console.log("未匹配人数渲染处");
  process.exit(1);
}
s = s.replace(old, neu);

// 定义 hasFilter：有关键词或列筛选条件
const anchor = "  return (\n    <div className=\"mx-auto max-w-[1700px] space-y-3\">";
const def = `  /** 当前是否处于「已筛选」状态（有关键词，或选了某一列 + 条件） */
  const hasFilter =
    q.keyword.trim() !== "" ||
    (q.colRaw !== "" && (q.op === "empty" || q.op === "notEmpty" || q.val !== ""));

  return (
    <div className="mx-auto max-w-[1700px] space-y-3">`;

if (!s.includes(anchor)) {
  console.log("未匹配 return 锚点");
  process.exit(1);
}
s = s.replace(anchor, def);
fs.writeFileSync(p, s);
console.log("顶部人数已改为显示筛选后命中数");
