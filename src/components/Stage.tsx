"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { StoryBeatData } from "@/lib/schema/story";
import { DraftsmanData } from "@/lib/schema/rig";
import DOMPurify from 'dompurify';
import { animateScene } from "@/lib/motion/core";

interface StageProps {
    beat: StoryBeatData | null;
    availableRigs: Record<string, DraftsmanData>;
    isPlaying?: boolean;
}

export default function Stage({ beat, availableRigs, isPlaying = false }: StageProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current || !beat) return;

        // Assembly Phase: Combine Background and Actors into a single SVG Document
        let masterSvgElement: SVGSVGElement;
        const parser = new DOMParser();

        if (beat.drafted_background) {
            // Parse the deterministic background SVG
            const bgDoc = parser.parseFromString(beat.drafted_background.svg_data, "image/svg+xml");
            masterSvgElement = bgDoc.querySelector("svg") as SVGSVGElement;
        } else {
            // Fallback grid if no background is generated yet
            const fallbackStr = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" class="w-full h-full max-w-none max-h-none">
              <rect width="1000" height="1000" fill="#111" />
              <g id="bg_sky"></g>
              <g id="bg_midground">
                <g id="grid_layer" stroke="#222" stroke-width="2">
                  ${Array.from({length: 10}).map((_, i) => `
                    <line x1="0" y1="${i*100}" x2="1000" y2="${i*100}" />
                    <line x1="${i*100}" y1="0" x2="${i*100}" y2="1000" />
                  `).join('')}
                </g>
              </g>
              <g id="bg_foreground"></g>
            </svg>`;
            const fallbackDoc = parser.parseFromString(fallbackStr, "image/svg+xml");
            masterSvgElement = fallbackDoc.querySelector("svg") as SVGSVGElement;
        }

        // 2. Create the Actor Layer
        // We want actors to stand IN FRONT of the midground, but BEHIND the foreground.
        const actorLayer = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        actorLayer.setAttribute("id", "stage_actors");

        const foregroundLayer = masterSvgElement.querySelector("#bg_foreground");
        if (foregroundLayer && foregroundLayer.parentNode) {
            // Insert exactly before foreground
            foregroundLayer.parentNode.insertBefore(actorLayer, foregroundLayer);
        } else {
            // Fallback to end
            masterSvgElement.appendChild(actorLayer);
        }

        // 3. Inject rigs for actors present in the scene
        const actorsInScene = new Set(beat.actions.map(a => a.actor_id));
        let actorIndex = 0;
        
        actorsInScene.forEach(actorId => {
            const rig = availableRigs[actorId];
            if (rig) {
                const rigDoc = parser.parseFromString(rig.svg_data, "image/svg+xml");
                const rigSvg = rigDoc.querySelector("svg");
                
                if (rigSvg) {
                    const actorGroup = masterSvgElement.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
                    actorGroup.setAttribute("id", `actor_group_${actorId}`);
                    
                    // Parse any scale/position tweaks from the action, default to basic layout
                    const actionData = beat.actions.find(a => a.actor_id === actorId);
                    
                    // Use spatial transforms provided by the AI, or fall back to defaults
                    const baseY = actionData?.spatial_transform?.y ?? 500;
                    const baseX = actionData?.spatial_transform?.x ?? (300 + (actorIndex * 200));
                    const baseScale = actionData?.spatial_transform?.scale ?? 0.6;
                    
                    actorGroup.setAttribute("transform", `translate(${baseX}, ${baseY}) scale(${baseScale})`);

                    // Move all children from the rig SVG into this group
                    while (rigSvg.firstChild) {
                        actorGroup.appendChild(rigSvg.firstChild);
                    }

                    actorLayer.appendChild(actorGroup);
                    actorIndex++;
                }
            }
        });

        // Ensure master classes are set for styling
        masterSvgElement.setAttribute("class", "w-full h-full max-w-none max-h-none");

        // 4. Safely render to the DOM
        const cleanSvg = DOMPurify.sanitize(masterSvgElement.outerHTML, { USE_PROFILES: { svg: true } });
        containerRef.current.innerHTML = cleanSvg;

        // 5. GSAP Context Setup (For later animation)
        const ctx = gsap.context(() => {
            if (isPlaying) {
                animateScene({ container: containerRef.current!, beat });
            }
        }, containerRef);

        return () => ctx.revert();
    }, [beat, availableRigs]);

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
                className="w-full aspect-square max-w-[1000px] shadow-2xl bg-black rounded-lg overflow-hidden border border-neutral-800"
            />
        </div>
    );
}