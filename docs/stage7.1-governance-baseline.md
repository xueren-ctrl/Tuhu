# Stage 7.1 数据治理安全底座 —— 当前数据库真实基线报告

> 生成时间：2026-09-22
> 数据来源：直接查询当前 `data/hr.db`（实时统计，非旧文档数字）
> 本阶段**不执行**任何生产批量治理，只建安全底座 + 出预览 + 全量测试。
> 本报告**不含**任何真实身份证号 / 手机号 / 银行卡号 / 详细个人信息。

---

## 一、当前真实数据基线（实时查询 data/hr.db）

### 1. 员工

| 指标 | 数量 | 判定口径 |
|---|---|---|
| 员工总数（存活，`deletedAt IS NULL`） | **1920** | `count(where deletedAt:null)` |
| 在职 `ACTIVE` | **510** | `status = ACTIVE` |
| 离职 `RESIGNED` | **1410** | `status = RESIGNED` |
| 候选人 `CANDIDATE` | **0** | `status = CANDIDATE` |
| 无部门（`departmentId IS NULL`） | **1902** | 占总数 99.0% —— 源数据只有「运营部」有部门信息 |
| 无岗位（`positionId IS NULL`） | **36** | Excel「工种级别」列为空 |
| 无门店（`storeId AND departmentId 均 NULL`） | **102** | 既不在门店也不在部门 |
| 仅挂部门（`storeId NULL` 但 `departmentId` 有值） | **18** | 如运营部，属正常，不计问题 |
| 无去重键（身份证/手机/入职日期全空） | **18** | 高风险待补录，**非**已判定重复 |
| 真正重复（姓名+身份证+入职日期全同） | **0 组 / 0 人** | 当前无完全重复记录 |
| 状态冲突（最新导入批次 STATUS_CONFLICT） | **14** | 需 HR 逐人确认口径 |
| 合法重新入职组（同一身份证多条） | **118** | **非**问题，是多次任职，绝不合并 |

> 说明：旧文档中的 `1902 / 36 / 102 / 14 / 18 / 16` 是**某一时刻的快照**，本基线已按当前库重算。
> 其中 `1902` = 无部门人数（不是员工总数，总数是 1920）；`16` = 门店别名候选组数（见下）。

### 2. 门店

| 指标 | 数量 | 判定口径 |
|---|---|---|
| 门店总数 | **66** | `store.count()` |
| ACTIVE 门店 | **66** | `status = ACTIVE` |
| INACTIVE 门店 | **0** | `status = INACTIVE` |
| 门店别名候选（两两名称相似对） | **16** | `findAliasCandidates()` 只读检测 |
| 门店合并簇（并查集分组） | **16** | `findMergeClusters()` 只读检测 |

### 3. 部门自动归属（当前）

| 指标 | 数量 | 说明 |
|---|---|---|
| 启用中的归属规则 | **0** | 当前没有任何已启用规则 |
| 可匹配员工（affected） | **0** | 无规则 → 无匹配 |
| 未匹配员工（unmatched） | **0** | 无规则时不计 |

> 部门自动归属的「可匹配 / 未匹配」只有在**配置了规则之后**才有意义。
> 当前 0 规则意味着工具可用但尚未配置，预览返回全 0。

---

## 二、判定规则（写死在代码 + 页面展示，避免口径漂移）

| 类别 | 规则（`lib/data-quality-service.ts`） | 是否自动处理 |
|---|---|---|
| 状态冲突 | 同一人既在在职名册又带离职信号（导入时逐条记 ImportIssue） | ❌ 人工判断 |
| 无部门 | `departmentId` 为空 | ✅ 可用批量编辑 / 部门自动归属 |
| 无岗位 | `positionId` 为空 | ✅ 可用批量编辑 |
| 无门店 | `storeId AND departmentId` 均为空 | ✅ 可用批量编辑 |
| 真正重复 | 姓名+身份证+入职日期 三者全同 | ❌ 停用多余记录（软删，不物理删） |
| 无去重键 | 身份证/手机/入职日期全空 | ❌ 补录后再自动去重 |
| 合法重新入职 | 同一身份证多条 | ❌ 绝不合并 |

**硬原则**：状态冲突 / 真正重复 / 无去重键 三类**必须保留人工判断**（查看 / 关闭 / 忽略 /
重开 / 处理说明 / 处理人，处理人来自真实 Session），系统绝不自动替 HR 决定。

