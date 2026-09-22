/**
 * API 认证覆盖检查（Stage 6.1 新增）
 *
 * 扫描 app/api 目录下所有 route.ts，逐个 HTTP handler 检查是否真正调用了 requireApiUser。
 * 规则：
 *   - /api/auth/login、/api/auth/logout、/api/auth/me 允许不调用（登录/登出/取自身）；
 *   - 其他**所有**业务 API handler 必须调用 requireApiUser(req)；
 *   - 仅 import 而不调用不算数（在 handler 函数体内检测）。
 *
 * 输出：API / Method / 是否守卫 / 角色限制。任一业务 handler 未守卫 → exit 1。
 *
 * 运行：npm run check:auth   （= node scripts/check-auth-coverage.mjs，无需启动服务器）
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "app", "api");

/** 允许豁免（不调用 requireApiUser）的路由：相对 /api 的路径 */
const EXEMPT = new Set(["auth/login", "auth/logout", "auth/me"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name === "route.ts") out.push(p);
  }
  return out;
}

const files = walk(API_DIR);
const results = []; // { api, method, guarded, roles, exempt, line }
let violations = 0;

for (const f of files) {
  const rel = path.relative(API_DIR, f).replace(/\\/g, "/").replace(/\/route\.ts$/, "");
  const src = readFileSync(f, "utf8");
  const exempt = EXEMPT.has(rel);
  const lines = src.split("\n");

  // 找到每个 handler：export async function GET/POST/PUT/PATCH/DELETE(...)
  const handlerRe = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(handlerRe);
    if (!m) continue;
    const method = m[1];
    // 提取 handler 函数体：从这一行起到下一个顶层 "export function / export const / EOF"
    // 简化：从 handler 行起，扫到下一个以 "export async function" 开头的行
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^export\s+async\s+function/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i, end).join("\n");
    const guarded = /requireApiUser\s*\(/.test(body);
    const rolesMatch = body.match(/requireApiUser\s*\(\s*req\s*,\s*\{\s*roles:\s*\[([^\]]*)\]/);
    const roles = rolesMatch ? `[${rolesMatch[1].trim()}]` : "ANY";
    results.push({ api: rel, method, guarded, roles, exempt, line: i + 1 });
    if (!exempt && !guarded) {
      violations++;
      console.log(`  ❌ 缺失守卫: POST  ${rel}#${method}`);
    }
  }
}

console.log("═".repeat(78));
console.log("API 认证覆盖检查（requireApiUser）");
console.log("═".repeat(78));
console.log("API".padEnd(30) + "Method".padEnd(8) + "守卫".padEnd(6) + "角色限制");
console.log("─".repeat(78));
for (const r of results) {
  const mark = r.exempt ? "豁免" : r.guarded ? "✅" : "❌";
  console.log(
    `/${r.api}`.padEnd(30) +
      r.method.padEnd(8) +
      mark.padEnd(6) +
      (r.exempt ? "-" : r.roles)
  );
}
console.log("─".repeat(78));

const biz = results.filter((r) => !r.exempt);
const guardedCount = biz.filter((r) => r.guarded).length;
const totalBiz = biz.length;
const coverage = totalBiz === 0 ? 100 : Math.round((guardedCount / totalBiz) * 100);
console.log(
  `业务 handler 总数：${totalBiz}   已守卫：${guardedCount}   覆盖率：${coverage}%`
);

if (violations > 0) {
  console.error(`\n❌ 发现 ${violations} 个业务 API handler 未调用 requireApiUser —— 检查失败`);
  process.exit(1);
}
if (coverage !== 100) {
  console.error(`\n❌ 认证覆盖率 ${coverage}% ≠ 100% —— 检查失败`);
  process.exit(1);
}
console.log("\n✅ 认证覆盖率 100%：所有业务 API handler 均在路由内真正调用 requireApiUser");
