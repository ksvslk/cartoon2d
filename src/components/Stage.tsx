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
    onActorPositionChange?: (actorId: string, dx: number, dy: number) => void;
    onActorScaleChange?: (actorId: string, scaleRatio: number) => void;
    onActorRotationChange?: (actorId: string, rotation: number) => void;
    onActorFlip?: (actorId: string) => void;
    onCameraChange?: (camera: { zoom: number; x: number; y: number; rotation: number; isEndKeyframe?: boolean }) => void;
    stageOrientation?: StageOrientation;
}

interface DragState {
    actorId: string;
    mode: 'move' | 'scale' | 'rotate' | 'camera_pan' | 'camera_rotate';
    naturalCX: number;
    naturalBottom: number;
    offsetX: number;
    offsetY: number;
    initialDist: number;
    initialScale: number;
    initialFeetX: number;
    initialFeetY: number;
    lastFeetX: number;
    lastFeetY: number;
    lastDist: number;
}

type TimelineWithIKSync = gsap.core.Timeline & {
    __ikSync?: () => void;
};

function facingSignForDirection(direction?: string): number | undefined {
    if (!direction) return undefined;
    if (direction === "left" || direction === "backward") return -1;
    if (direction === "right" || direction === "forward") return 1;
    return undefined;
}

function initialFacingSignForTrack(track: CompiledSceneData["instance_tracks"][number] | undefined): number {
    if (!track) return 1;
    const sortedTransforms = [...track.transform_track].sort((left, right) => left.time - right.time);
    const firstTransform = sortedTransforms[0];
    if (firstTransform?.flip_x !== undefined) {
        return firstTransform.flip_x ? -1 : 1;
    }
    // Do NOT infer facing from deltaX movement — only use explicit flip_x or locomotion direction

    const preferredDirection = [...track.clip_bindings]
        .sort((left, right) => left.start_time - right.start_time)[0]
        ?.ik_playback?.motion_spec?.locomotion?.preferredDirection;

    return facingSignForDirection(preferredDirection) ?? 1;
}

