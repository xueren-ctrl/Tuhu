"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type { MergeCluster, MergeResult } from "@/lib/store-merge-service";

interface Props {
  clusters: MergeCluster[];
}

/**
 * 门店合并面板
 *
 * 交互：每簇默认推荐一个主门店（在职人数最多的那个），可改；
 * 勾选要合并进来的门店后执行合并。
 *
 * 合并语义（页面上明确写出，避免误操作）：
 *   - 只改员工的 storeId 外键，不动任何其它字段
 *   - 员工一条都不删
 *   - 被合并的门店名登记为别名保留
 *   - 每一步都写员工变更记录
 *   - 被合并的门店记录本身只停用，不删除（可回退）
 */
export default function StoreMergePanel({ clusters }: Props) {
  const router = useRouter();
  const [mainId, setMainId] = useState<Record<number, number>>(() =>
    Object.fromEntries(clusters.map((c, i) => [i, c.suggestedMainId]))
  );
  const [picked, setPicked] = useState<Record<number, number[]>>(() =>
    Object.fromEntries(
      clusters.map((c, i) => [i, c.stores.filter((s) => s.id !== c.suggestedMainId).map((s) => s.id)])
    )
  );
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, MergeResult>>({});

  if (!clusters.length) {
    return (
      <Card title="没有发现疑似重复的门店">
        <p className="text-[12.5px] text-slate-600">
          当前门店名称之间没有检测到高度相似的组合。若你已知某两家其实是同一家店，
          可以回到<strong> 门店管理 </strong>页面把其中一个名称登记为另一个的别名。
        </p>
      </Card>
    );
  }

  function toggle(clusterIdx: number, storeId: number) {
    setPicked((p) => {
      const cur = p[clusterIdx] ?? [];
      return {
        ...p,
        [clusterIdx]: cur.includes(storeId) ? cur.filter((x) => x !== storeId) : [...cur, storeId],
      };
    });
  }

  /** 预览口径：合并后主门店人数 + 将建立的别名（只提示，不自动执行） */
  function previewOf(clusterIdx: number) {
    const c = clusters[clusterIdx];
    const main = mainId[clusterIdx] ?? c.suggestedMainId;
    const ids = (picked[clusterIdx] ?? []).filter((x) => x !== main);
    const mainStore = c.stores.find((s) => s.id === main);
    const selected = c.stores.filter((s) => ids.includes(s.id));
    const afterTotal = (mainStore?.total ?? 0) + selected.reduce((n, s) => n + s.total, 0);
    const aliasesToCreate = selected.filter((s) => s.name !== mainStore?.name).map((s) => s.name);
    return {
      mainName: mainStore?.name ?? "",
      selected,
      moveCount: selected.reduce((n, s) => n + s.total, 0),
      afterTotal,
      aliasesToCreate,
    };
  }

  async function merge(clusterIdx: number) {
    const c = clusters[clusterIdx];
    const main = mainId[clusterIdx] ?? c.suggestedMainId;
    const ids = (picked[clusterIdx] ?? []).filter((x) => x !== main);
    if (!ids.length) {
      setMsg({ tone: "err", text: "请至少勾选一家要合并进来的门店" });
      return;
    }
    const pv = previewOf(clusterIdx);
    if (
      !confirm(
        `确认合并？\n\n主门店：${pv.mainName}\n合并进来：${pv.selected.map((s) => s.name).join("、")}\n\n` +
          `将把 ${pv.moveCount} 名员工改挂到「${pv.mainName}」（只改门店外键），合并后主门店共 ${pv.afterTotal} 人。\n` +
          (pv.aliasesToCreate.length
            ? `将建立别名：${pv.aliasesToCreate.join("、")}\n`
            : "") +
          `员工数据不会删除；被合并的门店名会保留为别名；门店记录本身停用不删除。` +
          `\n\n本组为一个事务：中途失败会整体回滚，不会留下改了一半的数据。`
      )
    )
      return;

    setBusyIdx(clusterIdx);
    setMsg(null);
    try {
      const r = await fetch("/api/stores/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mainStoreId: main, mergeStoreIds: ids }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "合并失败（事务已整体回滚，可安全重试）");
      setResults((prev) => ({ ...prev, [clusterIdx]: j.data as MergeResult }));
      setMsg({
        tone: "ok",
        text:
          `已合并：${j.data.mergedStoreNames.length} 家并入「${j.data.mainStoreName}」，` +
          `迁移员工 ${j.data.employeesMoved} 人，生成别名 ${j.data.aliasesCreated} 个，` +
          `停用门店记录 ${j.data.storesDeactivated} 条。所有变更已写入员工变更记录。`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusyIdx(null);
    }
  }

  return (
    <div className="space-y-3">
      {msg && <Alert tone={msg.tone === "ok" ? "success" : "error"}>{msg.text}</Alert>}

      {clusters.map((c, idx) => {
        const main = mainId[idx] ?? c.suggestedMainId;
        const ids = picked[idx] ?? [];
        const done = results[idx];

        return (
          <Card
            key={idx}
            title={`第 ${idx + 1} 组 · ${c.stores.length} 家门店疑似同一家`}
            extra={
              <span className="text-[12px] text-slate-500">判定依据：{c.reason}</span>
            }
          >
            {done ? (
              <Alert tone="success">
                ✅ 本组已合并：{done.mergedStoreNames.join("、")} → 「{done.mainStoreName}」；
                迁移员工 {done.employeesMoved} 人；合并后主门店人数 {done.mainTotalAfter} 人。
              </Alert>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="px-3 py-2 font-medium">主门店</th>
                    <th className="px-3 py-2 font-medium">合并</th>
                    <th className="px-3 py-2 font-medium">门店名称</th>
                    <th className="px-3 py-2 text-right font-medium">员工总数</th>
                    <th className="px-3 py-2 text-right font-medium">在职</th>
                    <th className="px-3 py-2 text-right font-medium">离职</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {c.stores.map((s) => (
                    <tr
                      key={s.id}
                      className={
                        "border-b border-slate-100 " +
                        (s.id === main ? "bg-brand-50/50" : "")
                      }
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="radio"
                          name={`main-${idx}`}
                          aria-label={`选择 ${s.name} 作为主门店`}
                          checked={s.id === main}
                          onChange={() => {
                            setMainId((m) => ({ ...m, [idx]: s.id }));
                            setPicked((p) => ({
                              ...p,
                              [idx]: (p[idx] ?? []).filter((x) => x !== s.id),
                            }));
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`合并 ${s.name}`}
                          disabled={s.id === main}
                          checked={s.id !== main && ids.includes(s.id)}
                          onChange={() => toggle(idx, s.id)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium text-slate-800">{s.name}</span>
                        {s.id === c.suggestedMainId && (
                          <span className="ml-2">
                            <Badge tone="blue">建议主门店</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.total}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{s.active}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{s.resigned}</td>
                      <td className="px-3 py-2">
                        {s.status === "ACTIVE" ? (
                          <Badge tone="green">启用</Badge>
                        ) : (
                          <Badge tone="slate">已停用</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 预览汇总：合并后人数 / 将建立别名 / 迁移人数（只展示，不自动执行） */}
            {(() => {
              const pv = previewOf(idx);
              return (
                <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-[12.5px] text-slate-600">
                  <div className="font-medium text-slate-700">本组预览（勾选后实时计算）</div>
                  <ul className="mt-1 space-y-1">
                    <li>
                      主门店：<strong className="text-slate-800">{pv.mainName}</strong>
                      （当前 {c.stores.find((s) => s.id === (mainId[idx] ?? c.suggestedMainId))?.total ?? 0} 人）
                    </li>
                    <li>
                      合并后主门店人数：<strong className="text-slate-800 tabular-nums">{pv.afterTotal}</strong>
                      （迁移 {pv.moveCount} 人）
                    </li>
                    <li>
                      将建立别名：
                      {pv.aliasesToCreate.length ? (
                        pv.aliasesToCreate.map((n) => (
                          <span key={n} className="mx-1 rounded bg-brand-50 px-1.5 py-0.5 text-brand-800">
                            {n}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-400">无</span>
                      )}
                    </li>
                  </ul>
                </div>
              );
            })()}

            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="primary"
                disabled={busyIdx === idx || !ids.filter((x) => x !== main).length}
                onClick={() => void merge(idx)}
              >
                {busyIdx === idx ? "合并中…" : "执行合并"}
              </Button>
              <span className="text-[12.5px] text-slate-500">
                将把 <strong className="text-slate-700">{previewOf(idx).moveCount}</strong> 名员工改挂到主门店。
                只改门店外键，不删除员工；被合并的门店名保留为别名；门店记录停用不删除。
              </span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
