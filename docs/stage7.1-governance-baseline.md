# Stage 7.1 数据治理安全底座 —— 当前数据库真实基线报告

> 生成时间：2026-09-22（Stage 7.1）· 追加：2026-09-22（Stage 7.1.1 收口）· 追加：2026-09-22（Stage 7.1.2 闭环）· 追加：2026-09-23（Stage 7.1.3 最终收口）· 追加：2026-09-24（Stage 7.1.4 治理配置审计与事务一致性）
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
| 未匹配员工（unmatched） | **1902** | = 当前可匹配基数（实时无部门人数） |

> **unmatched 口径（修正）**：无启用规则时 `matchAllEmployees` 返回
> `{ matched: [], unmatched: baseCount, baseCount: 实时无部门人数 }` ——
> 即 **affected = 0，unmatched = 当前可匹配基数（当前生产 = 1902）**。
> 早期版本误写成「无规则时 unmatched=0 / 不计」，那是错误口径，已按
> Stage 7.1.1 G7-17 的实测统一修正。
> 「配置了规则之后」才有非零的 affected；unmatched 则始终 = 可匹配基数 − 已匹配。

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
| 部门自动归属 | `POST /api/departments/auto {action:preview}`（全量统计 + 快照） | 页面「确认批量更新部门」 | `{action:apply, snapshot}` | 服务端复核 snapshot，变化→409 STALE_PREVIEW；全批原子事务，失败整体回滚 |
| 批量编辑 | 列表页勾选/筛选 → 预览匹配数 | 确认框 | `POST /api/employees/batch`（全批原子事务） | 失败 409 BATCH_ABORTED，三表零残留 |
| 门店合并 | `findMergeClusters`（只读候选 + 每组预览）+ `GET /api/stores/merge`（快照） | 每组单独确认 | `POST /api/stores/merge`（携带 snapshot，单组事务） | ACTIVE/同名/逐店实时校验 + 快照漂移→409 STALE_MERGE_PREVIEW；整簇事务原子 |

「预览数量 = 执行数量」：`batchUpdateEmployees / applyDepartmentAuto / mergeStores`
三者统一约束 —— `matched = updated + unchanged + failed`，失败不留半修改。

---

## 六、新增测试（`scripts/stage7-1-test.mjs`，副本库 + 真实 HTTP）

`npm run test:stage7.1` —— 28 项全过（13 项规格要求 + 7.1.1 收口 5 项 + 门禁/补充 + 7.1.2/7.1.3 新增 8 项）：

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
| **G7-14** | 批量原子回滚（触发器确定性失败：员工/历史/审计三表零残留，409 BATCH_ABORTED） |
| **G7-15** | 门店合并 预览数量=执行数量（合法簇 1 人），straggler（原文写旧名但无 storeId）不自动迁 |
| **G7-16** | INACTIVE 门店不可作被合并来源（409）/不可作主门店（409），且不进入候选簇 |
| **G7-17** | 无启用规则时：affected=0，unmatched=baseCount=实时无部门人数（口径一致） |
| **G7-18** | 清理后零残留（员工/迁移/straggler/部门/规则/门店/别名 全清空） |
| **G7-19** | 门店 snapshot 与请求错配 → 409 STALE_MERGE_PREVIEW（五表零变化） |
| **G7-20** | 门店合并缺 snapshot → 400 MERGE_PREVIEW_REQUIRED（五表零变化） |
| **G7-21** | 非同一候选簇两个 ACTIVE 门店 → 409 INVALID_MERGE_CLUSTER（五表零变化） |
| **G7-22** | 合法簇部分合并 A+B（C 保留）+ snapshot 顺序容忍（反转集合不变仍通过） |
| **G7-23** | 部门规则条件改（数量不变、命中集合变化）→ 旧快照 409 STALE_PREVIEW（三表零变化） |
| **G7-24** | 部门 apply 缺 snapshot → 400 DEPARTMENT_PREVIEW_REQUIRED（三表零变化） |
| **G7-25** | 门店别名统一归属确定性失败 → 全批回滚（四表零残留，409 ALIAS_BATCH_ABORTED） |
| **G7-26** | 门店合并竞态保护（写库前 source 被停用）→ 409 MERGE_STATE_CHANGED（五表零变化） |

---

