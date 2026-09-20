import { NextResponse } from "next/server";
import { closeMany, listIssues, setIssueStatus } from "@/lib/quality-issue-service";
import { operatorFromRequest } from "@/lib/operator";

export const dynamic = "force-dynamic";

/**
 * GET /api/quality-issues —— 工单列表（可按类别 / 状态过滤）
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const data = await listIssues({
      issueType: url.searchParams.get("issueType") ?? undefined,
      status: (url.searchParams.get("status") as never) ?? "ALL",
      take: Number(url.searchParams.get("take") ?? 100),
    });
    return NextResponse.json({ ok: true, total: data.length, data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/quality-issues —— 设置工单状态 / 批量关闭
 *
 * 单条：{ issueType, employeeId, status, result? }
 * 批量：{ issueType, employeeIds: number[], status, result? }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      issueType?: string;
      employeeId?: number;
      employeeIds?: number[];
      status?: string;
      result?: string;
      note?: string;
    };
    const operator = operatorFromRequest(req);
    if (!body.issueType) {
      return NextResponse.json({ ok: false, error: "缺少 issueType" }, { status: 400 });
    }
    const status = (body.status ?? "CLOSED") as "OPEN" | "CLOSED" | "IGNORED";
    if (!["OPEN", "CLOSED", "IGNORED"].includes(status)) {
      return NextResponse.json({ ok: false, error: "status 只能是 OPEN / CLOSED / IGNORED" }, { status: 400 });
    }

    if (body.employeeIds?.length) {
      if (status === "OPEN") {
        // 批量重开
        let n = 0;
        for (const id of body.employeeIds) {
          await setIssueStatus({ issueType: body.issueType, employeeId: id, status: "OPEN", handler: operator });
          n++;
        }
        return NextResponse.json({ ok: true, mode: "reopen-many", data: { handled: n } });
      }
      const data = await closeMany({
        issueType: body.issueType,
        employeeIds: body.employeeIds,
        status: status as "CLOSED" | "IGNORED",
        handler: operator,
        result: body.result ?? null,
      });
      return NextResponse.json({ ok: true, mode: "many", data });
    }

    if (!body.employeeId) {
      return NextResponse.json({ ok: false, error: "缺少 employeeId 或 employeeIds" }, { status: 400 });
    }
    const data = await setIssueStatus({
      issueType: body.issueType,
      employeeId: body.employeeId,
      status,
      handler: operator,
      result: body.result ?? null,
      note: body.note ?? null,
    });
    return NextResponse.json({ ok: true, mode: "single", data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
