"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SHEET_LIST } from "@/lib/sheet-meta";

/** 左侧导航栏（桌面常驻；手机端由 AppShell 放进抽屉） */

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    // 由员工数据实时生成：状态决定一个人出现在哪些表
    title: "员工表（对应 Excel 各 Sheet）",
    items: [
      ...SHEET_LIST.map((s) => ({ href: `/sheets/${encodeURIComponent(s.key)}`, label: s.label, icon: s.icon })),
      { href: "/employees/views/other", label: "其他", icon: "◇" },
    ],
  },
  {
    title: "员工操作",
    items: [
      { href: "/employees/new", label: "新增员工", icon: "＋" },
      { href: "/employees/status", label: "更改员工状态", icon: "⇄" },
      { href: "/employees/batch", label: "批量编辑", icon: "⇉" },
    ],
  },
  {
    // 编制表一行代表一家门店（不是一个人），所以不放进「员工表」分组
    title: "门店编制",
    items: [
      { href: "/headcount", label: "门店人员编制", icon: "▥" },
    ],
  },
  {
    title: "统计与查询",
    items: [
      { href: "/", label: "首页看板", icon: "▦" },
      { href: "/employees/views", label: "视图总览", icon: "◱" },
      { href: "/employees/views/stores", label: "门店人员查询", icon: "⌂" },
      { href: "/employees/views/distribution", label: "人员分布统计", icon: "◔" },
      { href: "/attrition", label: "人员流失率", icon: "◐" },
    ],
  },
  {
    title: "基础设置",
    items: [
      { href: "/settings/access", label: "访问入口（手机/外网）", icon: "⇱" },
      { href: "/settings/stores", label: "门店管理", icon: "⌂" },
      { href: "/settings/departments", label: "部门管理", icon: "▣" },
      { href: "/settings/positions", label: "职位管理", icon: "◆" },
      { href: "/settings/import", label: "导入与报告", icon: "⇪" },
    ],
  },
  {
    title: "数据治理（工具）",
    items: [
      { href: "/stores/merge", label: "门店合并", icon: "⊕" },
      { href: "/data-quality", label: "数据质量中心", icon: "◎" },
      { href: "/employees/department-auto", label: "部门自动归属", icon: "⇄" },
      { href: "/import", label: "Excel 导入预览", icon: "⇧" },
    ],
  },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    const base = href.split("?")[0];
    if (base === "/employees") return pathname === "/employees";
    if (base === "/employees/views") return pathname === "/employees/views";
    // Sheet 页面路径含中文，usePathname 可能返回编码或未编码形式，两种都比对
    const decoded = decodeURI(base);
    const candidates = [base, decoded, encodeURI(decoded)];
    return candidates.some((c) => pathname === c || pathname.startsWith(c + "/"));
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-[var(--hr-border)] bg-white">
      {/* 系统标识 */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[var(--hr-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          途
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight">途虎加盟店</div>
          <div className="truncate text-[11px] leading-tight text-sub">HR 人事管理系统</div>
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
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={
                        "flex items-center gap-2 rounded-md px-2 py-[7px] text-[13px] transition-colors " +
                        (active
                          ? "bg-brand-50 font-medium text-brand-700"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")
                      }
                    >
                      <span className="w-4 shrink-0 text-center text-[12px]">{item.icon}</span>
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--hr-border)] px-4 py-3 text-[11px] leading-relaxed text-slate-400">
        <div>SQLite · Prisma · Next.js</div>
        <div className="mt-0.5">数据源：Excel 各 Sheet 导入</div>
      </div>
    </aside>
  );
}