## 七、全部测试结果（本阶段验收门）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm run build` | ✅ Compiled successfully |
| `npm run check:auth` | ✅ 41/41 业务 handler，认证覆盖率 100% |
| `npm run test:stage5` | ✅ 18 / 18 |
| `npm run test:stage6` | ✅ 25 / 25 |
| `npm run test:stage6:security` | ✅ 14 / 14 |
| `npm run test:tenure` | ✅ 22 / 22 |
| `npm run test:stage7.1`（含 7.1.1/7.1.2/7.1.3） | ✅ 28 / 28（G7-01~26） |

---

## 七·补，Stage 7.1.1 事务与门店合并执行一致性收口（追加）

> 在 7.1 已建好的「治理安全底座」之上，把**批量写入的事务原子性**与
> **门店合并的执行前校验/预览快照**彻底收口，并补 5 项确定性测试。
> 仍**不执行**任何生产批量治理；生产 `data/hr.db` 零污染（员工 1920 / ACTIVE 门店 66 实测不变）。

### A. 批量修改全批原子事务（`lib/employee-service.ts`）
- `batchUpdateEmployees()` 重写：每个员工的「档案修改 + 变更历史」与批次审计
  全部在**同一个 `prisma.$transaction`** 中完成（`runInTx(t)`）。
  任一步失败（含历史写入失败、审计写入失败）→ **整批回滚**，绝不出现
  「员工改了一半 / 员工改了但历史没写 / 历史写了但审计没记」。
- 因此该函数 `failed` 恒为 0：要么全成功，要么整体抛错。
  新增 `BatchUpdateAbortedError`（携带「已整体回滚」语义），
  `POST /api/employees/batch` 捕获它 → **409 `BATCH_ABORTED`**。
- 支持可选 `tx` 参数：外部事务传入时不再自开事务，原子性由外层保证
  （供部门自动归属整批复用）。

### B. 部门自动归属继承全批原子（`lib/department-rule-service.ts`）
- `applyDepartmentAuto()` 整批走**一个** `prisma.$transaction`：
  每个部门组的 `batchUpdateEmployees({ tx })` + 部门治理批次审计
  全部在同一事务中；任一组失败 → **所有部门组整体回滚**。
- 成功时 `matched = updated + unchanged`；失败时抛 `BatchUpdateAbortedError`。
- 携带 `snapshot` 时先 `assertSnapshotFresh`（任一变化 → 409 STALE_PREVIEW），
  执行**绝不消费预览 items**，重跑 `matchAllEmployees` 全量，数量恒等于全量 affected。

### C. 门店合并：删 straggler + ACTIVE 候选 + 预览快照 + 服务端校验（`lib/store-merge-service.ts`）
- **删 stragglers 自动迁移**：`mergeStores()` 只迁 `Employee.storeId === 源门店`，
  不再「顺带把原文列仍写旧名、未真正归属的员工也统一过来」。
  `storeNameRaw` 写旧名但 `storeId` 为空的员工**绝不自动改挂**（历史证据保留，人工判断）。
- **候选只 ACTIVE**：`findAliasCandidates()` / `findMergeClusters()` 均过滤
  `Store.status === ACTIVE`；并查集与 reason 查找统一用 `validPairs`（只含 ACTIVE 门店的候选对）。
  已合并停用的旧门店不再进入新候选、不可作主店/来源。
- **预览快照 + 陈旧拒绝**：新增 `previewStoreMerge()`（只读，生成
  `MergePreviewSnapshot`：dbVersion + 逐店人数 + 迁移总数 + 主店前置人数）
  与 `assertMergeSnapshotFresh()`（任一漂移 → 抛 `StaleMergePreviewError` → **409 `STALE_MERGE_PREVIEW`**）。
- **服务端业务校验（不信任客户端）**：`mergeStores()` 执行前重查库 ——
  主店/被合并店必须存在且 ACTIVE、同名门店记录拒绝自动合并（人工处理）、
  逐店人数实时重算（写库数量以实时值为准，预览数量 = 执行数量）。
- `GET /api/stores/merge` 返回预览+快照；`POST` 支持 `snapshot`，
  状态类错误（停用/同名/不存在）→ 409 `MERGE_STATE_CHANGED`，参数类 → 400。
