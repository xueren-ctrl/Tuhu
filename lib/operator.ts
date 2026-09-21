import { getApiUser } from "./auth";
import { DEFAULT_OPERATOR } from "./history-service";

/**
 * 解析当前请求的真实操作人。
 *
 * 第六阶段（启用登录）后规则：
 * 1. **只**从服务端 Session 取身份（HttpOnly Cookie → 数据库会话），
 *    绝不信任客户端提交的 `x-operator` 头（伪造该头无法冒充他人）。
 * 2. 优先返回 `displayName`，为空时回落到 `username`。
 * 3. 仅当没有有效会话时（例如离线脚本直连），回落到 DEFAULT_OPERATOR。
 *    受保护的所有 API / 页面都会先经 requireApiUser / requirePageUser 守卫，
 *    因此正常请求下一定能拿到真实登录用户。
 *
 * 注意：本函数已变为异步，调用方必须 `await`。
 */
export async function operatorFromRequest(req: Request): Promise<string> {
  const user = await getApiUser(req);
  if (user) {
    const name = user.displayName?.trim() || user.username?.trim();
    if (name) return name.slice(0, 64);
  }
  return DEFAULT_OPERATOR;
}
