"use client";

import { usePathname } from "next/navigation";

/** 顶部系统栏 */

const TITLE_MAP: { match: RegExp; title: string; sub?: string }[] = [
  { match: /^\/$/, title: "首页看板", sub: "员工 / 门店 / 部门 / 职位 实时统计" },
  { match: /^\/employees\/views$/, title: "人员视图总览", sub: "替代 Excel 分表视图，全部实时查询员工表" },
  { match: /^\/employees\/views\/active$/, title: "在职人员", sub: "status = ACTIVE" },
  { match: /^\/employees\/views\/resigned$/, title: "离职人员", sub: "status = RESIGNED" },
  { match: /^\/employees\/views\/stores$/, title: "门店人员查询", sub: "按 Store 表动态生成" },
  { match: /^\/employees\/views\/departments$/, title: "部门人员查询", sub: "按 Department 查询" },
  { match: /^\/employees\/views\/distribution$/, title: "人员分布统计", sub: "数据库实时聚合" },
  { match: /^\/employees\/new$/, title: "新增员工", sub: "保存后自动生成员工编号" },
  { match: /^\/employees\/\d+\/edit$/, title: "编辑员工", sub: "员工编号与创建时间不可修改" },
  { match: /^\/employees\/\d+$/, title: "员工详情", sub: "按分组展示全部档案字段" },
  { match: /^\/employees$/, title: "员工档案", sub: "搜索 · 筛选 · 分页 · 排序" },
  { match: /^\/settings\/stores$/, title: "门店管理", sub: "新增 · 编辑 · 停用 · 搜索" },
  { match: /^\/settings\/departments$/, title: "部门管理", sub: "新增 · 编辑 · 停用" },
  { match: /^\/settings\/positions$/, title: "职位管理", sub: "新增 · 编辑 · 停用" },
  { match: /^\/settings\/import$/, title: "导入与报告", sub: "Excel 迁移说明与导入统计" },
];

export default function Topbar() {
  const pathname = usePathname();
  const hit = TITLE_MAP.find((t) => t.match.test(pathname));

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--hr-border)] bg-white px-5">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold leading-tight">
          {hit?.title ?? "HR 人事管理系统"}
        </h1>
        {hit?.sub ? (
          <p className="truncate text-[11px] leading-tight text-sub">{hit.sub}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 md:inline">
          ● 数据库已连接
        </span>
        {/* 第一阶段：基础登录设计已预留，暂不阻塞核心开发 */}
        <div className="flex items-center gap-2 rounded-full border border-[var(--hr-border)] py-1 pl-1 pr-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
            H
          </span>
          <span className="text-[12px] text-slate-600">HR 用户</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            管理员
          </span>
        </div>
      </div>
    </header>
  );
}
