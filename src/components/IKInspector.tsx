"use client";

import { PoseGraph } from "@/lib/ik/graph";
import { PoseLayout } from "@/lib/ik/pose";

function fmt(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(1) : "n/a";
}

export function IKInspector({
  graph,
  layout,
  selectedNodeId,
  pinnedNodeIds,
  invalidNodeIds,
  onTogglePin,
  onUpdatePin,
  onUpdateLimit,
}: {
  graph: PoseGraph;
  layout: PoseLayout;
  selectedNodeId: string | null;
  pinnedNodeIds: Set<string>;
  invalidNodeIds: Set<string>;
  onTogglePin: (nodeId: string) => void;
  onUpdatePin: (nodeId: string) => void;
  onUpdateLimit?: (nodeId: string, limit: [number, number] | undefined) => void;
}) {
  const node = selectedNodeId ? graph.nodeMap.get(selectedNodeId) : undefined;
  const world = node ? layout.positions[node.id] : undefined;
  const hasPin = node ? pinnedNodeIds.has(node.id) : false;
  const invalid = node ? invalidNodeIds.has(node.id) : false;

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white/90 p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
            Inspector
          </div>
          <div className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {node?.id || "Select a node"}
          </div>
        </div>
        {node && (
          <div className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
            invalid
              ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          }`}>
            {invalid ? "limited" : "stable"}
          </div>
        )}
      </div>

      {node ? (
        <div className="space-y-3 text-xs text-neutral-600 dark:text-neutral-300">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
              <div className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Kind</div>
              <div className="mt-1 font-medium text-neutral-900 dark:text-neutral-100">{node.kind || "other"}</div>
            </div>
            <div className="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
              <div className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Role</div>
              <div className="mt-1 font-medium text-neutral-900 dark:text-neutral-100">{node.ikRole || "joint"}</div>
            </div>
            <div className="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
              <div className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">World</div>
              <div className="mt-1 font-medium text-neutral-900 dark:text-neutral-100">
                {fmt(world?.x)}, {fmt(world?.y)}
              </div>
            </div>
            <div className="rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
              <div className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Length</div>
              <div className="mt-1 font-medium text-neutral-900 dark:text-neutral-100">{fmt(node.restLength)}</div>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-900/70">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Angle Limit</span>
              {onUpdateLimit && (
                <button
                  type="button"
                  onClick={() => onUpdateLimit(node.id, undefined)}
                  className="text-[9px] uppercase tracking-wider text-cyan-600 hover:text-cyan-700 dark:text-cyan-500 dark:hover:text-cyan-400"
                >
                  Clear
                </button>
              )}
            </div>
            {onUpdateLimit ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] font-semibold text-neutral-500">Min (°)</label>
                  <input
                    type="number"
                    className="w-full rounded bg-white px-2 py-1.5 text-xs text-neutral-900 border border-neutral-200 mt-0.5 focus:border-cyan-500 focus:outline-none dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
                    value={node.rotationLimit?.[0] ?? -180}
                    onChange={(e) => onUpdateLimit(node.id, [Number(e.target.value), node.rotationLimit?.[1] ?? 180])}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-semibold text-neutral-500">Max (°)</label>
                  <input
                    type="number"
                    className="w-full rounded bg-white px-2 py-1.5 text-xs text-neutral-900 border border-neutral-200 mt-0.5 focus:border-cyan-500 focus:outline-none dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
                    value={node.rotationLimit?.[1] ?? 180}
                    onChange={(e) => onUpdateLimit(node.id, [node.rotationLimit?.[0] ?? -180, Number(e.target.value)])}
                  />
                </div>
              </div>
            ) : (
              <div className="font-medium text-neutral-900 dark:text-neutral-100">
                {node.rotationLimit ? `${fmt(node.rotationLimit[0])}° to ${fmt(node.rotationLimit[1])}°` : "None"}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onTogglePin(node.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                hasPin
                  ? "bg-cyan-600 text-white hover:bg-cyan-500"
                  : "border border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
              }`}
            >
              {hasPin ? "Unpin Node" : "Pin Node"}
            </button>
            <button
              type="button"
              onClick={() => onUpdatePin(node.id)}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              Pin to Current Pose
            </button>
          </div>

          <div className="rounded-xl bg-neutral-100 px-3 py-3 dark:bg-neutral-900">
            <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-neutral-500">Bindings</div>
            <div className="space-y-1 font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
              {Object.entries(node.bindings).map(([viewId, binding]) => (
                <div key={viewId}>
                  {viewId}: {binding.boneId}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-neutral-100 px-3 py-5 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          Select an effector, root, or joint handle to inspect its constraints and bindings.
        </div>
      )}
    </div>
  );
}
