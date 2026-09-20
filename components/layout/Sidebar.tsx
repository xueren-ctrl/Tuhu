"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 左侧导航栏（桌面优先，专业 HR 系统风格） */

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** 第一阶段是否已开放 */
  ready?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: "总览",
    items: [{ href: "/", label: "首页看板", icon: "▤", ready: true }],
  },
  {
    title: "人事档案",
    items: [
      { href: "/employees", label: "员工档案", icon: "▦", ready: true },
      { href: "/employees/new", label: "新增员工", icon: "＋", ready: true },
      { href: "/employees/batch", label: "批量编辑", icon: "⇉", ready: true },
    ],
  },
  {
    title: "数据治理（第三、四阶段）",
    items: [
      { href: "/stores", label: "门店管理", icon: "⌂", ready: true },
      { href: "/stores/merge", label: "门店合并", icon: "⊕", ready: true },
      { href: "/data-quality", label: "数据质量中心", icon: "◎", ready: true },
      { href: "/employees/department-auto", label: "部门自动归属", icon: "⇄", ready: true },
      { href: "/import", label: "Excel 导入预览", icon: "⇧", ready: true },
    ],
  },
  {
    title: "人员视图（第二阶段）",
    items: [
      { href: "/employees/views", label: "视图总览", icon: "◱", ready: true },
      { href: "/employees/views/active", label: "在职人员", icon: "✓", ready: true },
      { href: "/employees/views/resigned", label: "离职人员", icon: "✗", ready: true },
      { href: "/employees/views/stores", label: "门店人员查询", icon: "⌂", ready: true },
      { href: "/employees/views/departments", label: "部门人员查询", icon: "▣", ready: true },
      { href: "/employees/views/distribution", label: "人员分布统计", icon: "◔", ready: true },
    ],
  },
  {
    title: "基础设置",
    items: [
      { href: "/settings/stores", label: "门店管理", icon: "⌂", ready: true },
      { href: "/settings/departments", label: "部门管理", icon: "▣", ready: true },
      { href: "/settings/positions", label: "职位管理", icon: "◆", ready: true },
      { href: "/settings/import", label: "导入与报告", icon: "⇪", ready: true },
    ],
  },
  {
    title: "后续阶段（未开发）",
    items: [
      { href: "#", label: "招聘管理", icon: "◷", ready: false },
      { href: "#", label: "社保管理", icon: "◈", ready: false },
      { href: "#", label: "薪资管理", icon: "¥", ready: false },
      { href: "#", label: "Excel 导出", icon: "⇩", ready: false },
      { href: "#", label: "手机 APP", icon: "▢", ready: false },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    const base = href.split("?")[0];
    // /employees 只精确匹配列表页，避免与 /employees/views、/employees/new 冲突
    if (base === "/employees") return pathname === "/employees";
    // /employees/views 只精确匹配总览，子视图各自高亮
    if (base === "/employees/views") return pathname === "/employees/views";
    return pathname === base || pathname.startsWith(base + "/");
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--hr-border)] bg-white">
      {/* 系统标识 */}
      <div className="flex h-14 items-center gap-2.5 border-b border-[var(--hr-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          途
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight">
            途虎加盟店
          </div>
          <div className="truncate text-[11px] leading-tight text-sub">
            HR 人事管理系统
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-3">
        {NAV.map((group) => (
          <div key={group.title} className="mb-4">
            <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-slate-400">
              {group.title}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.ready && isActive(item.href);
                if (!item.ready) {
                  return (
                    <li key={item.label}>
                      <span className="flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-[7px] text-[13px] text-slate-300">
                        <span className="w-4 text-center text-[12px]">{item.icon}</span>
                        {item.label}
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      className={
                        "flex items-center gap-2 rounded-md px-2 py-[7px] text-[13px] transition-colors " +
                        (active
                          ? "bg-brand-50 font-medium text-brand-700"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")
                      }
                    >
                      <span className="w-4 text-center text-[12px]">{item.icon}</span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[11px] leading-relaxed text-slate-400">
        <div>第一阶段：核心数据库 + 员工档案</div>
        <div className="mt-0.5">SQLite · Prisma · Next.js</div>
      </div>
    </aside>
  );
}
