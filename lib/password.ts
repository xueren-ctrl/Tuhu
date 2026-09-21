/**
 * 密码哈希（scrypt + 随机盐），不依赖 Next.js 运行时，
 * 可被脚本（tsx）/ API 路由 / 页面共用。
 * 存储格式： scrypt$<saltHex>$<derivedHex>
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, derivedHex] = parts;
  try {
    const key = scryptSync(password, salt, 64);
    const expected = Buffer.from(derivedHex, "hex");
    if (key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
