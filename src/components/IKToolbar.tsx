"use client";

export function IKToolbar({
  activeView,
  availableViews,
  ragdollEnabled,
  onViewChange,
  onResetPose,
  onToggleRagdoll,
}: {
  activeView?: string;
  availableViews: string[];
  ragdollEnabled: boolean;
  onViewChange: (viewId: string) => void;
  onResetPose: () => void;
  onToggleRagdoll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200/80 bg-white/90 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950/80">
      <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
        View
      </label>
      <select
        value={activeView}
        onChange={(event) => onViewChange(event.target.value)}
        className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-700 outline-none focus:border-cyan-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      >
        {availableViews.map((viewId) => (
          <option key={viewId} value={viewId}>
            {viewId.replace("view_", "").replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onResetPose}
        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
      >
        Reset Pose
      </button>
      <button
        type="button"
        onClick={onToggleRagdoll}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
          ragdollEnabled
            ? "bg-amber-500 text-black hover:bg-amber-400"
            : "border border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
        }`}
      >
        {ragdollEnabled ? "Stop Ragdoll" : "Ragdoll"}
      </button>
    </div>
  );
}
