# 第二阶段交付报告

> 生成时间：2026-09-19
> 范围：把原 Excel 的各个业务 Sheet 软件化为「人员视图」模块
> 交付状态：**已完成并通过全部测试（33/33）**，第一阶段功能无退化（回归测试 38/38）

---

## 一、完成模块

需求书要求的 6 项全部完成：

| # | 需求 | 状态 | 实现位置 |
| --- | --- | --- | --- |
| 1 | 在职人员（替代「在职」Sheet） | ✅ | `/employees/views/active` |
| 2 | 离职人员（替代「离职」Sheet） | ✅ | `/employees/views/resigned` |
| 3 | 门店人员查询（替代各门店 Sheet） | ✅ | `/employees/views/stores` |
| 4 | 部门人员查询（替代「运营部」Sheet） | ✅ | `/employees/views/departments` |
| 5 | 人员分布统计（替代「人员分布明细」Sheet） | ✅ | `/employees/views/distribution` |
| 6 | 数据库优化：Store / Department / Position 关联 | ✅ | `prisma/schema.prisma` |
| — | 增加统一筛选组件 | ✅ | `components/employees/EmployeeFilterPanel.tsx` |
| — | 增加统计接口 | ✅ | `GET /api/statistics` |

### 1.1 人员视图总览 `/employees/views`

作为人员视图的入口页：5 个模块的卡片（含实时数量）、门店 Top10、部门人数、模块与 Excel Sheet 的对应关系说明。

### 1.2 在职人员 `/employees/views/active`

- 规则：`status = ACTIVE`（**在 URL 中锁定**，前端无法通过参数绕过）
- 列：员工编号 · 姓名 · 性别 · 年龄 · 门店 · 部门 · 职位 · 入职日期 · 手机号 · 状态
- 支持：搜索（姓名/手机号/身份证）、门店/部门/职位筛选、分页、排序、查看员工详情
- 导出接口已预留：`GET /api/employees?status=ACTIVE&pageSize=200`（页面上有说明）

### 1.3 离职人员 `/employees/views/resigned`

- 规则：`status = RESIGNED`
- 列：员工编号 · 姓名 · **原门店** · 职位 · 入职日期 · **离职日期** · **离职原因**

### 1.4 门店人员查询 `/employees/views/stores`

- 门店清单由 `Store` 表**动态生成**，**未为任何门店创建单独页面**（`南昌3店` 等不再需要独立 Sheet）
- 两态设计：
  - 不传 `storeId` → 门店总览（每家门店 在职/离职/合计 + 在职占比条）
  - 传 `storeId` → 门店详情：在职人数、离职人数、**岗位分布**（横向条形图）、员工列表
- `?storeId=__none__` 支持「未分配门店」口径

### 1.5 部门人员查询 `/employees/views/departments`

- 由 `Department` 表动态生成，替代「运营部」「运营部离职」Sheet
- 详情页：部门人数、岗位分布、人员列表

### 1.6 人员分布统计 `/employees/views/distribution`

- 总人数 / 在职 / 离职 / 门店数量 / 部门数量 / 岗位数量 —— **全部实时聚合**
- 各门店人数表、各部门人数表、岗位分布表（含「未分配」口径与占比条）
- 统计口径说明（在职 / 离职 / 未分配 的定义）

### 1.7 数据库优化（需求书第二节）

原模型只有 `Store` / `Position`，**缺少 `Department`**，且「运营部」被误当成一家门店（18 人挂在 `Store` 下）。

新增/调整：

```prisma
model Department {
  id, name @unique, code?, deptType?, managerName?, sortOrder, status, remark, createdAt, updatedAt
  employees Employee[]
}

model Employee {
  ...
  departmentId      Int?          // 关联 Department（查询走外键）
  departmentNameRaw String?       // Excel 原始值留痕
  department        Department?   @relation(...)
  @@index([departmentId])
}
```

**员工关联链路已建立**：`Employee → Store / Department / Position`。

