#!/usr/bin/env node
/**
 * 启动服务并打印「手机 / 其他电脑」可用的访问地址
 *
 * 用法：npm run serve            （默认 3000 端口）
 *       npm run serve -- 3010    （换端口）
 *
 * 与 npm start 的区别：start 只启动服务，本脚本额外把局域网地址清楚地列出来，
 * 并把 Windows 防火墙该放行的命令一起提示，省得去猜 IP。
 */
import { spawn } from "node:child_process";
import os from "node:os";

const PORT = Number(process.argv[2] || process.env.PORT || 3000);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      out.push({ name, address: info.address });
    }
  }
  const score = (ip) =>
    ip.startsWith("192.168.") ? 3 : ip.startsWith("10.") ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0;
  return out.sort((a, b) => score(b.address) - score(a.address));
}

const LAN = lanAddresses();
const line = "─".repeat(58);

console.log(`\n${line}`);
console.log("  途虎加盟店 HR 人事管理系统");
console.log(line);
console.log(`  本机访问      http://localhost:${PORT}`);
if (LAN.length === 0) {
  console.log("  局域网访问    （未检测到网卡，请确认已连 WiFi / 网线）");
} else {
  LAN.forEach((a, i) => {
    console.log(`  ${i === 0 ? "局域网访问" : "            "}  http://${a.address}:${PORT}   [${a.name}]`);
  });
  console.log("\n  手机连同一个 WiFi，浏览器输入上面的「局域网访问」地址即可。");
}
console.log(`\n  手机在外面用 4G 访问：另开一个窗口执行  npm run tunnel`);
console.log(`  打不开时先放行防火墙：以管理员身份执行  npm run firewall`);
console.log(`${line}\n`);

const child = spawn("next", ["start", "-H", "0.0.0.0", "-p", String(PORT)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PORT: String(PORT) },
});

const stop = (sig) => () => {
  child.kill(sig);
  process.exit(0);
};
process.on("SIGINT", stop("SIGINT"));
process.on("SIGTERM", stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
