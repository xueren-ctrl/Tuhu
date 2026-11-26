/**
 * Excel「数据库」Sheet 解析器（第五阶段 · 共享底座）
 *
 * 【这是全项目唯一的 Excel 解析实现】
 *   正式导入：parseFile()  → EmployeeRecord[] → Prisma
 *   导入预览：parseBuffer() → EmployeeRecord[] → Diff
 *
 * 两边共用同一份列映射、同一套归一化、同一个状态判定，
 * 因此不存在「预览看到的」与「实际写入的」不一致的可能。
 *
 * 解析阶段**不做脱敏**：脱敏只属于展示层。
 * 一旦在这里脱敏，写入数据库的就是脱敏后的残缺值（这是第五阶段要修的头号缺陷）。
 */
import ExcelJS from "exceljs";
import type { EmployeeRecord, ParseResult } from "./types";
import {
  EXPECTED_HEADER,
  SEQ_COL,
  SPEC_BY_FIELD,
  STORED_SPECS,
} from "./field-mapping";
import {
  RE_ID18,
  cellSafe,
  dateFromIso,
  digitsOnly,
  genderFromIdCard,
  isValidIdChecksum,
  isSlaveMergedCell,
  looksBankCard,
  looksBankName,
  looksIdCard,
  looksMobile,
  normalizeIdCard,
  normalizePhoneKeepRaw,
  parseDateIso,
  readCellValue,
} from "./normalization";
import { deriveStatus } from "./status";
import { IssueCollector } from "./issue";

export const DB_SHEET = "数据库";
export const HEADER_ROW = 2; // 第 1 行是上一版残留，第 2 行才是表头
export const FIRST_DATA_ROW = 3;
export const ROSTER_ACTIVE_SHEET = "在职";
export const ROSTER_RESIGNED_SHEET = "离职";

function emptyResult(error?: string): ParseResult {
  return {
    ok: false,
    error,
    sheetName: DB_SHEET,
    totalRows: 0,
    validRows: 0,
    skippedRows: 0,
    rows: [],
    issues: [],
    skipped: [],
    rosterActive: new Set(),
    rosterResigned: new Set(),
    headerMap: new Map(),
  };
}

/** 按列读取名册（「在职」/「离职」Sheet）里的「姓名|入职日期」 */
function loadRosterKeys(ws: ExcelJS.Worksheet | undefined): Set<string> {
  const set = new Set<string>();
  if (!ws) return set;
  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const nameV = cellSafe(ws, r, 5);
    const name = typeof nameV === "string" ? nameV.trim() : nameV ? String(nameV) : null;
    if (!name || name.startsWith("=")) continue;
    const hd = parseDateIso(readCellValue(cellSafe(ws, r, 3)));
    set.add(`${name}|${hd ?? ""}`);
  }
  return set;
}