关于「避免员工表保存大量重复文字」：查询与筛选**一律走外键**（`storeId` / `departmentId` / `positionId`），
`storeNameRaw` / `departmentNameRaw` / `jobGradeRaw` 三列**仅作 Excel 原始值留痕**，不参与任何查询。
保留它们是为了满足第一阶段「不丢掉原始字段 / 不擅自改变业务含义」的要求，
删除它们会违反「保持当前架构，不重构已有功能」。

### 1.8 统一筛选组件（需求书第三节）

`EmployeeFilterPanel` —— 一个组件覆盖全部 6 项筛选：姓名、手机号、门店、部门、职位、状态。
特性：

- 通过 `fields` 配置显示哪些筛选项，通过 `locked` 锁定条件（如在职视图锁定 `status=ACTIVE`）
- 条件全部写入 URL，服务端实时查询，刷新/分享链接结果一致
- 支持「未分配」哨兵值 `__none__`
- **`/employees` 主列表也已切换到该组件**，删除了原来的 `EmployeeFilterBar.tsx`，不再重复实现

同时抽出了 `EmployeeViewTable`（按列名配置的通用表格）与 `PersonnelListView`（通用页面外壳），
四个列表视图的页面代码因此都只有几十行。

### 1.9 统计接口（需求书第四节）

```
GET /api/statistics
```
返回：`totalEmployees` / `activeEmployees` / `resignedEmployees` /
`storeCount` / `departmentCount` / `positionCount`（另附 `candidateEmployees`、`deletedEmployees`、`activeRate`、`generatedAt`）

```
GET /api/statistics?detail=1
```
额外返回 `storeDistribution` / `departmentDistribution` / `positionDistribution`。

---

## 二、新增 / 变更文件

### 新增

| 文件 | 说明 |
| --- | --- |
| `scripts/migrate-departments.ts` | 部门迁移脚本（幂等，支持 `--dry-run`） |
| `scripts/stage2-test.mjs` | 第二阶段验收测试（33 项） |
| `app/api/statistics/route.ts` | 统计接口 |
| `app/api/departments/route.ts` | 部门列表 / 新增 |
| `app/api/departments/[id]/route.ts` | 部门编辑 / 启停 |
| `app/employees/views/page.tsx` | 人员视图总览 |
| `app/employees/views/active/page.tsx` | 在职人员 |
| `app/employees/views/resigned/page.tsx` | 离职人员 |
| `app/employees/views/stores/page.tsx` | 门店人员查询 |
| `app/employees/views/departments/page.tsx` | 部门人员查询 |
| `app/employees/views/distribution/page.tsx` | 人员分布统计 |
| `app/settings/departments/page.tsx` | 部门管理页 |
| `components/employees/EmployeeFilterPanel.tsx` | 统一筛选组件 |
| `components/employees/EmployeeViewTable.tsx` | 通用人员表格 |
| `components/employees/PersonnelListView.tsx` | 通用人员视图外壳 |
| `components/settings/DepartmentManager.tsx` | 部门管理组件 |
| `docs/stage2-report.md` | 本报告 |

### 变更

| 文件 | 变更 |
| --- | --- |
| `prisma/schema.prisma` | 新增 `Department`；`Employee` 增加 `departmentId` / `departmentNameRaw` / 索引 |
| `lib/employee-service.ts` | 增加部门筛选、部门关联、门店/部门汇总、三类分布统计、统计口径 |
| `lib/settings-service.ts` | 新增部门 CRUD；`getSelectOptions` 增加 `departments` |
| `lib/validation.ts` | 新增 `departmentSchema`；`employeeQuerySchema` / create 支持 `departmentId` |
| `lib/constants.ts` | 新增 `UNASSIGNED`；员工字段元数据增加部门；分组名改为「门店 / 部门」 |
| `components/employees/EmployeeForm.tsx` | 新增「部门」选择与「部门（Excel 原文）」 |
| `components/employees/EmployeeDetail.tsx` | 头部摘要与字段分组展示部门 |
| `components/employees/ListPagination.tsx` | 增加 `basePath` 参数，供各视图复用 |
| `components/layout/Sidebar.tsx` | 新增「人员视图」分组（6 项）与「部门管理」 |
| `components/layout/Topbar.tsx` | 新增各视图标题映射 |
| `app/page.tsx` | 首页增加部门数量卡片、人员视图入口 |
| `app/employees/page.tsx` | 切换到统一筛选组件，增加部门筛选 |
| `app/employees/new/page.tsx`、`app/employees/[id]/edit/page.tsx` | 传入 departments |
| `scripts/cleanup-test-data.ts` | 覆盖第二阶段测试数据清理 |

