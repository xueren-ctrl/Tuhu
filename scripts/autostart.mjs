#!/usr/bin/env node
/**
 * 开机自启动守护（Stage 9.9）
 *
 * 作用：这台电脑要当"服务器"，所以**开机后系统必须自己起来**，不能靠人手动敲命令。
 * 做法：Windows 登录时启动本脚本 → 它在后台常驻，每 15 秒检查一次服务是否在跑，
 *      掉了就自动拉起。日志写到 `logs/autostart.log`。
 *
 * 手动运行（调试用）：node scripts/autostart.mjs --once
 * 停止：结束进程 autostart.mjs 即可
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "logs");
const LOG = join(LOG_DIR, "autostart.log");
const PID_FILE = join(LOG_DIR, "autostart.pid");
const PORT = Number(process.env.PORT ?? 3000);
const CHECK_EVERY_MS = 15_000;
const NEXT_LOG_AT = 60 * 60 * 1000; // 每小时最多记一次「仍在运行」，免得日志疯长

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  appendFileSync(LOG, line);
  process.stdout.write(line);
}

let lastNoise = 0;
/** 只在状态变化或每隔一小时才记日志，避免刷屏 */
function logThrottled(msg, force = false) {
  const now = Date.now();
  if (force || now - lastNoise > NEXT_LOG_AT) {
    lastNoise = now;
    log(msg);
  }
}

/** 端口是否已被占用（即服务是否在跑） */
function portAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(2000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

let child = null;

function startServer(reason) {
  log(`启动服务（${reason}）… 端口 ${PORT}`);
  child = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
    windowsHide: true,
  });
  const prefix = (s) => `  [服务] ${s}`;
  child.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(prefix(l))));
  child.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(prefix(l))));
  child.on("exit", (code, sig) => {
    log(`服务已退出（code=${code} signal=${sig}），${CHECK_EVERY_MS / 1000} 秒后重试`);
    child = null;
  });
}

async function ensure() {
  if (child) return;
  if (await portAlive(PORT)) {
    // 端口有人在听 —— 可能是我自己拉起的、或用户手动开着 next dev
    logThrottled(`检测到 ${PORT} 端口已在监听，跳过启动`);
    return;
  }
  startServer("端口未监听");
}

// ------------------------------------------------------------
// 外网隧道（Stage 9.11）
//
// 用户不用 Tailscale（iOS 版只能走 Apple ID，与 Google/GitHub 账号不互通），
// 回到 Cloudflare 临时隧道。既然「电脑当服务器」，隧道也必须开机自动起，
// 否则每次开机都要手动开一个命令行窗口，用户还得自己从窗口里翻地址。
// ------------------------------------------------------------
const WANT_TUNNEL = process.env.TUHU_TUNNEL !== "0";
const TUNNEL_URL_FILE = join(ROOT, "logs", "tunnel-url.txt");
let tunnelChild = null;
/** 上次探测结果 + 连续失败次数，避免抖动导致地址反复变 */
let lastTunnelProbe = { ok: false, at: 0, fails: 0 };
const PROBE_MIN_INTERVAL = 120_000; // 2 分钟最多探一次
const FAILS_BEFORE_REBUILD = 2;      // 连续失败 2 次才重建（一次可能是网络抖动）

/**
 * 隧道是否真的可用 —— **发一个真实请求**去探，不能只看进程在不在。
 *
 * 踩过的坑：cloudflared 进程活着、但到 Cloudflare 的连接已断（网络抖动、切换 WiFi、
 * 电脑睡眠唤醒后），此时用户看到的是 `Error 1033 Cloudflare Tunnel error`，
 * 而守护只查「进程是否存在」→ 永远发现不了，隧道就这么僵在那儿一天。
 * 判据：HTTP 请求能拿到 200/307/401/403 都算通（说明 Cloudflare 已经把流量转到我们这儿），
 * 只有连接失败 / 5xx（尤其是 Cloudflare 返回的 1033）才算断。
 */
async function probeTunnel(url) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const res = await fetch(`${url}/login`, { method: "GET", signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    // 2xx/3xx/401 都算通；Cloudflare 自己的 1033 是 530，也算断
    return res.status < 500;
  } catch {
    return false;
  }
}

function killStrayCloudflared() {
  // 结束所有还活着的 cloudflared（含僵死的），再由我们重新拉起
  try {
    const out = execFileSync("taskkill", ["/IM", "cloudflared.exe", "/F"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    const n = (out.match(/PID:?\s*(\d+)/gi) ?? []).length;
    log(`已结束 ${n} 个旧隧道进程，正在重建…`);
  } catch {
    // 没有进程可杀是正常情况
  }
}

function tunnelProcessRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe", "/NH"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return /cloudflared\.exe/i.test(out);
  } catch {
    return false;
  }
}