- 前端 `StoreMergePanel` 改为「先 GET 预览取快照 → 确认后 POST 携带 snapshot →
  409 提示重新预览」，绝不按旧数据静默执行。

### D. unmatched 口径（规格确认）
- 无启用规则时：`matchAllEmployees` 返回 `{ matched: [], unmatched: emps.length,
  baseCount: emps.length }` → preview `affected=0`、`unmatched = baseCount = 实时无部门人数`。
- 即「无规则」时**所有无部门员工都是未匹配**（不是 0，也不是报错）。
- G7-17 实测：无规则 `affected=0 / unmatched=1932 / noDept=1932`（三者一致）。

### E. 新增 5 项确定性测试（G7-14 ~ G7-18，见第六节）
- G7-14 用 SQLite 触发器 `trg71_batch_fail`（`BEFORE UPDATE ... WHEN new.departmentId=测试部门`
  抛 `RAISE(ABORT)`）制造「批量写库必失败」，验证 409 BATCH_ABORTED 后
  员工档案 / EmployeeHistory / AuditLog 三表**前后数量完全一致（零残留）**。
- G7-15 验证门店合并「预览 moveCount = 执行 employeesMoved = 4」，且
  `storeNameRaw=旧名但 storeId=null` 的 straggler **保持 storeId=null 不被迁移**。
- G7-16 验证 INACTIVE 门店既不能作来源、也不能作主门店（均 409），且不进候选簇。
- G7-17 验证无规则口径（affected=0 / unmatched=baseCount=实时无部门数）。
- G7-18 验证 cleanup 后合成数据（员工/迁移/straggler/部门/规则/门店/别名）全部清零。

### F. 回归与生产验证
- 全量回归：typecheck / build / check:auth(41/41 100%) / stage5(18) /
  stage6(25) / stage6:security(14) / tenure(22) / stage7.1(**20/20**) 全部通过。
- 生产 `data/hr.db` 实测：**员工 1920 · ACTIVE 门店 66 · 门店总数 66**，零污染。

### G. 边界（本收口**不做**，等下一步指令）
16 组门店实际合并、1902 人批量归属、14 状态冲突、无去重键补录、
Excel 导出 / 招聘 / 薪资 / 社保。

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

---

## 十、Stage 7.1.2 门店合并服务端候选约束 + Snapshot 请求绑定最终收口（追加）

> 发现门店合并 POST 存在「snapshot 与本次请求参数可错配」的闭环漏洞：
> `previewStoreMerge(request)` 返回的 snapshot 被丢弃，`assertMergeSnapshotFresh()`
> 只校验客户端 `body.snapshot`，导致请求的 mainStoreId/mergeStoreIds 可与
> snapshot 不一致仍被执行。本阶段彻底收口，仍**不执行**任何生产合并。

### 1. 发现的 snapshot 错配问题 ✅ 已修复
- **旧问题**：POST 先调 `previewStoreMerge(request)`（snapshot 被丢弃），
  再调 `assertMergeSnapshotFresh(body.snapshot)` 校验的是**客户端快照**，
  请求参数与快照可错配（A 的预览拿去合并 B）。
- **修复**：新增 `assertMergeRequestFresh({mainStoreId, mergeStoreIds, snapshot})`，
  依次验证 8 步（任一失败**绝不写入**）：
  ① snapshot 存在 ② snapshot.mainStoreId===请求 ③ mergeStoreIds 集合一致（排序比较，容忍顺序）
  ④ dbVersion 一致 ⑤ 主店人数一致 ⑥ 逐店人数一致 ⑦ 主店/源店仍 ACTIVE ⑧ 属于同一当前候选簇。
- **错误码**：缺 snapshot→400 `MERGE_PREVIEW_REQUIRED`；参数错配/版本人数漂移→409 `STALE_MERGE_PREVIEW`；
  非同一候选簇→409 `INVALID_MERGE_CLUSTER`；停用/同名/不存在→409 `MERGE_STATE_CHANGED`。

### 2. snapshot 成为强制执行前置条件 ✅
- `body.snapshot` 缺失 → **400 MERGE_PREVIEW_REQUIRED**，绝不执行 `mergeStores()`，
  不为兼容旧调用放行。门店合并正式走「预览→确认→执行」闭环。

