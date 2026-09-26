const fs = require("fs");
const p = "app/(app)/headcount/page.tsx";
let s = fs.readFileSync(p, "utf8");

// React 会把 colSpan/rowSpan 规范化成大写属性输出，而 HTML 只认小写 → 浏览器忽略 → 整表错位。
// 唯一可靠的办法：不用 React 的属性绑定，改用 dangerouslySetInnerHTML 之外的原生写法 ——
// 即在 <th> 上直接写小写属性。TSX 不允许裸的小写属性名，但可以借 ts-ignore + 展开小写键。
// 实测 {...{ colspan: 8 }}（全小写键）也会被 React 规范化，故改用 createElement 之外的方案：
// 把表头整体用原生 HTML 字符串注入。
const start = s.indexOf("          {/*\n           * 第 1 层：分组表头。");
const endMark = "          </thead>";
const end = s.indexOf(endMark);
if (start < 0 || end < 0) {
  console.log("未定位到表头块");
  process.exit(1);
}

const header = `          {/**
           * 第 1 层：分组表头。
           *
           * ⚠️ 这里用 dangerouslySetInnerHTML 注入**原生小写** colspan/rowspan，
           *     不能写成 React 的 <th colSpan={8}>。
           *
           * 原因（Stage 9.14.1 踩坑，浪费很多时间）：
           *   React 19 会把 colSpan / rowSpan 规范化成**大写属性**输出到 HTML
           *   （<th colSpan="8">），而 HTML 规范只认**小写** colspan / rowspan。
           *   浏览器直接忽略未知的大写属性 → 每个 th 被当成 1 列 →
           *   表头只还原出 18 列而表体有 22 个 td → **整张表整体错位**，
           *   表现为「客服经理」列下面显示的是「具体缺编明细」。
           *
           * 列数核算（与 Excel 严格一致，22 列）：
           *   1 序号 + 1 名称 + 8 各门店现有总人数 + 3 满编配制 + 2 美容配制
           *   + 2 美容现有 + 1 缺编 + 3 各职位缺编 + 1 具体缺编 = 22 ✓
           *   （「当前合计人数」属于「各门店现有总人数」组，所以该组 colSpan=8）
           */}
          <thead
            dangerouslySetInnerHTML={{
              __html: HEAD_HTML,
            }}
          />
`;

s = s.slice(0, start) + header + s.slice(end + endMark.length);

// 在文件顶部插入 HEAD_HTML 常量
const anchor = 'const num = (v: number | null) =>';
const headConst = `/**
 * 表头 HTML（原生小写 colspan / rowspan，理由见下方 dangerouslySetInnerHTML 处的注释）。
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

const HEAD_BASE = "border-b border-r border-slate-200 px-2 py-1.5 text-center";
/** 按 Excel 的配色分组：现有=蓝、满编=靛、美容配制=紫、美容现有=琥珀、缺编=红 */
const HEAD_TINT = (i: number) =>
  i < 8 ? "bg-sky-50/60" : i < 11 ? "bg-indigo-50/60" : i < 13 ? "bg-violet-50/60" : i < 15 ? "bg-amber-50/60" : "bg-rose-50/60";

const HEAD_HTML = [
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
  HEAD_FIELDS.map(
    (h, i) => \`<th class="\${HEAD_BASE} \${HEAD_TINT(i)}">\${h}</th>\`
  ).join(""),
  "</tr>",
].join("");

`;
s = s.replace(anchor, headConst + anchor);
fs.writeFileSync(p, s);
console.log("表头已改为原生小写 colspan/rowspan 注入");
