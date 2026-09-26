import Link from "next/link";

/**
 * 离线兜底页（Service Worker 在断网时回退到这里）
 *
 * 放在 (app) 之外 —— 它必须在「拿不到服务端会话」时也能显示，
 * 否则断网时会连这个错误页都打不开。
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <div className="max-w-[420px]">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-900 text-2xl text-white">
          ⛅
        </div>
        <h1 className="text-[19px] font-semibold text-slate-800">当前连不上这台电脑</h1>
        <p className="mt-2.5 text-[13.5px] leading-relaxed text-slate-500">
          人事数据保存在运行这个系统的电脑上。请确认：
          <br />
          那台电脑已开机，且系统服务正在运行。
        </p>
        <a
          href="/"
          className="mt-6 block h-10 w-full rounded-md bg-slate-900 leading-10 text-[13.5px] text-white"
        >
          重试连接
        </a>
        <Link
          href="/login"
          className="mt-2.5 block text-[12.5px] text-slate-400 underline"
        >
          去登录页
        </Link>
      </div>
    </main>
  );
}
