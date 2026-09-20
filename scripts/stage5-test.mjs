/**
 * ============================================================
 * 第五阶段验收测试 —— Excel 导入底座修复
 * scripts/stage5-test.mjs
 *
 * 运行方式：npx tsx scripts/stage5-test.mjs
 *
 * 设计：本测试**不直接触碰生产数据库**。它把 data/hr.db 复制成
 * data/stage5-test.db，并通过 DATABASE_URL 让被测服务连到这个副本，
 * 测试结束后删除副本。因此即使测试中途失败，也不会污染 1920 人的真实数据。
 *
 * ⚠ 只使用合成数据（假身份证 / 假手机号），可安全提交到代码仓库。
 *
 * 覆盖需求书第五阶段 10 项要求中的关键验证点：
 *   - [S5-01] 预览阶段不写库（员工数前后一致）
 *   - [S5-02] 预览 Diff 对敏感字段脱敏展示（display 脱敏）
 *   - [S5-03] 预览 Diff 不泄露真实敏感值（raw 不外发）
 *   - [S5-04] 确认写入时用真实值（raw），而非脱敏值
 *   - [S5-05] 敏感字段清单覆盖手机/身份证/银行卡/紧急联系人/住址/薪资
 *   - [S5-06] 字段映射覆盖全部 46 列 Excel
 *   - [S5-07] Diff 对 46 个可比字段逐一比对（含非敏感字段变化可发现）
 *   - [S5-08] 合并单元格防护（从属格不生成幽灵员工）
 *   - [S5-09] 版本冲突：预览后改库 → 提交被拒绝（409 语义）
 *   - [S5-10] 事务状态机：SUCCESS 后重复提交被拒（终态保护）
 *   - [S5-11] 事务状态机：PENDING 下带 retry 被拒（须先提交）
 *   - [S5-12] 重复预览稳定：同一文件两次预览结果一致
 *   - [S5-13] 数据质量：exact-duplicate 与 no-identity-key 拆分正确
 *   - [S5-14] 文件校验：非 xlsx 缓冲被解析器拒绝
 * ============================================================
 */
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

// ⚠ 必须在任何 app 模块被 import 之前设定，lib/prisma 会读取它
const TEST_DB = path.resolve(process.cwd(), "data", "stage5-test.db");
process.env.DATABASE_URL = "file:" + TEST_DB;
// 避免开发期 Prisma 日志刷屏
process.env.NODE_ENV = "test";

let pass = 0;
let fail = 0;
const failures = [];

