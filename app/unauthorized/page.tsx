import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * 无权限提示页（位于 (app) 路由组之外，使用根布局）。
 * 由 requirePageUser 在角色不足时重定向至此。
 */
export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-lg">
        <div className="mb-3 text-4xl">🔒</div>
        <h1 className="text-lg font-bold text-slate-800">无访问权限</h1>
        <p className="mt-2 text-sm text-slate-500">
          当前账号角色无权访问该页面。如需操作请使用管理员账号，或联系系统管理员开通权限。
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          返回首页
        </Link>
      </div>
    </div>
  );
}
