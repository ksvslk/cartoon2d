"use client";

import { DraftsmanData } from "@/lib/schema/rig";
import { useEffect, useRef, useState } from "react";
import { applyDeterministicRigAssembly } from "@/lib/svg/assembly";

export function RigViewer({
    data,
    editable = false,
    onChange,
}: {
    data: DraftsmanData;
    editable?: boolean;
    onChange?: (next: DraftsmanData) => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [hoveredBone, setHoveredBone] = useState<string | null>(null);
    const dragBoneRef = useRef<string | null>(null);

    useEffect(() => {
        if (!containerRef.current || !data?.rig_data?.bones || editable) return;

        const svgElement = containerRef.current.querySelector('svg');
        if (!svgElement) return;

        applyDeterministicRigAssembly(svgElement, data);
    }, [data, editable]);

    useEffect(() => {
        if (!editable || !onChange) return;

        const handlePointerMove = (event: PointerEvent) => {
            const boneId = dragBoneRef.current;
            if (!boneId || !containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const nextX = Math.max(0, Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000));
            const nextY = Math.max(0, Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000));

            onChange({
                ...data,
                rig_data: {
                    ...data.rig_data,
                    bones: data.rig_data.bones.map((bone) =>
                        bone.id === boneId
                            ? { ...bone, pivot: { x: nextX, y: nextY } }
                            : bone
                    ),
                },
            });
        };

        const handlePointerUp = () => {
            dragBoneRef.current = null;
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
        };
    }, [data, editable, onChange]);

    return (
        <div className="relative w-full aspect-square bg-neutral-100 dark:bg-neutral-900 flex items-center justify-center overflow-hidden">

            {/* 
        The SVG Container: We force it to 100% width/height so the viewBox scales correctly within the aspect-square div.
      */}
            <div
                ref={containerRef}
                className="w-full h-full absolute inset-0 [&>svg]:w-[100%] [&>svg]:h-[100%] [&>svg]:max-w-none [&>svg]:max-h-none transform origin-center scale-[1]"
                dangerouslySetInnerHTML={{ __html: data.svg_data }}
            />

            {/* 
        The Pivot Point Overlay: 
        Since the SVG viewBox is always 0 0 1000 1000, we map the (x,y) coordinates
        from the rig JSON directly to absolute percentage positions overlays.
      */}
            <div className="absolute inset-0 pointer-events-none scale-[1] origin-center w-[100%] h-[100%]">
                {data.rig_data.bones.map((bone, i) => {
                    if (!bone.pivot) return null;

                    // Map the 0-1000 coordinate to 0%-100% css positioning
                    const leftPct = (bone.pivot.x / 1000) * 100;
                    const topPct = (bone.pivot.y / 1000) * 100;

                    const isHovered = hoveredBone === bone.id;

                    return (
                        <div
                            key={bone.id || i}
                            className="absolute pointer-events-auto group cursor-crosshair flex items-center justify-center"
                            style={{
                                left: `${leftPct}%`,
                                top: `${topPct}%`,
                                transform: 'translate(-50%, -50%)',
                                width: '16px',
                                height: '16px'
                            }}
                            onMouseEnter={() => setHoveredBone(bone.id)}
                            onMouseLeave={() => setHoveredBone(null)}
                            onPointerDown={(event) => {
                                if (!editable) return;
                                event.preventDefault();
                                event.stopPropagation();
                                dragBoneRef.current = bone.id;
                            }}
                        >
                            {/* The pivot dot */}
                            <div className={`w-3 h-3 rounded-full border-2 transition-all duration-200 shadow-sm ${editable ? 'ring-2 ring-cyan-400/30' : ''} ${isHovered ? 'bg-cyan-400 border-white scale-150 z-20' : 'bg-red-500 border-white/80'}`} />

                            {/* Tooltip */}
                            <div className={`absolute top-full mt-2 whitespace-nowrap px-2 py-1 bg-neutral-900 border border-neutral-700 rounded shadow-lg text-[10px] font-mono text-cyan-300 font-bold transition-opacity duration-200 z-30 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                                #{bone.id}
                                <br />
                                <span className="text-neutral-400 font-normal">[{Math.round(bone.pivot.x)}, {Math.round(bone.pivot.y)}]</span>
                                {editable && (
                                    <>
                                        <br />
                                        <span className="text-amber-300 font-normal">drag to fix pivot</span>
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

        </div>
    );
}
