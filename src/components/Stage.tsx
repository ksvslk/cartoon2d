"use client";

import { useEffect, useRef, useCallback } from "react";
import gsap from "gsap";
import { CompiledSceneData, StoryBeatData, StageOrientation, getStageDims } from "@/lib/schema/story";
import { DraftsmanData } from "@/lib/schema/rig";
import DOMPurify from 'dompurify';
import { animateAmbient, buildTimeline } from "@/lib/motion/core";
import { applyDeterministicRigAssembly } from "@/lib/svg/assembly";
import { showRigView } from "@/lib/ik/svgPose";

interface StageProps {
    beat: StoryBeatData | null;
    compiledScene?: CompiledSceneData | null;
    availableRigs: Record<string, DraftsmanData>;
    frameRate?: number;
    stageDomId?: string;
    disableAmbient?: boolean;
    showObstacleDebug?: boolean;
    isPlaying?: boolean;
    /** Current playhead position in seconds. Drives timeline seek when not playing. */
    playheadTime?: number;
    loopOnComplete?: boolean;
    /** Called when a new GSAP timeline is compiled for the selected beat. */
    onTimelineReady?: (durationSeconds: number) => void;
    /** Called on every GSAP frame tick during playback with the current timeline time. */
    onPlayheadUpdate?: (timeSeconds: number) => void;
    /** Called when the timeline reaches its end. */
    onPlayComplete?: () => void;
    selectedActorId?: string | null;
    onActorSelect?: (actorId: string | null) => void;
    onActorPositionChange?: (actorId: string, x: number, y: number) => void;
    stageOrientation?: StageOrientation;
}

interface DragState {
    actorId: string;
    naturalCX: number;
    naturalBottom: number;
    offsetX: number;
    offsetY: number;
}

type TimelineWithIKSync = gsap.core.Timeline & {
    __ikSync?: () => void;
};

