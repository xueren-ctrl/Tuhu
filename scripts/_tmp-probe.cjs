// 复现 lib/network.ts 里 getTailscale() 的读取过程，定位 DNSName 为何为空
const { execFileSync } = require("node:child_process");
const TS = "C:\\Program Files\\Tailscale\\tailscale.exe";

console.log("=== execFileSync 直接调用 ===");
try {
  const raw = execFileSync(TS, ["status", "--json"], {
    encoding: "utf8",
    timeout: 4000,
    windowsHide: true,
  });
  console.log("原始长度:", raw.length);
  const j = JSON.parse(raw);
  console.log("BackendState:", j.BackendState);
  console.log("TailscaleIPs:", (j.TailscaleIPs || []).join(", "));
  console.log("Self.HostName:", j.Self?.HostName);
  console.log("Self.DNSName :", j.Self?.DNSName);
  const ips = (j.TailscaleIPs || []).filter((ip) => /^100\./.test(ip));
  console.log("过滤出的 100.x:", ips[0] || "(空)");
  const dns = (j.Self?.DNSName ?? "").replace(/\.$/, "");
  console.log("去尾点后 DNS 名:", dns || "(空)");
} catch (e) {
  console.log("异常:", e.message.split("\n")[0]);
}
