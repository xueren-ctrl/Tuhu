import { headers } from "next/headers";
import { Card, Alert } from "@/components/ui";
import CopyField from "@/components/settings/CopyField";
import AccessSelfCheck from "@/components/settings/AccessSelfCheck";
import { getLanAddresses, isLocalAddress } from "@/lib/network";

export const dynamic = "force-dynamic";

/**
 * /settings/access —— 访问入口
 *
 * 把「本机 / 局域网（手机同 WiFi）/ 外网（手机 4G）」三类访问方式集中说明，
 * 地址由服务端实时探测本机网卡生成，不需要用户自己去查 IP。
 */

const PORT = Number(process.env.PORT ?? 3000);

export default async function AccessPage() {
  const h = await headers();
  const host = h.get("host") ?? "";
  const forwardedProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto === "https" ? "https" : forwardedProto === "http" ? "http" : "http";
  const ip = host.split(":")[0] ?? "";
  const viaLan = Boolean(ip) && !isLocalAddress(ip);
  const currentUrl = host ? `${proto}://${host}` : "";
  const lan = getLanAddresses(PORT);

  return (
    <div className="mx-auto max-w-[900px] space-y-4">
      <Alert tone="info">
        本系统跑在这台电脑上（端口 {PORT}）。只要电脑开着、这个服务在运行，
        同一网络下的手机或其他电脑就能直接打开下面的地址，不需要额外安装客户端。
      </Alert>

      <Card title="① 你现在正在用的入口">
        <CopyField value={currentUrl} tone="primary" />
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
          当前访问来源：<strong className="text-slate-700">{viaLan ? "局域网 / 外网地址" : "本机地址"}</strong>
          {viaLan ? "（说明其他设备已经能连上了）" : "（本机浏览器访问）。要给别人用，请用下面的局域网地址。"}
        </p>
      </Card>

      <Card title="⓪ 打不开？点一下自检">
        <p className="mb-2.5 text-[12.5px] leading-relaxed text-slate-600">
          如果某个设备上打不开、一直转圈、或提示「请检查网络」，在<strong>那个设备</strong>上点下面的按钮，
          会直接告诉你断在哪一环（网络不通 / 登录失效 / 浏览器缓存了旧版本），不用自己排查。
        </p>
        <AccessSelfCheck />
      </Card>

      <Card title="② 装到手机主屏幕，像 App 一样用">
        <p className="text-[12.5px] leading-relaxed text-slate-600">
          装好后桌面会出现一个图标，点开是<strong>独立窗口、没有浏览器地址栏</strong>，
          和原生 App 一样。数据仍然来自这台电脑，不会存到手机上。
        </p>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="text-[12px] font-medium text-slate-700">iPhone（用 Safari）</div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12px] leading-relaxed text-slate-500">
              <li>用 <strong>Safari</strong> 打开本系统（微信里打不开，要先点右上角「在浏览器中打开」）</li>
              <li>点底部中间的<strong>分享</strong>按钮（方框里一个向上箭头）</li>
              <li>向下滑，选<strong>「添加到主屏幕」</strong></li>
              <li>右上角点「添加」</li>
            </ol>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="text-[12px] font-medium text-slate-700">安卓（Chrome / Edge）</div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12px] leading-relaxed text-slate-500">
              <li>用 Chrome 打开本系统并登录</li>
              <li>点右下角「⋮」菜单</li>
              <li>选<strong>「安装应用」</strong>或<strong>「添加到主屏幕」</strong></li>
              <li>确认后桌面就出现图标了</li>
            </ol>
            <p className="mt-1.5 text-[11.5px] text-slate-400">
              页面右下角也会浮出「装到手机主屏幕」按钮，点它更快。
            </p>
          </div>
        </div>
        <Alert tone="info" className="mt-2.5">
          装好后<strong>断网时会看到「当前连不上这台电脑」</strong>的提示，而不是旧数据 ——
          人事数据（薪资、身份证）永远只从这台电脑实时取，不会给你看过期的内容。
        </Alert>
      </Card>

      <Card title="③ 手机 / 其他电脑（连同一个 WiFi）">
        {lan.length === 0 ? (
          <Alert tone="warn">没有检测到可用的局域网地址，请确认这台电脑已连接到 WiFi 或网线。</Alert>
        ) : (
          <div className="space-y-2.5">
            {lan.map((a) => (
              <div key={a.address}>
                <div className="mb-1 text-[11.5px] text-slate-400">
                  网卡：{a.iface} · {a.address}
                </div>
                <CopyField value={a.url} tone="primary" />
              </div>
            ))}
            <div className="pt-1 text-[12px] leading-relaxed text-slate-500">
              手机连上同一个 WiFi → 打开浏览器 → 输入上面任意一个地址 → 用系统账号登录即可。
              手机浏览器可以「添加到主屏幕」，以后就像 App 一样点开。
            </div>
          </div>
        )}

        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
          <div className="font-medium text-slate-700">连不上时按顺序检查这三点</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>这台电脑上的服务是否在运行（命令行窗口要开着）；</li>
            <li>手机和电脑是不是同一个 WiFi（不是 4G、也不是访客网络/公司隔离网络）；</li>
            <li>Windows 防火墙是否放行了 3000 端口 —— 在项目目录执行 <code className="rounded bg-white px-1">npm run firewall</code>（需管理员权限）。</li>
          </ol>
        </div>
      </Card>

      <Card title="④ 手机在外面、用 4G 也要能打开（外网）">
        <p className="text-[12.5px] leading-relaxed text-slate-600">
          外网访问靠一条临时隧道把本机服务暴露成一个公网网址。在项目目录另开一个命令行窗口执行：
        </p>
        <div className="mt-2">
          <CopyField value="npm run tunnel" />
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
          首次运行会自动下载隧道程序（约 30MB）。窗口里出现形如
          <code className="mx-1 rounded bg-slate-100 px-1">https://xxxx.trycloudflare.com</code>
          的地址后，用手机打开这个地址即可访问（https 加密，登录正常）。
          <br />
          注意：这是<strong>临时地址</strong>，隧道窗口一关就失效，下次启动会换一个新地址；
          需要固定网址可以改用 Tailscale（见项目 README）。
        </p>
        <Alert tone="warn" className="mt-3">
          隧道一旦开启，任何拿到该网址的人都能看到登录页。请务必使用强密码，
          用完及时关闭隧道窗口。数据始终存在这台电脑本地，不会上传到任何云端。
        </Alert>

        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
          <div className="font-medium text-slate-700">公网地址打不开、或提示「请检查网络」时</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>
              <strong>先强制刷新</strong>：电脑上按 <code className="rounded bg-white px-1">Ctrl+Shift+R</code>；
              手机上关掉页面重新打开，或在浏览器菜单里「清除浏览数据 → 仅缓存的图片和文件」。
              浏览器缓存了旧版本时，页面会永远停在加载状态。
            </li>
            <li>
              <strong>确认隧道窗口还开着</strong>：本机窗口一关，地址立刻失效。
              窗口里的地址才是当前有效地址，每次启动都会换新的。
            </li>
            <li>
              <strong>换网络试</strong>：公司网络、校园网、公共 WiFi 常会拦截
              <code className="mx-1 rounded bg-white px-1">*.trycloudflare.com</code>。
              换手机流量（4G/5G）立刻试。
            </li>
            <li>
              <strong>关掉浏览器代理 / VPN 插件</strong>：这类插件会接管所有请求，
              导致本地隧道地址也走不出去。
            </li>
            <li>
              还是不行就用<strong>上面的「⓪ 自检」</strong>：在出问题的那个设备上点一下，
              直接看出断在哪一环。
            </li>
          </ol>
        </div>
      </Card>

      <Card title="⑤ 这台电脑当服务器：自动运行与看护">
        <p className="text-[12.5px] leading-relaxed text-slate-600">
          人事数据保存在这台电脑上，所以它必须<strong>一直开着</strong>。已帮你配好：
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-slate-600">
          <li>
            <strong>开机自动启动</strong>：Windows 登录后自动运行，不用手动敲命令。
            取消：在项目目录执行{" "}
            <code className="rounded bg-slate-100 px-1">
              powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1 -Uninstall
            </code>
          </li>
          <li>
            <strong>故障自愈</strong>：服务一旦崩溃，守护进程会在 15 秒内自动拉起；
            电脑从睡眠唤醒、网络断开重连后也会自动恢复。
          </li>
          <li>
            <strong>插电时不休眠</strong>：已设为「从不睡眠、永不休眠」，并关闭了「快速启动」
            （快速启动会让休眠状态下的开机导致网络工具异常）。
          </li>
        </ul>
        <div className="mt-3 space-y-2">
          <div>
            <div className="mb-1 text-[11.5px] text-slate-400">看运行日志（最近 40 行）</div>
            <CopyField value="npm run autostart:log" />
          </div>
          <Alert tone="warn">
            <strong>务必注意</strong>：关机、休眠、拔电时，外面就全都连不上了。
            长时间外出请让电脑保持开机、插上电、屏幕可以关但别休眠。
          </Alert>
        </div>
      </Card>

      <Card title="⑥ 安全提醒">
        <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-slate-600">
          <li>系统已开启登录校验：任何入口（本机 / 局域网 / 外网）都必须先登录。</li>
          <li>手机等设备的登录状态为 8 小时，超时自动要求重新登录。</li>
          <li>局域网访问用 http（明文），仅建议在可信的家庭 / 办公网络中开启。</li>
          <li>外网隧道走 https，链路加密；关闭隧道窗口即下线。</li>
        </ul>
      </Card>
    </div>
  );
}
