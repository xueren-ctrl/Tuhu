/**
 * 从当前 Excel（`途虎HR人员登记.xlsx`）读取各表的表头与数据行。
 *
 * ## 为什么需要（Stage 9.42，2026-10-05）
 *
 * 换数据源（人事z资料9.19.xlsx → 人事z资料10.4.xlsx）后，回归里所有
 * 「期望值」都变了：招聘 478→496、薪资 290→300、在职 290→294、
 * 美容 85→140、合计 290→475 ……
 *
 * 硬编码这些数字的断言会**全线误报**，每次换文件都要改十几处断言，
 * 漏改就会变成「假绿灯」。所以改成：
 *   **断言「库里算出来的== 从 Excel 读到的」** —— 这才是真正的不变式，
 *   换任何版本的 Excel 都不用改断言。
 *
 * 读取规则与项目约定一致：
 *   - 日期统一 YYYY-MM-DD（UTC 零点取 ISO）
 *   - 公式取缓存结果（Excel 上次打开算出来的值）
 *   - 每个 Sheet 的表头行 / 数据起始行按实测
 */
import ExcelJS from "exceljs";

const HEADER_ROW = {
  在职: 2, 离职: 2, 南昌3店: 2, 运营部: 1, 招聘面试登记表: 3,
  运营部离职: 1, 薪资表: 1, 数据库: 2, 社保总名单: 1,
  门店人员编制: 3, 人员流失率: 3, 门店人员分布明细: 2,
};
const DATA_START = {
  在职: 3, 离职: 3, 南昌3店: 3, 运营部: 2, 招聘面试登记表: 4,
  运营部离职: 2, 薪资表: 2, 数据库: 3, 社保总名单: 2,
  门店人员编制: 4, 人员流失率: 4, 门店人员分布明细: 3,
};

function txt(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // ⚠️ Excel 里可能有「无效日期对象」（toISOString 直接抛 Invalid time value）
    //   —— 实测新文件的「人员流失率」表 J 列就是。
    if (!Number.isFinite(v.getTime())) return "";
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    const o = v;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return txt(o.result);
    return "";
  }
  return String(v).trim();
}

/**
 * 读全部 Sheet。
 * @returns {{ people: Record<string, object[]>, rows: Record<string, string[][]>, headers: Record<string, string[]> }}
 *   people[sheet] = 每行一个对象（键 = 表头文字，值为字符串；表头空白的列键为 `c{列号}`）
 *   rows[sheet]   = 每行一个字符串数组（**列序即原表列序**，不受表头文字影响）
 *   headers[sheet] = 表头文字数组
 */
export async function readExcelSheets(file = "途虎HR人员登记.xlsx") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const people = {};
  const rows = {};
  const headers = {};

  for (const ws of wb.worksheets) {
    const hr = HEADER_ROW[ws.name] ?? 1;
    const ds = DATA_START[ws.name] ?? hr + 1;

    // 表头（合并单元格取主格值）
    const hdr = [];
    for (let c = 1; c <= ws.columnCount; c++) hdr.push(txt(ws.getRow(hr).getCell(c).value));

    // 数据行
    const list = [];
    for (let r = ds; r <= ws.rowCount; r++) {
      const arr = [];
      let has = false;
      for (let c = 1; c <= ws.columnCount; c++) {
        const v = txt(ws.getRow(r).getCell(c).value);
        if (v) has = true;
        arr.push(v);
      }
      if (has) list.push(arr);
    }

    // 对象视图（供按列名取值的断言用）
    const objs = list.map((arr) => {
      const o = {};
      // ⚠️ 列号兜底时 arr 可能比 ws.columnCount 短（Excel 尾部空列），
      //   所以先补齐到表头长度，再做 arr[i] 访问 —— 否则 undefined.map 会抛。
      const width = Math.max(hdr.length, arr.length);
      for (let i = 0; i < width; i++) {
        const v = arr[i] ?? "";
        const key = hdr[i] && hdr[i].trim() ? hdr[i].trim() : `c${i + 1}`;
        o[key] = v;
      }
      // 常用列的别名（不同 Sheet 表头文字不一致，统一到这些键）
      /**
       * ⚠️ 用**列号兜底**，不能只靠表头文字 ——
       *   「在职」表第 5 列表头是**空的**（但那列就是姓名），
       *   只按表头名找会漏掉，导致断言拿不到基准值。
       * 列号按实测（各表人员类布局一致）：
       *   2=门店名称 3=入职时间 4=在职年限 5=姓名 8=工种级别 9=职位备注
       */
            const byIdx = (i) => arr[i] ?? "";
      const nameIdx = hdr.findIndex((h) => h === "姓名");
      if (nameIdx >= 0) o.name = arr[nameIdx];
      else if (arr.length >= 5 && !hdr[4]) o.name = byIdx(4);
      const storeIdx = hdr.findIndex((h) => h === "门店名称" || h === "门店");
      if (storeIdx >= 0) o.storeName = arr[storeIdx];
      else if (arr.length >= 2) o.storeName = byIdx(1);
      const gradeIdx = hdr.findIndex((h) => h === "工种级别");
      if (gradeIdx >= 0) o.jobGradeRaw = arr[gradeIdx];
      else if (arr.length >= 8 && (hdr[7] === "" || hdr[7] === undefined)) o.jobGradeRaw = byIdx(7);
      const noteIdx = hdr.findIndex((h) => h === "职位备注");
      if (noteIdx >= 0) o.positionNote = arr[noteIdx];
      else if (arr.length >= 9 && (hdr[8] === "" || hdr[8] === undefined)) o.positionNote = byIdx(8);
      return o;
    });

    people[ws.name] = objs;
    rows[ws.name] = list;
    headers[ws.name] = hdr;
  }

  return { people, rows, headers };
}