/** 解析已加载的工作簿 */
export function parseWorkbook(wb: ExcelJS.Workbook): ParseResult {
  const ws = wb.getWorksheet(DB_SHEET);
  if (!ws) {
    return emptyResult(
      `未找到「${DB_SHEET}」Sheet。现有：${wb.worksheets.map((w) => w.name).join("、")}`
    );
  }

  const collector = new IssueCollector();
  const skipped: { row: number; reason: string }[] = [];

  // ---- 1. 表头校验（列错位会导致身份证写进银行卡列，必须先拦） ----
  const headerMap = new Map<number, string>();
  for (let c = 1; c <= ws.columnCount; c++) {
    const t = readCellValue(ws.getCell(HEADER_ROW, c).value);
    if (t) headerMap.set(c, t);
  }
  for (const [c, label] of EXPECTED_HEADER) {
    const actual = headerMap.get(c);
    if (actual !== label) {
      return {
        ...emptyResult(
          `表头校验失败：第 ${c} 列应为「${label}」，实际为「${actual ?? "空"}」。Excel 列顺序可能被改动，为避免错位迁移已终止。`
        ),
        headerMap,
      };
    }
  }

  // ---- 2. 名册（仅用于辅助判定状态，数据仍以「数据库」Sheet 为准） ----
  const rosterActive = loadRosterKeys(wb.getWorksheet(ROSTER_ACTIVE_SHEET));
  const rosterResigned = loadRosterKeys(wb.getWorksheet(ROSTER_RESIGNED_SHEET));

  // ---- 3. 逐行解析 ----
  const rows: EmployeeRecord[] = [];
  const lastRow = ws.rowCount;

  for (let r = FIRST_DATA_ROW; r <= lastRow; r++) {
    /** 读取某列（合并单元格从属格视为空） */
    const read = (col: number): string | null => {
      const cell = ws.getCell(r, col);
      if (isSlaveMergedCell(cell)) return null;
      return readCellValue(cell.value, typeof cell.text === "string" ? cell.text : undefined, (raw, val) => {
        collector.add({
          row: r,
          field: `col${col}`,
          rawValue: raw,
          rawValueIsSafe: true,
          type: "PRECISION_RISK",
          message: `数值超出 JS 安全整数范围（${String(val)}），可能已丢失精度，已按显示文本读取`,
        });
      });
    };

    const name = read(5);
    const seqRaw = read(SEQ_COL);

    // 整行判空
    if (!name && !read(2) && !read(3) && !read(6)) {
      skipped.push({ row: r, reason: "整行为空" });
      continue;
    }
    // 有数据但没姓名 → 计入异常，不静默丢弃
    if (!name) {
      skipped.push({ row: r, reason: "姓名为空" });
      collector.add({
        row: r,
        field: "name",
        type: "EMPTY_NAME",
        message: `第 ${r} 行有数据但「姓名」为空，已跳过（原始行仍保留在 Excel 中）`,
      });
      continue;
    }

    // ---------- 3.1 长数字字段：内容识别 + 列错位归位 ----------
    // ⚠️ 2026-11-26 修：电话列用 normalizeIdCard 而不是 digitsOnly 取值。
    //    digitsOnly 会把身份证末尾的 x 也去掉（"…01x" → 17 位数字），
    //    looksIdCard 认不出，导致「身份证在电话列、手机号在身份证列」的
    //    互换行（郭驰行 191 等 8 行）没被归位，身份证被当成电话存、电话被
    //    当成身份证存。normalizeIdCard 保留末位 X，电话仍是纯数字，两者一致。
    const cIdCard = normalizeIdCard(read(6));
    const phoneRaw = read(7);
    const cPhone = normalizeIdCard(phoneRaw);
    let cBank = digitsOnly(read(22));
    let cBankBranch = read(21);
    const bankColRaw = read(22);

    let idCard: string | null = null;
    let phone: string | null = null;
    /** 3.1 是否已决定 phone 的最终值。未决定时沿用 3.5 循环的 keep-raw 值
     *  （电话列无任何数字时，如「无法适应 已离职」，3.1 的 phone 是 null，
     *   不能用它覆盖掉循环里已保留的原文 —— 罗龙平行 198 实测）。 */
    let phoneDecided = false;
    const flags: string[] = [];

    // 场景 A：身份证列填的不是身份证，而电话列里才是
    if (!looksIdCard(cIdCard) && looksIdCard(cPhone)) {
      idCard = cPhone;
      flags.push("身份证号填写在「联系电话」列，已按内容归位到身份证号字段");
      // 电话列里是身份证号，不是电话 → phone 定为 null 或归位来的手机号，
      // 绝不能沿用循环里对该列的 keep-raw 值（那会把身份证号写进电话字段）。
      phoneDecided = true;
      collector.add({
        row: r,
        name,
        field: "phone",
        rawValue: cPhone,
        type: "FIELD_MISPLACED",
        message: "「联系电话」列内为 18 位身份证号，已归位到身份证号字段",
      });
      if (looksMobile(cIdCard)) {
        // ★ 2026-11-24 修：身份证/电话互换的另一半 —— 身份证列里是 11 位手机号，
        //    必须归位到联系电话字段。旧逻辑只纠了身份证、把手机号丢了，
        //    实测 37 人的电话因此丢失（罗建柔、陈俊杰、唐跃彬等）。
        phone = cIdCard;
        phoneDecided = true;
        flags.push("手机号填写在「身份证号」列，已按内容归位到联系电话字段");
        collector.add({
          row: r,
          name,
          field: "idCardNo",
          rawValue: cIdCard,
          type: "FIELD_MISPLACED",
          message: "「身份证号」列内为 11 位手机号，已归位到联系电话字段",
        });
      } else if (looksBankCard(cIdCard)) {
        if (!cBank) {
          cBank = cIdCard;
          flags.push("银行卡号填写在「身份证号」列，已按内容归位到银行卡账号字段");
          collector.add({
            row: r,
            name,
            field: "idCardNo",
            rawValue: cIdCard,
            type: "FIELD_MISPLACED",
            message: "「身份证号」列内为银行卡号，已归位到银行卡账号字段",
          });
        } else {
          collector.add({
            row: r,
            name,
            field: "idCardNo",
            type: "OTHER",
            message: "「身份证号」列内容为银行卡号，但银行卡账号字段已有值，未做覆盖",
          });
        }
      } else if (cIdCard) {
        collector.add({
          row: r,
          name,
          field: "idCardNo",
          type: "OTHER",
          message: `「身份证号」列内容无法识别为身份证或银行卡（长度 ${cIdCard.length}），未做迁移`,
        });
      }
    } else if (looksIdCard(cIdCard)) {
      idCard = cIdCard;
      if (looksIdCard(cPhone)) {
        // 电话列也是同一张身份证号（重复值）→ 电话定为空，不沿用循环的 keep-raw 值
        phoneDecided = true;
        collector.add({
          row: r,
          name,
          field: "phone",
          type: "FIELD_MISPLACED",
          message: "「联系电话」列内为身份证号，与身份证号字段重复，已忽略该电话值",
        });
      }
    } else if (cIdCard) {
      idCard = cIdCard; // 原样保留，仅标记
      if (looksMobile(cIdCard)) {
        flags.push("「身份证号」列内容疑似手机号");
        collector.add({
          row: r,
          name,
          field: "idCardNo",
          type: "INVALID_ID",
          message: "「身份证号」列内容为 11 位手机号格式，已原样保留在身份证号字段，请人工核对",
        });
      } else if (looksBankCard(cIdCard)) {
        collector.add({
          row: r,
          name,
          field: "idCardNo",
          type: "INVALID_ID",
          message: `「身份证号」列内容为 ${cIdCard.length} 位数字（疑似银行卡号），已原样保留，请人工核对`,
        });
      } else {
        collector.add({
          row: r,
          name,
          field: "idCardNo",
          type: "INVALID_ID",
          message: `身份证号长度 ${cIdCard.length} 位（非标准 18 位），已按字符串原样保留`,
        });
      }
    }

    if (!looksIdCard(cPhone) && cPhone) {
      // ⚠️ 2026-11-26 修：digitsOnly 后不是合法 11 位手机号时保留原文
      //    （如「做了3天就走了」），不只剩一个「3」（罗龙平行 192 实测）。
      phone = normalizePhoneKeepRaw(phoneRaw);
      phoneDecided = true;
      if (phone === cPhone) {
        if (!looksMobile(cPhone) && cPhone.length > 11) {
          collector.add({
            row: r,
            name,
            field: "phone",
            type: "OTHER",
            message: `联系电话长度为 ${cPhone.length} 位（非 11 位手机号），已按字符串原样保留`,
          });
        }
      } else {
        collector.add({
          row: r,
          name,
          field: "phone",
          type: "INVALID_PHONE",
          message: `联系电话原文「${phoneRaw}」不是合法 11 位手机号，已保留原文，请人工核对`,
        });
      }
    } else if (phoneRaw && !cPhone) {
      // 电话列是纯文本、无任何数字（如「无法适应 已离职」）：
      // 值本身由 3.5 循环的 keep-raw 保留（phoneDecided 为 false，不覆盖），
      // 这里只记一条 issue（罗龙平行 198 实测：旧逻辑连 issue 都没有）。
      collector.add({
        row: r,
        name,
        field: "phone",
        type: "INVALID_PHONE",
        message: `联系电话原文「${phoneRaw}」不是合法 11 位手机号，已保留原文，请人工核对`,
      });
    }

    // 银行卡列填的是银行名称 → 归位到开户行
    if (bankColRaw && !looksBankCard(bankColRaw) && looksBankName(bankColRaw)) {
      if (!cBankBranch) {
        cBankBranch = bankColRaw;
        cBank = null;
        flags.push("银行名称填写在「银行卡账号」列，已按内容归位到开户行字段");
        collector.add({
          row: r,
          name,
          field: "bankAccountNo",
          rawValue: bankColRaw,
          type: "FIELD_MISPLACED",
          message: "「银行卡账号」列内容为银行/支行名称，已归位到开户行字段；银行卡号缺失",
        });
      } else {
        cBank = null;
        collector.add({
          row: r,
          name,
          field: "bankAccountNo",
          rawValue: bankColRaw,
          type: "FIELD_MISPLACED",
          message: "「银行卡账号」列内容为银行名称，开户行字段已有值，未做覆盖",
        });
      }
    } else if (bankColRaw && !looksBankCard(bankColRaw)) {
      // ⚠️ 2026-11-26 修：非 12–19 位数字的银行卡原文按原文保留
      //    （与 issue 文案「已原样保留」一致；旧逻辑只留 digits，文本信息会丢）。
      cBank = bankColRaw.trim();
      collector.add({
        row: r,
        name,
        field: "bankAccountNo",
        rawValue: bankColRaw,
        type: "OTHER",
        message: "「银行卡账号」列内容非纯数字，未识别为银行卡号，已原样保留",
      });
      flags.push("银行卡账号为非数字内容");
    }

    if (idCard && RE_ID18.test(idCard) && !isValidIdChecksum(idCard)) {
      collector.add({
        row: r,
        name,
        field: "idCardNo",
        type: "INVALID_ID",
        message: "身份证号校验位不通过（GB 11643 加权校验），已原样保留，请人工核对",
      });
    }
    if (!idCard) {
      collector.add({
        row: r,
        name,
        field: "idCardNo",
        type: "MISSING_ID",
        message: "身份证号为空，去重将回退到「姓名+入职日期」策略",
      });
    }

    // ---------- 3.2 日期 ----------
    const hireRaw = read(3);
    let hireDate = parseDateIso(hireRaw);
    if (hireRaw && !hireDate) {
      collector.add({
        row: r,
        name,
        field: "hireDate",
        rawValue: hireRaw,
        type: "INVALID_DATE",
        message: "入职时间无法解析为标准日期，已置空但原文保留在异常明细中",
      });
    } else if (hireDate && (Number(hireDate.slice(0, 4)) < 1990 || Number(hireDate.slice(0, 4)) > 2100)) {
      collector.add({
        row: r,
        name,
        field: "hireDate",
        rawValue: hireRaw,
        type: "INVALID_DATE",
        message: `入职时间「${hireRaw}」明显超出合理范围（疑似 Excel 序列号误填），已原样保留，请人工核对`,
      });
      flags.push(`入职日期异常（${hireRaw}）`);
    }

    // ⚠️ 2026-11-24 修：原表只有 45 列、无「薪资待遇」列，面试时间在 28 列（旧版误读 29 列）。
    const interviewRaw = read(28);
    const interviewDate = parseDateIso(interviewRaw);
    if (interviewRaw && !interviewDate) {
      collector.add({
        row: r,
        name,
        field: "interviewDate",
        rawValue: interviewRaw,
        type: "INVALID_DATE",
        message: "面试时间无法解析为标准日期，已置空但原文保留在异常明细中",
      });
    }

    // ---------- 3.3 离职信息与状态 ----------
    // ⚠️ 2026-11-24 修：原表只有 45 列、无「薪资待遇」列，离职原因在 25 列、
    //    备注（离职日期）在 26 列（旧版误读 26/27 列，离职原因读进了备注文本）。
    const resignRawText = read(26);
    const resignReason = read(25);
    const resignDate = parseDateIso(resignRawText);

    const rosterKey = `${name}|${hireDate ?? ""}`;
    const st = deriveStatus(
      {
        rowNo: r,
        name,
        hireDate,
        resignDate,
        resignDateRaw: resignRawText,
        resignReason,
        inActiveRoster: rosterActive.has(rosterKey),
        inResignedRoster: rosterResigned.has(rosterKey),
      },
      collector
    );
    flags.push(...st.flags);

    // ---------- 3.4 年龄 ----------
    // ⚠️ 2026-11-24 修：原表只有 45 列、无「薪资待遇」列，年龄在 27 列（旧版误读 28 列）。
    const ageRaw = read(27);
    let age: number | null = null;
    if (ageRaw) {
      const n = Number(ageRaw.replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 120) age = n;
    }

    // ---------- 3.5 组装标准化记录（覆盖 46 列） ----------
    const values: Record<string, string | number | null> = {};
    for (const spec of STORED_SPECS) {
      if (spec.col === 0) continue; // 派生字段稍后填
      const raw = read(spec.col);
      switch (spec.kind) {
        case "idcard":
          values[spec.field] = normalizeIdCard(raw);
          break;
        case "digits":
          if (spec.field === "bankAccountNo") {
            // 银行卡号由 3.1 的内容识别逻辑覆盖（values.bankAccountNo 稍后被覆写），
            // 这里只做占位，不额外记 issue。
            values[spec.field] = digitsOnly(raw);
          } else {
            // 手机号字段（phone / emergencyPhone1 / emergencyPhone2）：
            // 合法 11 位手机号取纯数字，否则保留原文（2026-11-26 修）。
            // phone 本身稍后会被 3.1 的归位结果覆写、3.1 也已记过 issue，
            // 这里只给紧急电话记 issue，避免同一行重复记两条。
            // ⚠️ 无任何数字的纯文本（如紧急电话列填了人名「父亲」）也要记 issue：
            //    digitsOnly 为空不代表值合法，只代表值里没数字。
            values[spec.field] = normalizePhoneKeepRaw(raw);
            if (spec.field !== "phone" && raw) {
              const kept = values[spec.field];
              if (kept !== null && kept !== undefined && !looksMobile(String(kept))) {
                collector.add({
                  row: r,
                  name,
                  field: spec.field,
                  type: "INVALID_PHONE",
                  message: `「${spec.label}」原文「${raw}」不是合法 11 位手机号，已保留原文，请人工核对`,
                });
              }
            }
          }
          break;
        case "date":
          values[spec.field] = parseDateIso(raw);
          break;
        case "int": {
          const n = Number((raw ?? "").replace(/[^\d.-]/g, ""));
          values[spec.field] = raw && Number.isFinite(n) ? Math.trunc(n) : null;
          break;
        }
        default:
          values[spec.field] = raw;
      }
    }
    // 覆盖经过「内容识别归位」处理的字段
    // （phone 只有 3.1 已决定时才覆盖；否则沿用 3.5 循环的 keep-raw 值，
    //  见 phoneDecided 注释 —— 电话列无数字的文本行不能写成 null）
    values.idCardNo = idCard;
    if (phoneDecided) values.phone = phone;
    values.bankAccountNo = cBank;
    values.bankBranch = cBankBranch;
    values.hireDate = hireDate;
    values.interviewDate = interviewDate;
    values.resignDate = resignDate;
    values.resignDateRaw = resignRawText;
    values.resignReason = resignReason;
    values.age = age;
    values.ageRaw = ageRaw;
    // 派生字段
    values.gender = genderFromIdCard(idCard);
    values.status = st.status;

    const seqNoNum = seqRaw ? Number(seqRaw.replace(/[^\d]/g, "")) : NaN;

    rows.push({
      rowNo: r,
      seqNo: Number.isFinite(seqNoNum) ? seqNoNum : null,
      name,
      idCardKey: idCard && RE_ID18.test(idCard) ? idCard : null,
      storeNameRaw: values.storeNameRaw as string | null,
      jobGradeRaw: values.jobGradeRaw as string | null,
      hireDate,
      status: st.status,
      resignDate,
      phone,
      values,
      dataFlags: flags,
    });
  }

  // ---- 4. 源数据缺失（SOURCE_MISSING）：与「系统应有但为空」区分开 ----
  const withoutDept = rows.filter((r) => !r.values.departmentNameRaw).length;
  if (withoutDept > 0) {
    collector.add({
      row: null,
      field: "departmentNameRaw",
      rawValue: `${withoutDept} 人`,
      rawValueIsSafe: true,
      type: "SOURCE_MISSING",
      message: `Excel「数据库」Sheet 未提供「部门」列：${withoutDept} 名员工的部门归属属于【源数据未采集】，不计为业务错误，也不应显示为「数据缺失待修复」。如需部门，请用「部门自动归属」按规则生成推荐。`,
    });
  }

  return {
    ok: true,
    sheetName: DB_SHEET,
    totalRows: Math.max(0, lastRow - FIRST_DATA_ROW + 1),
    validRows: rows.length,
    skippedRows: skipped.length,
    rows,
    issues: collector.issues,
    skipped,
    rosterActive,
    rosterResigned,
    headerMap,
  };
}

