# 第六阶段交付报告：登录、权限与审计硬化

> 本文档由 Stage 6 开发过程自动汇总，对应需求书「正式登录 / 角色权限 / 审计 / 导入加固」十一项要求。
> 生成时间：2026-09-21
> 状态：**全部落地并验收通过**（stage6-test 25/25 · stage5 回归 18/18 · typecheck / build 零错误 · 原始 Excel SHA256 未变）

## 一、阶段目标

**把系统从「本地开发态」升级为「可交给 HR 正式使用」的 Web 系统。** 本阶段不新增任何业务功能，只解决四件事：

1. 真正可用的登录（密码哈希 + 服务端会话），不再依赖约定俗成的开放访问；
2. 统一的身份与角色门禁（ADMIN / HR 两角色），**彻底废掉可伪造的 `x-operator` 头**；
3. 审计、变更历史、导入记录全部落「真实登录用户」，事后可追责；
4. 导入链路加三道保险（文件完整性、每次提交的版本复核、逐员工事务），并把 46 字段回归变成可自动验证的矩阵。

## 二、十一项要求逐条对照

| # | 要求 | 落地情况 |
| --- | --- | --- |
| 1 | **正式登录系统** | ✅ 详见第三节 |
| 2 | **服务端会话** | ✅ 详见第三节 |
| 3 | **中间件保护** | ✅ 详见第四节 |
| 4 | **角色权限（ADMIN / HR）** | ✅ 详见第五节 |
| 5 | **彻底废弃 x-operator** | ✅ 详见第六节 |
| 6 | **审计记录真实用户** | ✅ 详见第六节 |
| 7 | **API 权限测试** | ✅ `scripts/stage6-test.mjs`（S6-01~S6-09） |
| 8 | **ImportPreview 文件完整性** | ✅ 详见第七节 |
| 9 | **失败重试的版本保护** | ✅ 详见第七节 |
| 10 | **导入事务边界** | ✅ 详见第七节 |
| 11 | **46 字段真实回归 + 计算字段重新分类** | ✅ 详见第八、九节 |

## 三、登录系统（要求 1、2）

### 账号与密码

- 复用已有 `AppUser` 模型（`username / displayName / role / passwordHash`），不建新表。
- `lib/password.ts`：Node 内置 `crypto.scrypt` 加盐哈希（`scrypt$盐$派生` 三段式存储），**全程无明文、无第三方依赖**；校验用 `timingSafeEqual` 防时序攻击。
- `scripts/seed-users.ts`（`npm run db:seed:users`）：幂等初始化两个账号：

  | 账号 | 角色 | 默认密码（环境变量可覆盖） |
  | --- | --- | --- |
  | `admin` | ADMIN | `Tuhu@Admin2026`（`SEED_ADMIN_PASSWORD` 覆盖） |
  | `hr` | HR | `Tuhu@Hr2026`（`SEED_HR_PASSWORD` 覆盖） |

  明文仅在种子脚本 stdout 一次性打印，不写库、不写日志文件。

### 会话（Session）

- 新增 `Session` 表：`id（随机 32 字节 hex）/ userId / username / displayName / role / createdAt / expiresAt / lastActiveAt`，8 小时有效期，索引 `userId` 与 `expiresAt`。
- 登录流程（`POST /api/auth/login`）：scrypt 校验通过 → 服务端 `createSession` 落库 → 响应种 **HttpOnly** Cookie `hr_session`（只存 sessionId，sameSite=lax，生产 HTTPS 下加 Secure）。
- 注销（`POST /api/auth/logout`）：删库内会话 + 清空 Cookie。
- 会话过期或不存在 → 401，前端重登；Edge 中间件只粗筛 Cookie 是否存在，真实校验全部在能访问数据库的 API 路由 / 页面 Server Component 里完成（`lib/auth.ts`）。
- `GET /api/auth/me`：返回当前登录用户，未登录 401。

### 页面

- `/login`（登录页 + `LoginForm`，成功后 `router.replace` 回 `redirect` 目标）；
- `/unauthorized`（角色不足落地页）；
- 业务页面全部迁入 `app/(app)/` 路由组，外壳布局（侧栏 + 顶栏）统一挂在组布局上；顶栏改为从 `/api/auth/me` 读**真实**用户姓名 / 角色，带「退出登录」。

## 四、中间件与路由守卫（要求 3）

`middleware.ts`（Edge 运行时，只做粗筛，不 import 数据库）：

| 场景 | 行为 |
| --- | --- |
| `/api/auth/*` | 放行（内部自校验） |
| 其它 `/api/*` 无会话 Cookie | **401 JSON** |
| `/login`（已登录） | 302 → `/` |
| 其它页面 无会话 Cookie | **307 → `/login?redirect=<原路径>`** |

