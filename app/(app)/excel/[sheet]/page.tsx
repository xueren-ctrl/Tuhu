import { redirect } from "next/navigation";
import { SHEET_MAP } from "@/lib/sheet-meta";

/**
 * 旧地址跳转（Stage 9.3）
 *
 * 「Excel 原始留档」这个查看页面已按要求删除 —— 那份数据已经迁移进软件，
 * 现在统一到「员工表」里对应的表查看。
 * 保留跳转让旧网址 / 旧标签页不会 404。
 */
export default async function LegacyExcelRedirect({
  params,
}: {
  params: Promise<{ sheet: string }>;
}) {
  const { sheet: raw } = await params;
  const sheet = decodeURIComponent(raw);
  // 认识表名就跳到同名员工表；不认识的直接回「在职」
  const target = SHEET_MAP[sheet] ? sheet : "在职";
  redirect("/sheets/" + encodeURIComponent(target));
}