/**
 * 「运营部 / 运营部离职」Sheet —— 只取工作电话与户籍地址（2026-11-26 新增）
 *
 * 背景：导入只读「数据库」表，从不读这两个表，所以 Employee.workPhone /
 * householdAddress 全是空，导出运营部表这两列全空白。运营部的工作电话只存在
 * 于这两个表里（数据库表没有这一列），必须单独读。
 *
 * 列（与 lib/excel-export-service.ts 的 STAFF_COLUMNS 一致，按实测列序号）：
 *   3 入职时间、5 姓名、13 身份证号、14 联系电话、15 工作电话、16 户籍地址
 * 表头在第 1 行，数据从第 2 行起。无姓名的行跳过。
 *
 * ⚠️ 运营部离职表第 9/10 列虽然表头写「劳动合同 / 备注（薪资）」，实际填的是
 *    紧急联系人姓名+电话（人工表就是这样记的）—— 这里**不读**这两列，
 *    只取工作电话（15 列）与户籍地址（16 列），别的不碰。
 * 工作电话走 normalizePhoneKeepRaw（合法手机号取纯数字，否则保留原文）。
 */
export interface OpsContactRow {
  sheet: "运营部" | "运营部离职";
  /** Excel 原始行号 */
  rowNo: number;
  name: string;
  /** 18 位规范身份证（可用于匹配）；非 18 位时为 null */
  idCardKey: string | null;
  /** 原始身份证值（normalizeIdCard 后） */
  idCardRaw: string | null;
  /** 入职日期 ISO（YYYY-MM-DD），用于多候选时消歧 */
  hireDate: string | null;
  workPhone: string | null;
  householdAddress: string | null;
}

