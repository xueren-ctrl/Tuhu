import { DEFAULT_OPERATOR } from "./history-service";

/**
 * 解析操作人。
 *
 * 当前版本未启用登录（AUTH_ENABLED=false），因此：
 * 1. 优先取请求头 `x-operator`（接入登录后改从会话取，前端无需改动）；
 * 2. 取不到则记为「系统（未启用登录）」。
 *
 * 这么设计是为了让变更记录里「操作人」这一列从第一天起就是有意义的，
 * 而不是等做完权限系统再回头补历史（那时的历史已经无法追溯）。
 */
export function operatorFromRequest(req: Request): string {
  const header = req.headers.get("x-operator");
  if (header && header.trim()) return header.trim().slice(0, 64);
  return DEFAULT_OPERATOR;
}
