/**
 * 基础字典种子数据
 * 只放第一阶段必须的字典，不做过度设计。
 *
 * 注意：门店与职位主数据不在此处硬编码，
 * 而是由 scripts/import-excel.ts 从 Excel 历史取值中自动建立，
 * 以保证「Excel 已有数据 100% 可迁移」。
 *
 * 运行：npm run db:seed
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DICTS: { category: string; code: string; label: string; sortOrder: number }[] = [
  // Excel 中「是否住宿舍」「社保购买」「劳动合同」等列大量使用 是 / × 两种取值
  { category: "YES_NO_FLAG", code: "YES", label: "是", sortOrder: 1 },
  { category: "YES_NO_FLAG", code: "NO_X", label: "×", sortOrder: 2 },
  { category: "YES_NO_FLAG", code: "CHECK", label: "√", sortOrder: 3 },
  { category: "YES_NO_FLAG", code: "EMPTY", label: "空", sortOrder: 4 },

  // 资料收取状态
  { category: "DOC_STATUS", code: "COLLECTED", label: "已收", sortOrder: 1 },
  { category: "DOC_STATUS", code: "PENDING", label: "待收", sortOrder: 2 },
  { category: "DOC_STATUS", code: "NA", label: "不适用", sortOrder: 3 },

  // 离职原因（取自 Excel「离职原因」列实际出现的取值）
  { category: "RESIGN_REASON", code: "SELF_LEAVE", label: "自离", sortOrder: 1 },
  { category: "RESIGN_REASON", code: "QUIT", label: "辞职", sortOrder: 2 },
  { category: "RESIGN_REASON", code: "DISMISS", label: "辞退", sortOrder: 3 },
  { category: "RESIGN_REASON", code: "OTHER", label: "其他", sortOrder: 9 },

  // 住宿情况
  { category: "DORMITORY", code: "LIVE_IN", label: "住宿舍", sortOrder: 1 },
  { category: "DORMITORY", code: "LIVE_OUT", label: "不住宿舍", sortOrder: 2 },

  // 员工状态（与 lib/constants.ts 保持一致，便于基础设置页展示口径）
  { category: "EMPLOYEE_STATUS", code: "ACTIVE", label: "在职", sortOrder: 1 },
  { category: "EMPLOYEE_STATUS", code: "RESIGNED", label: "离职", sortOrder: 2 },
  { category: "EMPLOYEE_STATUS", code: "CANDIDATE", label: "候选人", sortOrder: 3 },

  // 招聘面试结果（取自 Excel「面试结果」列）
  { category: "INTERVIEW_RESULT", code: "PASS", label: "通过", sortOrder: 1 },
  { category: "INTERVIEW_RESULT", code: "FAIL", label: "未通过", sortOrder: 2 },
  { category: "INTERVIEW_RESULT", code: "PENDING", label: "待定", sortOrder: 3 },
];

async function main() {
  let created = 0;
  for (const d of DICTS) {
    const exists = await prisma.dictOption.findUnique({
      where: { category_code: { category: d.category, code: d.code } },
    });
    if (exists) continue;
    await prisma.dictOption.create({ data: { ...d, status: "ACTIVE" } });
    created++;
  }
  const total = await prisma.dictOption.count();
  console.log(`✓ 字典种子完成：新增 ${created} 条，字典总数 ${total} 条`);

  // 预留管理员账号（第一阶段不启用登录，仅占位）
  const admin = await prisma.appUser.findUnique({ where: { username: "admin" } });
  if (!admin) {
    await prisma.appUser.create({
      data: {
        username: "admin",
        displayName: "系统管理员",
        // 第一阶段不做登录，占位哈希；启用登录前必须重置
        passwordHash: "NOT_SET_CHANGE_BEFORE_ENABLE_LOGIN",
        role: "ADMIN",
      },
    });
    console.log("✓ 已预留管理员账号 admin（角色 ADMIN，登录功能尚未启用）");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