export function parseOpsSheets(wb: ExcelJS.Workbook): OpsContactRow[] {
  const out: OpsContactRow[] = [];
  for (const sheet of ["运营部", "运营部离职"] as const) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) continue;
    for (let r = 2; r <= ws.rowCount; r++) {
      const read = (col: number): string | null => {
        const cell = ws.getCell(r, col);
        if (isSlaveMergedCell(cell)) return null;
        return readCellValue(cell.value, typeof cell.text === "string" ? cell.text : undefined);
      };
      const name = read(5);
      if (!name) continue;
      const idRaw = normalizeIdCard(read(13));
      out.push({
        sheet,
        rowNo: r,
        name,
        idCardKey: idRaw && RE_ID18.test(idRaw) ? idRaw : null,
        idCardRaw: idRaw,
        hireDate: parseDateIso(read(3)),
        workPhone: normalizePhoneKeepRaw(read(15)),
        householdAddress: read(16),
      });
    }
  }
  return out;
}

/** 从文件路径解析（正式导入脚本用） */
export async function parseFile(filePath: string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return parseWorkbook(wb);
}

/** 从内存 Buffer 解析（导入预览用） */
export async function parseBuffer(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return parseWorkbook(wb);
}

/** 记录 → 可直接写入 Prisma 的日期对象（UTC 零点） */
export function recordDate(iso: string | null): Date | null {
  return dateFromIso(iso);
}

/** 字段中文名 */
export function labelOf(field: string): string {
  return SPEC_BY_FIELD.get(field)?.label ?? field;
}
