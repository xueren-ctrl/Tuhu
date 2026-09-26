import { redirect } from "next/navigation";

/**
 * 旧地址跳转（Stage 9.3）
 *
 * 「离职员工（列表）」这个页面已按要求删除，统一改用「员工表」里的「离职」表。
 * 保留跳转让旧网址 / 旧标签页不会 404。
 */
export default function LegacyResignedRedirect() {
  redirect("/sheets/" + encodeURIComponent("离职"));
}
