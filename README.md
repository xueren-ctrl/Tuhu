# 途虎加盟店 HR 人事管理系统

把 Excel「途虎HR人员登记.xlsx」中的 **`数据库` Sheet** 逐步软件化的 HR 系统。

**第一阶段目标（已完成范围）：核心数据库 + 员工档案管理。**

---

## 一、核心原则

| 原则 | 落地方式 |
| --- | --- |
| 数据库是唯一数据源 | `data/hr.db`（SQLite），员工数据只存在于 `Employee` 表 |
| 所有页面实时查询数据库 | 所有列表 / 统计 / 筛选均由服务端查询 Prisma，无前端硬编码、无缓存副本 |
| 各业务模块不各存一份员工数据 | 后续「在职/离职、编制、薪资、社保、流失率、导出」均通过 `employee_id` 关联同一张 `Employee` 表 |
| 员工内部唯一标识 | `employeeId` = `THHR + 年份 + 6位流水号`（如 `THHR2026000001`），创建后永不修改 |
| 不破坏原始 Excel | 导入脚本仅 `readFile`，并在导入前后校验 SHA256 证明未被修改 |

---

## 二、技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 15（App Router）+ TypeScript + React 19 |
| UI | Tailwind CSS + 自建统一基础组件（按钮/表单/表格/弹窗/分页/统计卡片） |
| 后端 | Next.js Server Components + Route Handlers（`app/api/*`） |
| 数据库 | SQLite（`data/hr.db`） |
| ORM | Prisma 6 |
| Excel 处理 | ExcelJS 4 |

- ✅ 所有数据库访问统一经过 Prisma
- ✅ 前端不直接操作 SQLite（只调用 `/api/*`）
- ✅ 配置不写死敏感信息（`.env` 已加入 `.gitignore`）

---

## 三、快速开始（Windows 本地）

```bash
# 0) 环境：Node.js >= 18.18（实测 Node 22 可用）

# 1) 安装依赖
npm install

# 2) 准备环境变量（复制示例后按需修改）
copy .env.example .env

# 3) 初始化数据库（生成 Prisma Client + 建表）
npm run db:push

# 4) 写入基础字典
npm run db:seed

# 5) 从 Excel 迁移数据（可重复执行，不会重复创建员工）
npm run import:excel

# 6) 启动
npm run dev
# 浏览器打开 http://localhost:3000
```

其他命令：

```bash
npm run build        # 生产构建
npm run typecheck    # TypeScript 类型检查
npm run start        # 生产模式启动
npm run db:studio    # Prisma Studio 可视化查库
npm run backup       # 备份数据库到 data/backup/

# 一次性任务
npx tsx scripts/acceptance-test.mjs   # 验收自检（需先 npm run build && npm run start）
npx tsx scripts/cleanup-test-data.ts  # 清理验收自检产生的临时数据
```

### 重新建立迁移基线（危险操作）

若需要把 Excel 完整重新导入一遍（例如修正了字段映射规则后再跑一次）：

```bash
npm run import:excel:reset
```

`--reset` 会先删除 **全部员工记录、导入批次、导入异常、员工编号计数器、
以及没有任何员工关联的门店/职位主数据**，然后重新导入。
原始 Excel 不会被触碰。执行前建议先 `npm run backup`。

理论上并不需要 `--reset`：`npm run import:excel` 本身是幂等的，
重复执行只更新不新增（已实测连续 3 次导入，第 2、3 次新增均为 0）。

---

## 四、目录结构

```
D:\Tuhu-HR\
├── app\                          # Next.js App Router
│   ├── page.tsx                  # 首页 HR Dashboard（实时统计）
│   ├── layout.tsx                # 左侧导航 + 顶部系统栏
│   ├── employees\
│   │   ├── page.tsx              # /employees   员工档案列表
│   │   ├── new\page.tsx          # 新增员工
│   │   └── [id]\
│   │       ├── page.tsx          # 员工详情（分组 Tab）
│   │       └── edit\page.tsx     # 编辑员工
│   ├── settings\
│   │   ├── stores\page.tsx       # 门店管理
│   │   ├── positions\page.tsx    # 职位管理
│   │   └── import\page.tsx       # 导入报告
│   └── api\                      # 服务端接口（唯一的数据出口）
│       ├── employees\            # 列表 / 新增 / 详情 / 编辑 / 软删除
│       ├── stores\  positions\   # 门店、职位 CRUD
│       ├── stats\   options\     # 统计、下拉选项
├── components\
│   ├── layout\                   # Sidebar / Topbar
│   ├── ui\                       # 统一基础组件
│   ├── employees\                # 筛选栏 / 表格 / 表单 / 详情
│   └── settings\                 # 门店 / 职位管理组件
├── lib\
│   ├── prisma.ts                 # Prisma 单例
│   ├── employee-service.ts       # 员工业务层（唯一数据访问入口）
│   ├── settings-service.ts       # 门店 / 职位业务层
│   ├── employee-id.ts            # employee_id 生成器
│   ├── validation.ts             # Zod 校验 + 空值归一化
│   ├── mask.ts                   # 敏感字段脱敏
│   ├── format.ts                 # 日期 / 长数字 / 身份证工具
│   └── constants.ts              # 状态、字段元数据、分组
├── prisma\
│   ├── schema.prisma             # 数据模型
│   └── seed.ts                   # 字典种子
├── scripts\
│   ├── import-excel.ts           # Excel → SQLite 迁移脚本（幂等）
│   ├── backup-db.ts              # 数据库备份
│   ├── acceptance-test.mjs       # 验收自检 38 项（A~Q）
│   └── cleanup-test-data.ts      # 清理验收临时数据
├── docs\
│   ├── excel-analysis.md         # Excel 结构分析（46 字段全量）
│   └── import-report.md          # 导入报告（自动生成）
├── templates\                    # 预留：Excel 官方导出模板
├── data\
│   ├── hr.db                     # SQLite 数据库（不入 Git）
│   ├── import\                   # 可放入 Excel 只读副本
│   └── backup\                   # 数据库备份
├── public\
└── 途虎HR人员登记.xlsx            # 原始 Excel（程序只读，不入 Git）
```

