/**
 * SQLite 数据库备份脚本
 *
 * HR 敏感数据系统必须有备份策略。本脚本把 data/hr.db 复制到
 * data/backup/hr-YYYYMMDD-HHmmss.db，并保留最近 N 份。
 *
 * 运行：npm run backup
 */
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data", "hr.db");
const BACKUP_DIR = path.join(ROOT, "data", "backup");
const KEEP = Number(process.env.BACKUP_KEEP ?? 30);

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

async function main() {
  await mkdir(BACKUP_DIR, { recursive: true });

  const s = await stat(DB_PATH).catch(() => null);
  if (!s) {
    console.error(`✗ 找不到数据库文件：${DB_PATH}`);
    console.error("  请先执行 npm run db:push 初始化数据库。");
    process.exit(1);
  }

  const target = path.join(BACKUP_DIR, `hr-${stamp()}.db`);
  await copyFile(DB_PATH, target);
  const ts = await stat(target);
  console.log(`✓ 备份完成：${target}`);
  console.log(`  源库大小 ${(s.size / 1024).toFixed(1)} KB → 备份 ${(ts.size / 1024).toFixed(1)} KB`);

  // 清理旧备份
  const files = (await readdir(BACKUP_DIR))
    .filter((f) => /^hr-\d{8}-\d{6}\.db$/.test(f))
    .sort();
  if (files.length > KEEP) {
    const drop = files.slice(0, files.length - KEEP);
    for (const f of drop) {
      await unlink(path.join(BACKUP_DIR, f));
      console.log(`  - 已清理旧备份 ${f}`);
    }
  }
  console.log(`  当前保留备份数：${Math.min(files.length, KEEP)}（上限 ${KEEP}）`);

  console.log("");
  console.log("建议：Windows 任务计划程序每日执行一次 `npm run backup`，");
  console.log("      并把 data/backup 目录纳入网盘 / 移动硬盘同步。");
}

main().catch((e) => {
  console.error("✗ 备份失败：", e);
  process.exit(1);
});