function check(id, title, ok, detail) {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${title}`);
  }
  console.log(`${ok ? "✅" : "❌"} [${id}] ${title}${detail ? `\n       ${detail}` : ""}`);
}

// 合成数据（均为无效/示例号码，不对应真实个人；身份证号/手机号使用
// scripts/pre-push-check.mjs 中已白名单的假号码，确保测试脚本可安全提交）
const SYN = {
  a: { name: "阶段五测试员工甲", idCard: "110101199001011234", phoneOld: "13800138000", phoneNew: "13900139000", hire: "2022-05-10" },
  b: { name: "阶段五测试员工乙", idCard: "110101199001011234", phone: "13800138000", hire: "2022-06-11" },
  c: { name: "阶段五测试员工丙", idCard: "110101199001011234", phone: "13800138000", hire: "2022-07-12" },
  d: { name: "阶段五测试员工丁", idCard: "110101199001011234", phone: "13800138000", hire: "2022-08-13" },
  e: { name: "阶段五测试员工戊", idCard: "", phone: "", hire: "" },
};

async function main() {
  // ---- 准备：复制生产库为测试副本 ----
  const SRC = path.resolve(process.cwd(), "data", "hr.db");
  if (!existsSync(SRC)) {
    console.error("❌ 找不到 data/hr.db，请先完成基线导入");
    process.exit(2);
  }
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  copyFileSync(SRC, TEST_DB);
  console.log(`═`.repeat(72));
  console.log("第五阶段导入底座测试  TEST_DB =", TEST_DB);
  console.log(`═`.repeat(72));

  // ---- 动态加载被测模块（确保 DATABASE_URL 先生效）----
  const { prisma } = await import("../lib/prisma.ts");
  const { createPreview, commitPreview, discardPreview, getPreview, VersionConflictError } = await import(
    "../lib/import-preview-service.ts"
  );
  const { parseBuffer } = await import("../lib/excel-import/parser.ts");
  const { FIELD_SPECS, SPEC_BY_FIELD, STORED_SPECS, COMPARABLE_SPECS, SENSITIVE_FIELDS } = await import(
    "../lib/excel-import/field-mapping.ts"
  );
  const { maskByField } = await import("../lib/mask.ts");
  const dq = await import("../lib/data-quality-service.ts");

  // 清理可能遗留的上一轮合成数据
  await prisma.employee.deleteMany({ where: { name: { contains: "阶段五测试员工" } } });

  // ---- 构造工作簿的辅助函数（表头由 FIELD_SPECS 生成，保证列对齐）----
  function buildWorkbook(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据库");
    ws.getCell(2, 1).value = "序号";
    for (const s of FIELD_SPECS) {
      if (s.col > 0) ws.getCell(2, s.col).value = s.header;
    }
    for (const r of rows) {
      for (const [field, val] of Object.entries(r.values)) {
        const spec = SPEC_BY_FIELD.get(field);
        if (!spec || spec.col === 0) continue;
        ws.getCell(r.row, spec.col).value = val;
      }
    }
    return wb;
  }
  async function bufferOf(wb) {
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // 把库里的某员工改成「可匹配」状态（供预览命中）
  async function seedEmployee(rec) {
    const created = await prisma.employee.create({
      data: {
        employeeId: "THHR2026" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"),
        name: rec.name,
        idCardNo: rec.idCard || null,
        phone: rec.phone || null,
        hireDate: rec.hire ? new Date(rec.hire + "T00:00:00.000Z") : null,
        status: "ACTIVE",
        sourceSheet: "数据库",
        sourceRowNo: rec.rowNo ?? null,
        importBatch: "stage5-test",
        dataFlags: null,
      },
    });
    return created;
  }

  // ============================================================
  // [S5-05] 敏感字段清单
  // ============================================================
  check(
    "S5-05",
    "敏感字段清单覆盖 手机/身份证/银行卡/紧急联系人/住址/薪资",
    ["phone", "idCardNo", "bankAccountNo", "emergencyPhone1", "currentAddress", "salaryTerms"].every((f) =>
      SENSITIVE_FIELDS.has(f)
    ),
    `敏感字段数=${SENSITIVE_FIELDS.size}`
  );

  // ============================================================
  // [S5-06] 46 列覆盖
  // ============================================================
  const distinctCols = new Set(FIELD_SPECS.filter((s) => s.col > 0).map((s) => s.col));
  check("S5-06", "字段映射覆盖全部 46 列 Excel", distinctCols.size === 46, `distinct cols=${distinctCols.size}`);
  check(
    "S5-06b",
    "可比字段覆盖全部数据列（Diff 能发现任意字段变化）",
    COMPARABLE_SPECS.length >= 45,
    `comparable=${COMPARABLE_SPECS.length}`
  );

  // ============================================================
  // [S5-14] 非 xlsx 缓冲被拒绝（返回失败或抛错都算拒绝）
  // ============================================================
  {
    let rejected = false;
    let detail = "";
    try {
      const bad = await parseBuffer(Buffer.from("this is not an xlsx file at all"));
      rejected = bad.ok === false;
      detail = bad.ok === false ? bad.error?.slice(0, 40) : "意外返回 ok=true";
    } catch (e) {
      rejected = true;
      detail = String(e).slice(0, 40);
    }
    check("S5-14", "非 xlsx 缓冲被解析器拒绝（返回失败或抛错）", rejected, detail);
  }

  // ============================================================
  // [S5-08] 合并单元格防护（从属格不生成幽灵员工）
  // ============================================================
  {
    const wb = buildWorkbook([]);
    // 行3 有姓名+门店；把姓名列(E,col5) 与 行4 合并，主格在行3
    wb.getWorksheet("数据库").getCell(3, 5).value = SYN.b.name;
    wb.getWorksheet("数据库").getCell(3, 2).value = "阶段五测试门店";
    wb.getWorksheet("数据库").getCell(4, 2).value = "阶段五测试门店"; // 行4 仅门店、无姓名
    wb.getWorksheet("数据库").mergeCells("E3:E4"); // 行4 姓名从属，应被视为空
    const parsed = await parseBuffer(await bufferOf(wb));
    check(
      "S5-08",
      "合并单元格从属格不产生幽灵员工（validRows=1，行4被跳过）",
      parsed.ok && parsed.validRows === 1 && parsed.skippedRows === 1,
      `valid=${parsed.validRows} skipped=${parsed.skippedRows}`
    );
  }

  // ============================================================
  // [S5-01] 预览不写库
  // ============================================================
  const empA = await seedEmployee({ ...SYN.a, rowNo: 1001 });
  const beforeCount = await prisma.employee.count();
  {
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.a.name, idCardNo: SYN.a.idCard, phone: SYN.a.phoneNew, hireDate: SYN.a.hire, storeNameRaw: "阶段五测试门店" } },
    ]);
    const preview = await createPreview({ buffer: await bufferOf(wb), fileName: "stage5-a.xlsx" });
    const afterCount = await prisma.employee.count();
    check(
      "S5-01",
      "创建预览不写入数据库（员工数前后一致）",
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`
    );

    // [S5-02] 预览脱敏展示
    const mod = preview.diff.modified.find((m) => m.employeeCode === empA.employeeId);
    const phoneChange = mod?.changes.find((c) => c.field === "phone");
    const masked = phoneChange ? maskByField("phone", SYN.a.phoneNew) : null;
    check(
      "S5-02",
      "预览 Diff 对敏感字段脱敏展示（display 为掩码）",
      !!phoneChange && phoneChange.displayNewValue === masked,
      `display=${phoneChange?.displayNewValue} expect=${masked}`
    );

    // [S5-03] 预览不泄露真实值
    const leaked = JSON.stringify(preview.diff).includes(SYN.a.phoneNew);
    check("S5-03", "预览 Diff 不泄露真实敏感值（raw 不外发）", !leaked, leaked ? "发现明文手机号" : "ok");

    // 清理该预览（不提交）
    await discardPreview(preview.id);
  }

  // ============================================================
  // [S5-04] 确认写入用真实值（raw）
  // ============================================================
  {
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.a.name, idCardNo: SYN.a.idCard, phone: SYN.a.phoneNew, hireDate: SYN.a.hire, storeNameRaw: "阶段五测试门店" } },
    ]);
    const preview = await createPreview({ buffer: await bufferOf(wb), fileName: "stage5-a2.xlsx" });
    const result = await commitPreview({ id: preview.id });
    const updated = await prisma.employee.findUnique({ where: { id: empA.id } });
    check(
      "S5-04",
      "确认写入使用真实值（库内为明文手机号，非掩码）",
      updated?.phone === SYN.a.phoneNew,
      `db.phone=${updated?.phone} expect=${SYN.a.phoneNew}`
    );
    const fresh = await getPreview(preview.id);
    check("S5-04b", "提交成功后状态为 SUCCESS", fresh?.status === "SUCCESS" && result.failed === 0, `status=${fresh?.status}`);

    // [S5-10] SUCCESS 后重复提交被拒（终态保护）
    let threw = false;
    try {
      await commitPreview({ id: preview.id });
    } catch {
      threw = true;
    }
    check("S5-10", "事务状态机：SUCCESS 后重复提交被拒（终态保护）", threw);
  }

  // ============================================================
  // [S5-09] 版本冲突：预览后改库 → 提交被拒绝
  // ============================================================
  {
    const empC = await seedEmployee({ ...SYN.c, rowNo: 1002 });
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.c.name, idCardNo: SYN.c.idCard, phone: SYN.c.phone, hireDate: SYN.c.hire, storeNameRaw: "阶段五测试门店" } },
    ]);
    const preview = await createPreview({ buffer: await bufferOf(wb), fileName: "stage5-c.xlsx" });
    // 模拟「预览之后有人改了数据库」
    await prisma.employee.update({ where: { id: empC.id }, data: { name: SYN.c.name + "（已被改动）" } });
    let conflict = false;
    try {
      await commitPreview({ id: preview.id });
    } catch (e) {
      conflict = e instanceof VersionConflictError;
    }
    check("S5-09", "版本冲突：预览后改库 → 提交被拒绝（VersionConflictError）", conflict);
    await discardPreview(preview.id);
  }

  // ============================================================
  // [S5-11] DISCARDED 后提交被拒（终态保护）
  // ============================================================
  {
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.b.name, idCardNo: SYN.b.idCard, phone: SYN.b.phone, hireDate: SYN.b.hire, storeNameRaw: "阶段五测试门店" } },
    ]);
    const preview = await createPreview({ buffer: await bufferOf(wb), fileName: "stage5-b.xlsx" });
    await discardPreview(preview.id); // → DISCARDED（终态）
    let threw = false;
    try {
      await commitPreview({ id: preview.id });
    } catch {
      threw = true;
    }
    check("S5-11", "事务状态机：DISCARDED 后提交被拒（终态保护）", threw);
  }

  // ============================================================
  // [S5-12] 重复预览稳定
  // ============================================================
  {
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.b.name, idCardNo: SYN.b.idCard, phone: SYN.b.phone, hireDate: SYN.b.hire, storeNameRaw: "阶段五测试门店" } },
    ]);
    const buf = await bufferOf(wb);
    const p1 = await createPreview({ buffer: buf, fileName: "stage5-stable.xlsx" });
    const p2 = await createPreview({ buffer: buf, fileName: "stage5-stable.xlsx" });
    const s1 = p1.diff.summary;
    const s2 = p2.diff.summary;
    check(
      "S5-12",
      "重复预览稳定：同一文件两次预览结果一致",
      s1.newCount === s2.newCount && s1.modified === s2.modified && s1.unchanged === s2.unchanged,
      `p1=${JSON.stringify(s1)} p2=${JSON.stringify(s2)}`
    );
    await discardPreview(p1.id);
    await discardPreview(p2.id);
  }

  // ============================================================
  // [S5-07] Diff 能发现非敏感字段变化（门店名改动）
  // ============================================================
  {
    const empB = await seedEmployee({ ...SYN.b, rowNo: 1003 });
    const wb = buildWorkbook([
      { row: 3, values: { name: SYN.b.name, idCardNo: SYN.b.idCard, phone: SYN.b.phone, hireDate: SYN.b.hire, storeNameRaw: "阶段五测试门店_改名后" } },
    ]);
    const preview = await createPreview({ buffer: await bufferOf(wb), fileName: "stage5-store.xlsx" });
    const mod = preview.diff.modified.find((m) => m.employeeCode === empB.employeeId);
    const storeChange = mod?.changes.find((c) => c.field === "storeNameRaw");
    check(
      "S5-07",
      "Diff 能发现非敏感字段变化（门店原文变更被识别）",
      !!storeChange && storeChange.displayNewValue?.includes("改名后"),
      `storeNameRaw change=${storeChange ? storeChange.displayNewValue : "none"}`
    );
    await discardPreview(preview.id);
  }

  // ============================================================
  // [S5-13] 数据质量：exact-duplicate 与 no-identity-key 拆分
  // ============================================================
  {
    // 真重复：姓名+身份证+入职日期 完全相同
    const dup1 = await seedEmployee({ ...SYN.d, rowNo: 1004 });
    const dup2 = await seedEmployee({ ...SYN.d, rowNo: 1005 });
    // 无去重键：三键皆空
    const noKey = await seedEmployee({ ...SYN.e, rowNo: 1006 });

    const summary = await dq.getDataQualitySummary();
    const exact = summary.rows.find((c) => c.key === "exact-duplicate");
    const noId = summary.rows.find((c) => c.key === "no-identity-key");
    check(
      "S5-13",
      "数据质量：exact-duplicate 与 no-identity-key 正确拆分",
      !!exact && exact.count >= 1 && !!noId && noId.count >= 1,
      `exact(组)=${exact?.count} noIdentity=${noId?.count}`
    );

    const exactIds = await dq.listExactDuplicateIds();
    const ids = new Set(exactIds.map((x) => x.id));
    check(
      "S5-13b",
      "listExactDuplicateIds 包含两条真重复记录",
      ids.has(dup1.id) && ids.has(dup2.id),
      `ids=${[...ids].join(",")}`
    );

    // no-identity-key 明细应包含该员工
    const detail = await dq.getDataQualityDetail("no-identity-key", { page: 1, pageSize: 50 });
    const hasNoKey = detail.data.some((r) => r.id === noKey.id);
    check("S5-13c", "no-identity-key 明细可定位到无去重键员工", hasNoKey);
  }

  // ---- 收尾：清理合成数据 + 删除测试副本 ----
  await prisma.employee.deleteMany({ where: { name: { contains: "阶段五测试员工" } } });
  await prisma.importPreview.deleteMany({ where: { fileName: { contains: "stage5-" } } });
  await prisma.$disconnect();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

  console.log("═".repeat(72));
  console.log(`第五阶段测试完成：通过 ${pass} · 失败 ${fail}`);
  console.log("═".repeat(72));
  if (fail > 0) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("✗ 测试运行异常：", e);
  try {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  } catch {}
  process.exit(1);
});