export default function Stage({
    beat,
    compiledScene = null,
    availableRigs,
    frameRate = 60,
    stageDomId,
    disableAmbient = false,
    showObstacleDebug = false,
    isPlaying = false,
    playheadTime = 0,
    loopOnComplete = false,
    onTimelineReady,
    onPlayheadUpdate,
    onPlayComplete,
    selectedActorId,
    onActorSelect,
    onActorPositionChange,
    stageOrientation = "landscape",
}: StageProps) {
    const { width: stageW, height: stageH } = getStageDims(stageOrientation);
    const stageFrameClass = `shadow-2xl bg-black rounded-lg overflow-hidden border border-neutral-800 ${
        stageOrientation === "portrait"
            ? "h-full aspect-[9/16]"
            : "w-full aspect-video"
    }`;
    const containerRef = useRef<HTMLDivElement>(null);

    // Refs so animation effects always see the latest values without re-running on them.
    const beatRef = useRef(beat);
    const compiledSceneRef = useRef(compiledScene);
    const rigsRef = useRef(availableRigs);
    useEffect(() => { beatRef.current = beat; }, [beat]);
    useEffect(() => { compiledSceneRef.current = compiledScene; }, [compiledScene]);
    useEffect(() => { rigsRef.current = availableRigs; }, [availableRigs]);

    // Callback refs to avoid stale closures inside GSAP callbacks
    const onPlayheadUpdateRef = useRef(onPlayheadUpdate);
    const onPlayCompleteRef   = useRef(onPlayComplete);
    const onTimelineReadyRef  = useRef(onTimelineReady);
    const loopOnCompleteRef   = useRef(loopOnComplete);
    useEffect(() => { onPlayheadUpdateRef.current = onPlayheadUpdate; }, [onPlayheadUpdate]);
    useEffect(() => { onPlayCompleteRef.current   = onPlayComplete;   }, [onPlayComplete]);
    useEffect(() => { onTimelineReadyRef.current  = onTimelineReady;  }, [onTimelineReady]);
    useEffect(() => { loopOnCompleteRef.current   = loopOnComplete;   }, [loopOnComplete]);

    // Tracks whether we are currently playing (for seek guard)
    const isPlayingRef = useRef(isPlaying);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

    useEffect(() => {
        gsap.ticker.fps(frameRate);
    }, [frameRate]);

    // Ambient GSAP context (always-on loops)
    const ambientCtxRef = useRef<gsap.Context | null>(null);
    // Scrubable timeline returned by buildTimeline()
    const gsapTimelineRef = useRef<gsap.core.Timeline | null>(null);

    // Drag state ref — avoids re-renders during drag
    const dragRef = useRef<DragState | null>(null);
    const isDraggingRef = useRef(false);

    const syncTimelineIK = useCallback((timeline: gsap.core.Timeline | null) => {
        (timeline as TimelineWithIKSync | null)?.__ikSync?.();
    }, []);

    // ── SVG coordinate conversion ──────────────────────────────────────────────
    const toSvgCoords = useCallback((clientX: number, clientY: number) => {
        if (!containerRef.current) return { x: stageW / 2, y: stageH / 2 };
        const rect = containerRef.current.getBoundingClientRect();
        return {
            x: ((clientX - rect.left) / rect.width) * stageW,
            y: ((clientY - rect.top) / rect.height) * stageH,
        };
    }, [stageW, stageH]);

    // ── Selection overlay update ───────────────────────────────────────────────
    const updateSelectionOverlay = useCallback((actorId: string | null | undefined) => {
        if (!containerRef.current) return;
        const domSvg = containerRef.current.querySelector("svg");
        const selRect = domSvg?.querySelector<SVGRectElement>("#__sel_rect");
        if (!selRect) return;

        if (!actorId) {
            selRect.setAttribute("display", "none");
            return;
        }

        const group = domSvg?.querySelector<SVGGElement>(`#actor_group_${actorId}`);
        if (!group) {
            selRect.setAttribute("display", "none");
            return;
        }

        try {
            const bbox = group.getBBox();
            const ctm = group.getCTM();
            const svgEl = domSvg as SVGSVGElement;
            const svgCTM = svgEl.getCTM();

            // Transform bbox corners to SVG root coordinates
            let minX = bbox.x, minY = bbox.y;
            let maxX = bbox.x + bbox.width, maxY = bbox.y + bbox.height;

            if (ctm && svgCTM) {
                const inv = svgCTM.inverse();
                const toRoot = inv.multiply(ctm);
                // Transform all 4 corners and take min/max
                const corners = [
                    { x: bbox.x, y: bbox.y },
                    { x: bbox.x + bbox.width, y: bbox.y },
                    { x: bbox.x, y: bbox.y + bbox.height },
                    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
                ];
                const transformed = corners.map(c => {
                    const pt = svgEl.createSVGPoint();
                    pt.x = c.x; pt.y = c.y;
                    return pt.matrixTransform(toRoot);
                });
                minX = Math.min(...transformed.map(p => p.x));
                minY = Math.min(...transformed.map(p => p.y));
                maxX = Math.max(...transformed.map(p => p.x));
                maxY = Math.max(...transformed.map(p => p.y));
            }

            const pad = 8;
            selRect.setAttribute("x", String(minX - pad));
            selRect.setAttribute("y", String(minY - pad));
            selRect.setAttribute("width", String(maxX - minX + pad * 2));
            selRect.setAttribute("height", String(maxY - minY + pad * 2));
            selRect.setAttribute("display", "");
        } catch {
            selRect.setAttribute("display", "none");
        }
    }, []);

    // ── Effect 1: SVG Assembly + Ambient + Build Timeline ────────────────────
    // Rebuilds the scene and starts ambient animations whenever beat/rigs change.
    useEffect(() => {
        if (!containerRef.current || !beat) return;

        // Kill any running animations from the previous scene
        if (gsapTimelineRef.current) { gsapTimelineRef.current.kill(); gsapTimelineRef.current = null; }
        if (ambientCtxRef.current)   { ambientCtxRef.current.revert(); ambientCtxRef.current  = null; }

        const parser = new DOMParser();
        let masterSvgElement: SVGSVGElement;

        if (beat.drafted_background) {
            const bgDoc = parser.parseFromString(beat.drafted_background.svg_data, "image/svg+xml");
            masterSvgElement = bgDoc.querySelector("svg") as SVGSVGElement;
        } else {
            const gridRows = Math.ceil(stageH / 108) + 1;
            const gridCols = Math.ceil(stageW / 96) + 1;
            const fallbackStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${stageW} ${stageH}" class="w-full h-full">
              <rect width="${stageW}" height="${stageH}" fill="#111"/>
              <g id="bg_sky"/>
              <g id="bg_midground">
                ${Array.from({length:gridRows}).map((_,i)=>`<line x1="0" y1="${i*108}" x2="${stageW}" y2="${i*108}" stroke="#222" stroke-width="2"/>`).join('')}
                ${Array.from({length:gridCols}).map((_,i)=>`<line x1="${i*96}" y1="0" x2="${i*96}" y2="${stageH}" stroke="#222" stroke-width="2"/>`).join('')}
              </g>
              <g id="bg_foreground"/>
            </svg>`;
            const fallbackDoc = parser.parseFromString(fallbackStr, "image/svg+xml");
            masterSvgElement = fallbackDoc.querySelector("svg") as SVGSVGElement;
        }

        // Actor layer appended LAST — characters always render above all background layers.
        const actorLayer = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        actorLayer.setAttribute("id", "stage_actors");
        masterSvgElement.appendChild(actorLayer);

        // Sort ascending by z_index: lower = further back within the actor layer.
        const actorsInScene = (compiledScene?.instance_tracks.length
            ? compiledScene.instance_tracks.map(track => {
                const firstTransform = track.transform_track[0];
                return { actorId: track.actor_id, zIndex: firstTransform?.z_index ?? 10 };
            })
            : Array.from(new Set(beat.actions.map(a => a.actor_id))).map(actorId => {
                const actionData = beat.actions.find(a => a.actor_id === actorId);
                return { actorId, zIndex: actionData?.spatial_transform?.z_index ?? 10 };
            })
        ).sort((a, b) => a.zIndex - b.zIndex);

        const targetTransforms: Record<string, { x: number; y: number; scale: number }> = {};
        let actorIdx = 0;

        actorsInScene.forEach(({ actorId }) => {
            const rig = availableRigs[actorId];
            if (!rig) return;

            const rigDoc = parser.parseFromString(rig.svg_data, "image/svg+xml");
            const rigSvg = rigDoc.querySelector("svg");
            if (!rigSvg) return;

            const actorGroup = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
            actorGroup.setAttribute("id", `actor_group_${actorId}`);

            const track = compiledScene?.instance_tracks.find(instanceTrack => instanceTrack.actor_id === actorId);
            const initialTransform = track?.transform_track[0];
            const actionData = beat.actions.find(a => a.actor_id === actorId);
            const tX     = initialTransform?.x ?? actionData?.spatial_transform?.x     ?? (480 + actorIdx * 320);
            const tY     = initialTransform?.y ?? actionData?.spatial_transform?.y     ?? 950;
            const tScale = initialTransform?.scale ?? actionData?.spatial_transform?.scale ?? 0.5;

            targetTransforms[actorId] = { x: tX, y: tY, scale: tScale };

            while (rigSvg.firstChild) {
                actorGroup.appendChild(rigSvg.firstChild);
            }

            const initialView =
                track?.clip_bindings[0]?.view ||
                rig.rig_data.ik?.defaultView ||
                Object.keys(rig.rig_data.ik?.views || {}).sort()[0];
            if (initialView) {
                showRigView(actorGroup, initialView);
            }

            actorLayer.appendChild(actorGroup);
            actorIdx++;
        });

        // Inject cursor style for actor groups
        const styleEl = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "style");
        styleEl.textContent = `#stage_actors > g { cursor: grab; } #stage_actors > g:active { cursor: grabbing; }`;
        masterSvgElement.insertBefore(styleEl, masterSvgElement.firstChild);

        // Selection overlay group — appended LAST so it renders on top of everything
        const overlayGroup = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        overlayGroup.setAttribute("id", "__selection_overlay");
        const selRect = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
        selRect.setAttribute("id", "__sel_rect");
        selRect.setAttribute("fill", "none");
        selRect.setAttribute("stroke", "cyan");
        selRect.setAttribute("stroke-width", "3");
        selRect.setAttribute("stroke-dasharray", "8 4");
        selRect.setAttribute("pointer-events", "none");
        selRect.setAttribute("display", "none");
        selRect.setAttribute("rx", "4");
        overlayGroup.appendChild(selRect);
        masterSvgElement.appendChild(overlayGroup);

        if (showObstacleDebug && compiledScene?.obstacles?.length) {
            const obstacleGroup = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
            obstacleGroup.setAttribute("id", "__obstacle_overlay");
            obstacleGroup.setAttribute("pointer-events", "none");

            compiledScene.obstacles.forEach((obstacle) => {
                const rect = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
                rect.setAttribute("x", String(obstacle.x));
                rect.setAttribute("y", String(obstacle.y));
                rect.setAttribute("width", String(obstacle.width));
                rect.setAttribute("height", String(obstacle.height));
                rect.setAttribute("fill", "rgba(245, 158, 11, 0.14)");
                rect.setAttribute("stroke", "#f59e0b");
                rect.setAttribute("stroke-width", "3");
                rect.setAttribute("stroke-dasharray", "12 6");
                obstacleGroup.appendChild(rect);

                const label = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
                label.setAttribute("x", String(obstacle.x + 10));
                label.setAttribute("y", String(obstacle.y + 24));
                label.setAttribute("fill", "#fbbf24");
                label.setAttribute("font-size", "20");
                label.setAttribute("font-family", "monospace");
                label.textContent = obstacle.id;
                obstacleGroup.appendChild(label);
            });

            masterSvgElement.appendChild(obstacleGroup);
        }

        masterSvgElement.setAttribute("class", "w-full h-full max-w-none max-h-none");

        const cleanSvg = DOMPurify.sanitize(masterSvgElement.outerHTML, { USE_PROFILES: { svg: true } });
        containerRef.current.innerHTML = cleanSvg;

        // getBBox-based positioning: find each actor's natural bounds, then translate
        // so their bottom-center lands exactly at the target (x, y).
        const domSvg = containerRef.current.querySelector("svg");

        actorsInScene.forEach(({ actorId }) => {
            const rig = availableRigs[actorId];
            const actorGroup = domSvg?.querySelector<SVGGElement>(`#actor_group_${actorId}`);
            if (!rig || !actorGroup) return;
            applyDeterministicRigAssembly(actorGroup, rig);
        });

        const posCtx = gsap.context(() => {
            Object.entries(targetTransforms).forEach(([id, t]) => {
                const group = domSvg?.querySelector(`#actor_group_${id}`) as SVGGElement | null;
                if (!group) return;

                let naturalCX = stageW / 2;
                let naturalBottom = stageH * 0.97;

                try {
                    const bbox = group.getBBox();
                    if (bbox.width > 0 || bbox.height > 0) {
                        naturalCX = bbox.x + bbox.width / 2;
                        naturalBottom = bbox.y + bbox.height;
                    }
                } catch { /* getBBox failed — use fallbacks */ }

                group.dataset.naturalCx     = naturalCX.toString();
                group.dataset.naturalBottom = naturalBottom.toString();

                gsap.set(group, {
                    x: t.x - naturalCX,
                    y: t.y - naturalBottom,
                    scaleX: t.scale,
                    scaleY: t.scale,
                    svgOrigin: `${naturalCX} ${naturalBottom}`,
                });
            });
        }, containerRef);

        // Start ambient animations immediately after positioning
        if (!disableAmbient) {
            ambientCtxRef.current = animateAmbient({
                container: containerRef.current,
                beat,
                compiledScene,
                availableRigs,
            });
        }

        // Build the scrubable timeline (paused — play/seek is controlled by Effects 2 & 3)
        const tl = buildTimeline({
            container: containerRef.current,
            beat,
            compiledScene,
            availableRigs,
        }) as TimelineWithIKSync;
        tl.eventCallback("onUpdate",   () => {
            syncTimelineIK(tl);
            onPlayheadUpdateRef.current?.(tl.time());
        });
        tl.eventCallback("onComplete", () => {
          console.log("[stage] Timeline complete");
          if (loopOnCompleteRef.current) {
            tl.pause(0);
            syncTimelineIK(tl);
            onPlayheadUpdateRef.current?.(0);
            requestAnimationFrame(() => tl.play(0));
            return;
          }
          onPlayCompleteRef.current?.();
        });
        gsapTimelineRef.current = tl;
        onTimelineReadyRef.current?.(tl.duration());

        if (isPlayingRef.current) {
            if (ambientCtxRef.current) {
                ambientCtxRef.current.revert();
                ambientCtxRef.current = null;
            }
            tl.play(playheadTime);
            syncTimelineIK(tl);
        } else {
            tl.pause(playheadTime);
            syncTimelineIK(tl);
        }

        // Update selection overlay after assembly
        updateSelectionOverlay(selectedActorId);

        return () => {
            posCtx.revert();
            if (ambientCtxRef.current)   { ambientCtxRef.current.revert(); ambientCtxRef.current  = null; }
            if (gsapTimelineRef.current) { gsapTimelineRef.current.kill(); gsapTimelineRef.current = null; }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [beat, compiledScene, availableRigs, showObstacleDebug, stageOrientation]);

    // ── Effect 2: Play / Pause ────────────────────────────────────────────────
    useEffect(() => {
        const tl = gsapTimelineRef.current;
        if (!tl) return;

        if (isPlaying) {
            // Kill ambient loops — they conflict with timeline bone tweens
            if (ambientCtxRef.current) { ambientCtxRef.current.revert(); ambientCtxRef.current = null; }
            console.log(`[stage] Play — timeline duration: ${tl.duration().toFixed(2)}s`);
            tl.play();
        } else {
            console.log("[stage] Pause");
            tl.pause();
            // Restart ambient when playback stops
            if (!disableAmbient && !ambientCtxRef.current && containerRef.current && beatRef.current) {
                ambientCtxRef.current = animateAmbient({
                    container: containerRef.current,
                    beat: beatRef.current,
                    compiledScene: compiledSceneRef.current,
                    availableRigs: rigsRef.current,
                });
            }
        }
    }, [disableAmbient, isPlaying]);

    // ── Effect 3: Seek timeline when playhead is dragged (not playing) ────────
    useEffect(() => {
        if (isPlayingRef.current) return;  // GSAP drives the playhead while playing
        const tl = gsapTimelineRef.current;
        if (!tl) return;
        tl.seek(playheadTime, true);  // suppress callbacks to avoid feedback loop
        syncTimelineIK(tl);
    }, [playheadTime, syncTimelineIK]);

    // ── Effect 4: Selection overlay sync ─────────────────────────────────────
    useEffect(() => {
        updateSelectionOverlay(selectedActorId);
    }, [selectedActorId, updateSelectionOverlay]);

    // ── Mouse event handlers ──────────────────────────────────────────────────
    const findActorGroup = (target: EventTarget | null): SVGGElement | null => {
        let el = target as Element | null;
        while (el && el !== containerRef.current) {
            if (el.id && el.id.startsWith("actor_group_")) {
                return el as SVGGElement;
            }
            el = el.parentElement;
        }
        return null;
    };

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const actorGroup = findActorGroup(e.target);

        if (!actorGroup) {
            // Click on empty area — deselect
            onActorSelect?.(null);
            return;
        }

        const actorId = actorGroup.id.replace("actor_group_", "");
        onActorSelect?.(actorId);

        // Set up drag
        const naturalCX = parseFloat(actorGroup.dataset.naturalCx || "960");
        const naturalBottom = parseFloat(actorGroup.dataset.naturalBottom || "1050");

        const svgCoords = toSvgCoords(e.clientX, e.clientY);

        // Current feet position = naturalCX + gsap x offset, naturalBottom + gsap y offset
        const currentX = gsap.getProperty(actorGroup, "x") as number;
        const currentY = gsap.getProperty(actorGroup, "y") as number;
        const feetX = naturalCX + currentX;
        const feetY = naturalBottom + currentY;

        dragRef.current = {
            actorId,
            naturalCX,
            naturalBottom,
            offsetX: svgCoords.x - feetX,
            offsetY: svgCoords.y - feetY,
        };
        isDraggingRef.current = false;

        e.preventDefault();
    }, [onActorSelect, toSvgCoords]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;

        isDraggingRef.current = true;
        const { actorId, naturalCX, naturalBottom, offsetX, offsetY } = dragRef.current;
        const svgCoords = toSvgCoords(e.clientX, e.clientY);

        const newFeetX = svgCoords.x - offsetX;
        const newFeetY = svgCoords.y - offsetY;

        const domSvg = containerRef.current?.querySelector("svg");
        const group = domSvg?.querySelector<SVGGElement>(`#actor_group_${actorId}`);
        if (!group) return;

        gsap.set(group, {
            x: newFeetX - naturalCX,
            y: newFeetY - naturalBottom,
        });

        // Update selection overlay to follow
        updateSelectionOverlay(actorId);
    }, [toSvgCoords, updateSelectionOverlay]);

    const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;

        if (isDraggingRef.current) {
            const { actorId, offsetX, offsetY } = dragRef.current;
            const svgCoords = toSvgCoords(e.clientX, e.clientY);
            const newFeetX = svgCoords.x - offsetX;
            const newFeetY = svgCoords.y - offsetY;
            onActorPositionChange?.(actorId, newFeetX, newFeetY);
        }

        dragRef.current = null;
        isDraggingRef.current = false;
    }, [toSvgCoords, onActorPositionChange]);

    const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!dragRef.current || !isDraggingRef.current) {
            dragRef.current = null;
            return;
        }
        // Commit position on leave too
        const { actorId, offsetX, offsetY } = dragRef.current;
        const svgCoords = toSvgCoords(e.clientX, e.clientY);
        const newFeetX = svgCoords.x - offsetX;
        const newFeetY = svgCoords.y - offsetY;
        onActorPositionChange?.(actorId, newFeetX, newFeetY);
        dragRef.current = null;
        isDraggingRef.current = false;
    }, [toSvgCoords, onActorPositionChange]);

    if (!beat) {
        return (
            <div className="w-full h-full grid place-items-center p-4">
                <div className={`${stageFrameClass} grid place-items-center px-6 text-center`}>
                    <div className="space-y-2">
                        <div className="text-neutral-500 text-xs font-mono uppercase tracking-widest">
                            {stageOrientation === "portrait" ? "Portrait Stage" : "Landscape Stage"}
                        </div>
                        <div className="text-neutral-600 text-[11px]">
                            Select a scene or generate a new one.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full grid place-items-center p-4">
            <div
                ref={containerRef}
                id={stageDomId}
                className={stageFrameClass}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            />
        </div>
    );
}
