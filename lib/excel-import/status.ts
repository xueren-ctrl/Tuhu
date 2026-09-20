/**
 * 在职 / 离职状态判定（第五阶段 · 共享底座）
 *
 * 判定口径（与正式导入、导入预览**完全一致**）：
 *   离职信号 = 在「离职」名册 / 有离职日期 / 有离职原因 / 备注文本含离职字样；
 *   有任一信号即为 RESIGNED，否则 ACTIVE。
 *   「重新入职 / 又入职 / 回归 / 再入职」**不算**离职信号。
 *
 * 历史教训：预览曾经漏掉「离职名册」这一路，把 171 名离职员工判成在职，
 * 一旦确认写入就会把大批离职档案改回在职 —— 这类错误必须靠单一实现来根除。
 */
import type { EmployeeStatus } from "./types";
import { textMeansResigned } from "./normalization";
import type { IssueCollector } from "./issue";

export interface StatusInput {
  rowNo: number;
  name: string;
  hireDate: string | null;
  resignDate: string | null;
  resignDateRaw: string | null;
  resignReason: string | null;
  inActiveRoster: boolean;
  inResignedRoster: boolean;
}

export interface StatusResult {
  status: EmployeeStatus;
  signals: string[];
  /** 需要写入 dataFlags 的标记 */
  flags: string[];
}

export function deriveStatus(input: StatusInput, issues?: IssueCollector): StatusResult {
  const {
    rowNo,
    name,
    resignDate,
    resignDateRaw,
    resignReason,
    inActiveRoster,
    inResignedRoster,
  } = input;

  const resignText = textMeansResigned(resignDateRaw);

  const signals: string[] = [];
  if (inResignedRoster) signals.push("离职名册");
  if (resignDate) signals.push("离职日期");
  if (resignReason) signals.push("离职原因");
  if (resignText.yes) signals.push("备注文本含离职");

  const status: EmployeeStatus = signals.length > 0 ? "RESIGNED" : "ACTIVE";
  const flags: string[] = [];

  if (!issues) return { status, signals, flags };

  // 冲突：在职名册里却有离职信号
  if (inActiveRoster && signals.length > 0) {
    issues.add({
      row: rowNo,
      name,
      field: "status",
      rawValue: signals.join("+"),
      rawValueIsSafe: true,
      type: "STATUS_CONFLICT",
      message: `该员工同时出现在「在职」名册且带有离职信号（${signals.join("+")}），已按【离职】处理，请人工复核`,
    });
    flags.push("在职名册与离职信号冲突");
  }

  // 离职名册但库中无任何离职信息
  if (inResignedRoster && !resignDate && !resignReason && !resignText.yes) {
    issues.add({
      row: rowNo,
      name,
      field: "resignDate",
      type: "RESIGN_DATE_MISSING",
      message:
        "出自「离职」名册，但「数据库」Sheet 中无离职日期与离职原因，状态按离职处理，离职日期留空待补录",
    });
    flags.push("离职日期缺失");
  }

  // 文本型离职备注
  if (resignText.yes && !resignDate) {
    issues.add({
      row: rowNo,
      name,
      field: "resignDateRaw",
      rawValue: resignDateRaw,
      type: "RESIGN_DATE_MISSING",
      message: `离职备注为自由文本「${resignDateRaw ?? ""}」，无法解析出具体日期，已原样保留在 resignDateRaw 字段`,
    });
    flags.push("离职日期为文本，未解析出具体日期");
  }

  if (resignText.rehire) {
    issues.add({
      row: rowNo,
      name,
      field: "resignDateRaw",
      rawValue: resignDateRaw,
      type: "OTHER",
      message: `备注含「重新入职」语义（${resignDateRaw ?? ""}），未判定为离职，按在职处理`,
    });
    flags.push("备注含重新入职语义");
  }

  if (status === "RESIGNED" && !resignDate) flags.push("离职但无离职日期");

  return { status, signals, flags };
}
