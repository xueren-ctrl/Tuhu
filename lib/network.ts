import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 访问地址探测（仅服务端使用）
 *
 * 用途：把「本机 / 局域网 / 外网」三类访问方式明确展示给用户，
 * 手机上不用去猜 IP，照着地址输入即可。
 */

export interface LanAddress {
  /** 网卡名（中文系统下通常是「WLAN」「以太网」等） */
  iface: string;
  /** IPv4 地址 */
  address: string;
  /** 可直接访问的完整地址 */
  url: string;
}

/** 列出本机所有可用于局域网访问的 IPv4 地址 */
export function getLanAddresses(port: number): LanAddress[] {
  const out: LanAddress[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      // 169.254.x.x 是链路本地地址（DHCP 失败时的兜底），不可用
      if (info.address.startsWith("169.254.")) continue;
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

/**
 * 读取当前外网隧道地址（Cloudflare 临时隧道）
 *
 * scripts/tunnel.mjs 每次拿到公网地址后会写 logs/tunnel-url.txt，
 * 这里读出来展示 —— 用户不必再去命令行窗口里翻地址。
 * 没有隧道 / 文件不存在时返回空字符串。
 */
export function getTunnelUrl(): string {
  const f = join(process.cwd(), "logs", "tunnel-url.txt");
  if (!existsSync(f)) return "";
  try {
    const lines = readFileSync(f, "utf8").split("\n");
    return lines.map((l) => l.trim()).find((l) => l.startsWith("https://")) ?? "";
  } catch {
    return "";
  }
}
