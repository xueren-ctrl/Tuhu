import { PrismaClient } from "@prisma/client";

/**
 * Prisma 单例。
 * 所有数据库访问必须通过此处导出的 `prisma`，
 * 前端不得直接操作 SQLite 文件。
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
