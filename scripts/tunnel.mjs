#!/usr/bin/env node
/**
 * 外网访问隧道（Cloudflare Quick Tunnel）
 *
 * 作用：把本机 http://127.0.0.1:3000 暴露成一个公网 https 地址，
 *      手机用 4G 也能打开 HR 系统。
 *
 * 用法：npm run tunnel              （默认隧道到 3000 端口）
 *       npm run tunnel -- 3010
 *       set HTTPS_PROXY=http://127.0.0.1:7890 && npm run tunnel   （指定代理）
 *
 * 特性：
 *  - 首次运行自动下载 cloudflared.exe 到 tools/ 目录（约 40MB）；
 *  - 直连失败会依次尝试环境变量里的代理、以及本机常见的 127.0.0.1:7890，
 *    再不行走 GitHub 镜像 —— 国内网络通常至少有一条路能通；
 *  - 地址是临时的：窗口关掉就失效，下次启动换新地址（数据始终留在本机，不上云）。
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = path.join(ROOT, "tools");
const BIN = path.join(TOOLS_DIR, "cloudflared.exe");

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const TARGET = `http://127.0.0.1:${PORT}`;
const RELEASE =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const MIRRORS = [`https://ghfast.top/${RELEASE}`, `https://gh-proxy.com/${RELEASE}`];

/** 本机常见的科学上网代理端口（用户环境实测 7890 可用） */
const LOCAL_PROXIES = ["http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:10809"];

const ENV_PROXIES = [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy]
  .filter(Boolean)
  .map((p) => String(p));

const ALL_PROXIES = [...new Set([...ENV_PROXIES, ...LOCAL_PROXIES])];

const log = (...a) => console.log(...a);

function curlDownload(url, dest, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      "-L",
      "--fail",
      "--retry",
      "1",
      "--retry-delay",
      "2",
      "--connect-timeout",
      "10",
      // 连上了但速度过低（<20KB/s 持续 15 秒）就放弃这条路，换下一条
      "--speed-limit",
      "20000",
      "--speed-time",
      "15",
      "--max-time",
      "600",
      "-s",
      "-S",
      "-o",
      dest,
    ];
    if (proxy) args.push("-x", proxy);
    args.push(url);
    const p = spawn("curl.exe", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `curl exit ${code}`))
    );
  });
}

async function directFetch(url, dest) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function ok(dest) {
  return existsSync(dest) && statSync(dest).size > 20 * 1024 * 1024;
}

/** 用 1KB 的小请求探一下某条线路通不通，通返回 HTTP 码，不通返回 0 */
function probe(proxy, url) {
  return new Promise((resolve) => {
    const args = [
      "-s",
      "-o",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "--max-time",
      "8",
      "-r",
      "0-1023",
      "-w",
      "%{http_code}",
    ];
    if (proxy) args.push("-x", proxy);
    args.push(url);
    const p = spawn("curl.exe", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(0));
    p.on("exit", () => resolve(Number(out.trim()) || 0));
  });
}

async function ensureBinary() {
  if (ok(BIN)) return BIN;
  mkdirSync(TOOLS_DIR, { recursive: true });
  const tmp = BIN + ".part";

  // 先探测哪条线路真能下（各 8 秒小请求），把实测可用的排在前面 ——
  // 国内直连 GitHub 往往只是「连得上但极慢」，不做探测会白等十几分钟。
  log("\n首次运行：需要下载隧道程序 cloudflared（约 40MB）");
  log("  正在探测可用下载线路…");
  const routes = [
    { label: "直连", proxy: null },
    ...ALL_PROXIES.map((px) => ({ label: `代理 ${px}`, proxy: px })),
  ];
  const probed = [];
  for (const r of routes) {
    const code = await probe(r.proxy, RELEASE);
    if (code >= 200 && code < 400) {
      log(`    ✓ ${r.label} 可用（HTTP ${code}）`);
      probed.push(r);
    } else {
      log(`    ✗ ${r.label} 不可用`);
    }
  }
  const usable = probed.length ? probed : [{ label: "直连", proxy: null }];

  const attempts = [
    ...usable.map((r) => [r.label, () => curlDownload(RELEASE, tmp, r.proxy)]),
    ...MIRRORS.map((m, i) => [`GitHub 镜像 ${i + 1}`, () => curlDownload(m, tmp, null)]),
    ["直连(fetch 兜底)", () => directFetch(RELEASE, tmp)],
  ];

  log("");
  let lastErr;
  for (const [name, fn] of attempts) {
    try {
      log(`  · 下载（${name}）…`);
      await fn();
      if (ok(tmp)) {
        if (existsSync(BIN)) unlinkSync(BIN);
        renameSync(tmp, BIN);
        log(`  ✓ 下载完成（${(statSync(BIN).size / 1048576).toFixed(1)} MB）`);
        return BIN;
      }
      lastErr = new Error("文件不完整");
      log("    ✗ 文件不完整");
    } catch (e) {
      lastErr = e;
      if (existsSync(tmp)) unlinkSync(tmp);
      log(`    ✗ ${e.message}`);
    }
  }
  throw new Error(`cloudflared 下载失败：${lastErr?.message ?? "未知原因"}`);
}

