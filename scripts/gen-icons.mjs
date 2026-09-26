/**
 * 从 public/icons/icon.svg 生成 PWA 所需的各尺寸 PNG 图标。
 * 用项目自带的 sharp（Next.js 依赖链里已有，无需额外安装）。
 * 运行：node scripts/gen-icons.mjs
 */
import sharp from "sharp";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public/icons/icon.svg"));

const SIZES = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  // iOS 主屏图标（苹果要求不能有透明通道，用背景色垫底）
  { size: 180, name: "apple-touch-icon.png", flatten: true },
  { size: 152, name: "apple-touch-icon-152.png", flatten: true },
  { size: 167, name: "apple-touch-icon-167.png", flatten: true },
];

for (const s of SIZES) {
  const dest = join(root, "public/icons", s.name);
  let pipeline = sharp(svg, { density: 384 }).resize(s.size, s.size, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (s.flatten) pipeline = pipeline.flatten({ background: "#0f172a" });
  await pipeline.png({ compressionLevel: 9 }).toFile(dest);
  console.log("已生成", s.name, `${s.size}×${s.size}`);
}

// favicon（浏览器标签页）
const fav = join(root, "public/favicon.ico");
if (existsSync(fav)) console.log("（favicon.ico 已存在，跳过）");
console.log("完成");