路由内还有一层真守卫 `requireApiUser(req, { roles })`：Cookie 里的 sessionId 查库拿到会话，
过期 / 不存在 → 401；角色不在 `roles` 白名单 → 403。
**24 个 API 路由全部接入**：

- 通用业务（员工 CRUD、批量、统计、数据质量、质检工单、选项、数据概览、预览系列）：`requireApiUser(req)`；
- 仅 ADMIN（`requireApiUser(req, { roles: ["ADMIN"] })`）：`stores/merge`、`departments/auto`、`department-rules`（GET/POST/PUT/DELETE）、`store-aliases/[id]`。

## 五、角色矩阵（要求 4）

| 模块 | HR | ADMIN |
| --- | :-: | :-: |
| 首页 / 员工列表 / 详情 / 新增 / 编辑 / 停用恢复 / 批量 / 变更记录 | ✅ | ✅ |
| 人员视图（在职 / 离职 / 门店 / 部门 / 分布） | ✅ | ✅ |
| 数据质量中心（五类问题 / 工单处理） | ✅ | ✅ |
| 导入预览 + 确认 + 重试 + 丢弃 | ✅ | ✅ |
| 门店 / 职位 / 部门 基础设置（CRUD / 启停） | ✅ | ✅ |
| 门店合并（`/api/stores/merge`） | ❌ 403 | ✅ |
| 部门自动归属（`/api/departments/auto`） | ❌ 403 | ✅ |
| 部门规则 / 门店别名管理 | ❌ 403 | ✅ |

（门店合并会批量改几十人的归属、部门规则会批量写部门，均判为高影响操作，只开放 ADMIN。）

## 六、废弃 x-operator、审计落真实用户（要求 5、6）

- `lib/operator.ts` 重写：`operatorFromRequest(req)` 变为**只读服务端会话**——
  从 `hr_session` Cookie 解析 sessionId → 查库拿 `displayName`（为空回落 `username`）。
  **客户端提交的 `x-operator` 头从此被完全忽略**（伪造该头无法冒充任何人，stage6 测试 S6-08 专门验证了这一点）。
- 所有调用点改为 `await operatorFromRequest(req)`。
- 审计链路全部落真实用户：
  - `AuditLog.actor`：员工增改、门店/职位/部门增改（`settings-service` 9 个变更函数全带 `actor`）、导入提交、软删除/恢复；
  - `EmployeeHistory.operator`：单条编辑 / 批量 / 导入写入；
  - `QualityIssue`、`ImportPreview.operator` 同口径。
- 仅当请求无有效会话时（例如离线脚本直连）才回落 `系统（未启用登录）` 兜底值——受保护 API 正常请求下必然拿到真实用户。

## 七、导入链路三道保险（要求 8、9、10）

### 8. 文件完整性（FILE_CHANGED）

- `ImportPreview` 新增 `fileSha256`：创建预览时对上传缓冲算 SHA256 落库；
- 提交 / 重试时重新读取 `storedPath` 文件再算一次 SHA256，**与落库指纹不符直接 409 `FILE_CHANGED`**——杜绝「预览 A 文件、写入 B 文件」。

### 9. 每次提交都做版本复核（含重试）

- 首次提交：基线 = 预览创建时冻结的 `dbVersion`；
- 重试：基线 = `lastCommitDbVersion`（上次提交后**重新计算**并写回的指纹）；
- 只要「员工 / 门店 / 职位 / 部门 / 别名 / 历史」任一变过，指纹即变 → 409 `VERSION_CONFLICT`，要求重新生成预览。
  这堵住了旧版「提交后重试按过期基线放行」的洞。

### 10. 逐员工事务边界

- 每个员工的 `employee.update` + `recordEmployeeHistory` 包进**同一个** `prisma.$transaction`：
  该员工任一步失败 → 只回滚该员工（档案与历史不留半截），其余员工继续处理；
- 新增员工同理：`employee.create` + 溯源映射 `employeeSourceRow` + 建档历史同事务。

## 八、46 字段真实回归测试（要求 11·一）

`scripts/stage6-test.mjs` 的 **S6-14 是数据驱动的 46 列回归矩阵**（不是抽样）：

1. 用 ExcelJS 生成一张覆盖 46 列的合成工作簿（长数字全部用白名单假号，可安全提交仓库）；
2. 预览 → 提交 → 逐列比对：
   - **库内**每个字段 = Excel 原值（身份证 / 银行卡 / 手机全程字符串，不得科学计数法 / 丢前导零）；
   - **Diff 展示**中 8 个敏感列全部为脱敏形态（含 `*` 且 ≠ 原值）；
3. 附加断言：预览接口返回的 JSON **不含**任何原始敏感值（raw 只在提交阶段内存中使用）；列表接口敏感列脱敏。
4. 结果：**46/46 列逐项通过**（`S6-14` 通过时输出 `全部 46 列通过；commit=200`）。

