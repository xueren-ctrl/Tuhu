# Stage 6.1 安全与业务口径收口报告

**生成时间**：2026-09-22
**提交**：`1d4bc26`（父提交 `30ee787` = Stage 6）
**范围声明**：本阶段只做「认证、权限、审计最终收口 + 计算字段业务口径修正」，**未**进入 Stage 7（门店合并深化、部门治理深化、Excel 导出、招聘、薪资、社保均未开发）。

---

## 1. 满 2 个月的最终业务规则

- **规则**：满 2 个月日期 = 入职日期 + **2 个自然月**（不是 60 天，也不是 61 天）。
- **判定**：`hasCompletedTwoMonths(hireDate, today)` ⇔ `today 的日历日 >= hireDate + 2 自然月`。
- **示例**：
  - 2026-01-10 入职 → 2026-03-10 满 2 个月；
  - 2026-01-31 入职 → 2026-03-31 满 2 个月；
  - 2025-12-31 入职 → 2026-02-28 满 2 个月（2026 年 2 月无 31 日，落尾 28）。
- 旧实现 `lib/tenure.ts` 的 `past2Months = days >= 60` 已**删除**，全项目再无 60 天近似口径。

## 2. 自然月计算实现方式（`lib/tenure.ts`）

- 新增统一封装：`addNaturalMonths(d, n)` / `getTwoMonthDate(hireDate)` / `hasCompletedTwoMonths(hireDate, today)`。
- `addNaturalMonths` 只做日历分量加法（年月进位、日号截断），**不做**天数换算：
  目标月没有对应日号时取 `new Date(Date.UTC(targetYear, targetMonth + 1, 0))` 回退一天 = 目标月最后一天，正确跨月/跨年/闰年。
- 全项目搜索 `满2个月 / past2Months / 2个月 / 60天 / tenure` 后确认：**唯一计算源**是 `lib/tenure.ts`；
  `computeTenure().past2Months` 与 `getTwoMonthDate` **同源**（同一函数计算），不存在第二套逻辑。
  Excel 快照列 `computed2Months` 仍原样入库（历史留档），页面与判定**不读**它。

## 3. 月末日期处理

| 输入 | + 2 自然月 | 处理 |
|---|---|---|
| 2026-01-10 | 2026-03-10 | 直接 |
| 2026-01-31 | 2026-03-31 | 直接 |
| 2026-02-28 | 2026-04-28 | 直接 |
| 2024-02-29（闰年） | 2024-04-29 | 直接 |
| 2026-11-30 | 2027-01-30 | 跨年末 |
| 2025-12-31 | 2026-02-28 | **目标月无 31 → 落尾 28** |
| 2024-12-31 | 2025-02-28 | 落尾 |

> 规格示例「2026-02-29 → 2026-04-29」：2026 年不是闰年，2 月没有 29 日，该日期在日历上**不存在**。
> 测试 T-04 用真实存在的闰年日期 2024-02-29 → 2024-04-29 验证同类场景；T-17b 专门验证
> 「传入 2026-02-29 必须抛错，绝不静默滚成 2026-03-01」。

日期解析对 `YYYY-MM-DD` 做**严格日历校验**（`2026-02-29` 这类不可能日期被识别为非法并抛错），
杜绝了 JS `new Date("2026-02-29")` 静默进位到 3 月 1 日的坑。

## 4. API 认证覆盖率

- 新增自动检查 `scripts/check-auth-coverage.mjs`（`npm run check:auth`）：
  扫描 `app/api` 全部 `route.ts`，逐个 HTTP handler 在**函数体**内检测 `requireApiUser(` 调用，
  输出 API / Method / 是否守卫 / 角色限制；业务 handler 未守卫或覆盖率 ≠ 100% 即 `exit 1`。
- 豁免仅 3 个：`/api/auth/login`、`/api/auth/logout`、`/api/auth/me`。
- **本阶段扫描发现并修复 5 个真实漏守卫 handler**（此前肉眼 grep 因跨行/导入合并误判为已守卫）：
  1. `POST /api/department-rules`（补 ADMIN 守卫）
  2. `PUT /api/department-rules/[id]`（补 ADMIN 守卫，与同文件 DELETE 对齐）
  3. `POST /api/employees`
  4. `PUT /api/employees/[id]`
  5. `PUT /api/stores/[id]`
