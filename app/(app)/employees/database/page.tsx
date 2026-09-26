import { redirect } from "next/navigation";

/**
 * 旧地址跳转（Stage 9.4）
 *
 * 「员工操作 → 全部员工（数据库）」与「员工表 → 数据库」是同一份数据（全部员工），
 * 按用户要求只保留员工表里的那张。这个旧网址保留为自动跳转，
 * 避免收藏夹 / 旧标签页 404。
 */
export default function LegacyDatabaseRedirect() {
  redirect("/sheets/" + encodeURIComponent("数据库"));
}
