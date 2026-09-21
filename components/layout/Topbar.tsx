"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

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
  { match: /^\/stores\/merge$/, title: "门店合并", sub: "疑似同一门店归到主门店，只改门店外键（管理员）" },
  { match: /^\/employees\/department-auto$/, title: "部门自动归属", sub: "按规则生成推荐，确认后批量更新（管理员）" },
  { match: /^\/import$/, title: "Excel 导入预览", sub: "上传 → 解析 → Diff → 确认写入" },
  { match: /^\/employees\/batch$/, title: "批量编辑", sub: "按条件批量设置门店 / 部门 / 岗位" },
  { match: /^\/data-quality\/[^/]+$/, title: "数据质量问题明细", sub: "可下钻到具体员工" },
  { match: /^\/data-quality$/, title: "数据质量中心", sub: "状态冲突 · 无部门 · 无岗位 · 无门店 · 重复员工" },
  { match: /^\/stores$/, title: "门店管理", sub: "门店人数 · 别名归并（同一门店多种写法）" },
  { match: /^\/settings\/stores$/, title: "门店基础设置", sub: "新增 · 编辑 · 停用 · 搜索" },
  { match: /^\/settings\/departments$/, title: "部门管理", sub: "新增 · 编辑 · 停用" },
  { match: /^\/settings\/positions$/, title: "职位管理", sub: "新增 · 编辑 · 停用" },
  { match: /^\/settings\/import$/, title: "导入与报告", sub: "Excel 迁移说明与导入统计" },
];

interface MeUser {
  username: string;
  displayName: string | null;
  role: string;
}

export default function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const hit = TITLE_MAP.find((t) => t.match.test(pathname));
  const [me, setMe] = useState<MeUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.ok) setMe(d.user);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const roleLabel = me?.role === "ADMIN" ? "管理员" : "HR";

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
        <div className="flex items-center gap-2 rounded-full border border-[var(--hr-border)] py-1 pl-1 pr-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
            {me?.displayName?.[0] ?? me?.username?.[0] ?? "?"}
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[12px] font-medium text-slate-700">
              {me?.displayName || me?.username || "未登录"}
            </span>
            <span className="text-[10px] text-slate-400">{roleLabel}</span>
          </div>
          <button
            onClick={logout}
            disabled={loggingOut || !me}
            className="ml-1 rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"
            title="退出登录"
          >
            {loggingOut ? "退出中…" : "退出"}
          </button>
        </div>
      </div>
    </header>
  );
}