### 删除

| 文件 | 原因 |
| --- | --- |
| `components/employees/EmployeeFilterBar.tsx` | 被统一的 `EmployeeFilterPanel` 取代，避免重复实现（需求书第三节明确要求） |

---

## 三、数据迁移结果

执行 `npx tsx scripts/migrate-departments.ts`（幂等，重复执行迁移 0 人）：

| 指标 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 员工总数 | 1920 | **1920（不变，无数据丢失）** |
| 门店数量 | 67 | **66** |
| 部门数量 | 0 | **1** |
| 职位 / 岗位数量 | 52 | 52 |
| 溯源映射 | 1934 | 1934 |

- 新建部门「运营部」（来源：Excel Sheet「运营部」+「运营部离职」），
  18 人从 `Store` 迁到 `Department`（**在职 9 / 离职 9**），`storeId` 置空。
- 原「运营部」门店记录（id=392）迁移后已无员工关联，作为非门店主体被删除。
- 未分配部门：**1902 人** —— Excel 源数据未提供门店员工的部门归属，**系统不擅自填充**。

---

## 四、测试结果

### 4.1 第二阶段验收测试（需求书第五节）

`node scripts/stage2-test.mjs` —— **通过 33 项，失败 0 项**

| 测试项 | 结果 | 实测数据 |
| --- | --- | --- |
| **1. 新增 ACTIVE 员工是否自动出现在「在职人员」** | | |
| 1.0 新增员工成功 | ✅ | `THHR2026001922` |
| 1.1 出现在 `/employees/views/active` | ✅ | 页面命中数 1 |
| 1.2 不出现在 `/employees/views/resigned` | ✅ | 页面命中数 0 |
| 1.3 在职视图口径 = status ACTIVE | ✅ | 接口命中 1 条 |
| 1.4 `/api/statistics` 在职 +1 | ✅ | 510 → 511 |
| **2. ACTIVE → RESIGNED 的自动联动** | | |
| 2.0 状态修改成功 | ✅ | status=RESIGNED |
| 2.1 自动从「在职人员」消失 | ✅ | 页面命中数 0 |
| 2.2 自动出现在「离职人员」 | ✅ | 页面命中数 1 |
| 2.3 接口口径同步（RESIGNED=1） | ✅ | 命中 1 条 |
| 2.3b 接口口径同步（ACTIVE=0） | ✅ | 命中 0 条 |
| 2.4 `/api/statistics` 在职 -1、离职 +1 | ✅ | 511→510，1410→1411 |
| **3. 修改门店后门店人员列表自动更新** | | |
| 3.1 出现在门店A 列表 | ✅ | 命中数 1 |
| 3.2 不在门店B 列表 | ✅ | 命中数 0 |
| 3.3 修改门店成功 | ✅ | storeId 407 → 408 |
| 3.4 自动从门店A 移出 | ✅ | 命中数 0 |
| 3.5 自动出现在门店B | ✅ | 命中数 1 |
| 3.6 门店人数统计同步 | ✅ | 门店A 1→0，门店B 0→1 |
| 3.7 门店列表由 Store 表动态生成 | ✅ | 总览页含新建门店 |
| 3.8 部门人员列表同步 | ✅ | 命中数 1 |
| **4. 刷新页面数据仍来自数据库** | | |
| 4.1 连续两次请求结果一致 | ✅ | 两次命中数 1 / 1 |
| 4.2 URL 参数刷新后仍生效 | ✅ | 分页/排序 HTTP 200 |
| **补充：统计接口与可访问性** | | |
| S1 `/api/statistics` 返回全部规定字段 | ✅ | 总数1921 在职511 离职1410 门店68 部门2 岗位52 |
| S2 `?detail=1` 附带三类分布 | ✅ | 门店69 / 部门3 / 岗位53 |
| S3 分布口径自洽（门店合计 = 员工总数） | ✅ | 1921 = 1921 |
| S4 分布口径自洽（部门合计 = 员工总数） | ✅ | 1921 = 1921 |
| S5 支持「未分配」筛选 | ✅ | `departmentId=__none__` → 1902 人 |
| 7 个新页面均可访问 | ✅ | HTTP 200 |

