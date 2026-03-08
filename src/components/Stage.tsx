"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { StoryBeatData } from "@/lib/schema/story";
import { DraftsmanData } from "@/lib/schema/rig";
import DOMPurify from 'dompurify';

interface StageProps {
    beat: StoryBeatData | null;
    availableRigs: Record<string, DraftsmanData>;
}

export default function Stage({ beat, availableRigs }: StageProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current || !beat) return;

        // Assembly Phase: Combine Background and Actors into a single SVG Document

        let compositeSvgContent = "";

        // 1. Base Layer: The Environment Set
        if (beat.drafted_background) {
            // We strip the wrapping <svg> tag from the background so we can inject into a master SVG
            const bgSvgContent = beat.drafted_background.svg_data
                .replace(/^<svg[^>]*>/i, '') // Remove opening <svg> tag
                .replace(/<\/svg>$/i, '');   // Remove closing </svg> tag
            
            compositeSvgContent += `<g id="environment_layer">${bgSvgContent}</g>`;
        } else {
            // Fallback grid if no background is generated yet
            compositeSvgContent += `
              <rect width="1000" height="1000" fill="#111" />
              <g id="grid_layer" stroke="#222" stroke-width="2">
                ${Array.from({length: 10}).map((_, i) => `
                  <line x1="0" y1="${i*100}" x2="1000" y2="${i*100}" />
                  <line x1="${i*100}" y1="0" x2="${i*100}" y2="1000" />
                `).join('')}
              </g>
            `;
        }

        // 2. Actor Layer: Inject rigs for actors present in the scene
        const actorsInScene = new Set(beat.actions.map(a => a.actor_id));
        let actorIndex = 0;
        
        actorsInScene.forEach(actorId => {
            const rig = availableRigs[actorId];
            if (rig) {
                // Extract inner SVG content
                const rigSvgContent = rig.svg_data
                    .replace(/^<svg[^>]*>/i, '')
                    .replace(/<\/svg>$/i, '');
                
                // For now, space them out slightly horizontally to avoid perfect overlap
                const xOffset = 300 + (actorIndex * 200); 
                const yOffset = 300; // Place them roughly in the lower middle
                
                // Scale actors down slightly so they fit in the scene.
                // In the future, this scale and offset will be calculated dynamically based on background interaction nulls.
                compositeSvgContent += `
                    <g id="actor_group_${actorId}" transform="translate(${xOffset}, ${yOffset}) scale(0.6)">
                        ${rigSvgContent}
                    </g>
                `;
                actorIndex++;
            }
        });

        // 3. Wrap in a Master SVG Viewport
        const masterSvgStr = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" class="w-full h-full max-w-none max-h-none">
                ${compositeSvgContent}
            </svg>
        `;

        // 4. Safely render to the DOM
        const cleanSvg = DOMPurify.sanitize(masterSvgStr, { USE_PROFILES: { svg: true } });
        containerRef.current.innerHTML = cleanSvg;

        // 5. GSAP Context Setup (For later animation)
        const ctx = gsap.context(() => {
            // Example: We can target specific actor groups now!
            /*
            beat.actions.forEach(action => {
               if (action.motion === "run") {
                 gsap.to(\`#actor_group_${action.actor_id}\", { x: "+=200", duration: action.duration_seconds });
               }
            });
            */
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