### 3. 服务端候选簇验证 ✅
- 执行前调 `findMergeClusters()`，要求 `mainStoreId + mergeStoreIds` **全部属于
  同一个当前 ACTIVE 候选簇**（`allIds.every(id => cluster.storeIds.includes(id))`），
  否则 409 `INVALID_MERGE_CLUSTER`。不信任前端 clusters 数据。

### 4. 允许候选簇部分合并 ✅
- 簇 A/B/C 中只合并 A+B（C 暂不合并）是允许的 —— 校验用 `every`（所选门店都在簇内），
  而非 `===`（必须整簇）。C 保持 ACTIVE、员工不迁、不建别名、不被修改。

### 5. snapshot 参数排序容忍 ✅
- mergeStoreIds 是集合：请求 `[2,3]` 与 snapshot `[3,2]` 视为相同（排序后 join 比较）；
  但 `[2,3]` 与 `[2,4]` 必须判为不同 → 409。

### 6. 避免重复查询与竞态 ✅
- POST 保留 `assertMergeRequestFresh → mergeStores` 两段；`mergeStores` 内部仍重查
  ACTIVE/同名/存在性/实时员工（最终执行前重读），事务原子。不删既有内部校验。

### 7. 全项目入口收口 ✅
- 搜索 `mergeStores` / `previewStoreMerge` / `assertMergeSnapshotFresh` / `assertMergeRequestFresh`
  / `/api/stores/merge`：唯一业务入口是 `POST /api/stores/merge`；前端 `StoreMergePanel`
  走「GET 预览取 snapshot → POST 携带 snapshot → 409/400 提示重新预览」。
  无其他入口可绕过 ACTIVE/候选簇/snapshot/operator 校验。

### 8. 原始数据保护（继续遵守）✅
- 合并只改 `Employee.storeId`；不改 `storeNameRaw/departmentNameRaw/jobGradeRaw`；
  不删 Employee；继续写 EmployeeHistory / AuditLog / 保留 StoreAlias。

### 9. 新增 4 项测试 G7-19 ~ G7-22（见第六节表）
- G7-19 snapshot 错配（A+C 预览拿去 B+C）→ 409 STALE_MERGE_PREVIEW，五表零变化。
- G7-20 缺 snapshot → 400 MERGE_PREVIEW_REQUIRED，五表零变化。
- G7-21 非同一候选簇 → 409 INVALID_MERGE_CLUSTER，五表零变化。
- G7-22 合法簇部分合并 A+B（C 保留 ACTIVE/员工不动/不建 C 别名）+ snapshot 顺序容忍。

### 10. 全量回归与生产验证
- typecheck 0 错 · build 成功 · check:auth 41/41 (100%) · stage5 18/18 ·
  stage6 25/25 · stage6:security 14/14 · tenure 22/22 · **stage7.1 24/24**（G7-01~22）。
- 生产 `data/hr.db` 实测：员工 1920 · ACTIVE 门店 66 · 门店 66 · 别名 0 ·
  历史 0 · 审计 121，全部与基线一致；**Excel SHA256 = `aac5f0ca...e19129` 不变**。

### 11. 边界（本阶段**不做**，等下一步指令）
16 组门店实际合并、1902 人批量归属、14 状态冲突、无去重键补录、
Excel 导出 / 招聘 / 薪资 / 社保。不进入 Stage 7.2。

---

## 十一、Stage 7.1.3 治理预览/执行一致性最终收口（追加）

> 在 7.1.2 的「门店合并 snapshot 绑定 + 候选簇校验」之上，把**部门自动归属**
> 与**门店别名统一归属**也收成「预览→确认→执行」闭环，堵住预览/执行一致性
> 的最后几处漏洞。仍**不执行**任何生产治理；生产 `data/hr.db` 零污染。

### 1. P0：部门自动归属 apply 强制 snapshot ✅
- **旧问题**：`POST /api/departments/auto {action:apply}` 允许**不带 snapshot** 直接执行
  （`if (snapshot) assertSnapshotFresh(...)` 分支），「预览→确认→执行」闭环对部门侧不成立。
- **修复**：`applyDepartmentAuto` 的 `snapshot` 参数改为**必填**（`snapshot: AutoPreviewSnapshot`），
  service 层缺 snapshot → 抛 `DepartmentPreviewRequiredError`；route 层在调 service 前
  直接返回 **400 `DEPARTMENT_PREVIEW_REQUIRED`**。删除「无 snapshot 兼容直接执行」分支。