function startTunnel(reason = "") {
  const urlFile = join(ROOT, "logs", "tunnel-url.txt");
  try {
    if (existsSync(urlFile)) unlinkSync(urlFile);
  } catch {
    /* 忽略 */
  }
  lastTunnelProbe = { ok: false, at: Date.now(), fails: 0 };
  log(`启动外网隧道（手机在外地也能打开）…${reason}`);
  tunnelChild = spawn(process.execPath, [join(ROOT, "scripts", "tunnel.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });
  const prefix = (s) => `  [隧道] ${s}`;
  tunnelChild.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(prefix(l))));
  tunnelChild.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log(prefix(l))));
  tunnelChild.on("exit", (code) => {
    log(`隧道已退出（code=${code}），${CHECK_EVERY_MS / 1000} 秒后重试`);
    tunnelChild = null;
  });
  // 拿到地址后明确记一行，方便用户直接看日志
  const watcher = setInterval(() => {
    if (!existsSync(TUNNEL_URL_FILE)) return;
    clearInterval(watcher);
    const url = readTunnelUrl();
    if (url) log(`★ 外网地址已就绪：${url}  （手机直接用浏览器打开，或「添加到主屏幕」装成 App）`);
  }, 2000);
}

/**
 * 守护隧道：
 *   1. 进程没了 → 重新拉起
 *   2. 进程在但**探不通**（Error 1033 那类假活）→ 杀掉僵死进程并重建
 */
async function ensureTunnel() {
  if (!WANT_TUNNEL) return;

  const running = Boolean(tunnelChild) || tunnelProcessRunning();
  const url = readTunnelUrl();

  if (!running) {
    startTunnel("（进程不存在）");
    return;
  }
  // 刚拉起来还没拿到地址，先给它时间
  if (!url) return;
  // 90 秒内已探过且是通的，不必重复探测
  if (lastTunnelProbe.ok && Date.now() - lastTunnelProbe.at < PROBE_MIN_INTERVAL) return;
  // 刚重建不到一个节流窗口，给它建立连接的时间
  if (Date.now() - lastTunnelProbe.at < PROBE_MIN_INTERVAL) return;

  const ok = await probeTunnel(url);
  lastTunnelProbe = {
    ok,
    at: Date.now(),
    fails: ok ? 0 : lastTunnelProbe.fails + 1,
  };

  if (ok) {
    if (lastTunnelProbe.fails === 0) logThrottled(`✓ 外网地址正常（已探测确认）`);
    return;
  }

  // 一次失败可能是网络抖动，连续 2 次才认定为真断
  if (lastTunnelProbe.fails < FAILS_BEFORE_REBUILD) {
    log(`· 外网地址暂时探不通（${lastTunnelProbe.fails}/${FAILS_BEFORE_REBUILD}），下轮再确认…`);
    return;
  }

  log(`✗ 外网地址连续探不通（用户会看到 Error 1033），正在重建隧道…`);
  if (tunnelChild) {
    try {
      tunnelChild.kill();
    } catch {
      /* 忽略 */
    }
    tunnelChild = null;
  }
  killStrayCloudflared();
  // 立刻重建，不等下一轮
  startTunnel("（重建）");
}

function readTunnelUrl() {
  try {
    if (!existsSync(TUNNEL_URL_FILE)) return "";
    const lines = readFileSync(TUNNEL_URL_FILE, "utf8").split("\n");
    const url = lines.map((l) => l.trim()).find((l) => l.startsWith("https://"));
    return url ?? "";
  } catch {
    return "";
  }
}

const ONCE = process.argv.includes("--once");

if (ONCE) {
  await ensure();
  // --once 模式下等服务起来就退出
  for (let i = 0; i < 30; i++) {
    if (await portAlive(PORT)) {
      log("✓ 服务已就绪");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("✗ 60 秒内服务仍未就绪，请查看上面的错误");
  process.exit(1);
}

// 常驻守护模式
writeFileSync(PID_FILE, String(process.pid), "utf8");
log(`=== 守护启动，pid=${process.pid}，每 ${CHECK_EVERY_MS / 1000} 秒检查一次 ===`);
log(`电脑从睡眠唤醒或网络恢复后会自动重连，无需手动操作。`);

await ensure();

// 服务起来之后再拉隧道（隧道要连本机 3000，服务没就绪会白跑一次）
setTimeout(() => ensureTunnel().catch(() => undefined), 3000);

const timer = setInterval(() => {
  ensure().catch((e) => log(`检查失败：${e.message}`));
  ensureTunnel().catch((e) => log(`隧道检查失败：${e.message}`));
}, CHECK_EVERY_MS);

function shutdown(sig) {
  log(`收到 ${sig}，正在停止…`);
  clearInterval(timer);
  if (child && !child.killed) {
    child.kill();
  }
  if (tunnelChild && !tunnelChild.killed) {
    tunnelChild.kill();
  }
  try {
    if (existsSync(PID_FILE)) writeFileSync(PID_FILE, "");
  } catch {
    /* 忽略 */
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
