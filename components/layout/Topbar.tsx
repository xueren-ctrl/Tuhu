"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SHEET_MAP } from "@/lib/sheet-meta";

/** 顶部系统栏 */

const TITLE_MAP: { match: RegExp; title: string; sub?: string }[] = [
  { match: /^\/$/, title: "首页看板", sub: "员工 / 门店 / 部门 / 职位 实时统计" },
  { match: /^\/employees\/views$/, title: "人员视图总览", sub: "按在职 / 离职 / 门店 / 部门查看人员" },
  { match: /^\/employees\/views\/active$/, title: "在职人员", sub: "status = ACTIVE" },
  { match: /^\/employees\/views\/resigned$/, title: "离职人员", sub: "status = RESIGNED" },
  { match: /^\/employees\/views\/stores$/, title: "门店人员查询", sub: "按 Store 表动态生成" },
  { match: /^\/employees\/views\/departments$/, title: "部门人员查询", sub: "按 Department 查询" },
  { match: /^\/employees\/views\/distribution$/, title: "人员分布统计", sub: "数据库实时聚合" },
  { match: /^\/employees\/new$/, title: "新增员工", sub: "先选类型（门店 / 运营部），字段按对应表合并去重" },
  { match: /^\/employees\/status$/, title: "更改员工状态", sub: "状态决定这个人出现在哪些表" },
  { match: /^\/employees\/\d+\/edit$/, title: "编辑员工", sub: "员工编号与创建时间不可修改" },
  { match: /^\/employees\/\d+$/, title: "员工详情", sub: "按分组展示全部档案字段" },
  { match: /^\/employees$/, title: "员工档案", sub: "搜索 · 筛选 · 分页 · 排序" },
  { match: /^\/stores\/merge$/, title: "门店合并", sub: "疑似同一门店归到主门店，只改门店外键（管理员）" },
  { match: /^\/employees\/department-auto$/, title: "部门自动归属", sub: "按规则生成推荐，确认后批量更新（管理员）" },
  { match: /^\/import$/, title: "Excel 导入预览", sub: "上传 → 解析 → Diff → 确认写入" },
  { match: /^\/employees\/batch$/, title: "批量编辑", sub: "按条件批量设置门店 / 部门 / 岗位" },
  { match: /^\/data-quality\/[^/]+$/, title: "数据质量问题明细", sub: "可下钻到具体员工" },
  { match: /^\/data-quality$/, title: "数据质量中心", sub: "状态冲突 · 无部门 · 无岗位 · 无门店 · 重复员工" },
  { match: /^\/settings\/access$/, title: "访问入口", sub: "手机 / 其它电脑 / 外网访问地址与说明" },
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

export default function Topbar({ onMenu }: { onMenu?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // /sheets/<中文表名> 与 /excel/<中文表名> —— 从路径里取出表名
  const sheetHit = (() => {
    const m = /^\/(sheets|excel)\/([^/]+)$/.exec(pathname);
    if (!m) return null;
    const isArchive = m[1] === "excel";
    const key = decodeURIComponent(m[2]);
    const meta = SHEET_MAP[key];
    return {
      title: (meta?.label ?? key) + (isArchive ? "（Excel 原始留档）" : ""),
      sub: isArchive ? "只读：导入时的原样数据，用于对照" : (meta?.desc ?? "由员工数据实时生成"),
    };
  })();

  const hit = sheetHit ?? TITLE_MAP.find((t) => t.match.test(pathname));

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
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--hr-border)] bg-white px-3 md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        {onMenu ? (
          <button
            type="button"
            onClick={onMenu}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-[13px] leading-none text-slate-600 md:hidden"
            aria-label="打开菜单"
          >
            ☰
          </button>
        ) : null}
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight">
            {hit?.title ?? "HR 人事管理系统"}
          </h1>
          {hit?.sub ? (
            <p className="truncate text-[11px] leading-tight text-sub">{hit.sub}</p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 lg:inline">
          ● 数据库已连接
        </span>
        <div className="flex items-center gap-2 rounded-full border border-[var(--hr-border)] py-1 pl-1 pr-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
            {me?.displayName?.[0] ?? me?.username?.[0] ?? "?"}
          </span>
          <div className="hidden flex-col leading-tight sm:flex">
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
