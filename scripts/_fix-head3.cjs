const fs = require("fs");
const p = "app/(app)/headcount/page.tsx";
let s = fs.readFileSync(p, "utf8");

const lines = s.split("\n");
// 定位：注释块起始行（含 "第 1 层：分组表头"）到 </thead> 那一行
const cStart = lines.findIndex((l) => l.includes("第 1 层：分组表头")) - 1; // 上一行是 {/**
const cEnd = lines.findIndex((l) => l.trim() === "</thead>");
if (cStart < 0 || cEnd < 0) {
  console.log("定位失败", { cStart, cEnd });
  process.exit(1);
}

const newBlock = `          {/**
           * 第 1 层：分组表头 —— 用原生 HTML 字符串注入，**不能**写成 <th colSpan={8}>。
           *
           * ⚠️ 踩坑记录（Stage 9.14.1，定位耗时很长，务必记住）：
           *   React 会把 colSpan / rowSpan 规范化成**大写属性**输出到 HTML
           *   （<th colSpan="8">），而 HTML 规范只认**小写** colspan / rowspan。
           *   浏览器忽略未知的大写属性 → 每个 th 被当成 1 列 →
           *   表头只还原出 18 列，而表体有 22 个 <td> → **整张表整体错位**，
           *   表现就是「客服经理」列下面显示的竟是「具体缺编明细」。
           *
           *   试过且**无效**的写法：<th {...{ colSpan: 8 }}>（展开小写键同样被规范化）。
           *   只有直接注入原生小写属性的 HTML 才有效。
           *
           * 列数核算（与 Excel 严格一致，共 22 列）：
           *   1 序号 + 1 名称 + 8 各门店现有总人数 + 3 满编配制 + 2 美容配制
           *   + 2 美容现有 + 1 缺编 + 3 各职位缺编 + 1 具体缺编 = 22 ✓
           *   （「当前合计人数」归属「各门店现有总人数」组，故该组 colSpan=8）
           */}
          <thead dangerouslySetInnerHTML={{ __html: HEAD_HTML }} />`;

lines.splice(cStart, cEnd - cStart + 1, newBlock);
s = lines.join("\n");

// 插入 HEAD_HTML 常量
const anchor = "const num = (v: number | null) =>";
const headConst = `/**
 * 表头 HTML（原生小写 colspan / rowspan —— 原因见页面里 dangerouslySetInnerHTML 处的注释）。
 * 字段顺序与 Excel「门店人员编制」Sheet 第 3 行逐列一致。
 */
const HEAD_FIELDS = [
  "店长",
  "技术店长",
  "副店长",
  "客服经理",
  "机修现有",
  "美容现有",
  "后勤",
  "当前合计人数",
  "客服经理满编",
  "机修满编",
  "美容满编",
  "美容师傅满编",
  "美容中小工满编",
  "现有美容师傅",
  "现有美容中小工",
  "机修",
  "美容",
  "客服经理",
] as const;

/** 分组配色：现有=蓝、满编=靛、美容配制=紫、美容现有=琥珀、缺编=红 */
const HEAD_TINT = (i: number) =>
  i < 8 ? "bg-sky-50/60" : i < 11 ? "bg-indigo-50/60" : i < 13 ? "bg-violet-50/60" : i < 15 ? "bg-amber-50/60" : "bg-rose-50/60";

const HEAD_HTML =
  [
    '<tr class="bg-[#f7f9fc] text-[11.5px] font-medium text-slate-600">',
    '<th rowspan="2" class="sticky left-0 z-20 w-[46px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">序号</th>',
    '<th rowspan="2" class="sticky left-[46px] z-20 w-[150px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">名称</th>',
    '<th colspan="8" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">各门店现有总人数</th>',
    '<th colspan="3" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">满编配制人数</th>',
    '<th colspan="2" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">美容配制人数</th>',
    '<th colspan="2" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">美容现有人数</th>',
    '<th rowspan="2" class="w-[58px] border-b border-r border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-center">缺编</th>',
    '<th colspan="3" class="border-b border-r border-slate-300 px-2 py-1.5 text-center">各职位缺编明细/人数</th>',
    '<th rowspan="2" class="border-b border-slate-200 bg-[#f7f9fc] px-2 py-1.5 text-left">具体缺编明细</th>',
    "</tr>",
    '<tr class="bg-[#f7f9fc] text-[11.5px] text-slate-600">',
    HEAD_FIELDS.map((h, i) => \`<th class="border-b border-r border-slate-200 px-2 py-1.5 text-center \${HEAD_TINT(i)}">\${h}</th>\`).join(""),
    "</tr>",
  ].join("");

`;
s = s.replace(anchor, headConst + anchor);
fs.writeFileSync(p, s);
console.log("表头已改为原生小写属性注入");
