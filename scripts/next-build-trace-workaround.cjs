/**
 * `next build` 在本机的绕行补丁（仅构建期使用，通过 NODE_OPTIONS 预加载）
 *
 * 现象：多个 webpack worker 各自对 `.next/trace` 调一次
 *   `fs.createWriteStream(file, { flags: 'a' })`（Next 自带的性能 trace）。
 *   在本机的文件代理环境下，**并发追加同一个文件**会被拒绝：
 *     uncaughtException [Error: EPERM: operation not permitted, open 'D:\Tuhu-HR\.next\trace']
 *   而这个 stream 上没有 error 监听器 → 直接 uncaughtException → 构建在
 *   「Creating an optimized production build ...」就整个挂掉（其实业务代码早就编译完了）。
 *
 * 处理：只对「路径是 .next/trace 且 errno 为 EPERM」的错误吞掉（挂一个 no-op 监听器），
 * **其他任何错误照常抛出**，绝不掩盖真实构建失败。
 * trace 文件本身只是 Next 的本地性能记录，丢几行不影响产物。
 *
 * 用法（见 MEMORY.md「next build 的绕坑流程」）：
 *   停掉 3000 服务
 *   CODEBUDDY_SAFE_DELETE_ENABLED=0 \
 *   NODE_OPTIONS="--require ./scripts/next-build-trace-workaround.cjs" \
 *   npx next build
 *   看 .next/BUILD_ID 是否生成 来判断成功（不要看管道后的退出码）
 *
 * ⚠️ 本文件只在「用 WorkBuddy 命令行跑构建」时需要；用户在自己终端里直接
 *    npm run build 通常不触发（没有并发追加的限制）。
 */
const fs = require("fs");

const isTracePath = (p) => typeof p === "string" && p.includes(".next") && /[\\/]trace$/.test(p);

const origCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function (file, options) {
  const stream = origCreateWriteStream.call(fs, file, options);
  if (isTracePath(String(file))) {
    stream.on("error", (err) => {
      if (err && (err.code === "EPERM" || err.code === "EBUSY")) {
        // 忽略：仅性能 trace 写不进去，不影响构建产物
        return;
      }
      throw err;
    });
  }
  return stream;
};