> 测试过程中修正了一处**测试脚本自身的缺陷**：最初用「页面是否包含员工姓名」判断命中，
> 但筛选框 value 与「当前筛选」提示会回显关键词，导致误判。
> 已改为解析卡片标题里的真实命中数（`在职人员（N 条）`），并补充接口层断言。

### 4.2 第一阶段回归测试

`node scripts/acceptance-test.mjs` —— **通过 38 项，失败 0 项**

确认替换筛选组件、增加部门字段后，原有员工 CRUD、搜索、筛选、分页、排序、软删除、脱敏等全部未退化。

### 4.3 构建与类型检查

```
npx tsc --noEmit     ✅ 无错误
npx next build        ✅ 成功，27 条路由
```

路由清单（新增部分）：

```
ƒ /employees/views               ƒ /api/statistics
ƒ /employees/views/active        ƒ /api/departments
ƒ /employees/views/resigned      ƒ /api/departments/[id]
ƒ /employees/views/stores        ƒ /settings/departments
ƒ /employees/views/departments
ƒ /employees/views/distribution
```

### 4.4 数据清理

`npx tsx scripts/cleanup-test-data.ts` 清理后，数据库回到基线：

| 指标 | 值 |
| --- | --- |
| 员工总数 | 1920 |
| 门店 / 部门 / 岗位 | 66 / 1 / 52 |
| 溯源映射 | 1934 |

---

## 五、存在问题

### 5.1 ⚠️ 门店名称存在大量「同一门店两种写法」（建议优先处理）

Excel「门店名称」列对同一家门店存在两种写法，导入后成为两条独立 Store 记录：

| 无「店」后缀（员工多、在职≈0） | 带「店」后缀（员工少、在职多） |
| --- | --- |
| 东城东宝路（51 / 在职 0） | 东城东宝路店（22 / 在职 14） |
| 东城景湖春天（27 / 0） | 东城景湖春天店（17 / 11） |
| 南昌八月湖（45 / 1） | 南昌八月湖店（4 / 3） |
| 南昌莲西路（27 / 1） | 南昌莲西路店（5 / 3） |
| 厚街中心大道（58 / 0） | 厚街中心大道店（14 / 10） |
| 大朗富丽东路（40 / 0） | 大朗富丽东路店（29 / 23） |
| 常平常朗路（63 / 2） | 常平常朗路店（20 / 16） |
| 常平朗贝社区（43 / 0） | 常平朗贝社区店（13 / 10） |
| 惠州下角中路（58 / 0） | 惠州下角中路店（17 / 10） |
| 惠州新江北（53 / 0） | 惠州新江北店（16 / 12） |
| 惠州水云居（33 / 0） | 惠州水云居店（7 / 0） |
| 樟木头南城大道（34 / 0） | 樟木头南城大道店（12 / 7） |
| 长安乌沙大润发（22 / 0） | 长安乌沙大润发店（10 / 9） |
| 长安锦厦新兴街（33 / 0） | 长安锦厦新兴街店（16 / 9） |

另有 2 组名称包含关系：`南昌三店西` ⊂ `南昌三店西路店`、`塘厦林村新阳` ⊂ `塘厦林村新阳路店`。

**共 16 组疑似重复**。规律很明显：**无后缀的记录基本全是离职（在职≈0），带后缀的多为在职** ——
高度提示前者是门店的历史写法、后者是现行写法，属于同一家门店。

