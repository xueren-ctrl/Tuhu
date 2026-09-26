import os from "node:os";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * 访问地址探测（仅服务端使用）
 *
 * 用途：把「本机 / 局域网 / Tailscale 永久地址 / 公网临时隧道」四类访问方式
 * 集中展示给用户，手机上不用去猜 IP，照着地址输入即可。
 *
 * Tailscale 说明（Stage 9.10）：
 *   装上 Tailscale 并登录后，这台电脑会多出一个 `100.x.x.x` 的虚拟地址。
 *   **任何地方（家里、公司、酒店、4G）用这个地址都能访问，且地址永不变。**
 *   该地址只对登录了同一 Tailscale 账号的设备开放，外面的人完全访问不到，
 *   比公网隧道安全得多 —— 系统里存着身份证和薪资，不宜暴露在公网。
 */

export interface LanAddress {
  /** 网卡名（中文系统下通常是「WLAN」「以太网」等） */
  iface: string;
  /** IPv4 地址 */
  address: string;
  /** 可直接访问的完整地址 */
  url: string;
}

export interface TailscaleInfo {
  /** 已安装且已登录（能拿到 100.x 地址） */
  ok: boolean;
  /** 安装了但拿不到地址 —— 提示用户执行 npm run ts:up */
  installed: boolean;
  /** 100.x.x.x 地址 */
  ip: string;
  /** MagicDNS 名称，如 xxx.tailxxxx.ts.net（可在客户端直接解析） */
  dnsName: string;
  /** 设备名 */
  hostName: string;
}

const TS_EXE = "C:\\Program Files\\Tailscale\\tailscale.exe";

/** 列出本机所有可用于局域网访问的 IPv4 地址（不含 Tailscale 的 100.64~127 段） */
export function getLanAddresses(port: number): LanAddress[] {
  const out: LanAddress[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      // 169.254.x.x 是链路本地地址（DHCP 失败时的兜底），不可用
      if (info.address.startsWith("169.254.")) continue;
      // 100.64~127.x.x 是 CGNAT / Tailscale 网段，单独在「永久地址」卡片展示
      if (isCgnat(info.address)) continue;
      out.push({ iface: name, address: info.address, url: `http://${info.address}:${port}` });
    }
  }
  // 常见的家用/办公网段优先展示
  out.sort((a, b) => score(b.address) - score(a.address));
  return out;
}

function score(ip: string): number {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}

/** 100.64.0.0/10 —— CGNAT 段，Tailscale 用的就是这一段 */
export function isCgnat(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/**
 * 读取本机 Tailscale 状态。
 *
 * ⚠️ 必须用**异步 execFile**，不能用 `execFileSync` / `execSync`：
 * 在本机环境（Windows + 沙箱 shim）下同步派生进程会抛 `EBUSY`，
 * 导致读不到 MagicDNS 名称（IP 能从网卡兜底拿到，所以只表现为「少了域名」）。
 *
 * 拿不到 JSON 时回退到网卡列表里找 100.64~127.x 的地址。
 * 任何异常都吞掉 —— 探测失败只影响展示，不能让页面 500。
 */
export function getTailscale(): Promise<TailscaleInfo> {
  const empty: TailscaleInfo = { ok: false, installed: false, ip: "", dnsName: "", hostName: "" };
  if (!existsSync(TS_EXE)) return Promise.resolve(empty);

  return new Promise((resolve) => {
    execFile(
      TS_EXE,
      ["status", "--json"],
      { encoding: "utf8", timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const finish = (fromJson: TailscaleInfo | null) => {
          if (fromJson && fromJson.ok) return resolve(fromJson);
          // 兜底：JSON 不可用时至少把网卡上的 100.x 地址显示出来
          const nic = getCgnatAddress();
          resolve({
            ok: Boolean(nic),
            installed: true,
            ip: nic ?? "",
            dnsName: fromJson?.dnsName ?? "",
            hostName: fromJson?.hostName ?? "",
          });
        };

        if (stdout) {
          try {
            const j = JSON.parse(stdout) as {
              BackendState?: string;
              TailscaleIPs?: string[];
              Self?: { HostName?: string; DNSName?: string };
            };
            const ips = (j.TailscaleIPs ?? []).filter((ip) => /^100\./.test(ip));
            finish({
              ok: j.BackendState === "Running" && ips.length > 0,
              installed: true,
              ip: ips[0] ?? "",
              dnsName: (j.Self?.DNSName ?? "").replace(/\.$/, ""),
              hostName: j.Self?.HostName ?? "",
            });
            return;
          } catch {
            /* 落到下面的兜底 */
          }
        }
        if (err) finish(null);
        else finish(null);
      }
    );
  });
}

function getCgnatAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && isCgnat(i.address)) return i.address;
    }
  }
  return null;
}

/** 判断某个 IP 是不是本机地址 */
export function isLocalAddress(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    Object.values(os.networkInterfaces())
      .flat()
      .some((i) => i?.address === ip)
  );
}
