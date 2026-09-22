/**
 * 登录失败限流（Stage 6.1 新增，最简内存版）
 *
 * 规则：同一来源（按客户端 IP 归组）5 分钟内连续失败 10 次 → 限流。
 * 成功登录 → 立即清除该来源的失败计数。
 * 计数**绝不**写入员工表 / 业务表。
 *
 * ⚠ 单实例说明：采用进程内存计数（Map）。当前项目部署目标是「家用电脑单实例
 * 服务器」（单个 next start 进程、无负载均衡），内存计数可接受且最简单；
 * 若未来多实例部署，需换成共享存储（如 DB 表 / Redis）。
 */

export interface RateLimitResult {
  /** 当前限流剩余可用次数（0 表示已被限流） */
  remaining: number;
  /** 是否已被限流（应返回 429） */
  blocked: boolean;
  /** 距窗口重置的剩余毫秒数（限流时有效） */
  retryAfterMs: number;
}

const WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const MAX_FAILURES = 10; // 连续失败 10 次

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** 取客户端来源标识：优先 X-Forwarded-For 首个值，否则 X-Real-IP，最后「direct」。 */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "direct";
}

/** 记录一次失败；返回限流状态。窗口滑动：超过 5 分钟自动重新计窗口。 */
export function recordLoginFailure(req: Request): RateLimitResult {
  const key = clientKey(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(key, b);
  }
  b.count += 1;
  const blocked = b.count >= MAX_FAILURES;
  const remaining = Math.max(0, MAX_FAILURES - b.count);
  const retryAfterMs = blocked ? b.windowStart + WINDOW_MS - now : 0;
  return { remaining, blocked, retryAfterMs };
}

/** 成功登录后清零 */
export function clearLoginFailures(req: Request): void {
  buckets.delete(clientKey(req));
}

/** 测试辅助：清空全部计数（生产代码不调用） */
export function _testReset(): void {
  buckets.clear();
}