**当前处理：不做自动合并。** 依据是需求书「不允许使用 mock 数据」与第一阶段的
「不要擅自改变业务含义」—— 合并属于业务判断，应由 HR 确认。
**影响**：门店人员查询与人员分布统计中，同一家门店会分成两条，66 家门店实际约为 52 家。

**建议**：下一阶段在「门店管理」中增加**门店合并**功能（把 A 门店的员工批量改挂到 B 门店，
A 停用并保留原名到 `storeNameRaw`），由 HR 逐组确认执行。

### 5.2 门店员工的部门归属缺失

Excel 只提供「运营部」的部门信息，**1902 名门店员工没有部门**。
系统未用 mock 数据填充，部门筛选里以「未分配部门」呈现。

**建议**：下一阶段增加「批量设置部门」（按门店批量给员工指定所属部门）。

### 5.3 岗位名称未归并，岗位分布较碎

岗位名称直接取自 Excel「工种级别」原始值（如「青铜机修技师」「钻石机修技师」），
共 52 个，含级别前缀，导致岗位分布图条目偏多。

**当前处理**：原样展示，不归并（保证与源数据一致）。
**建议**：在「职位管理」中为岗位设置「大类」，下一阶段支持按大类聚合统计。
`Position.category` 字段已就绪。

### 5.4 失业日期为空的历史记录（第一阶段遗留）

部分离职记录的离职日期为空，原因是 Excel「备注（离职日期）」为自由文本（如「9/30已离职」）。
原文完整保留在 `resignDateRaw`，可在员工详情页人工补录。离职人员视图底部已提示。

### 5.5 `/api/stats` 与 `/api/statistics` 并存

第一阶段已有 `GET /api/stats`，本阶段按需求新增 `GET /api/statistics`（字段命名更规范）。
两个接口**数据同源**（都走 `getDashboardStats()`），行为一致。
为遵守「不重构已有功能」，保留 `/api/stats` 未删除；后续可将其标记为 deprecated 并合并。

### 5.6 未实现的功能（按需求书明确排除）

招聘系统、薪资系统、社保系统、手机 APP、Excel 正式导出 —— 本阶段**未开发**，
`Sidebar` 中标注为「后续阶段（未开发）」。

---

## 六、下一阶段建议（按优先级）

1. **门店合并 + 批量设置部门**（解决 5.1 / 5.2，直接提升人员视图与统计的准确性）
2. **岗位大类聚合**（解决 5.3，`Position.category` 字段已就绪）
3. 离职日期人工补录辅助（批量编辑 / 从 `resignDateRaw` 半自动解析）
4. Excel 正式导出（`templates/` 已预留，按现有视图口径导出）
5. 基础登录与角色权限（`AppUser` / `AuditLog` 已就绪，`AUTH_ENABLED=false`）

---

## 七、如何复现

```bash
# 1) 数据库结构同步（新增 Department 表与 Employee.departmentId）
npx prisma db push

# 2) 部门迁移（可先 --dry-run 预演）
npx tsx scripts/migrate-departments.ts --dry-run
npx tsx scripts/migrate-departments.ts

# 3) 构建与启动
npm run build
npm run start

# 4) 测试
node scripts/stage2-test.mjs        # 第二阶段 33 项
node scripts/acceptance-test.mjs    # 第一阶段回归 38 项
npx tsx scripts/cleanup-test-data.ts
```

---

## 八、核心原则遵守情况自检

| 原则 | 遵守情况 |
| --- | --- |
| Employee 表永远是唯一员工数据源 | ✅ 所有视图均查询 `Employee`，未新建任何员工表 |
| 禁止复制员工数据生成新的员工表 | ✅ 仅新增 `Department` 字典表，不含员工数据副本 |
| 所有业务页面必须通过查询 Employee 得到结果 | ✅ 统计与分布全部由 `Employee` 聚合得出 |
| 不允许使用 mock 数据 | ✅ 1902 人无部门 / 部分记录无离职日期，均如实呈现为「未分配 / 空」，未填充假数据 |
| 保持当前架构，不重构已有功能 | ✅ 仅将筛选组件替换为统一的公共组件，第一阶段 38 项回归测试全部通过 |
