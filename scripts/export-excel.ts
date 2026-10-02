/**
 * 命令行导出 Excel（与页面按钮同一套逻辑，Stage 9.38）
 *
 * 用法：
 *   npm run export:excel                    # 导出到 data/export/
 *   npx tsx scripts/export-excel.ts --out D:\某目录
 *   npx tsx scripts/export-excel.ts --dryrun # 只看各 Sheet 回填统计，不写文件
 *
 * ⚠️ 原始 `途虎HR人员登记.xlsx` **只读**，永不写入。
 * ⚠️ 本项目 tsconfig 是 cjs，所以不能用顶层 await —— 用 main() 包装。
 */
import { exportExcel } from "../lib/excel-export-service";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (f: string) => process.argv.includes(f);

async function main() {
  const dry = has("--dryrun");
  const outDir = resolve(arg("--out", join(process.cwd(), "data", "export"))!);

  console.log("开始导出（底模 = 途虎HR人员登记.xlsx，只读）…");
  const t0 = Date.now();
  const { buffer, filename, stats } = await exportExcel();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n耗时 ${secs}s，文件大小 ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n`);
  console.log("各 Sheet 回填情况：");
  for (const s of stats) {
    const mark = s.written > 0 ? "OK" : s.note.includes("!") ? "!!" : "--";
    console.log(`  ${mark} ${s.sheet.padEnd(10, "　")} 行数=${String(s.rows).padStart(5)} 回填=${String(s.written).padStart(6)}  ${s.note}`);
  }
  const totalWritten = stats.reduce((a, s) => a + s.written, 0);
  const totalRows = stats.reduce((a, s) => a + s.rows, 0);
  console.log(`\n合计：${totalRows} 行，回填 ${totalWritten} 个单元格`);

  if (dry) {
    console.log("\n(--dryrun 模式，未写文件)");
    return;
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const target = join(outDir, filename);
  writeFileSync(target, buffer);
  console.log(`\n已导出：${target}`);
  console.log(`   文件大小 ${(statSync(target).size / 1024 / 1024).toFixed(2)} MB`);
  console.log("\n提示：请用 Excel 打开核对 —— 表头位置、列顺序、合并单元格、公式应与原文件一致，");
  console.log("      差异只应体现在数据行（新增/离职人员会体现为行数变化）。");
}

main().catch((e) => {
  console.error("导出失败：", e.message);
  console.error(e.stack?.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});