- **验证**：G7-24（apply 缺 snapshot → 400，Employee/History/Audit 三表零变化）。

### 2. P0：DepartmentRule 纳入版本指纹 ✅
- **旧问题**：`computeDbVersion()` 未覆盖 `DepartmentRule` —— 预览后增删/编辑规则
  （enabled/storeId/positionId/employeeType/priority/departmentId）不改变 dbVersion，
  部门预览的快照保护对「规则变化」失效。
- **修复**：`computeDbVersion()` 加入 `departmentRule.aggregate({ _count, _max: updatedAt })`，
  指纹现覆盖 Employee / Store / Position / Department / **DepartmentRule** / StoreAlias /
  EmployeeHistory 七类。新增/删除/编辑任一规则（写库刷新 updatedAt）都会改变 dbVersion。
- **补充：命中员工集合指纹**（防「规则数量不变、匹配总数不变、但命中集合已换」的
  陈旧执行）：`AutoPreviewSnapshot` 新增 `matchedFingerprint`（对「ruleId→deptId:empId」
  排序串 SHA-256），`assertSnapshotFresh` 一并比对。

### 3. P1：门店别名统一归属全批事务 ✅
- **旧问题**：`addStoreAlias()` = `StoreAlias.create()` → `repointEmployeesByName()`
  （逐个 `Employee.update` + `EmployeeHistory.create`）**不是事务**——中途失败会留下
  孤儿 StoreAlias / 半套员工改挂 / 半套历史。
- **修复**：`repointEmployeesByName` 支持外部 `tx`；`addStoreAlias` 把「别名创建（事务内
  再查唯一防 TOCTOU）+ 员工重挂 + 逐条历史 + 批次审计（type=store-alias）」全部包进
  同一个 `prisma.$transaction`，任一步失败**整体回滚**，抛 `StoreAliasAbortedError`
  → `/api/stores/[id]/aliases` 返回 **409 `ALIAS_BATCH_ABORTED`**。
  批次审计与业务同事务（detail 含 batchKey/type=store-alias/storeId/names/repointed/时间）。

### 4. P2：merge 事务内 ACTIVE 二次校验（竞态保护）✅
- **旧问题**：`mergeStores` 的 ACTIVE/存在性/同名检查全在事务**外**，「事务外检查通过、
  写库前一刻门店被并发停用」仍有窗口。
- **修复**：在 `prisma.$transaction` 内、写入前第一行，对主店/各被合并店**再查一次**
  存在性 / ACTIVE / 主店不在来源 / 名称与主店不同；任一失败抛
  `MergeStoreStateChangedError` → **409 `MERGE_STATE_CHANGED`**，整笔 merge 回滚
  （此时零写入，无残留）。

### 5. operator 规则复核 ✅
- 全项目扫描 `app/api/**`：所有写操作 API 的 `AuditLog.actor` / `EmployeeHistory.operator`
  均来自 `operatorFromRequest(req)`（Session 真实用户）；**无** `body.operator` /
  `x-operator` / query operator 信任点（grep 零命中）。`DEFAULT_OPERATOR` 仅作离线脚本
  兜底，受保护 HTTP API 一律 Session。

### 6. 新增 4 项测试 G7-23 ~ G7-26
- **G7-23**：部门规则指向「庚店(3人)」预览后，改规则指向「庚(3人)」——规则数量不变、
  匹配总数不变（3=3）、命中员工集合全换 → 旧快照 apply 必 **409 STALE_PREVIEW**
  （靠 dbVersion/命中集合指纹，不靠 matchedCount）。
- **G7-24**：`POST /api/departments/auto {action:apply}` 不带 snapshot → **400
  DEPARTMENT_PREVIEW_REQUIRED**，三表零变化。
- **G7-25**：SQLite 触发器 `trg713_alias_fail`（重挂到主店即中止）制造别名统一归属
  确定性失败 → **409 ALIAS_BATCH_ABORTED**，StoreAlias/员工/历史/审计 四表前后一致。
- **G7-26**：预览门店合并后，用 raw UPDATE（只改 status、不碰 updatedAt → dbVersion 不变）
  把 source 店置 INACTIVE → merge 必 **409 MERGE_STATE_CHANGED**，五表零变化。