- 修复后：**40/40 业务 handler 全部在路由内调用 `requireApiUser`，覆盖率 100%**。
  既有漏网的 `GET/POST /api/quality-issues`、`GET /api/stats`（Stage 6 遗留）也已补守卫。
- 当前 ADMIN 门禁：`stores/merge`、`departments/auto`、`department-rules`（GET/POST/PUT/DELETE）、`store-aliases/[id]`。

## 5. 页面认证方式

- `app/(app)/layout.tsx` 顶层 `await requirePageUser()`：每个业务页面渲染前都真校验
  服务端 Session（查库 + AppUser 实时状态），未登录 → `/login`，权限不足 → `/unauthorized`。
- `middleware.ts` 保持只做「Cookie 是否存在」的 Edge 粗筛（无库依赖），页面/API 各自的守卫是**真正的权限边界**。
- 登录页/无权限页在 `(app)` 路由组之外，不受影响。

## 6. 伪造 Cookie 测试（SEC-02）

- 伪造 `hr_session=deadbeef-…` 与 64 位 `f` 假 sessionId 访问 `/api/stats`、`/api/employees` → **401**。
- 原因：`getSession` 先查 `Session` 表（查不到 → null），再查 `AppUser`（查不到/停用 → 销毁会话并 null），伪造 ID 永远过不了第一关。

## 7. operator 伪造测试（SEC-05 / SEC-06）

- **SEC-05**：请求头带 `x-operator: evil-impersonator` 调 `PUT /api/employees/:id` → 200，
  但 `EmployeeHistory.operator` 落「HR 操作员」（登录用户），请求头被完全忽略。
- **SEC-06**：`POST /api/employees/batch` body 带 `operator: "body-evil-operator"` → 200，
  历史 operator 仍是登录用户。本阶段从源码中**删除了** `employees/batch` 与 `stores/[id]/aliases`
  里 `body.operator ?? DEFAULT_OPERATOR` 的写法（全项目搜索确认无残留客户端 operator 入口），
  一律 `await operatorFromRequest(req)`。
- `DEFAULT_OPERATOR`（「系统（未启用登录）」）现在只保留给离线脚本直连场景，Web API 链路不会落到它。

## 8. AppUser 停用测试（SEC-07）

- `getSession()` 不再信任 Session 表里缓存的 role/status，**每次**重新读 `AppUser`：
  `status !== "ACTIVE"` → 立即销毁该 Session 并返回 401。
- 测试实测：`AppUser(status: DISABLED)` 后，旧 Cookie 访问 `/api/auth/me`、`/api/stats` 均 401，
  且 `Session` 行被销毁；恢复 ACTIVE 后重新登录正常。

## 9. 角色实时变化测试（SEC-08）

- 旧 Session 缓存的 role 已被 `getSession` 的实时读取取代。
- 测试实测：登录后把 `hr` 角色改 ADMIN → 同一旧 Cookie 立即可过 `stores/merge` 门禁（非 403/401）；
  改回 HR → 下一次请求立即 403。无需重新登录、无需等 TTL。

## 10. 登录限流测试（SEC-09 / SEC-09b）

- 实现：`lib/login-rate-limit.ts` 内存计数（按 `X-Forwarded-For` 来源归组，5 分钟窗口，
  失败 10 次 → 429 + `Retry-After`，成功登录清零）。
- 测试实测：同一来源连续 10 次错误密码 → 前 9 次 401、第 10 次 429；
  **限流窗口内即使密码正确也 429**（防「爆破试探」）。
- 失败计数**不写入任何数据库表**（更不写员工表）。
- ⚠ 单实例说明：内存计数只对本进程有效。当前部署目标为「家用电脑单实例 `next start`」，
  可接受；若将来多实例/负载均衡部署，需换成共享存储（DB 表或 Redis），届时再改。

## 11. 登录审计

- `POST /api/auth/login` 写 `LOGIN_SUCCESS`（actor = 用户名，记录角色）与 `LOGIN_FAILED`
  （账号不存在 / 停用 / 密码错误三类，**摘要与明细中均不含密码**——SEC-11 专门校验无泄漏）；
- `POST /api/auth/logout` 写 `LOGOUT`（actor = 真实会话用户，会话失效时记 `unknown`）。
- 测试实测：成功登录/失败登录/退出三条审计均落库，失败记录 JSON 化后全文不含任何密码字符串。