function zIndexForTrackAtTime(
    track: CompiledSceneData["instance_tracks"][number] | undefined,
    timeSeconds: number,
): number {
    if (!track || track.transform_track.length === 0) return 10;
    const sortedTransforms = [...track.transform_track].sort((left, right) => left.time - right.time);
    if (timeSeconds <= sortedTransforms[0].time) {
        return sortedTransforms[0].z_index ?? 10;
    }
    let active = sortedTransforms[0];
    for (let index = 1; index < sortedTransforms.length; index += 1) {
        const next = sortedTransforms[index];
        if (timeSeconds < next.time) break;
        active = next;
    }
    return active.z_index ?? 10;
}

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
    onActorScaleChange,
    onActorRotationChange,
    onActorFlip,
    onCameraChange,
    stageOrientation = "landscape",
    selectedKeyframe = null,
}: StageProps & { selectedKeyframe?: 'start' | 'end' | null }) {
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
    const playheadTimeRef     = useRef(playheadTime);
    const selectedKeyframeRef = useRef(selectedKeyframe);
    const stagePropsOnCameraChange = useRef(onCameraChange);
    const wheelAccumulatorRef = useRef<{ zoom: number, timer: NodeJS.Timeout | null }>({ zoom: 1, timer: null });

    useEffect(() => { onPlayheadUpdateRef.current = onPlayheadUpdate; }, [onPlayheadUpdate]);
    useEffect(() => { onPlayCompleteRef.current   = onPlayComplete;   }, [onPlayComplete]);
    useEffect(() => { onTimelineReadyRef.current  = onTimelineReady;  }, [onTimelineReady]);
    useEffect(() => { loopOnCompleteRef.current   = loopOnComplete;   }, [loopOnComplete]);
    useEffect(() => { playheadTimeRef.current     = playheadTime;     }, [playheadTime]);
    useEffect(() => { selectedKeyframeRef.current = selectedKeyframe; }, [selectedKeyframe]);
    useEffect(() => { stagePropsOnCameraChange.current = onCameraChange; }, [onCameraChange]);
    useEffect(() => { onTimelineReadyRef.current  = onTimelineReady;  }, [onTimelineReady]);
    useEffect(() => { loopOnCompleteRef.current   = loopOnComplete;   }, [loopOnComplete]);
    useEffect(() => { playheadTimeRef.current     = playheadTime;     }, [playheadTime]);
    useEffect(() => { stagePropsOnCameraChange.current = onCameraChange; }, [onCameraChange]);

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
    const actorLayerOrderRef = useRef("");
    // Saved initial positioning so Effect 2 can re-apply after reverting
    const targetTransformsRef = useRef<Record<string, { x: number; y: number; scale: number; rotation?: number; facingSign: number }>>({});
    const stageWRef = useRef(1920);
    const stageHRef = useRef(1080);
    // Master GSAP context — wraps ALL gsap operations inside the container.
    // revert() on this nukes every inline style GSAP has ever set on any descendant.
    const masterCtxRef = useRef<gsap.Context | null>(null);

    // Drag state ref — avoids re-renders during drag
    const dragRef = useRef<DragState | null>(null);
    const isDraggingRef = useRef(false);
    const windowDragHandlersRef = useRef<{ move: (event: MouseEvent) => void; up: () => void } | null>(null);

    const syncTimelineIK = useCallback((timeline: gsap.core.Timeline | null) => {
        (timeline as TimelineWithIKSync | null)?.__ikSync?.();
    }, []);

    const detachWindowDragHandlers = useCallback(() => {
        if (!windowDragHandlersRef.current) return;
        window.removeEventListener("mousemove", windowDragHandlersRef.current.move);
        window.removeEventListener("mouseup", windowDragHandlersRef.current.up);
        windowDragHandlersRef.current = null;
    }, []);

    // ── SVG coordinate conversion ──────────────────────────────────────────────
    const toSvgCoords = useCallback((clientX: number, clientY: number) => {
        if (!containerRef.current) return { x: stageW / 2, y: stageH / 2 };
        const domSvg = containerRef.current.querySelector("svg");
        const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");

        if (domSvg && cameraGroup) {
            const pt = domSvg.createSVGPoint();
            pt.x = clientX;
            pt.y = clientY;
            const ctm = cameraGroup.getScreenCTM();
            if (ctm) {
                const transformed = pt.matrixTransform(ctm.inverse());
                return { x: transformed.x, y: transformed.y };
            }
        }

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

        const hideAll = () => {
            selRect.setAttribute("display", "none");
            ['tl', 'tr', 'bl', 'br'].forEach(pos => domSvg?.querySelector(`#__sel_handle_${pos}`)?.setAttribute('display', 'none'));
            domSvg?.querySelector('#__sel_rotate')?.setAttribute('display', 'none');
            domSvg?.querySelector('#__sel_rotate_line')?.setAttribute('display', 'none');
            domSvg?.querySelector('#__sel_rotate_icon')?.setAttribute('display', 'none');
            domSvg?.querySelector('#__sel_flip')?.setAttribute('display', 'none');
            domSvg?.querySelector('#__sel_flip_icon')?.setAttribute('display', 'none');
        };

        if (!actorId) { hideAll(); return; }

        const group = domSvg?.querySelector<SVGGElement>(`#actor_group_${actorId}`);
        if (!group) { hideAll(); return; }

        try {
            const bbox = group.getBBox();
            const ctm = group.getCTM();
            const svgEl = domSvg as SVGSVGElement;
            const svgCTM = svgEl.getCTM();

            // Since overlay is inside the camera layer (same coordinate space as actors),
            // we only need to account for the actor group's local transforms (GSAP-applied)
            let minX = bbox.x, minY = bbox.y;
            let maxX = bbox.x + bbox.width, maxY = bbox.y + bbox.height;

            if (ctm && svgCTM) {
                // Get local transform of the group relative to the camera layer (its parent)
                const camEl = group.closest('#__camera_layer') as SVGGraphicsElement | null;
                const parentCTM = camEl?.getCTM?.() || svgCTM;
                const inv = parentCTM.inverse();
                const toLocal = inv.multiply(ctm);
                const corners = [
                    { x: bbox.x, y: bbox.y },
                    { x: bbox.x + bbox.width, y: bbox.y },
                    { x: bbox.x, y: bbox.y + bbox.height },
                    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
                ];
                const transformed = corners.map(c => {
                    const pt = svgEl.createSVGPoint();
                    pt.x = c.x; pt.y = c.y;
                    return pt.matrixTransform(toLocal);
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

            // Scale corner handles
            const handles = ['tl', 'tr', 'bl', 'br'].map(pos => domSvg?.querySelector(`#__sel_handle_${pos}`));
            handles[0]?.setAttribute('cx', String(minX - pad));
            handles[0]?.setAttribute('cy', String(minY - pad));
            handles[1]?.setAttribute('cx', String(maxX + pad));
            handles[1]?.setAttribute('cy', String(minY - pad));
            handles[2]?.setAttribute('cx', String(minX - pad));
            handles[2]?.setAttribute('cy', String(maxY + pad));
            handles[3]?.setAttribute('cx', String(maxX + pad));
            handles[3]?.setAttribute('cy', String(maxY + pad));
            handles.forEach(h => h?.setAttribute('display', ''));

            // Rotate handle — 40px above top-center
            const centerX = (minX + maxX) / 2;
            const rotY = minY - pad - 40;
            const rotLine = domSvg?.querySelector('#__sel_rotate_line');
            const rotHandle = domSvg?.querySelector('#__sel_rotate');
            const rotIcon = domSvg?.querySelector('#__sel_rotate_icon');
            if (rotLine) {
                rotLine.setAttribute('x1', String(centerX));
                rotLine.setAttribute('y1', String(minY - pad));
                rotLine.setAttribute('x2', String(centerX));
                rotLine.setAttribute('y2', String(rotY));
                rotLine.setAttribute('display', '');
            }
            if (rotHandle) {
                rotHandle.setAttribute('cx', String(centerX));
                rotHandle.setAttribute('cy', String(rotY));
                rotHandle.setAttribute('display', '');
            }
            if (rotIcon) {
                rotIcon.setAttribute('x', String(centerX));
                rotIcon.setAttribute('y', String(rotY));
                rotIcon.setAttribute('display', '');
            }

            // Flip button — 40px below bottom-center
            const flipY = maxY + pad + 30;
            const flipBtn = domSvg?.querySelector('#__sel_flip');
            const flipIcon = domSvg?.querySelector('#__sel_flip_icon');
            if (flipBtn) {
                flipBtn.setAttribute('cx', String(centerX));
                flipBtn.setAttribute('cy', String(flipY));
                flipBtn.setAttribute('display', '');
            }
            if (flipIcon) {
                flipIcon.setAttribute('x', String(centerX));
                flipIcon.setAttribute('y', String(flipY));
                flipIcon.setAttribute('display', '');
            }

        } catch {
            hideAll();
        }
    }, []);

    const syncActorLayerOrder = useCallback((timeSeconds: number) => {
        const container = containerRef.current;
        if (!container) return;
        const domSvg = container.querySelector("svg");
        const actorLayer = domSvg?.querySelector<SVGGElement>("#stage_actors");
        if (!actorLayer) return;

        const scene = compiledSceneRef.current;
        const currentBeat = beatRef.current;
        if (!currentBeat) return;

        const actorEntries = scene?.instance_tracks.length
            ? scene.instance_tracks.map((track) => ({
                actorId: track.actor_id,
                zIndex: zIndexForTrackAtTime(track, timeSeconds),
            }))
            : Array.from(new Set(currentBeat.actions.map((action) => action.actor_id))).map((actorId) => {
                const actionData = currentBeat.actions.find((action) => action.actor_id === actorId);
                return { actorId, zIndex: actionData?.spatial_transform?.z_index ?? 10 };
            });

        const nextOrder = actorEntries
            .sort((left, right) => left.zIndex - right.zIndex)
            .map((entry) => entry.actorId);
        const nextOrderKey = nextOrder.join("|");
        if (nextOrderKey === actorLayerOrderRef.current) return;

        nextOrder.forEach((actorId) => {
            const group = actorLayer.querySelector<SVGGElement>(`#actor_group_${actorId}`);
            if (group) {
                actorLayer.appendChild(group);
            }
        });
        actorLayerOrderRef.current = nextOrderKey;
    }, []);

    // ── Effect 1: SVG Assembly + Ambient + Build Timeline ────────────────────
    // Rebuilds the scene and starts ambient animations whenever beat/rigs change.
    useEffect(() => {
        if (!containerRef.current || !beat) return;
        if (isDraggingRef.current) return; // Skip heavy DOM rebuilds during live dragging!

        // Kill any running animations from the previous scene
        if (gsapTimelineRef.current) { gsapTimelineRef.current.kill(); gsapTimelineRef.current = null; }
        if (ambientCtxRef.current)   { ambientCtxRef.current.revert(); ambientCtxRef.current  = null; }
        actorLayerOrderRef.current = "";

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

        const targetTransforms: Record<string, { x: number; y: number; scale: number; rotation?: number; facingSign: number }> = {};
        stageWRef.current = stageW;
        stageHRef.current = stageH;
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
            // User's explicit placement takes priority over compiled animation data
            const tX     = actionData?.spatial_transform?.x     ?? initialTransform?.x ?? (480 + actorIdx * 320);
            const tY     = actionData?.spatial_transform?.y     ?? initialTransform?.y ?? 950;
            const tScale = actionData?.spatial_transform?.scale ?? initialTransform?.scale ?? 0.5;

            // Resolve facing from user's explicit flip_x first, then compiled track
            const userFlipX = actionData?.spatial_transform?.flip_x;
            const facingSign = userFlipX !== undefined
                ? (userFlipX ? -1 : 1)
                : initialFacingSignForTrack(track);

            targetTransforms[actorId] = {
                x: tX,
                y: tY,
                scale: tScale,
                rotation: actionData?.spatial_transform?.rotation ?? initialTransform?.rotation,
                facingSign,
            };

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
            targetTransformsRef.current = targetTransforms;
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

        const handles = ['tl', 'tr', 'bl', 'br'];
        handles.forEach(pos => {
            const handle = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
            handle.setAttribute("id", `__sel_handle_${pos}`);
            handle.setAttribute("r", "8");
            handle.setAttribute("fill", "white");
            handle.setAttribute("stroke", "cyan");
            handle.setAttribute("stroke-width", "3");
            handle.setAttribute("cursor", pos === 'tl' || pos === 'br' ? 'nwse-resize' : 'nesw-resize');
            handle.setAttribute("display", "none");
            overlayGroup.appendChild(handle);
        });

        // Rotate handle — circle above top-center with connector line
        const rotLine = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "line");
        rotLine.setAttribute("id", "__sel_rotate_line");
        rotLine.setAttribute("stroke", "cyan");
        rotLine.setAttribute("stroke-width", "2");
        rotLine.setAttribute("pointer-events", "none");
        rotLine.setAttribute("display", "none");
        overlayGroup.appendChild(rotLine);

        const rotHandle = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
        rotHandle.setAttribute("id", "__sel_rotate");
        rotHandle.setAttribute("r", "10");
        rotHandle.setAttribute("fill", "white");
        rotHandle.setAttribute("stroke", "#f472b6");
        rotHandle.setAttribute("stroke-width", "3");
        rotHandle.setAttribute("cursor", "grab");
        rotHandle.setAttribute("display", "none");
        overlayGroup.appendChild(rotHandle);

        // Rotate icon inside the handle (↻ symbol)
        const rotIcon = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
        rotIcon.setAttribute("id", "__sel_rotate_icon");
        rotIcon.setAttribute("text-anchor", "middle");
        rotIcon.setAttribute("dominant-baseline", "central");
        rotIcon.setAttribute("fill", "#f472b6");
        rotIcon.setAttribute("font-size", "12");
        rotIcon.setAttribute("pointer-events", "none");
        rotIcon.setAttribute("display", "none");
        rotIcon.textContent = "↻";
        overlayGroup.appendChild(rotIcon);

        // Flip button — horizontal flip icon below bottom-center
        const flipBtn = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
        flipBtn.setAttribute("id", "__sel_flip");
        flipBtn.setAttribute("r", "10");
        flipBtn.setAttribute("fill", "white");
        flipBtn.setAttribute("stroke", "#60a5fa");
        flipBtn.setAttribute("stroke-width", "3");
        flipBtn.setAttribute("cursor", "pointer");
        flipBtn.setAttribute("display", "none");
        overlayGroup.appendChild(flipBtn);

        const flipIcon = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
        flipIcon.setAttribute("id", "__sel_flip_icon");
        flipIcon.setAttribute("text-anchor", "middle");
        flipIcon.setAttribute("dominant-baseline", "central");
        flipIcon.setAttribute("fill", "#60a5fa");
        flipIcon.setAttribute("font-size", "14");
        flipIcon.setAttribute("pointer-events", "none");
        flipIcon.setAttribute("display", "none");
        flipIcon.textContent = "⇔";
        overlayGroup.appendChild(flipIcon);

        // Append overlay inside camera layer so it shares the same coordinate space as actors
        const cameraLayerForOverlay = masterSvgElement.querySelector('#__camera_layer');
        if (cameraLayerForOverlay) {
            cameraLayerForOverlay.appendChild(overlayGroup);
        } else {
            masterSvgElement.appendChild(overlayGroup);
        }

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

        const cameraLayer = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        cameraLayer.setAttribute("id", "__camera_layer");
        while (masterSvgElement.firstChild) {
            cameraLayer.appendChild(masterSvgElement.firstChild);
        }
        masterSvgElement.appendChild(cameraLayer);

        masterSvgElement.setAttribute("class", "w-full h-full max-w-none max-h-none");

        const cleanSvg = DOMPurify.sanitize(masterSvgElement.outerHTML, { USE_PROFILES: { svg: true } });
        containerRef.current.innerHTML = cleanSvg;

        // getBBox-based positioning: find each actor's natural bounds, then translate
        // so their bottom-center lands exactly at the target (x, y).
        const domSvg = containerRef.current.querySelector("svg");
        if (!domSvg) return;

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
                    rotation: t.rotation ?? 0,
                    scaleX: t.scale * t.facingSign,
                    scaleY: t.scale,
                    svgOrigin: `${naturalCX} ${naturalBottom}`,
                });
            });

            const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");
            if (cameraGroup && beat.camera) {
                const rawCx = beat.camera.x ?? (stageW / 2);
                const rawCy = beat.camera.y ?? (stageH / 2);
                const rawZoom = beat.camera.zoom ?? 1;
                const rot = beat.camera.rotation ?? 0;
                // Sanitize: clamp camera to prevent stored extreme values from hiding everything
                const cx = Math.max(-3000, Math.min(3000, isFinite(rawCx) ? rawCx : stageW / 2));
                const cy = Math.max(-3000, Math.min(3000, isFinite(rawCy) ? rawCy : stageH / 2));
                const zoom = Math.max(0.2, Math.min(3, isFinite(rawZoom) ? rawZoom : 1));
                console.log(`[stage] Camera — raw: x=${rawCx}, y=${rawCy}, zoom=${rawZoom} → clamped: x=${cx}, y=${cy}, zoom=${zoom}`);
                // Use stage-center transformOrigin to match the timeline tween
                const originX = stageW / 2;
                const originY = stageH / 2;
                gsap.set(cameraGroup, {
                    x: originX - cx,
                    y: originY - cy,
                    scaleX: zoom,
                    scaleY: zoom,
                    rotation: rot,
                    transformOrigin: `${originX}px ${originY}px`
                });
            }

        }, containerRef);
        // Store as master context — revert() on this will clean ALL GSAP state
        masterCtxRef.current = posCtx;

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
            syncActorLayerOrder(tl.time());
            onPlayheadUpdateRef.current?.(tl.time());

            // ── Camera Tracking Update (only during playback) ──
            if (isPlayingRef.current && beat.camera?.target_actor_id && containerRef.current) {
                const domSvg = containerRef.current.querySelector("svg");
                const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");
                const targetActorGroup = domSvg?.querySelector<SVGGElement>(`#actor_group_${beat.camera.target_actor_id}`);
                
                if (cameraGroup && targetActorGroup) {
                    const actorX = gsap.getProperty(targetActorGroup, "x") as number;
                    const actorY = gsap.getProperty(targetActorGroup, "y") as number;
                    const naturalCX = parseFloat(targetActorGroup.dataset.naturalCx || "0");
                    const naturalBottom = parseFloat(targetActorGroup.dataset.naturalBottom || "0");
                    
                    const worldActorX = naturalCX + actorX;
                    const worldActorY = naturalBottom + actorY - 150;
                    
                    gsap.set(cameraGroup, {
                        x: (stageW / 2) - worldActorX,
                        y: (stageH / 2) - worldActorY,
                    });
                }
            }
        });
        tl.eventCallback("onComplete", () => {
          // Only act on completion during actual playback — not manual seek
          if (!isPlayingRef.current) return;
          console.log("[stage] Timeline complete");
          if (loopOnCompleteRef.current) {
            tl.pause(0);
            syncTimelineIK(tl);
            syncActorLayerOrder(0);
            onPlayheadUpdateRef.current?.(0);
            requestAnimationFrame(() => tl.play(0));
            return;
          }
          tl.pause(tl.duration());
          syncTimelineIK(tl);
          syncActorLayerOrder(tl.duration());
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
            syncActorLayerOrder(playheadTime);
        } else {
            tl.pause(playheadTime);
            syncTimelineIK(tl);
            syncActorLayerOrder(playheadTime);
        }

        // Update selection overlay after assembly
        updateSelectionOverlay(selectedActorId);

        return () => {
            posCtx.revert();
            masterCtxRef.current = null;
            if (ambientCtxRef.current)   { ambientCtxRef.current.revert(); ambientCtxRef.current  = null; }
            if (gsapTimelineRef.current) { gsapTimelineRef.current.kill(); gsapTimelineRef.current = null; }
            actorLayerOrderRef.current = "";
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
            const requestedStart = Math.max(0, Math.min(playheadTimeRef.current, tl.duration()));
            tl.play(requestedStart);
        } else {
            console.log("[stage] Pause — reverting ALL GSAP state via master context");
            
            // 1. NUCLEAR CLEANUP: revert the master context.
            // This removes EVERY inline style GSAP has ever set on ANY element
            // inside the container — actor group transforms, bone transforms
            // from IK sync (applyPoseToSvg), camera transforms, everything.
            if (masterCtxRef.current) {
                masterCtxRef.current.revert();
                masterCtxRef.current = null;
            }
            // Also kill any timeline and ambient that might live outside the context
            if (gsapTimelineRef.current) {
                gsapTimelineRef.current.kill();
                gsapTimelineRef.current = null;
            }
            if (ambientCtxRef.current) {
                ambientCtxRef.current.revert();
                ambientCtxRef.current = null;
            }

            // COMPREHENSIVE CLEANUP: clear ALL GSAP inline styles from every <g>
            // inside the container. This catches state created outside the master
            // context — timeline display:none on view groups, bone transforms
            // from applyPoseToSvg, camera transforms, etc.
            if (containerRef.current) {
                containerRef.current.querySelectorAll<SVGGElement>('g').forEach(g => {
                    gsap.set(g, { clearProps: 'all' });
                });
                // Reset all view groups to visible (timeline may have set display:none)
                containerRef.current.querySelectorAll<SVGGElement>('[id^="view_"]').forEach(v => {
                    v.setAttribute('display', 'inline');
                });
            }

            // 2. Re-apply initial positioning from saved refs (clean slate)
            if (containerRef.current) {
                const domSvg = containerRef.current.querySelector('svg');
                // Re-run deterministic rig assembly (bone ordering/nesting)
                if (domSvg && beatRef.current) {
                    const actorsInScene = beatRef.current.actions?.map(a => a.actor_id) || [];
                    const uniqueActors = Array.from(new Set(actorsInScene));
                    uniqueActors.forEach(actorId => {
                        const rig = rigsRef.current[actorId];
                        const actorGroup = domSvg.querySelector<SVGGElement>(`#actor_group_${actorId}`);
                        if (rig && actorGroup) {
                            applyDeterministicRigAssembly(actorGroup, rig);
                        }
                    });
                }

                // Create a fresh positioning context
                const freshPosCtx = gsap.context(() => {
                    Object.entries(targetTransformsRef.current).forEach(([id, t]) => {
                        const group = domSvg?.querySelector(`#actor_group_${id}`) as SVGGElement | null;
                        if (!group) return;
                        const naturalCX = parseFloat(group.dataset.naturalCx || String(stageWRef.current / 2));
                        const naturalBottom = parseFloat(group.dataset.naturalBottom || String(stageHRef.current * 0.97));
                        gsap.set(group, {
                            x: t.x - naturalCX,
                            y: t.y - naturalBottom,
                            rotation: t.rotation ?? 0,
                            scaleX: t.scale * t.facingSign,
                            scaleY: t.scale,
                            svgOrigin: `${naturalCX} ${naturalBottom}`,
                        });
                    });
                }, containerRef);
                masterCtxRef.current = freshPosCtx;
            }

            // 3. Restart ambient on clean, properly-positioned actors
            if (!disableAmbient && containerRef.current && beatRef.current) {
                ambientCtxRef.current = animateAmbient({
                    container: containerRef.current,
                    beat: beatRef.current,
                    compiledScene: compiledSceneRef.current,
                    availableRigs: rigsRef.current,
                });
            }

            // 4. Rebuild timeline (paused at 0) for future seek/play
            if (containerRef.current && beatRef.current) {
                const freshTl = buildTimeline({
                    container: containerRef.current,
                    beat: beatRef.current,
                    compiledScene: compiledSceneRef.current,
                    availableRigs: rigsRef.current,
                }) as TimelineWithIKSync;
                freshTl.eventCallback("onUpdate", () => {
                    syncTimelineIK(freshTl);
                    syncActorLayerOrder(freshTl.time());
                    onPlayheadUpdateRef.current?.(freshTl.time());
                });
                freshTl.eventCallback("onComplete", () => {
                    if (!isPlayingRef.current) return;
                    console.log("[stage] Timeline complete");
                    if (loopOnCompleteRef.current) {
                        freshTl.pause(0);
                        syncTimelineIK(freshTl);
                        syncActorLayerOrder(0);
                        onPlayheadUpdateRef.current?.(0);
                        requestAnimationFrame(() => freshTl.play(0));
                        return;
                    }
                    freshTl.pause(freshTl.duration());
                    syncTimelineIK(freshTl);
                    syncActorLayerOrder(freshTl.duration());
                    onPlayCompleteRef.current?.();
                });
                freshTl.pause(0);
                gsapTimelineRef.current = freshTl;
            }
        }
    }, [disableAmbient, isPlaying]);

    // ── Effect 3: Seek timeline when playhead is dragged (not playing) ────────
    useEffect(() => {
        if (isPlayingRef.current) return;  // GSAP drives the playhead while playing
        if (isDraggingRef.current) return; // Wait until drag is finished to not overwrite local overrides
        const tl = gsapTimelineRef.current;
        if (!tl) {
            console.log(`[stage] Effect 3 — no timeline to seek`);
            return;
        }
        
        console.log(`[stage] Effect 3 — seeking to ${playheadTime.toFixed(3)}s (tl duration: ${tl.duration().toFixed(3)}s)`);
        // Use regular seek. Suppressing events entirely sometimes skips rendering the frame.
        tl.seek(playheadTime, false);
        syncTimelineIK(tl);
        syncActorLayerOrder(playheadTime);
        
        // Force the selection overlay to align with the new playhead frame 
        updateSelectionOverlay(selectedActorId);
    }, [playheadTime, selectedActorId, syncActorLayerOrder, syncTimelineIK, updateSelectionOverlay]);

    // ── Effect 4: Selection overlay sync ─────────────────────────────────────
    useEffect(() => {
        updateSelectionOverlay(selectedActorId);
    }, [selectedActorId, updateSelectionOverlay]);


    useEffect(() => () => {
        detachWindowDragHandlers();
    }, [detachWindowDragHandlers]);

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
        const target = e.target as Element;
        
        let actorIdToDrag: string | null = null;
        let mode: DragState['mode'] = 'move';
        let actorGroup: SVGGElement | null = null;
        
        if (e.button === 1) { // Middle click always pans camera
            e.preventDefault();
            actorIdToDrag = 'camera';
            mode = 'camera_pan';
            onActorSelect?.(null);
        } else if (target.id && target.id.startsWith("__sel_handle_")) {
            if (!selectedActorId) return;
            actorIdToDrag = selectedActorId;
            mode = 'scale';
            actorGroup = containerRef.current?.querySelector(`#actor_group_${selectedActorId}`) as SVGGElement | null;
        } else if (target.id === '__sel_rotate') {
            if (!selectedActorId) return;
            actorIdToDrag = selectedActorId;
            mode = 'rotate';
            actorGroup = containerRef.current?.querySelector(`#actor_group_${selectedActorId}`) as SVGGElement | null;
        } else if (target.id === '__sel_flip') {
            // Flip is instant — no drag needed
            if (selectedActorId) {
                const group = containerRef.current?.querySelector<SVGGElement>(`#actor_group_${selectedActorId}`);
                if (group) {
                    const currentScaleX = gsap.getProperty(group, 'scaleX') as number;
                    gsap.set(group, { scaleX: -currentScaleX });
                    updateSelectionOverlay(selectedActorId);
                    onActorFlip?.(selectedActorId);
                }
            }
            return;
        } else {
            actorGroup = findActorGroup(e.target);
            if (!actorGroup) {
                onActorSelect?.(null);
                if (stagePropsOnCameraChange.current) {
                    actorIdToDrag = 'camera';
                    mode = e.altKey ? 'camera_rotate' : 'camera_pan';
                } else {
                    return;
                }
            } else {
                actorIdToDrag = actorGroup.id.replace("actor_group_", "");
                mode = 'move';
                onActorSelect?.(actorIdToDrag);
            }
        }

        if (!actorIdToDrag) return;

        if (actorIdToDrag === 'camera') {
            const currentCamera = beatRef.current?.camera ?? { zoom: 1, x: stageW/2, y: stageH/2, rotation: 0 };
            
            const isEditingEnd = selectedKeyframeRef.current === 'end' || (selectedKeyframeRef.current !== 'start' && playheadTimeRef.current > 0.1);
            
            const startX = isEditingEnd ? (currentCamera.target_x ?? currentCamera.x ?? (stageW/2)) : (currentCamera.x ?? (stageW/2));
            const startY = isEditingEnd ? (currentCamera.target_y ?? currentCamera.y ?? (stageH/2)) : (currentCamera.y ?? (stageH/2));
            const startZoom = isEditingEnd ? (currentCamera.target_zoom ?? currentCamera.zoom ?? 1) : (currentCamera.zoom ?? 1);
            const startRot = currentCamera.rotation ?? 0;
            
            const svgCoords = toSvgCoords(e.clientX, e.clientY);
            
            dragRef.current = {
                actorId: 'camera',
                mode,
                naturalCX: stageW / 2,
                naturalBottom: stageH / 2,
                offsetX: svgCoords.x,
                offsetY: svgCoords.y,
                initialDist: 0,
                initialScale: startZoom,
                initialFeetX: startX,
                initialFeetY: startY,
                lastFeetX: startX,
                lastFeetY: startY,
                lastDist: startRot,
            };
        } else if (actorGroup) {
            // Set up drag
            const naturalCX = parseFloat(actorGroup.dataset.naturalCx || "960");
            const naturalBottom = parseFloat(actorGroup.dataset.naturalBottom || "1050");
            const svgCoords = toSvgCoords(e.clientX, e.clientY);
    
            const currentX = gsap.getProperty(actorGroup, "x") as number;
            const currentY = gsap.getProperty(actorGroup, "y") as number;
            const feetX = naturalCX + currentX;
            const feetY = naturalBottom + currentY;
            const currentScaleY = gsap.getProperty(actorGroup, "scaleY") as number;
    
            if (mode === 'move') {
                dragRef.current = {
                    actorId: actorIdToDrag,
                    mode,
                    naturalCX,
                    naturalBottom,
                    offsetX: svgCoords.x - feetX,
                    offsetY: svgCoords.y - feetY,
                    initialDist: 0,
                    initialScale: 0,
                    initialFeetX: feetX,
                    initialFeetY: feetY,
                    lastFeetX: feetX,
                    lastFeetY: feetY,
                    lastDist: 0,
                };
            } else if (mode === 'scale') {
                const dx = svgCoords.x - feetX;
                const dy = svgCoords.y - feetY;
                const initialDist = Math.max(1, Math.sqrt(dx*dx + dy*dy));
                
                dragRef.current = {
                    actorId: actorIdToDrag,
                    mode,
                    naturalCX,
                    naturalBottom,
                    offsetX: 0,
                    offsetY: 0,
                    initialDist,
                    initialScale: currentScaleY,
                    initialFeetX: feetX,
                    initialFeetY: feetY,
                    lastFeetX: feetX,
                    lastFeetY: feetY,
                    lastDist: initialDist,
                };
            } else if (mode === 'rotate') {
                // Store initial angle from actor center to mouse position
                const initialAngle = Math.atan2(svgCoords.y - feetY, svgCoords.x - feetX);
                const currentRotation = gsap.getProperty(actorGroup, "rotation") as number || 0;
                
                dragRef.current = {
                    actorId: actorIdToDrag,
                    mode,
                    naturalCX,
                    naturalBottom,
                    offsetX: initialAngle, // initial mouse angle
                    offsetY: currentRotation, // initial rotation value
                    initialDist: 0,
                    initialScale: currentScaleY,
                    initialFeetX: feetX,
                    initialFeetY: feetY,
                    lastFeetX: feetX,
                    lastFeetY: feetY,
                    lastDist: 0,
                };
            }
        }

        isDraggingRef.current = false;
        detachWindowDragHandlers();
        const move = (event: MouseEvent) => {
            handleDragMove(event.clientX, event.clientY);
        };
        const up = () => {
            finishDrag(true);
        };
        windowDragHandlersRef.current = { move, up };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        e.preventDefault();
    }, [detachWindowDragHandlers, onActorSelect, selectedActorId, toSvgCoords]);

    const handleDragMove = useCallback((clientX: number, clientY: number) => {
        if (!dragRef.current) return;

        isDraggingRef.current = true;
        const dragState = dragRef.current;
        const { actorId, mode, naturalCX, naturalBottom, offsetX, offsetY, initialDist, initialScale } = dragState;
        
        const domSvg = containerRef.current?.querySelector("svg");
        
        if (actorId === 'camera') {
            const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");
            if (!cameraGroup) return;

            const currentSvgCoords = toSvgCoords(clientX, clientY);

            if (mode === 'camera_pan') {
                // Determine raw 1:1 SVG delta, inverted since we are moving the "world" under the camera.
                // We divide by initialScale so that if we are zoomed in 5x, the camera only shifts 1/5th as fast 
                // native SVG coordinates, ensuring the world pixels stay 1:1 glued to the mouse cursor!
                const dx = (currentSvgCoords.x - offsetX) / (initialScale || 1);
                const dy = (currentSvgCoords.y - offsetY) / (initialScale || 1);
                const newX = dragState.initialFeetX - dx;
                const newY = dragState.initialFeetY - dy;
                
                // Use gsap.to with overwrite to kill conflicting timeline tweens
                // IMPORTANT: keep transformOrigin fixed at stage center to prevent
                // objects jumping when zoomed (scale applied around changing origin)
                gsap.to(cameraGroup, {
                    x: (stageW / 2) - newX,
                    y: (stageH / 2) - newY,
                    duration: 0.1,
                    overwrite: "auto"
                });
                
                dragState.lastFeetX = newX;
                dragState.lastFeetY = newY;
            } else if (mode === 'camera_rotate' && domSvg) {
                const rect = domSvg.getBoundingClientRect();
                const centerXPx = rect.left + rect.width / 2;
                const centerYPx = rect.top + rect.height / 2;
                const initAngle = Math.atan2(offsetY - centerYPx, offsetX - centerXPx);
                const currentAngle = Math.atan2(clientY - centerYPx, clientX - centerXPx);
                let diff = (currentAngle - initAngle) * (180 / Math.PI);
                const newRot = dragState.lastDist + diff; // lastDist holds initial rotation
                
                gsap.to(cameraGroup, {
                    rotation: newRot,
                    duration: 0.1,
                    overwrite: "auto"
                });
                
                // Note: we're only displaying the rotation, committing it later on up
            }
            return;
        }

        const svgCoords = toSvgCoords(clientX, clientY);

        const group = domSvg?.querySelector<SVGGElement>(`#actor_group_${actorId}`);
        if (!group) return;

        if (mode === 'move') {
            const newFeetX = svgCoords.x - offsetX;
            const newFeetY = svgCoords.y - offsetY;
            const dx = newFeetX - dragRef.current.lastFeetX;
            const dy = newFeetY - dragRef.current.lastFeetY;
            dragRef.current.lastFeetX = newFeetX;
            dragRef.current.lastFeetY = newFeetY;

            gsap.set(group, {
                x: newFeetX - naturalCX,
                y: newFeetY - naturalBottom,
            });
        } else if (mode === 'scale') {
            const currentX = gsap.getProperty(group, "x") as number;
            const currentY = gsap.getProperty(group, "y") as number;
            const feetX = naturalCX + currentX;
            const feetY = naturalBottom + currentY;
            
            const dx = svgCoords.x - feetX;
            const dy = svgCoords.y - feetY;
            const currentDist = Math.max(1, Math.sqrt(dx*dx + dy*dy));
            
            const scaleFactorThisFrame = currentDist / dragRef.current.lastDist;
            dragRef.current.lastDist = currentDist;

            const totalScaleFactor = currentDist / initialDist;
            const newScale = Math.max(0.1, Math.min(3.0, initialScale * totalScaleFactor));
            const facingSign = Math.sign(gsap.getProperty(group, "scaleX") as number) || 1;
            
            gsap.set(group, {
                scaleX: newScale * facingSign,
                scaleY: newScale,
            });
        } else if (mode === 'rotate') {
            // Arc-based rotation: compute angle delta from center to mouse
            const currentX = gsap.getProperty(group, "x") as number;
            const currentY = gsap.getProperty(group, "y") as number;
            const feetX = naturalCX + currentX;
            const feetY = naturalBottom + currentY;
            
            const currentAngle = Math.atan2(svgCoords.y - feetY, svgCoords.x - feetX);
            const angleDelta = (currentAngle - offsetX) * (180 / Math.PI); // offsetX = initial angle
            const newRotation = offsetY + angleDelta; // offsetY = initial rotation
            
            gsap.set(group, { rotation: newRotation });
        }

        // Update selection overlay to follow
        updateSelectionOverlay(actorId);
    }, [toSvgCoords, updateSelectionOverlay]);

    const finishDrag = useCallback((commitChanges: boolean) => {
        if (!dragRef.current) return;
        const dragState = dragRef.current;
        const domSvg = containerRef.current?.querySelector("svg");

        if (commitChanges) {
            if (dragState.actorId === 'camera') {
                const currentCamera = beatRef.current?.camera ?? { zoom: 1, x: stageW/2, y: stageH/2, rotation: 0 };
                const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");
                let finalRotation = currentCamera.rotation ?? 0;
                
                if (dragState.mode === 'camera_rotate' && cameraGroup) {
                     finalRotation = gsap.getProperty(cameraGroup, "rotation") as number;
                }
                
                const isEditingEnd = selectedKeyframeRef.current === 'end' || (selectedKeyframeRef.current !== 'start' && playheadTimeRef.current > 0.1);
                const zoomToUse = isEditingEnd ? (currentCamera.target_zoom ?? currentCamera.zoom ?? 1) : (currentCamera.zoom ?? 1);

                stagePropsOnCameraChange.current?.({
                    x: Math.round(dragState.lastFeetX),
                    y: Math.round(dragState.lastFeetY),
                    rotation: Math.round(finalRotation),
                    zoom: zoomToUse,
                    isEndKeyframe: isEditingEnd
                });
            } else {
                const group = domSvg?.querySelector<SVGGElement>(`#actor_group_${dragState.actorId}`);
                if (group) {
                    if (dragState.mode === 'move') {
                        const dx = dragState.lastFeetX - dragState.initialFeetX;
                        const dy = dragState.lastFeetY - dragState.initialFeetY;
                        if (dx !== 0 || dy !== 0) {
                            onActorPositionChange?.(dragState.actorId, dx, dy);
                        }
                    } else if (dragState.mode === 'scale') {
                        const finalScale = Math.abs(gsap.getProperty(group, "scaleY") as number) || dragState.initialScale;
                        const scaleRatio = finalScale / Math.max(0.0001, dragState.initialScale);
                        if (Number.isFinite(scaleRatio) && Math.abs(scaleRatio - 1) > 0.0001) {
                            onActorScaleChange?.(dragState.actorId, scaleRatio);
                        }
                    } else if (dragState.mode === 'rotate') {
                        const finalRotation = gsap.getProperty(group, "rotation") as number || 0;
                        onActorRotationChange?.(dragState.actorId, finalRotation);
                    }
                }
            }
        }

        dragRef.current = null;
        isDraggingRef.current = false;
        detachWindowDragHandlers();
    }, [detachWindowDragHandlers, onActorPositionChange, onActorScaleChange, onActorRotationChange, onActorFlip]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        handleDragMove(e.clientX, e.clientY);
    }, [handleDragMove]);

    // Instead of using React onWheel, we bind a non-passive wheel event directly to dom to prevent browser scaling/panning
    useEffect(() => {
        const stageDom = containerRef.current;
        if (!stageDom) return;
        
        const handleNativeWheel = (e: WheelEvent) => {
            if (!beatRef.current || !stagePropsOnCameraChange.current) return;
            
            // Unconditionally prevent browser default (swiping back/forward or scrolling page)
            e.preventDefault(); 
            
            const domSvg = stageDom.querySelector("svg");
            const cameraGroup = domSvg?.querySelector<SVGGElement>("#__camera_layer");
            const isEditingEnd = selectedKeyframeRef.current === 'end' || (selectedKeyframeRef.current !== 'start' && playheadTimeRef.current > 0.1);

            // Read active zoom from local accumulator if active to prevent React tearing
            let currentZoom = wheelAccumulatorRef.current.timer 
                ? wheelAccumulatorRef.current.zoom 
                : (isEditingEnd ? (beatRef.current.camera?.target_zoom ?? beatRef.current.camera?.zoom ?? 1) : (beatRef.current.camera?.zoom ?? 1));

            // Hybrid sizing for Trackpad vs Physical Wheel. Trackpad deltaY is small (2-10). Wheel is large (100).
            const isTrackpad = Math.abs(e.deltaY) < 50; 
            const zoomDelta = isTrackpad 
                ? e.deltaY * -0.01          // Smooth continuous trackpad ratio
                : Math.sign(e.deltaY) * -0.1; // Solid 0.1 click interval for wheel

            if (zoomDelta === 0) return;
            
            // Widen bounds so users can aggressively zoom if needed
            const newZoom = Math.max(0.01, Math.min(100.0, currentZoom + zoomDelta));
            wheelAccumulatorRef.current.zoom = newZoom;
            
            // Immediate visual GSAP update (kill tweens to avoid overlapping scaling anomalies)
            if (cameraGroup) {
                gsap.killTweensOf(cameraGroup, "scaleX,scaleY");
                gsap.set(cameraGroup, {
                    scaleX: newZoom,
                    scaleY: newZoom,
                });
            }

            // Debounce expensive React state update logic
            if (wheelAccumulatorRef.current.timer) clearTimeout(wheelAccumulatorRef.current.timer);
            wheelAccumulatorRef.current.timer = setTimeout(() => {
                wheelAccumulatorRef.current.timer = null;
                stagePropsOnCameraChange.current?.({
                    x: isEditingEnd ? (beatRef.current?.camera?.target_x ?? beatRef.current?.camera?.x ?? stageW / 2) : (beatRef.current?.camera?.x ?? stageW / 2),
                    y: isEditingEnd ? (beatRef.current?.camera?.target_y ?? beatRef.current?.camera?.y ?? stageH / 2) : (beatRef.current?.camera?.y ?? stageH / 2),
                    rotation: beatRef.current?.camera?.rotation ?? 0,
                    zoom: Number(newZoom.toFixed(2)),
                    isEndKeyframe: isEditingEnd
                });
            }, 100);
        };

        stageDom.addEventListener('wheel', handleNativeWheel, { passive: false });
        return () => stageDom.removeEventListener('wheel', handleNativeWheel);
    }, [stageW, stageH]);

    const handleMouseLeave = useCallback(() => {
        // Window-level handlers keep the drag active after leaving the stage bounds.
    }, []);

    const handleMouseUp = useCallback(() => {
        finishDrag(true);
    }, [finishDrag]);

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
                // Native wheel effect manages zooming instead of react passive wheel to block page scrolls
            />
        </div>
    );
}