### 7. 全量回归与生产验证
- typecheck 0 错 · build 成功 · check:auth 41/41 (100%) · stage5 18/18 ·
  stage6 25/25 · stage6:security 14/14 · tenure 22/22 · **stage7.1 28/28**（G7-01~26）。
- 生产 `data/hr.db` 实测：员工 1920 · ACTIVE 门店 66 · 门店 66 · 别名 0 ·
  历史 0 · 审计 121，全部与基线一致；**Excel SHA256 = `aac5f0ca...e19129` 不变**。

### 8. 边界（本阶段**不做**，等下一步指令）
16 组门店实际合并、1902 人批量归属、14 状态冲突、无去重键补录、
Excel 导出 / 招聘 / 薪资 / 社保。不进入 Stage 7.2。

---

## Stage 7.1.4 治理配置审计与事务一致性（2026-09-24）

> 提交基线：`5b40225`（Stage 7.1.3）。本阶段只做代码 + 副本库测试，**不执行任何生产治理**。

### 1. DepartmentRule CRUD 纳入事务审计（P0）
- `createRule/updateRule/deleteRule`（`lib/department-rule-service.ts`）改为业务写入 + AuditLog
  同一 `prisma.$transaction`：任一步失败整体回滚，不留「改了没审计」。
  - **CREATE**：entity=DepartmentRule、action=CREATE、entityId=新规则 id、actor=Session 操作人，
    detail 记 departmentId/storeId/positionId/employeeType/priority/enabled/remark（无敏感字段）。
  - **UPDATE**：查旧值 + 修改 + 审计同事务；detail 只记**真正变化**的字段（oldValue/newValue）。
  - **DELETE**：查删除前内容 + 删除 + 审计同事务；detail 保存删除前规则全字段。
- 三个 API 路由（`POST /api/department-rules`、`PUT/DELETE /api/department-rules/[id]`）
  统一 `await operatorFromRequest(req)` 传入 operator（Session 真实用户），禁止
  `body.operator` / `x-operator` / query operator（grep 零命中）。

### 2. StoreAlias DELETE 纳入审计（P0）
- `removeStoreAlias(aliasId, operator)`：「查删除前信息 → 删别名 → 写 AuditLog(DELETE/StoreAlias)」
  同一事务；detail 含 aliasId/alias/storeId/note（无敏感数据）；员工 storeId 不动。
- 事务整体回滚（含触发器强制审计失败）→ 别名未删、审计未落，零残留，API 映射
  **409 ALIAS_DELETE_ABORTED**；`DELETE /api/store-aliases/[id]` 取 Session operator 传入。

### 3. addStoreAlias 员工目标查询进入事务 + 门店 ACTIVE 二次验证（P1）
- `repointEmployeesByName` 传入 `tx` 时，**targets 查询也走 tx**（事务内读），
  绝不使用事务外提前查询出的 targets 作为最终写入依据（堵竞态窗口）。
- `addStoreAlias` 事务内顺序：再查 Store 存在 → 再验 `Store.status===ACTIVE`
  （已停用 → `StoreNotActiveError` → **409 STORE_NOT_ACTIVE**，整笔零写入）→ 再查 Alias 唯一（TOCTOU）
  → 创建 StoreAlias → tx 内查 targets → 更新 Employee → 写 EmployeeHistory → 写批次 AuditLog。

### 4. DepartmentRule snapshot 显式绑定 overrideExisting
- `AutoPreviewSnapshot` 新增 `overrideExisting: boolean`；preview 记录当前参数，
  apply 时 `snapshot.overrideExisting !== 请求 overrideExisting` → **409 STALE_PREVIEW** 不执行
  （旧快照缺该字段 `?? false` 兜底，同样要求重新预览）。

### 5. 测试基础设施修复（SEC-13）
- `test:stage6:security` 的 SEC-13 原用 `execSync`（Windows 走 cmd.exe）派生第二个 node 进程，
  触发 `EBUSY` 句柄竞态；改为**异步 spawn + await**（与启动 next 服务器同机制）直跑
  `check-auth-coverage.mjs`，stage6:security 恢复 14/14。

