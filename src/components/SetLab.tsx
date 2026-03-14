"use client";

import { DraftsmanData } from "@/lib/schema/rig";
import { RigViewer } from "./RigViewer";
import { IKSourceEditor } from "./IKSourceEditor";

export function SetLab({
  data,
  onChange,
}: {
  data: DraftsmanData;
  onChange: (nextData: DraftsmanData) => void;
}) {
  return (
    <div className="flex h-full w-full gap-4">
      {/* Viewer Panel */}
      <div className="flex-1 min-w-0 bg-neutral-100 dark:bg-neutral-900 rounded-xl overflow-hidden relative shadow-inner">
        <RigViewer data={data} />
      </div>

      {/* Editor Panel */}
      <div className="w-[400px] flex-shrink-0">
        <IKSourceEditor
          svgData={data.svg_data}
          onChange={(nextSvg) => {
            onChange({
              ...data,
              svg_data: nextSvg,
            });
          }}
        />
      </div>
    </div>
  );
}