const banner = (url) => {
  const line = "─".repeat(58);
  log(`\n${line}`);
  log("  外网访问地址（手机 4G 可直接打开）：");
  log(`  ${url}`);
  log(`${line}`);
  log("  · 地址是临时的：关掉本窗口就失效，下次启动会换新地址。");
  log("  · 别把地址发给无关的人；用完请关掉本窗口（本窗口即隧道开关）。");
  log("  · 数据始终存在本机 data/hr.db，隧道只做转发，不上云。");
  log(`${line}\n`);
};

/** 起隧道；resolve 得到公网地址；若超时未拿到地址 resolve(null) */
function startTunnel(env, timeoutMs = 30_000, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(BIN, ["tunnel", "--url", TARGET, "--no-autoupdate", ...extraArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let announced = false;
    let buf = "";
    const timer = setTimeout(() => {
      if (!announced) {
        child.kill();
        resolve(null);
      }
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (process.env.TUNNEL_VERBOSE) process.stdout.write(chunk);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !announced) {
        announced = true;
        clearTimeout(timer);
        // 把当前公网地址落盘，软件内的「访问入口」页据此显示，
        // 用户不必再去命令行窗口里翻地址。
        try {
          mkdirSync(path.join(ROOT, "logs"), { recursive: true });
          writeFileSync(
            path.join(ROOT, "logs", "tunnel-url.txt"),
            `${new Date().toISOString()}\n${m[0]}\n`,
            "utf8"
          );
        } catch {
          /* 写不进去也不影响隧道本身 */
        }
        resolve({ url: m[0], child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!announced) resolve(null);
      else log(`隧道进程已退出（code=${code}），公网地址随即失效。`);
    });
  });
}

function withoutProxyEnv() {
  const env = { ...process.env };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    delete env[k];
  }
  return env;
}

log(`\n隧道目标：${TARGET}`);

try {
  await ensureBinary();
} catch (e) {
  log(`\n[x] ${e.message}`);
  log("提示：确认本机代理是否开启（如 127.0.0.1:7890），或手动把 cloudflared.exe 放到 tools/ 目录后重试。\n");
  process.exit(1);
}

log("\n正在建立隧道…（约 5–20 秒）");
let result = await startTunnel(withoutProxyEnv());

if (!result && ALL_PROXIES.length) {
  for (const px of ALL_PROXIES) {
    log(`  直连没通，换成代理 ${px} 重试…`);
    // 走 HTTP 代理时 QUIC(UDP) 出不去，强制用 http2 传输
    result = await startTunnel({ ...withoutProxyEnv(), HTTPS_PROXY: px, HTTP_PROXY: px }, 30_000, [
      "--protocol",
      "http2",
    ]);
    if (result) break;
  }
}

if (!result) {
  log("\n[x] 隧道建立失败：本机网络无法连上 Cloudflare 的边缘节点。");
  log("    可以先开启代理（Clash 等）再执行 npm run tunnel，或改用 Tailscale 方案。\n");
  process.exit(1);
}

banner(result.url);
const child = result.child;
process.on("SIGINT", () => {
  child.kill();
  process.exit(0);
});
child.on("exit", (code) => process.exit(code ?? 0));