### 6. 新增 4 项测试 G7-27 ~ G7-30
- **G7-27**：规则 CREATE → HTTP 201 + AuditLog +1（entity=DepartmentRule/action=CREATE/
  actor=Session「系统管理员」）；携带伪造 `x-operator` 头，审计 actor 仍为 Session 用户（伪造无效）。
- **G7-28**：规则 UPDATE 审计记录变化字段 old/new（priority 950→960、enabled true→false、
  remark）；DELETE 审计记录删除前全字段；actor 均为 Session 用户，伪造无效。
- **G7-29**：别名 DELETE 成功 +1 审计（actor=Session）；触发器 `trg714_aliasdel_fail`
  强制 AuditLog 写入失败 → 别名删除整体回滚（别名仍在、审计未新增，零残留，409 ALIAS_DELETE_ABORTED）。
- **G7-30**：preview overrideExisting=false 的快照拿去 apply overrideExisting=true
  → **409 STALE_PREVIEW**，Employee/History/Audit 三表零变化。

### 7. 全量回归与生产验证
- typecheck 0 错 · build 成功 · check:auth 41/41 (100%) · stage5 18/18 ·
  stage6 25/25 · stage6:security 14/14 · tenure 22/22 · **stage7.1 32/32**（G7-01~30）。
- 生产 `data/hr.db` 实测：员工 1920 · ACTIVE 门店 66 · 门店 66 · 别名 0 ·
  历史 0 · 审计 121 · 规则 0，全部与基线一致；**Excel SHA256 = `aac5f0ca...e19129` 不变**。

### 8. 边界（本阶段**不做**，等下一步指令）
16 组门店实际合并、1902 人批量归属、14 状态冲突、无去重键补录、
Excel 导出 / 招聘 / 薪资 / 社保。不进入 Stage 7.2。

---

## Stage 7.1.5 门店合并后导入兼容性收口（2026-09-24）

> 提交基线：`2d38246`（Stage 7.1.4）。本阶段只修代码、补测试、做副本库验证，
> **严禁修改生产 data/hr.db / 执行真实门店合并 / 执行部门自动归属 / 进入 Stage 7.2**。
> 核心目标：门店合并把旧店置为 INACTIVE 后，下一次 Excel 导入绝不能把员工重新挂回
> 已停用的旧店；预览与正式提交共用同一套门店解析；StoreAlias 创建始终有审计。

### 1. INACTIVE Store 不再作为导入归属目标
- 旧行为 `scripts/import-excel.ts` 用 `store.upsert({ where: { name: nm } })` 建立
  `storeIdByName` —— 会让已合并停用的 INACTIVE 老门店被静默复活为导入目标。
- 现已改为统一 resolver：INACTIVE 门店**绝不**被 `upsert` 复活、也**绝不**作为归属目标；
  既无同名门店也无别名时才按既有规则新建 ACTIVE Store，否则 `storeId = null`。

### 2. 统一门店解析规则（单一事实来源）
新增 `lib/store-service.ts` 的 **`resolveStoreByName()` / `resolveStoreNamesBatch()`**
（单值与批量共用同一实现，杜绝漂移）。对一个 Excel 原始门店名 `rawName`：

| 优先级 | 条件 | 结果 |
|---|---|---|
| ① | 存在 **ACTIVE** `Store.name === rawName` | 用该 ACTIVE Store（`matchedBy:"name"`） |
| ② | 无 ACTIVE 同名，但存在 `StoreAlias.alias === rawName` 且其目标 **ACTIVE** | 用 `alias.storeId`（`"alias"`） |
| ③ | 存在 INACTIVE 同名门店 + 有效 ACTIVE Alias | **必须优先 Alias**（被②覆盖），绝不返回 INACTIVE 门店 |
| ④ | 存在 INACTIVE 同名门店、**无**有效 Alias | `storeId = null`（`"inactive-no-alias"`），记 `STORE_UNRESOLVED` 异常交人工 |
| ⑤ | 既无 Store 也无 Alias | 导入可新建 ACTIVE Store；预览/提交保持 `null`（`"not-found"`） |

**严禁**：INACTIVE Store 被重新当作有效门店返回 / 被 `upsert` 静默复活 / 被自动重绑。

