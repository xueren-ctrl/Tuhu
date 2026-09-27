import type { TransferRecord } from "./transfer-service";

/**
 * 折叠「改过去又改回」的往返噪音（Stage 9.28）
 *
 * ── 为什么需要 ──────────────────────────────────────────────
 * 途虎门店调动很「反复」，加上录数据时手滑，产生了大量
 * 「A 店 → B 店 → 又调回 A 店」的往返。实测 136 条记录里 **99 组是往返**，
 * 真实调店被彻底淹没。
 *
 * ── 判定规则（宁可漏判也不误判）─────────────────────────────
 * 同一个人，在时间线上**相邻两条**满足：
 *   前一条 A→B，后一条 B→A（门店完全对称），且间隔 **≤ 48 小时**
 * → 视为一次「往返」，净变动 = 0。
 *
 * ⚠️ **为什么用 48 小时而不是 10 分钟**：
 *   真实业务里「店长说调去，几天后改口」是常态（用户明确反馈过），
 *   那不是手滑，但**净变动同样是 0**（最终没走）——
 *   对「我关心这人最后在哪」这个视角，两者效果一样。
 *   反过来，超过 48 小时才改回的，中间很可能真的在 B 店待过一段时间，
 *   那就是**有意义的经历**，不该被折叠掉。
 *
 * ── 绝不删数据 ──────────────────────────────────────────────
 * 折叠只影响**显示**：原记录仍在库中，审计痕迹完整。
 * 折叠后仍可展开查看（页面保留「显示往返明细」开关）。
 */

/** 往返判定的最长间隔：48 小时 */
export const ROUND_TRIP_WINDOW_MS = 48 * 3600 * 1000;

export type FoldedRow =
  | (TransferRecord & { kind: "normal"; at: Date; isRoundTrip: false; tripCount: 0; minutes: 0 })
  | {
      kind: "roundtrip";
      id: number;
      at: Date;
      employeeId: number;
      employeeName: string;
      employeeCode: string | null;
      /** 往返涉及的门店（去而复返的那家） */
      store: string | null;
      /** 合并后的操作人（去重） */
      operators: string;
      source: string;
      isNoise: boolean;
      /** 合并了几条原始记录 */
      tripCount: number;
      /** 往返持续时间（分钟） */
      minutes: number;
    };

/** 门店键：null 统一成 "\u0000none"，便于对称比较 */
const key = (v: string | null) => v ?? "\u0000none";

export function foldRoundTrips(records: TransferRecord[]): FoldedRow[] {
  // 按员工分组，各组内按时间正序（便于找「相邻」）
  const byEmp = new Map<number, TransferRecord[]>();
  for (const r of records) {
    if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, []);
    byEmp.get(r.employeeId)!.push(r);
  }

  const consumed = new Set<number>();
  const result: FoldedRow[] = [];

  for (const list of byEmp.values()) {
    const asc = [...list].sort((a, b) => a.operatedAt.getTime() - b.operatedAt.getTime());
    for (let i = 0; i < asc.length; i++) {
      const cur = asc[i];
      if (consumed.has(cur.id)) continue;

      // 尝试与后续记录组成往返（可能连续多次来回，合并成一组）
      const group: TransferRecord[] = [cur];
      let j = i + 1;
      while (j < asc.length) {
        const next = asc[j];
        if (consumed.has(next.id)) break;
        const last = group[group.length - 1];
        const isMirror = key(next.fromStore) === key(last.toStore) && key(next.toStore) === key(last.fromStore);
        const withinWindow = next.operatedAt.getTime() - group[0].operatedAt.getTime() <= ROUND_TRIP_WINDOW_MS;
        if (isMirror && withinWindow) {
          group.push(next);
          consumed.add(next.id);
          j++;
          continue;
        }
        // 链条断了：只要最后一条回到起点就算一组
        if (
          key(group[group.length - 1].toStore) === key(group[0].fromStore) &&
          key(group[group.length - 1].fromStore) === key(group[0].toStore) &&
          next.operatedAt.getTime() - group[0].operatedAt.getTime() > ROUND_TRIP_WINDOW_MS
        ) {
          break;
        }
        break;
      }

      if (group.length >= 2 && key(group[group.length - 1].toStore) === key(group[0].fromStore)) {
        // 成功构成往返 → 折叠成一行
        consumed.add(cur.id);
        const operators = [...new Set(group.map((g) => g.operator))].join("、");
        result.push({
          kind: "roundtrip",
          id: cur.id,
          at: group[group.length - 1].operatedAt,
          employeeId: cur.employeeId,
          employeeName: cur.employeeName,
          employeeCode: cur.employeeCode,
          store: group[0].toStore,
          operators,
          source: group[0].source,
          isNoise: group.every((g) => g.isNoise),
          tripCount: group.length,
          minutes: Math.round((group[group.length - 1].operatedAt.getTime() - group[0].operatedAt.getTime()) / 60000),
        });
        i = j - 1;
      } else {
        result.push({ ...cur, kind: "normal", at: cur.operatedAt, isRoundTrip: false, tripCount: 0, minutes: 0 });
      }
    }
  }

  // 统一按时间倒序（页面习惯）
  return result.sort((a, b) => b.at.getTime() - a.at.getTime());
}