## 12. 默认密码整改

- `scripts/seed-users.ts` 已**移除**固定生产默认密码（`Tuhu@Admin2026` / `Tuhu@Hr2026` 不再存在于源码）。
  - `SEED_ADMIN_PASSWORD` / `SEED_HR_PASSWORD` 未设置 → **直接失败（exit 1）并打印指引**；
  - 密码 < 8 位 → 拒绝执行；
  - 账号已存在 → 默认只同步 displayName/role/status，**不改密码**；
  - 显式 `--reset-password` 才允许重置。
- 实测：清空两个环境变量后运行 → 拒绝并提示；
- 测试环境（`test:stage6` / `test:stage6:security`）各自注入**测试专用密码**（仅作用于副本库），
  对正式生产无影响。

## 13. 测试数量（全量验收，2026-09-22 实测）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm run build` | ✅ Compiled successfully |
| `npm run check:auth` | ✅ 40/40 handler，覆盖率 100% |
| `npm run test:stage5` | ✅ 18/18 |
| `npm run test:stage6` | ✅ 25/25（含 46/46 字段矩阵） |
| `npm run test:stage6:security` | ✅ 14/14 |
| `npm run test:tenure` | ✅ 22/22 |

## 14. 生产数据前后数量

| 指标 | 测试前 | 测试后 |
|---|---|---|
| 员工总数 | 1920 | **1920**（零污染） |
| 合成员工残留（5 个测试名） | — | 0 |
| 测试门店残留 | — | 0 |
| 测试 DB 副本 | — | 全部已删（`data/` 仅剩 `hr.db`） |
| 原始 Excel `途虎HR人员登记.xlsx` SHA256 | `aac5f0ca…19129` | 不变（全程只读） |

> 说明：登录审计在**副本库**中产生，测试结束副本即删，生产库 `hr.db` 未新增审计行；
> 正式环境部署后的登录/退出审计会正常写入生产库（这是审计功能的应有行为）。

## 15. Git commit

- 提交：`1d4bc26`（`feat(stage6.1): 认证/权限/审计收口 + 满2个月自然月口径修正`，22 个文件）
- 已推送到 `github.com/xueren-ctrl/Tuhu` main（`30ee787..1d4bc26`），未提交任何 `data/`、`.xlsx`、`.env`。

---

## 附：源码修改清单

| 文件 | 改动 |
|---|---|
| `lib/tenure.ts` | 重写：自然月加法 + 严格日期校验 + `getTwoMonthDate` / `hasCompletedTwoMonths` / `renderDate`；`computeTenure` 换口径 |
| `lib/auth.ts` | `getSession` 实时读 AppUser（停用即失效、角色实时生效） |
| `lib/login-rate-limit.ts` | 新增：登录限流（内存计数，单实例说明） |
| `scripts/seed-users.ts` | 整改：环境变量强校验 + `--reset-password` 语义 |
| `app/api/auth/login\|logout/route.ts` | 限流接入 + 登录/退出审计 |
| `app/api/{department-rules,department-rules/[id],employees,employees/[id],stores/[id],quality-issues,stats,…}` | 补齐 5 个漏守卫 handler + quality-issues/stats 守卫 |
| `app/api/employees/batch`、`stores/[id]/aliases` | 根除 `body.operator` 客户端控制 |
| `app/(app)/layout.tsx` | 顶层 `await requirePageUser()` 页面真校验 |
| `components/employees/EmployeeDetail.tsx` | 实时卡片新增「满 2 个月日期（自然月口径）」展示 |
| `scripts/stage6-security-test.mjs` | 新增：14 项安全验收（副本库 + 真实 HTTP） |
| `scripts/check-auth-coverage.mjs` | 新增：认证覆盖率自动检查（`check:auth`） |
| `scripts/tenure-test.mjs` | 新增：满 2 个月口径 22 项单测 |
| `scripts/stage6-test.mjs` | 适配新 seed 密码流程（测试专用密码 + `--reset-password`） |
| `package.json` | 新增 `test:stage6:security` / `test:tenure` / `check:auth` |

**已知边界（不在本阶段）**：登录限流为单实例内存版；`/api/auth/*` 三个端点按规格豁免守卫；
门店合并/部门治理/Excel 导出/招聘/薪资/社保均未开发，等待下一步指令。