---

## 五、功能清单（第一阶段）

### 首页 `/`

- 员工总数、在职人数、离职人数、门店数量、职位数量（全部实时计算）
- 最近新增员工列表
- 数据库表概览 + 最近导入批次
- 状态口径说明

### 员工档案 `/employees`

- 员工列表（默认脱敏展示身份证 / 手机号）
- 关键词搜索（姓名 / 手机号 / 身份证 / 员工编号 / 门店 / 职位）
- 精确筛选：按姓名、按手机号、按身份证
- 门店筛选、职位筛选、在职状态筛选
- 分页（每页 10/20/50/100）+ 排序（编号 / 姓名 / 入职日期 / 状态 / 离职日期 / 创建时间 / 更新时间）
- 新增、编辑、查看详情、停用（软删除）、恢复

### 员工详情 `/employees/[id]`

按 **12 个分组 Tab** 展示：基本信息 · 联系方式 · 门店信息 · 职位信息 · 入职信息 · 社保 · 薪资 ·
合同与资料 · 招聘面试 · 离职信息 · 其他字段 · 系统信息。
另提供「全部字段一览」表，逐一对照 46 个 Excel 列。

### 基础设置

- `/settings/stores` 门店管理：新增 / 编辑 / 停用 / 搜索
- `/settings/positions` 职位管理：新增 / 编辑 / 停用
- `/settings/import` 导入批次历史 + 异常分类统计 + 导入报告全文

### 删除设计

**第一阶段不做物理删除。** 删除统一为软删除（`deletedAt`），历史档案完整保留，
可在列表页勾选「包含已停用档案」查看并恢复。「彻底删除」不对普通用户开放。

---

## 六、安全约定（HR 敏感数据）

1. 控制台日志**不打印**完整身份证号 / 银行卡号 / 手机号。
2. 列表接口默认输出**脱敏值**（`lib/mask.ts`）；详情页按需展示完整值。
3. `.env` 已在 `.gitignore` 中；`data/*.db`、`data/import/*.xlsx`、原始 Excel 同样不入 Git。
4. 数据库备份策略：`npm run backup` → `data/backup/hr-YYYYMMDD-HHmmss.db`，默认保留最近 30 份。
5. SQLite 数据文件**不作为静态资源暴露**，仅通过服务端 API 访问。
6. `AuditLog` 表记录员工/门店/职位的创建、编辑、停用、恢复（敏感字段已脱敏）。

---

## 七、后续阶段（本阶段明确不做）

- 完整招聘系统（字段已保留）
- 完整社保系统（字段已保留）
- 复杂薪资系统（字段已保留）
- 人员流失率报表
- Excel 导出（`templates/` 已预留）
- 复杂权限控制（已预留 `ADMIN` / `HR` 两种角色）
- 远程访问（Tailscale / Cloudflare Tunnel）

上述功能的原始字段**已全部在 `Employee` 表中保留**，后续拆分子模块时无需重新迁移。

---

## 八、文档

| 文件 | 内容 |
| --- | --- |
| `docs/excel-analysis.md` | Sheet 清单、46 字段含义/类型/可空性/模块归属、数据质量问题、无法判断字段登记 |
| `docs/import-report.md` | 导入统计、去重逻辑、状态统计、异常明细、原始 Excel 完整性核对（自动生成） |

---

## 安全提示（重要）

本系统处理**个人敏感信息**。提交代码前请务必执行一次体检：

```bash
npm run check:sensitive
```

数据库文件、原始 Excel、导入报告、`.env` 已全部由 `.gitignore` 排除。
仓库安全约定与「敏感数据已泄露时的处理流程」见 [`docs/security-checklist.md`](docs/security-checklist.md)。
