import { redirect } from "next/navigation";

/**
 * 旧地址跳转（Stage 9.3）
 *
 * 「在职员工（列表）」这个页面已按要求删除，统一改用「员工表」里的「在职」表。
 * 这里保留一个跳转，避免用户收藏的旧网址 / 浏览器里还开着的旧标签页直接 404。
 */
export default function LegacyActiveRedirect() {
  redirect("/sheets/" + encodeURIComponent("在职"));
}
