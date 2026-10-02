import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

/**
 * Stage 9.38 导出断言（被 stage9-test.mjs 在末尾 import 调用）
 *
 * 用户要求：「导出后跟 Excel 一模一样，只是数据更新了」。
 * 锁死三件事：
 *  ① 原始 Excel **只读** —— SHA256 必须与基准一致（导出绝不覆盖原文件）
 *  ② 走真实 HTTP 接口下载到的文件，结构与原文件一致（Sheet 数 / 列数 / 合并单元格）
 *  ③ 导出流程跑完后原文件仍未变
 *
 * ⚠️ 两个踩过的坑：
 *  - `.mjs` **不能 import TS 模块**（ERR_MODULE_NOT_FOUND）
 *  - 本机沙箱**不让起子进程**（`spawnSync cmd.exe EBUSY`）
 *  → 所以这里**走 HTTP 接口**拿文件（这也更真实：用户就是点按钮下载的）。
 *    `req` 由调用方传入（已带登录 Cookie）。
 */
export async function runExportChecks(check, req) {
  const SRC_SHA = "aac5f0cad725f167e8d49e7b2b2bb4d0368923a190b500d5399bc4ffa3e19129";
  const sha = createHash("sha256").update(readFileSync("途虎HR人员登记.xlsx")).digest("hex");
  check(
    "S9-110",
    "原始 Excel 只读：SHA256 与基准一致，导出绝不覆盖原文件",
    sha === SRC_SHA,
    `当前 ${sha.slice(0, 16)}…（基准 ${SRC_SHA.slice(0, 16)}…）`
  );

  // ② 走接口下载，逐 Sheet 比对结构
  let structOk = false;
  let structDetail = "";
  let size = 0;
  try {
    const res = await req("/api/export/excel");
    if (res.status !== 200) {
      structDetail = `导出接口 HTTP=${res.status}`;
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      size = buf.length;
      const wbOut = new ExcelJS.Workbook();
      await wbOut.xlsx.load(buf);
      const wbSrc = new ExcelJS.Workbook();
      await wbSrc.xlsx.readFile("途虎HR人员登记.xlsx");

      const issues = [];
      if (wbOut.worksheets.length !== wbSrc.worksheets.length) {
        issues.push(`Sheet 数 ${wbSrc.worksheets.length}→${wbOut.worksheets.length}`);
      }
      for (const wsS of wbSrc.worksheets) {
        const wsO = wbOut.getWorksheet(wsS.name);
        if (!wsO) {
          issues.push(`缺 Sheet ${wsS.name}`);
          continue;
        }
        if (wsS.columnCount !== wsO.columnCount) {
          issues.push(`${wsS.name} 列数 ${wsS.columnCount}→${wsO.columnCount}`);
        }
        const mS = (wsS.model?.merges ?? []).length;
        const mO = (wsO.model?.merges ?? []).length;
        if (mS !== mO) issues.push(`${wsS.name} 合并单元格 ${mS}→${mO}`);
      }
      structOk = issues.length === 0;
      structDetail =
        issues.length > 0
          ? issues.slice(0, 4).join("；")
          : `${wbOut.worksheets.length} 个 Sheet 的列数与合并单元格数全部一致；文件 ${(size / 1024 / 1024).toFixed(2)} MB`;
    }
  } catch (e) {
    structDetail = `导出接口调用失败：${String(e.message).slice(0, 100)}`;
  }
  check("S9-111", "导出文件与原文件结构一致（Sheet 数 / 列数 / 合并单元格）", structOk, structDetail);

  const sha2 = createHash("sha256").update(readFileSync("途虎HR人员登记.xlsx")).digest("hex");
  check(
    "S9-113",
    "跑完导出后原文件 SHA256 仍未变（导出流程绝不写原文件）",
    sha2 === SRC_SHA,
    `导出后 ${sha2.slice(0, 16)}…`
  );
}