## 九、计算字段与原始字段重新分类（要求 11·二）

- 新增 `lib/tenure.ts`：纯函数 `computeTenure(hireDate, resignDate, now)` 从**原始日期实时推算**
  在职年限 / 是否满 7 天 / 是否入职满 2 个月（在职以今天为基准，离职以离职日为基准，缺入职日 → 未知）；
- 员工详情页头部下方新增「任职时长（实时计算）」卡片，四个指标全部来自 `hireDate` / `resignDate`；
- Excel 里的 `在职年限`、`在职年限（离职）`、`是否满7天`、`是否满2个月` 4 列继续**原样入库**（历史兼容，导入快照），
  界面已标注「导入快照」，**系统任何判定都不再读它们**；
- S6-15 用例验证：在职 1461 天 / 离职 753 天 / 缺入职日为 null 三条路径全部符合口径。

## 十、测试与回归

```bash
npm run typecheck        # tsc 零错误
npm run build            # next build 零错误
npm run test:stage5      # 第五阶段回归 18/18
npm run test:stage6      # 本阶段验收 25/25
```

`scripts/stage6-test.mjs` 采用与 stage5 相同的安全模型：
`data/hr.db` → 复制为 `data/stage6-test.db`（副本上 db:push + seed-users）→
`DATABASE_URL` 指向副本启动 `next -p 3199` → 全部走**真实 HTTP**（登录 Cookie jar、中间件 401、路由 403、
预览/确认接口、SQLite 触发器制造「某一行写库必失败」的确定性场景）→ 结束杀进程删副本，**生产库 1920 人数据零污染**。

| 组 | 用例 | 验证点 |
| --- | --- | --- |
| S6-01~04 | 登录 / 会话 | 成功 200 + HttpOnly + 会话落库；失败 401；未登录 API 401 / 页面 307；me / 登出 |
| S6-05~07 | 角色门禁 | HR 可做 8 类操作；HR 访问 3 个 ADMIN 接口 403；ADMIN 全通过 |
| S6-08~09 | 身份真实 | 伪造 `x-operator` 无效；审计 actor = 登录 HR |
| S6-10 | 文件完整性 | 篡改存储文件 → 409 FILE_CHANGED |
| S6-11/12 | 版本保护 | 预览后改库 → 409；提交后改库 → retry 409（lastCommitDbVersion 已刷新） |
| S6-13 | 逐员工事务 | 触发器令一行失败 → 207 PARTIAL；成功行档案+历史同事务；失败行零残留；去掉故障源后 200 |
| S6-14 | 46 字段矩阵 | 46/46 列（库内真实值 + 敏感脱敏 + 不外发 raw + 列表脱敏） |
| S6-15 | 计算字段 | tenure 实时推算三路径 |

另做完整性守护：原始 `途虎HR人员登记.xlsx` 前后 SHA256 与基准一致
（`aac5f0ca…3e19129`），确认本阶段未触碰只读源文件。

## 十一、明确不做（边界）

- Excel 导出、招聘 / 薪资 / 社保系统、门店批量治理、部门批量治理——相关字段与接口全部保留，后续拆模块无需重新迁移；
- 复杂多角色 / 细粒度字段级权限；远程访问（Tailscale / Cloudflare Tunnel）。

## 十二、交付物清单

| 类别 | 文件 |
| --- | --- |
| 会话模型 | `prisma/schema.prisma`（`Session` + `ImportPreview.fileSha256 / lastCommitDbVersion`） |
| 密码 / 鉴权 | `lib/password.ts`、`lib/auth.ts`（新建） |
| 账号种子 | `scripts/seed-users.ts` + `npm run db:seed:users` |
| 登录 / 登出 / me | `app/api/auth/{login,logout,me}/route.ts`、`app/login/page.tsx`、`app/unauthorized/page.tsx`、`components/auth/LoginForm.tsx` |
| 守卫 | `middleware.ts`（新建）、24 个 API 路由接入 `requireApiUser` |
| 身份 | `lib/operator.ts`（重写为会话读取）、`lib/history-service.ts` / `lib/settings-service.ts` / `lib/employee-service.ts`（审计 actor） |
| 导入加固 | `lib/import-preview-service.ts`（fileSha256 / 每次提交版本复核 / 逐员工事务 / `FileChangedError`）、`app/api/import/preview/[id]/route.ts`（409 映射） |
| 计算字段 | `lib/tenure.ts`（新建）、`components/employees/EmployeeDetail.tsx`（实时卡片） |
| 测试 | `scripts/stage6-test.mjs` + `npm run test:stage6` |
| 本报告 | `docs/stage6-report.md` |