### 3. 正式导入与预览共用同一解析逻辑
- `lib/excel-import/diff.ts`（预览 `createPreview` 与提交 `commitPreview` 共用的底座）
  的门店外键解析由自建 `storeNameToId`（含 INACTIVE、门店名优先）改为
  **`resolveStoreNamesBatch`**；`created` 行新增 `storeResolution` 字段
  （`name|alias|unresolved|absent`），`unresolved` 记 `STORE_UNRESOLVED` 问题。
- `lib/import-preview-service.ts` 新增员工分支的门店解析（原 `findFirst` 无 ACTIVE
  过滤、Alias 在前）也改为 `resolveStoreByName`。
- `scripts/import-excel.ts` 的 `storeIdByName` 建立改为 `resolveStoreNamesBatch` +
  无规则则新建 ACTIVE Store；`storeNameRaw` 原文始终保留。
- 三处**全部走同一个 resolver**，「预览挂 A 店、提交却挂 INACTIVE A」从此不可能发生。

### 4. StoreAlias CREATE 审计补齐（P1）
- `addStoreAlias` 旧实现在 `repointed === 0`（无员工迁移）时 `repointEmployeesByName`
  直接 `return`，导致「别名创建成功但 **0 条审计**」。
- 现改为：创建别名后**立即**写 `AuditLog(CREATE/StoreAlias)`（actor = Session 操作人，
  detail 含 aliasId/alias/storeId/note，无敏感字段）；有员工迁移时再写
  `AuditLog(BATCH_UPDATE/Store)`。全部在**同一 `prisma.$transaction`** 内，任一失败整体回滚。
  - 无迁移：至少 1 条 CREATE 审计；有迁移：CREATE + BATCH_UPDATE 两条。

### 5. 新增 5 项测试 G7-31 ~ G7-35（副本库 `data/stage7-1-test.db`）
- **G7-31**：INACTIVE 旧店名 + 有效 Alias → 返回 ACTIVE 主店 storeId（单值=批量，绝不返回 INACTIVE 旧店）。
- **G7-32**：INACTIVE 同名门店且无 Alias → `storeId = null`（不重绑/不复活）。
- **G7-33**：旧店名 Excel → 预览 `created.storeResolution = "alias"` 且 commit 后
  `employee.storeId = ACTIVE 主店`、`storeNameRaw` 原文保留（预览/提交同源）。
- **G7-34**：`addStoreAlias` 零迁移（repointed=0）也必写 1 条 CREATE 审计（actor=Session）。
- **G7-35**：CREATE 审计触发器 `trg715_alias_create_fail` 强制失败 → 整笔回滚
  （Alias 不存在 / 员工 / 历史 / 审计 四表零残留，409 ALIAS_BATCH_ABORTED）。

### 6. merge → alias → import 真实回归（本阶段最重要，G7-36）
真实 `mergeStores`（HTTP）把「子店」并入「子」主店后：主店 ACTIVE、源店 INACTIVE、
StoreAlias 已建、2 名员工已迁；下一次 Excel 出现源店旧名时，**resolver / 预览 diff /
正式 commit 三级一致**指向 ACTIVE 主店（`emp.storeId = 主店`、原文保留），绝不指向
INACTIVE 源店。

### 7. 全量回归与生产验证
- typecheck 0 错 · build 成功 · check:auth 41/41 (100%) · stage5 18/18 ·
  stage6 25/25 · stage6:security 14/14 · tenure 22/22 · **stage7.1 38/38**（G7-01~36）。
- 生产 `data/hr.db` 实测：员工 1920 · 门店 66（全 ACTIVE）· 别名 0 · 历史 0 ·
  审计 121 · 规则 0，全部与 7.1.4 基线一致；**Excel SHA256 = `aac5f0ca...e19129` 不变**。
  所有写测试仅发生在副本 `data/stage7-1-test.db`，测试结束即删除。

### 8. unmatched 口径修正
- 「部门自动归属（当前）」表的 **unmatched = 1902**（= 当前可匹配基数，即实时无部门人数），
  不再是旧版误写的「无规则时 unmatched=0 / 不计」。与 Stage 7.1.1 G7-17 口径统一：
  无启用规则时 `affected = 0`、`unmatched = baseCount = 实时无部门人数`。

### 9. 边界（本阶段**不做**，等下一步指令）
16 组门店实际合并、1902 人批量归属、14 状态冲突、无去重键补录、
Excel 导出 / 招聘 / 薪资 / 社保。不进入 Stage 7.2。
