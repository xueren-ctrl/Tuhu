# 历史测试脚本（已归档，**不要运行**）

归档日期：2026-09-27

## 为什么归档

这 4 个脚本是 Stage 1~3 时期的验收脚本。Stage 6（2026-09-22）给系统加了
登录守卫（`middleware.ts` + 各路由的 `requireApiUser`）之后，**它们就再也没通过过了** ——
因为脚本里所有请求都是裸的 `fetch(BASE + path)`，**完全不带 cookie**，
所有写接口一律返回 401。

实测（归档前逐个跑过一遍）：

| 脚本 | npm 命令 | 归档前实际结果 |
|---|---|---|
| `acceptance-test.mjs` | `test:stage1` | `TypeError: Cannot read properties of undefined (reading 'total')` |
| `stage2-test.mjs` | `test:stage2` | `ERR 测试过程未抛异常`（创建部门拿不到 id） |
| `stage2-acceptance.mjs` | `test:stage2:acceptance` | 3 项失败：`P1/P2 门店/部门可用` + 中断 |
| `stage3-test.mjs` | `test:stage3` | 3 项失败：`P1/P2 标准门店/部门可用` + 中断 |

**接口本身没问题** —— 手工带 cookie 调 `POST /api/departments` 返回 201。
坏的只是脚本没登录。

## 功能已被取代

它们测的主体功能（新增员工出现在在职表 / 改状态后跨表联动 / 改门店后列表同步）
现在由 **`scripts/stage9-test.mjs`（82 项）**覆盖，而且测得更严 ——
stage9 走真实登录、逐表核对、还会验证任职历史与计算字段。

## 唯一没被覆盖的（Stage 9.24 已补）

stage2 原本独有、当时无人测的 3 项，已在 Stage 9.24 补进 stage9：

- `S9-80` `/api/statistics` 字段完整性 + 分布口径自洽
- `S9-81` 刷新后 URL 参数（分页/排序）依然生效
- `S9-82` 「未分配」筛选 `departmentId=__none__`

## 仍然有效的脚本（**不要动**）

| 脚本 | 命令 | 项数 |
|---|---|---|
| `stage5-test.mjs` | `test:stage5` | 18 |
| `stage6-test.mjs` | `test:stage6` | 25 |
| `stage6-security-test.mjs` | `test:stage6:security` | 14 |
| `stage7-1-test.mjs` | `test:stage7.1` | 41 |
| `stage8-test.mjs` | `test:stage8` | 18 |
| `stage9-test.mjs` | `test:stage9` | 82+ |

## 如果非要恢复

给每个请求加登录即可（参考 `stage9-test.mjs` 的 `req()` 助手：
先 `POST /api/auth/login` 拿 `hr_session` cookie，之后所有请求带上）。
但**不推荐** —— 恢复后与 stage9 大量重复，维护成本大于收益。