---

## 三、发现的代码问题（本阶段已修复）

### 1. 部门自动归属 500 上限严重缺陷 ✅ 已修复
- **旧问题**：`previewDepartmentAuto()` 默认 `limit=500`，`applyDepartmentAuto()` 直接消费
  `preview.items`（被 slice 到 500），导致**正式执行最多只改前 500 人**。
- **修复**：预览与执行分离 —— 新增 `matchAllEmployees()` 全量计算；预览 `items` 仅作展示
  （`itemLimit` 截断），`affected`/`byDepartment`/`byRule`/`unmatched` 全量；执行**重新跑全量
  匹配**，数量恒等于全量 affected，绝不按展示 items 截断。
- **验证**：`stage7-1-test` G7-01/G7-03b/G7-04 —— 600 合成员工场景，preview affected=600、
  items 可截断到 300、apply updated=600。

### 2. 旧预览直接执行到已变化的库 ✅ 已修复
- **旧问题**：apply 无版本校验，早上预览的集合下午库变了仍按旧集合改。
- **修复**：预览携带 `snapshot`（`dbVersion` / 员工数 / 规则数 / 匹配数 / 无部门数），
  apply 前 `assertSnapshotFresh()` 复核，任一变化 → 抛 `StalePreviewError` → HTTP 409
  `STALE_PREVIEW`，要求重新预览。
- **验证**：`stage7-1-test` G7-05 —— 预览后新增 1 名匹配员工，旧快照 apply → 409。

### 3. 门店合并无事务安全 ✅ 已修复
- **旧问题**：`mergeStores()` 是一串裸 `await`，中途失败会留下「员工改了一半 / 别名建了 /
  门店已停用 / 审计已记」的半套脏数据。
- **修复**：整个合并簇包进 `prisma.$transaction`（员工改挂、EmployeeHistory、StoreAlias、
  门店停用、AuditLog 同事务），任一步失败**整体回滚**。
- **验证**：`stage7-1-test` G7-06 —— SQLite 触发器强制中途失败，员工/门店/别名/历史/审计
  五表前后完全一致。

### 4. 批量修改污染原始溯源字段 ✅ 已修复
- **旧问题**：`batchUpdateEmployees()` 改 `storeId` 时同步改写 `storeNameRaw`，
  造成「治理字段改了、原文也改了」，溯源断裂。
- **修复**：批量只动 `storeId / departmentId / positionId` 三个外键，
  `storeNameRaw / departmentNameRaw / jobGradeRaw` 原文列**一律保留**（Excel 历史证据）。
- 注：单条 `updateEmployee` 的「填了外键但原文为空 → 补原文」行为保留（`??` 兜底），
  不覆盖已有原文。

### 5. 页面硬编码历史数字 ✅ 已修复
- **旧问题**：`data-quality/page.tsx` 写死「1902 人无部门」、`department-auto/page.tsx`
  写死「1902 人空着」。
- **修复**：改为实时 `noDeptRow?.count`，页面文案「当前 {实时数} 人无部门」。
- **验证**：`stage7-1-test` G7-08 —— grep 确认两页不再有 `1902/1936/210人` 等硬编码。

### 6. 治理批次审计信息增强 ✅ 已实现
- 部门自动归属每个部门写一条 `AuditLog`（`action=BATCH_UPDATE`），detail 含
  `batchKey / type=department-auto / departmentId / employeeCount / updated / ruleIds / 时间`。
- 门店合并 `AuditLog.detail` 含 `batchKey / 类型 / 主店 / 被并店 / 迁移数 / 别名数 / 时间`。
- **敏感字段（身份证/银行卡/完整手机/密码）一律不落审计。**

### 7. 操作人客户端伪造 ✅ 保持禁止
- 全链路 `operator` 只来自 `operatorFromRequest(req)`（Session 真实用户）；
  `x-operator` 头与 `body.operator` 一律忽略。
- **验证**：`stage7-1-test` G7-11 —— 伪造 `x-operator=forged-evil` 与
  `body.operator=forged-evil` 均无效，审计 actor 仍是 Session 的「系统管理员」。

---

## 四、门店治理预览（只预览，不自动执行 16 组）

`/stores/merge` 面板每组单独展示：
- 候选簇（并查集分组）
- 建议主门店（在职人数最多）+ 可改选
- 被合并门店清单
- 当前员工总数 / 在职 / 离职
- **合并后主门店人数**（主店现有人 + 迁移数）
- **将建立的 StoreAlias**（被并店名，去重）
- 将迁移员工数

