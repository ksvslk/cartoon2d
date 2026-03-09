"use client";

import { DraftsmanData } from "@/lib/schema/rig";
import { useEffect, useRef, useState } from "react";

export function RigViewer({ data }: { data: DraftsmanData }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [hoveredBone, setHoveredBone] = useState<string | null>(null);

    // Phase 2 of Deterministic Assembler: Auto-Snapping Laps Joints
    // This runs on the client *after* the SVG is painted, so we can use native DOM getBBox() math.
    useEffect(() => {
        if (!containerRef.current || !data?.rig_data?.bones) return;

        const svgElement = containerRef.current.querySelector('svg');
        if (!svgElement) return;

        // Create a fast lookup map for all bones by ID
        const boneMap = new Map(data.rig_data.bones.map(b => [b.id, b]));

        // Iterate through all bones to snap children to their parents
        data.rig_data.bones.forEach(bone => {
            // Only snap bones that have a structural parent defined by the AI
            if (!bone.parent) return;
            const parentBone = boneMap.get(bone.parent);
            if (!parentBone || !parentBone.pivot) return;

            // Find the actual SVG group for this child bone
            const gElement = svgElement.querySelector(`g[id="${bone.id}"]`) as SVGGElement | null;
            if (!gElement) return; // Might have been garbage collected in Phase 1

            // 1. Measure the native geometry of the child limb
            // getBBox returns the unsnapped/untransformed bounding box of the child's raw graphics
            try {
                const childBox = gElement.getBBox();

                // 2. Establish our Anchor Strategy:
                // For limbs, the ideal "socket hook" is usually the top-center of its bounding box.
                const childHookX = childBox.x + (childBox.width / 2);
                const childHookY = childBox.y; // Top edge

                // 3. Get the absolute target coordinate (the socket on the parent body)
                const targetSocketX = parentBone.pivot.x;
                const targetSocketY = parentBone.pivot.y;

                // 4. Calculate the Vector Math to slam the child hook onto the parent socket
                const dx = targetSocketX - childHookX;
                const dy = targetSocketY - childHookY;

                // 5. Apply the deterministic snap!
                // If it's already perfectly snapped (dx/dy = 0), this has no visual effect.
                // If the AI floated the arm 500px away, this instantly fixes it.
                // Note: We use setAttribute rather than style.transform to ensure it bakes into the SVG space natively
                gElement.setAttribute('transform', `translate(${dx}, ${dy})`);

                console.log(`[Assembler] Snapped #${bone.id} to #${bone.parent} socket. translated(${Math.round(dx)}, ${Math.round(dy)})`);

            } catch (err) {
                // getBBox can fail if the element is not currently rendered or has 0 dimensions
                console.warn(`[Assembler] Failed to calculate BBox for ${bone.id}`, err);
            }
        });
    }, [data.svg_data, data.rig_data]);

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
                        >
                            {/* The pivot dot */}
                            <div className={`w-3 h-3 rounded-full border-2 transition-all duration-200 shadow-sm ${isHovered ? 'bg-cyan-400 border-white scale-150 z-20' : 'bg-red-500 border-white/80'}`} />

                            {/* Tooltip */}
                            <div className={`absolute top-full mt-2 whitespace-nowrap px-2 py-1 bg-neutral-900 border border-neutral-700 rounded shadow-lg text-[10px] font-mono text-cyan-300 font-bold transition-opacity duration-200 z-30 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                                #{bone.id}
                                <br />
                                <span className="text-neutral-400 font-normal">[{Math.round(bone.pivot.x)}, {Math.round(bone.pivot.y)}]</span>
                            </div>
                        </div>
                    );
                })}
            </div>

        </div>
    );
}
