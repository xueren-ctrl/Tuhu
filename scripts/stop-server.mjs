/**
 * 停掉 3000 端口的服务进程（供 prisma generate 等需要独占引擎文件的操作使用）
 *
 * 背景（Stage 9.37）：`npx prisma generate` 要替换
 * `node_modules/.prisma/client/query_engine-windows.dll.node`，但正在运行的
 * `next start` 占着这个文件 → `EPERM: operation not permitted, rename ...`。
 * 而 autostart.mjs 守护每 15 秒会把服务拉起来，所以「停服务 → generate」这个
 * 空档必须在**同一个进程**里连续完成，不能分两次命令。
 *
 * ⚠️ 实现说明：本机沙箱会拦 `cmd.exe` 与 PowerShell 的进程操作，所以这里
 *    **不查端口**，而是直接扫 `.next` 构建产物对应的 `next start` 进程 —— 也不行，
 *    最终采用「按 pid 文件 + taskkill 都不行则让调用方自己处理」。
 *    目前只在**用户手动执行**时有效（不受沙箱限制）。
 *
 * 用法：node scripts/stop-server.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = join(ROOT, "logs", "server.pid");

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const n = Number(readFileSync(PID_FILE, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const pid = readPid();
if (!pid) {
  console.log("没有 logs/server.pid，无法自动定位服务进程");
  console.log("请手动在任务管理器结束命令行含 `next start` 的 node.exe");
  process.exit(1);
}

try {
  process.kill(pid, "SIGKILL");
  console.log(`已结束服务进程 PID ${pid}`);
} catch (e) {
  console.log(`结束 PID ${pid} 失败：${e.code ?? e.message}`);
  process.exit(1);
}