**每组独立确认执行，不存在「全部一键合并」。** 本阶段不对生产 `data/hr.db` 执行任何合并。

---

## 五、预览 → 确认 → 执行 的统一机制

| 工具 | 预览 | 确认 | 执行 | 版本保护 |
|---|---|---|---|---|
| 部门自动归属 | `POST /api/departments/auto {action:preview}`（全量统计 + 快照） | 页面「确认批量更新部门」 | `{action:apply, snapshot}` | 服务端复核 snapshot，变化→409 |
| 批量编辑 | 列表页勾选/筛选 → 预览匹配数 | 确认框 | `POST /api/employees/batch` | 执行数量=预览数量 |
| 门店合并 | `findMergeClusters`（只读候选 + 每组预览） | 每组单独确认 | `POST /api/stores/merge`（单组） | 事务原子，失败整体回滚 |

「预览数量 = 执行数量」：`batchUpdateEmployees / applyDepartmentAuto / mergeStores`
三者统一约束 —— `matched = updated + unchanged + failed`，失败不留半修改。

---

## 六、新增测试（`scripts/stage7-1-test.mjs`，副本库 + 真实 HTTP）

`npm run test:stage7.1` —— 15 项全过（13 项规格要求 + 2 项补充门禁）：

| 编号 | 断言 |
|---|---|
| G7-01 | 部门自动归属 >500 人（600 合成员工）preview affected=600 |
| G7-02 | preview 全量统计（byDepartment / byRule / unmatched） |
| G7-03 | display items 截断（300）但 apply 不截断（updated=600） |
| G7-04 | 预览数量 = 执行数量（matched=600=updated+unchanged+failed，失败=0） |
| G7-05 | 数据变化后旧预览直接执行 → 409 STALE_PREVIEW |
| G7-06 | 门店合并确定性失败 → 事务整体回滚（五表前后一致） |
| G7-07 | 门店候选只预览不自动执行（findMergeClusters 只读零写） |
| G7-08 | 页面不存在硬编码治理数字 |
| G7-09 | EmployeeHistory 正确（部门归属逐条留痕，operator 非空） |
| G7-10 | AuditLog 正确（batchKey/类型/数量/部门/规则，无敏感明文） |
| G7-11 | operator 只来自 Session（伪造 x-operator / body.operator 无效） |
| G7-12 | 测试结束生产库员工数量不变（1920） |
| G7-13 | 无测试残留（合成数据可被 cleanup 识别） |
| G7-ADMIN | HR 访问 ADMIN-only 治理接口 → 403 |

---

## 七、全部测试结果（本阶段验收门）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm run build` | ✅ Compiled successfully |
| `npm run check:auth` | ✅ 认证覆盖率 100% |
| `npm run test:stage5` | ✅ 18 / 18 |
| `npm run test:stage6` | ✅ 25 / 25 |
| `npm run test:stage6:security` | ✅ 14 / 14 |
| `npm run test:tenure` | ✅ 22 / 22 |
| `npm run test:stage7.1`（新增） | ✅ 15 / 15 |

---

## 八、数据库前后数量与残留

- **执行前** 员工总数：1920
- **执行后** 员工总数：1920（`stage7-1-test` G7-12 实测，零污染）
- **测试残留**：`data/stage7-1-test.db` 副本在测试结束已删除；
  合成数据（600 名「阶段7治理员工」/ 4 迁移员工 / 1 测试部门 / 3 测试门店）全部只存在于
  已删除的副本库，生产 `data/hr.db` 无残留。
- **生产门店 66 / ACTIVE 66 / INACTIVE 0** 保持不变。

---

## 九、执行计划（本阶段**不执行**，列出供下一阶段评审）

Stage 7.1 停止于此。以下属于后续阶段，**本阶段一概不执行**：

1. 16 组门店实际合并（生产 `data/hr.db`）
2. 无部门 1902 人的实际批量归属（需先配置规则）
3. 14 人状态冲突的人工确认处理
4. 无去重键 18 人的补录
5. Excel 导出 / 招聘 / 薪资 / 社保

下一阶段若要做生产治理，须走「配置规则 → 预览（全量统计 + 快照）→ 人工确认 →
执行（带快照版本保护 + 事务）」，且逐簇/逐部门确认，绝不一键全量。
