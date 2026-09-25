/**
 * Excel 各 Sheet 的元信息（纯常量，可被客户端组件安全引用 —— 不 import prisma）
 *
 * 这些 Sheet 在软件里各自对应一张「数据表」：
 * 表里的数据就是该 Sheet 导入进来的原始数据，只是用软件的方式展示与检索，
 * 不再照搬 Excel 的网格外观。
 */

export interface SheetMeta {
  /** Sheet 名（与 Excel 一致，也是 /sheets/<key> 的路径） */
  key: string;
  /** 侧边栏 / 页面标题 */
  label: string;
  /** 一句话说明 */
  desc: string;
  /** 侧边栏图标 */
  icon: string;
}

export const SHEET_LIST: SheetMeta[] = [
  { key: "在职", label: "在职", desc: "各门店在职人员", icon: "✓" },
  { key: "离职", label: "离职", desc: "离职人员登记", icon: "✗" },
  { key: "南昌3店", label: "南昌3店", desc: "南昌 / 抚州三家门店", icon: "③" },
  { key: "运营部", label: "运营部", desc: "公司管理层（非门店）", icon: "▣" },
  { key: "招聘面试登记表", label: "招聘面试登记表", desc: "招聘面试与入职登记", icon: "◷" },
  { key: "运营部离职", label: "运营部离职", desc: "运营部离职人员", icon: "◐" },
  { key: "薪资表", label: "薪资表", desc: "薪资待遇与首月保障", icon: "¥" },
  { key: "数据库", label: "数据库", desc: "全部历史数据（所有 Sheet 的来源）", icon: "▤" },
];

export const SHEET_MAP: Record<string, SheetMeta> = Object.fromEntries(
  SHEET_LIST.map((s) => [s.key, s])
);

export function isKnownSheet(key: string): boolean {
  return Boolean(SHEET_MAP[key]);
}
