"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type {
  MergeCluster,
  MergePreviewSnapshot,
  MergeResult,
} from "@/lib/store-merge-service";

interface Props {
  clusters: MergeCluster[];
}

/**
 * Stage 7.1.6：GET /api/stores/merge 的响应结构。
 *
 * `preview` 由**服务器直接读库计算**，是「执行前确认」的唯一权威数据来源；
 * 页面上的 clusters 只是加载时的候选快照，可能已过期。
 * 用显式类型约束确认框读取的字段，避免 `any` / `unknown` 掩盖口径漂移。
 */
type MergePreviewResponse = {
  snapshot: MergePreviewSnapshot;
  preview: {
    mainStore: { id: number; name: string; total: number };
    mergedStores: {
      id: number;
      name: string;
      total: number;
      active: number;
      status: string;
    }[];
    aliasesToCreate: string[];
    moveCount: number;
    mainTotalAfter: number;
  };
};

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
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "stale"; text: string } | null>(null);
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

  /**
   * 页面**静态展示**用的本地估算（勾选变化时实时算，仅供参考）。
   *
   * Stage 7.1.6：⚠️ 这里的数据来自页面加载时的 clusters 快照，**可能已过期**，
   * 绝不可用于「执行前的确认弹窗」——确认弹窗与 POST 的 snapshot 一律以
   * 服务器 GET /api/stores/merge 返回的 preview 为准（见 merge()）。
   */
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

    // ① Stage 7.1.6：先走服务端预览（校验 ACTIVE / 同名 / 实时人数，取快照 + 实时 preview）
    //    服务器返回的 preview 是「执行前确认」的唯一权威数据来源：
    //    页面 clusters 只是加载时的候选快照，可能已过期（人数/别名/合并结果都可能变）。
    setBusyIdx(clusterIdx);
    setMsg(null);
    let serverPreview: MergePreviewResponse;
    try {
      const pvRes = await fetch(
        `/api/stores/merge?mainStoreId=${main}&mergeStoreIds=${ids.join(",")}`,
        { cache: "no-store" }
      );
      const pj = await pvRes.json();
      if (!pvRes.ok || !pj.ok) throw new Error(pj.error ?? "合并前校验未通过");
      if (!pj.data?.preview || !pj.data?.snapshot) {
        throw new Error("服务器未返回实时预览数据，已中止（未执行任何修改）");
      }
      serverPreview = pj.data as MergePreviewResponse;
    } catch (e) {
      setBusyIdx(null);
      setMsg({ tone: "err", text: (e as Error).message + "（未执行任何修改，可重新勾选或刷新页面）" });
      return;
    }

    // ② 确认文案全部来自服务器实时 preview（不再用页面旧 clusters 的 previewOf()）
    const sp = serverPreview.preview;
    if (
      !confirm(
        `确认合并？（以下数字为服务器刚刚从数据库实时计算）\n\n` +
          `主门店：${sp.mainStore.name}（当前 ${sp.mainStore.total} 人）\n` +
          `合并进来：${sp.mergedStores.map((s) => `${s.name}（${s.total} 人）`).join("、")}\n\n` +
          `将把 ${sp.moveCount} 名员工改挂到「${sp.mainStore.name}」（只改门店外键），合并后主门店共 ${sp.mainTotalAfter} 人。\n` +
          (sp.aliasesToCreate.length ? `将建立别名：${sp.aliasesToCreate.join("、")}\n` : "") +
          `员工数据不会删除；被合并的门店名会保留为别名；门店记录本身停用不删除。` +
          `\n\n本组为一个事务：中途失败会整体回滚，不会留下改了一半的数据。`
      )
    ) {
      setBusyIdx(null);
      return;
    }

    try {
      const r = await fetch("/api/stores/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mainStoreId: main,
          mergeStoreIds: ids,
          snapshot: serverPreview.snapshot,
        }),
      });
      const j = await r.json();
      if (r.status === 400 && j.code === "MERGE_PREVIEW_REQUIRED") {
        // 缺 snapshot（预览→确认→执行 强制）：提示重新预览
        setBusyIdx(null);
        setMsg({
          tone: "stale",
          text: "缺少预览快照，本次未执行。请刷新本页面重新预览后再合并。",
        });
        router.refresh();
        return;
      }
      if (r.status === 409) {
        // 预览后数据库已变化 / 门店状态已变 / 不属于同一候选簇 → 提示重新预览，绝不静默执行
        setBusyIdx(null);
        setMsg({
          tone: "stale",
          text:
            j.code === "STALE_MERGE_PREVIEW"
              ? "预览已过期：数据库在预览后发生了变化，本次未执行。请刷新本页面重新预览后再合并。"
              : j.code === "INVALID_MERGE_CLUSTER"
                ? "所选门店不属于同一个当前候选合并簇，本次未执行。请刷新本页面重新预览。"
                : "门店状态已变化（已有门店被停用或不存在），本次未执行。请刷新本页面重新预览。",
        });
        router.refresh();
        return;
      }
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
      {msg && <Alert tone={msg.tone === "ok" ? "success" : msg.tone === "stale" ? "warn" : "error"}>{msg.text}</Alert>}

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
