"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

interface StageProps {
    actorSvgData: string;
}

export default function Stage({ actorSvgData }: StageProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        // A placeholder GSAP context where we will later apply
        // the semantic motion commands to the actor SVG's IDs
        const ctx = gsap.context(() => {
            // Example: If the SVG has an element with id "arm_right",
            // we could animate it here in the future
            /*
            gsap.to("#arm_right", {
              rotation: 45,
              duration: 1,
              ease: "power1.inOut"
            });
            */
        }, containerRef);

        return () => ctx.revert();
    }, [actorSvgData]);

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full border border-neutral-800 bg-neutral-900 rounded-lg overflow-hidden flex items-center justify-center p-8"
            dangerouslySetInnerHTML={{ __html: actorSvgData }}
        />
    );
}
