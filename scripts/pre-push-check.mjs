#!/usr/bin/env node
/**
 * 提交前敏感信息体检 —— 防止把 HR 个人数据推到 Git 仓库
 *
 * 用法：
 *   node scripts/pre-push-check.mjs          # 扫描「将要提交的内容」（会先 git add -A）
 *   node scripts/pre-push-check.mjs --staged # 只扫描已暂存内容，不再 add
 *
 * 检出内容：
 *   1. 完整 18 位身份证号（含校验位算法）
 *   2. 完整 19 位银行卡号
 *   3. 完整 11 位手机号
 *   4. 绝不允许入库的文件名（数据库 / 原始 Excel / 备份 / 导出）
 *   5. 明文密钥模式（GitHub token、sk- 开头的 API Key、私钥头）
 *
 * 发现问题时以退出码 1 结束，必须处理后再提交。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const STAGED_ONLY = process.argv.includes("--staged");

/**
 * 允许出现的**合成测试数据**（用于自动化测试与文档示例，不对应真实个人）。
 * 只允许这一类明确无主的假号码，任何真实数据都不得进入此列表。
 */
const ALLOWLIST = [
  "110101199001011234", // 假身份证（行政区划 110101 北京东城 + 1990-01-01）
  "13800138000", // 中国移动测试号段惯例假号
  "13900139000", // 假号
  "13700137000", // 假号（第三阶段验收脚本用于验证敏感字段脱敏）
  "0000123456789012", // 假银行卡号（用于验证前导零保留）
];

const PATTERNS = [
  {
    name: "完整身份证号（18 位）",
    re: /(?<![\d*\w])\d{17}[\dXx](?![\d*\w])/g,
    verify: looksLikeRealIdCard,
    severity: "P0",
  },
  {
    name: "完整银行卡号（19 位）",
    re: /(?<![\d*\w])\d{19}(?![\d*\w])/g,
    verify: (v) => !ALLOWLIST.includes(v),
    severity: "P0",
  },
  {
    name: "完整手机号（11 位）",
    re: /(?<![\d*\w])1[3-9]\d{9}(?![\d*\w])/g,
    verify: (v) => !ALLOWLIST.includes(v),
    severity: "P0",
  },
  {
    name: "明文 GitHub Token",
    re: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    severity: "P0",
  },
  {
    name: "明文 API Key（sk- 开头）",
    re: /sk-[A-Za-z0-9_-]{20,}/g,
    severity: "P0",
  },
  {
    name: "私钥文件内容",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: "P0",
  },
];

/** 绝不允许进入 Git 的文件（即使被误 add） */
const FORBIDDEN_FILES = [
  { re: /\.db(-journal|-wal|-shm)?$/i, why: "SQLite 数据库文件（含全部员工个人数据）" },
  { re: /\.xlsx?$/i, why: "Excel 原始数据文件（含全部员工个人数据）" },
  { re: /\.csv$/i, why: "CSV 数据文件（可能含个人数据）" },
  { re: /^\.env$/i, why: "环境变量文件（可能含密钥/连接串）" },
  { re: /^\.env\.(?!example$)/i, why: "环境变量文件（可能含密钥）" },
];

/** GB 11643-1999 校验位：用于降低误报（日期型/业务编号不会通过） */
function looksLikeRealIdCard(v) {
  if (ALLOWLIST.includes(v)) return false;
  const s = v.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const area = Number(s.slice(0, 2));
  if (area < 11 || area > 82) return false; // 行政区划码
  const y = Number(s.slice(6, 10));
  const m = Number(s.slice(10, 12));
  const d = Number(s.slice(12, 14));
  if (y < 1900 || y > new Date().getFullYear()) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
  return c[sum % 11] === s[17];
}

function sh(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function main() {
  if (!existsSync(".git")) {
    console.error("✗ 当前目录不是 Git 仓库，无法扫描。请先执行 git init。");
    process.exit(1);
  }

  if (!STAGED_ONLY) {
    console.log("→ 暂存全部改动（git add -A）…");
    sh(["add", "-A"]);
  }

  const files = sh(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`→ 本次将提交 ${files.length} 个文件，开始体检…`);
  console.log("");

  const problems = [];

  // ① 文件名黑名单
  for (const f of files) {
    const base = f.split("/").pop() ?? f;
    for (const rule of FORBIDDEN_FILES) {
      if (rule.re.test(base) || rule.re.test(f)) {
        problems.push({
          severity: "P0",
          kind: "禁止提交的文件",
          file: f,
          detail: rule.why,
        });
      }
    }
  }

  // ② 内容扫描（读暂存区里的内容，而不是工作区）
  const TEXT_EXT =
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|yml|yaml|env|example|css|html|sql|prisma|gitignore|npmrc)$/i;
  for (const f of files) {
    if (!TEXT_EXT.test(f) && !f.startsWith(".env")) continue;
    let content = "";
    try {
      content = sh(["show", `:${f}`]);
    } catch {
      continue; // 二进制或被删除
    }
    const lines = content.split(/\r?\n/);
    for (const p of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(line)) !== null) {
          const val = m[0];
          if (p.verify && !p.verify(val)) continue;
          problems.push({
            severity: p.severity,
            kind: p.name,
            file: f,
            line: i + 1,
            detail: mask(val),
            snippet: line.trim().slice(0, 110),
          });
        }
      }
    }
  }

  if (problems.length === 0) {
    console.log("✅ 体检通过：未发现身份证号 / 银行卡号 / 手机号 / 密钥 / 禁止提交的文件。");
    console.log("   可以安全提交与推送。");
    return;
  }

  console.log(`❌ 体检未通过，发现 ${problems.length} 处问题：`);
  console.log("");
  for (const p of problems) {
    console.log(`[${p.severity}] ${p.kind}`);
    console.log(`       文件：${p.file}${p.line ? `:${p.line}` : ""}`);
    console.log(`       内容：${p.detail}`);
    if (p.snippet && p.snippet !== p.detail) console.log(`       原行：${p.snippet}`);
    console.log("");
  }
  console.log("处理建议：");
  console.log("  1) 数据文件（.db/.xlsx/.csv/.env）→ 确认已写入 .gitignore，然后 git rm --cached <文件>");
  console.log("  2) 文档里的示例值 → 改成脱敏写法，如 4206**********2815");
  console.log("  3) 明文密钥 → 立即吊销该密钥，改从环境变量读取");
  console.log("");
  console.log("⚠ 若这些内容已经推送到远程，仅删除文件是不够的，必须清理 Git 历史。");
  process.exit(1);
}

function mask(v) {
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}${"*".repeat(Math.max(4, v.length - 8))}${v.slice(-4)}`;
}

main();
