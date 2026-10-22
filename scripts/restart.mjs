#!/usr/bin/env node
/**
 * 一键重启 / 查看状态（Stage 9.50）
 *
 * 为什么不用「杀掉所有进程再全起一遍」：
 *   守护进程（scripts/autostart.mjs）每 15 秒检查一次 3000 端口，服务掉了会自动拉起。
 *   所以「重启服务」最干净的做法是**只结束服务进程**，让守护把它重新拉起来 ——
 *   守护和 Cloudflare 隧道都不用动，外网地址因此保持不变（不会换新地址）。
 *
 * 用法：
 *   npm run restart           重启网页服务（守护会自动拉起，约 15 秒）
 *   npm run restart -- --hard 连守护一起重启（隧道地址会变）
 *   npm run status            只看当前状态：端口 / 守护 / 服务 / 外网地址
 *
 * 注意：本脚本不用 PowerShell 扫进程（沙箱下拿不到输出），
 *       只依赖 logs/server.pid + logs/autostart.pid + 端口探测。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "logs");
const SERVER_PID = join(LOG_DIR, "server.pid");
const GUARD_PID = join(LOG_DIR, "autostart.pid");
const TUNNEL_URL = join(LOG_DIR, "tunnel-url.txt");
const PORT = Number(process.env.PORT ?? 3000);

const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes("--status");
const HARD = argv.includes("--hard");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPid(file) {
  try {
    if (!existsSync(file)) return null;
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 结束进程；Windows 上 taskkill 最稳（process.kill 对子进程树不彻底） */
function killPid(pid) {
  if (!pid) return false;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function portOpen(port = PORT) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** 真正发一个 HTTP 请求确认登录页能出来（端口开着不等于服务正常） */
function httpOk(port = PORT, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/login", timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function tunnelUrl() {
  try {
    if (!existsSync(TUNNEL_URL)) return "";
    return (readFileSync(TUNNEL_URL, "utf8").split("\n").map((s) => s.trim()).find((s) => s.startsWith("https://"))) ?? "";
  } catch {
    return "";
  }
}

async function waitUp(maxMs, label) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await httpOk()) {
      console.log(`✓ ${label}：服务已就绪（${Math.round((Date.now() - start) / 1000)} 秒）`);
      return true;
    }
    await sleep(1000);
  }
  console.log(`✗ ${label}：${maxMs / 1000} 秒内服务没有起来，请看 logs/autostart.log`);
  return false;
}

async function printStatus() {
  const guard = readPid(GUARD_PID);
  const server = readPid(SERVER_PID);
  const up = await httpOk();
  console.log("");
  console.log("──────── 途虎 HR 运行状态 ────────");
  console.log(`  服务端口 ${PORT}  : ${up ? "正常（登录页 200）" : "未响应"}`);
  console.log(`  服务进程        : ${alive(server) ? `运行中 pid=${server}` : "未运行"}`);
  console.log(`  守护进程        : ${alive(guard) ? `运行中 pid=${guard}` : "未运行（重启后不会自动拉起）"}`);
  console.log(`  外网地址        : ${tunnelUrl() || "（无，隧道未运行）"}`);
  console.log(`  本机地址        : http://localhost:${PORT}`);
  console.log(`  开机自启        : ${existsSync(join(process.env.APPDATA ?? "", "Microsoft/Windows/Start Menu/Programs/Startup/TuhuHR-AutoStart.vbs")) ? "已安装" : "未安装"}`);
  console.log("──────────────────────────────────");
  console.log("");
}

async function main() {
  if (STATUS_ONLY) {
    await printStatus();
    return;
  }

  const guard = readPid(GUARD_PID);
  const server = readPid(SERVER_PID);
  const guardAlive = alive(guard);

  if (HARD) {
    console.log("· 连守护一起重启（外网地址会变）…");
    killPid(server);
    if (guardAlive) killPid(guard);
    // 守护的子进程（tunnel.mjs / cloudflared）不随父进程结束，单独收掉
    for (const f of ["tunnel.pid"]) killPid(readPid(join(LOG_DIR, f)));
    try {
      execFileSync("taskkill", ["/IM", "cloudflared.exe", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 没有也无妨 */
    }
    if (existsSync(TUNNEL_URL)) writeFileSync(TUNNEL_URL, "", "utf8");
    for (let i = 0; i < 15 && (await portOpen()); i++) await sleep(1000);
  } else if (alive(server)) {
    console.log(`· 结束服务进程 pid=${server}，等守护自动拉起…`);
    killPid(server);
    for (let i = 0; i < 15 && (await portOpen()); i++) await sleep(1000);
  } else {
    console.log("· 服务进程本来就没在跑…");
  }

  if (guardAlive && !HARD) {
    const ok = await waitUp(60_000, "重启服务");
    if (!ok) {
      console.log("· 守护没有把服务拉起来，改为手动启动守护…");
      startGuard();
      await waitUp(60_000, "手动启动");
    }
  } else {
    startGuard();
    if (HARD) await waitUp(90_000, "重启守护");
    else await waitUp(60_000, "启动");
  }

  await printStatus();
}

function startGuard() {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "autostart.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(`· 已启动守护进程 pid=${child.pid}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
