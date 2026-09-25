import { headers } from "next/headers";
import { Card, Alert } from "@/components/ui";
import CopyField from "@/components/settings/CopyField";
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

      <Card title="② 手机 / 其他电脑（连同一个 WiFi）">
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

      <Card title="③ 手机在外面、用 4G 也要能打开（外网）">
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
      </Card>

      <Card title="④ 安全提醒">
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
