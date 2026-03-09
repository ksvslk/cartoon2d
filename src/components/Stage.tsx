"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { StoryBeatData } from "@/lib/schema/story";
import { DraftsmanData } from "@/lib/schema/rig";
import DOMPurify from 'dompurify';
import { animateAmbient, animateTimeline } from "@/lib/motion/core";

interface StageProps {
    beat: StoryBeatData | null;
    availableRigs: Record<string, DraftsmanData>;
    isPlaying?: boolean;
}

export default function Stage({ beat, availableRigs, isPlaying = false }: StageProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    // Refs so animation effects always see the latest values without re-running on them.
    const beatRef = useRef(beat);
    const rigsRef = useRef(availableRigs);
    useEffect(() => { beatRef.current = beat; }, [beat]);
    useEffect(() => { rigsRef.current = availableRigs; }, [availableRigs]);

    // Two separate GSAP contexts: ambient (always-on loops) and timeline (play-driven).
    const ambientCtxRef = useRef<gsap.Context | null>(null);
    const timelineCtxRef = useRef<gsap.Context | null>(null);

    // ── Effect 1: SVG Assembly + Ambient ─────────────────────────────────────
    // Rebuilds the scene and starts ambient animations whenever beat/rigs change.
    useEffect(() => {
        if (!containerRef.current || !beat) return;

        // Kill any running animations from the previous scene
        if (timelineCtxRef.current) { timelineCtxRef.current.revert(); timelineCtxRef.current = null; }
        if (ambientCtxRef.current)  { ambientCtxRef.current.revert();  ambientCtxRef.current  = null; }

        const parser = new DOMParser();
        let masterSvgElement: SVGSVGElement;

        if (beat.drafted_background) {
            const bgDoc = parser.parseFromString(beat.drafted_background.svg_data, "image/svg+xml");
            masterSvgElement = bgDoc.querySelector("svg") as SVGSVGElement;
        } else {
            const fallbackStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" class="w-full h-full">
              <rect width="1920" height="1080" fill="#111"/>
              <g id="bg_sky"/>
              <g id="bg_midground">
                ${Array.from({length:11}).map((_,i)=>`<line x1="0" y1="${i*108}" x2="1920" y2="${i*108}" stroke="#222" stroke-width="2"/>`).join('')}
                ${Array.from({length:20}).map((_,i)=>`<line x1="${i*96}" y1="0" x2="${i*96}" y2="1080" stroke="#222" stroke-width="2"/>`).join('')}
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
        const actorsInScene = Array.from(new Set(beat.actions.map(a => a.actor_id))).map(actorId => {
            const actionData = beat.actions.find(a => a.actor_id === actorId);
            return { actorId, zIndex: actionData?.spatial_transform?.z_index ?? 10 };
        }).sort((a, b) => a.zIndex - b.zIndex);

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

            const actionData = beat.actions.find(a => a.actor_id === actorId);
            const tX     = actionData?.spatial_transform?.x     ?? (480 + actorIdx * 320);
            const tY     = actionData?.spatial_transform?.y     ?? 950;
            const tScale = actionData?.spatial_transform?.scale ?? 0.5;

            targetTransforms[actorId] = { x: tX, y: tY, scale: tScale };

            while (rigSvg.firstChild) {
                actorGroup.appendChild(rigSvg.firstChild);
            }
            actorLayer.appendChild(actorGroup);
            actorIdx++;
        });

        masterSvgElement.setAttribute("class", "w-full h-full max-w-none max-h-none");

        const cleanSvg = DOMPurify.sanitize(masterSvgElement.outerHTML, { USE_PROFILES: { svg: true } });
        containerRef.current.innerHTML = cleanSvg;

        // getBBox-based positioning: find each actor's natural bounds, then translate
        // so their bottom-center lands exactly at the target (x, y).
        const domSvg = containerRef.current.querySelector("svg");

        const posCtx = gsap.context(() => {
            Object.entries(targetTransforms).forEach(([id, t]) => {
                const group = domSvg?.querySelector(`#actor_group_${id}`) as SVGGElement | null;
                if (!group) return;

                let naturalCX = 960;
                let naturalBottom = 1050;

                try {
                    const bbox = group.getBBox();
                    if (bbox.width > 0 || bbox.height > 0) {
                        naturalCX = bbox.x + bbox.width / 2;
                        naturalBottom = bbox.y + bbox.height;
                    }
                } catch (_) { /* getBBox failed — use fallbacks */ }

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
        ambientCtxRef.current = animateAmbient({
            container: containerRef.current,
            beat,
            availableRigs,
        });

        return () => {
            posCtx.revert();
            if (ambientCtxRef.current) { ambientCtxRef.current.revert(); ambientCtxRef.current = null; }
        };
    }, [beat, availableRigs]);

    // ── Effect 2: Timeline Animation ─────────────────────────────────────────
    // Starts scripted motion (walk, panic, hide) when play is pressed.
    // Kills ambient while playing; restarts it when stopped.
    useEffect(() => {
        if (!containerRef.current || !beatRef.current) return;

        if (!isPlaying) {
            // Not playing — ambient should already be running from Effect 1.
            // Nothing to do here unless we need to restart it after timeline reverted it.
            return;
        }

        // Kill ambient while timeline plays (prevents conflicting tweens on bones)
        if (ambientCtxRef.current) { ambientCtxRef.current.revert(); ambientCtxRef.current = null; }

        const ctx = animateTimeline({
            container: containerRef.current,
            beat: beatRef.current,
            availableRigs: rigsRef.current,
        });
        timelineCtxRef.current = ctx;

        return () => {
            ctx.revert();
            timelineCtxRef.current = null;
            // Restart ambient when timeline stops
            if (containerRef.current && beatRef.current) {
                ambientCtxRef.current = animateAmbient({
                    container: containerRef.current,
                    beat: beatRef.current,
                    availableRigs: rigsRef.current,
                });
            }
        };
    }, [isPlaying]);

    if (!beat) {
        return (
            <div className="w-full h-full flex items-center justify-center text-neutral-500 text-xs font-mono uppercase tracking-widest">
                Select a scene from the timeline to stage it.
            </div>
        );
    }

    return (
        <div className="w-full h-full flex items-center justify-center p-4">
            <div
                ref={containerRef}
                className="w-full aspect-video max-w-[1920px] shadow-2xl bg-black rounded-lg overflow-hidden border border-neutral-800"
            />
        </div>
    );
}
