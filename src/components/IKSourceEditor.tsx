"use client";

import { useState, useEffect } from "react";

export function IKSourceEditor({
  svgData,
  onChange,
}: {
  svgData: string;
  onChange: (nextSvg: string) => void;
}) {
  const [localCode, setLocalCode] = useState(svgData);

  useEffect(() => {
    setLocalCode(svgData);
  }, [svgData]);

  const handleApply = () => {
    onChange(localCode);
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-neutral-200 bg-white/90 p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
            Raw SVG Source
          </div>
          <div className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Edit Artwork Safely
          </div>
        </div>
        <button
          type="button"
          onClick={handleApply}
          disabled={localCode === svgData}
          className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply Changes
        </button>
      </div>

      <div className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100 mb-3 shrink-0">
        Changes to raw SVG tags will update the canvas instantly without touching the physics rig or cached animation clips.
      </div>

      <div className="min-h-0 flex-1 relative overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
        <textarea
          value={localCode}
          onChange={(e) => setLocalCode(e.target.value)}
          className="absolute inset-0 h-full w-full resize-none bg-neutral-50 p-3 font-mono text-[10px] sm:text-xs leading-relaxed text-neutral-800 focus:outline-none dark:bg-neutral-900 dark:text-neutral-300"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
