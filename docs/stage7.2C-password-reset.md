# Stage 7.2C 密码重置安全收口报告

> **本阶段仅修改代码与测试，未对生产库做任何写入。**
> 未重置生产 admin / hr 密码、未登录生产、未执行任何门店合并。
> 本文档**不包含任何实际密码、密码哈希或 Session ID**。

生成时间：2026-09-25
相关提交：`4585c4e`（Stage 7.2C 单用户密码重置）+ 本阶段提交

---

## 1. 单账号 reset（Stage 7.2C）

`scripts/seed-users.ts` 新增 `--only=admin` / `--only=hr`。

| 场景 | 行为 |
|---|---|
| `--reset-password --only=admin` | 只处理 admin |
| `--reset-password --only=hr` | 只处理 hr |
| `--reset-password`（**缺 `--only`**） | **exit 1，拒绝执行** |
| 不传 `--only`（普通首装） | admin + hr 一起初始化（需两个环境变量） |
| `--only=admin --only=hr`（冲突） | exit 1 |
| `--only=xxx`（未知用户名） | exit 1 |

环境变量按 `--only` 精确要求：`--only=admin` 只需 `SEED_ADMIN_PASSWORD`；
`--only=hr` 只需 `SEED_HR_PASSWORD`；普通首装仍需两者都提供。

**生产安全闸门**：不指定 `--only` 的密码重置会直接被拒绝，杜绝一次误操作
同时改掉 admin 与 hr 两个生产账号、导致两个账号同时被锁死。

**stdout 绝不输出密码明文**（创建与重置分支均已移除明文输出）。

---

## 2. metadata 保留（Stage 7.2C.1）

**核心原则：重置密码只改 `passwordHash`，绝不顺带修改账号治理字段。**

改动前（不符合最小权限语义）：

```ts
appUser.update({
  displayName, role, status: "ACTIVE", passwordHash   // ← 顺手改了 3 个字段，还自动激活
})
```

改动后：

```ts
appUser.update({
  data: { passwordHash: hashPassword(u.password) }    // ← 只有这一个字段
})
```

因此：

- **「重置密码」≠「重新激活账号」**：停用账号（`status=INACTIVE`）重置密码后**仍然是 INACTIVE**，
  不会被「顺手激活」。
- `role` / `displayName` 属于账号治理字段，只能通过专用的账号管理入口修改，
  密码重置无权触碰。

---

## 3. Session 撤销（Stage 7.2C.1）

`lib/auth.ts` 的 `getSession()` 只依据 `AppUser` 的 `status/role/displayName`，
**不会因为 `passwordHash` 变化而自动失效** —— 密码改了，旧凭据签发的会话仍可继续使用。

因此密码重置成功后立即执行：

```ts
const revoked = await prisma.session.deleteMany({
  where: { userId: existing.id },
});
```

- 只删除**被重置账号自己**的 Session（按 `userId` 精确匹配）
- **绝不波及其他账号**（重置 admin 不影响 hr 的会话，反之亦然）
- stdout 只输出被撤销的**条数**，不输出任何 Session ID

---

## 4. 新旧密码认证测试

使用项目现有的 `verifyPassword(password, stored)`（`lib/password.ts`，scrypt 校验）验证：

| 断言 | 结果 |
|---|---|
| reset 后的**新密码**能通过 `verifyPassword` | ✅ admin / hr 均通过 |
| reset 前的**旧密码**被 `verifyPassword` 拒绝 | ✅ admin / hr 均被拒绝 |

说明：密码重置确实生效，新凭据可用、旧凭据失效；不依赖任何「数据库里存了什么」的实现细节。

---

## 5. 测试结果

`npm run test:seed-users` —— **14 / 14 全部通过**（全部在一次性副本库运行）：

| 用例 | 验证内容 | 结果 |
|---|---|---|
| S7-U1 | `--only=admin` → admin hash 变、hr 不变 | ✅ |
| S7-U2 | `--only=hr` → hr hash 变、admin 不变 | ✅ |
| S7-U3 | `--reset-password` 无 `--only` → exit 1，双账号不变 | ✅ |
| S7-U3b | 拒绝提示明确给出两个正确用法 | ✅ |
| S7-U4 | `--only=admin` 缺环境变量 → exit 1，DB 不变 | ✅ |
| S7-U5 | `--only=xxx` → exit 1，DB 不变 | ✅ |
| S7-U6 | stdout/stderr 不含明文密码，也不含 passwordHash | ✅ |
| S7-U7 | `--only` 冲突 → exit 1，DB 不变 | ✅ |
| S7-U8 | 生产库 admin/hr passwordHash 与员工数全程未被触碰 | ✅ |
| **S7-U9a** | admin reset：hash 变，`displayName`/`role`/`status` 不变；**停用账号仍为 INACTIVE** | ✅ |
| **S7-U9b** | hr reset：hash 变，`displayName`/`role`/`status` 不变 | ✅ |
| **S7-U10a** | admin reset → admin Session 2→0，hr Session 不受影响 | ✅ |
| **S7-U10b** | hr reset → hr Session 1→0 | ✅ |
| **S7-U11** | `verifyPassword`：新密码通过、旧密码拒绝（admin + hr） | ✅ |

### 全量回归

| 项目 | 结果 |
|---|---|
| `npm run test:seed-users` | **14 / 14** |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 成功 |
| `npm run check:auth` | 41 / 41（100%） |
| `npm run test:stage5` | 18 / 18 |
| `npm run test:stage6` | 25 / 25 |
| `npm run test:stage6:security` | 14 / 14 |
| `npm run test:tenure` | 22 / 22 |
| `npm run test:stage7.1` | 41 / 41 |

---

## 6. 无生产写入

本阶段全程未对生产 `data/hr.db` 执行任何写操作。

| 项 | 值 | 状态 |
|---|---:|---|
| Employee | 1920 | 未变 |
| Store | 66 | 未变 |
| StoreAlias | 0 | 未变 |
| EmployeeHistory | 0 | 未变 |
| DepartmentRule | 0 | 未变 |
| admin `passwordHash` | — | **未变**（本阶段未执行生产 reset） |
| hr `passwordHash` | — | **未变**（本阶段未执行生产 reset） |
| 原始 Excel SHA256 | `aac5f0cad725f167e8d49e7b2b2bb4d0368923a190b500d5399bc4ffa3e19129` | 未变 |

所有 seed-users 调用都指向一次性副本库（`data/seed-users-test.db`），测试结束即删除。
测试密码在运行时由 `crypto.randomBytes` 随机生成，**仓库中不含任何明文凭据**。
