"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { DraftsmanData } from "@/lib/schema/rig";
import { resolvePlayableMotionClip } from "@/lib/motion/compiled_ik";
import { EvaluatedMotionGoals, estimateMotionClipDuration, evaluateMotionIntentAtTime } from "@/lib/motion/intent";
import { buildPoseGraph } from "@/lib/ik/graph";
import { createRestPoseState } from "@/lib/ik/pose";
import { solvePoseFromGoals } from "@/lib/ik/goal_solver";
import { applyPoseToSvg, mountRigSvg } from "@/lib/ik/svgPose";
import { validateRigForMotion } from "@/lib/motion/validation";

const EMPTY_GOALS: EvaluatedMotionGoals = {
  normalizedTime: 0,
  effectorTargets: [],
  axialRotations: {},
  activePins: [],
  activeContacts: [],
};

export function RigClipPreview({
  rig,
  clipId,
  isPlaying,
  playheadTime,
  frameRate = 60,
  loop = true,
  onPlayheadUpdate,
}: {
  rig: DraftsmanData;
  clipId: string;
  isPlaying: boolean;
  playheadTime: number;
  frameRate?: number;
  loop?: boolean;
  onPlayheadUpdate?: (timeSeconds: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const currentTimeRef = useRef(playheadTime);

  const motionClip = rig.rig_data.motion_clips?.[clipId];
  const durationSeconds = useMemo(() => estimateMotionClipDuration(motionClip), [motionClip]);
  const playableClip = useMemo(() => resolvePlayableMotionClip({
    rig,
    clipId,
    motionClip,
    durationSeconds,
  }), [clipId, durationSeconds, motionClip, rig]);
  const validation = useMemo(() => validateRigForMotion({
    rig,
    motion: clipId,
    durationSeconds,
    motionClip: playableClip || motionClip,
  }), [clipId, durationSeconds, motionClip, playableClip, rig]);

  const activeView = playableClip?.view
    || rig.rig_data.ik?.defaultView
    || Object.keys(rig.rig_data.ik?.views || {}).sort()[0]
    || "view_default";

  const graph = useMemo(() => buildPoseGraph(rig, activeView), [activeView, rig]);
  const restPose = useMemo(() => createRestPoseState(graph), [graph]);

  const renderAtTime = useCallback((timeSeconds: number) => {
    if (!svgRef.current) return;
    const goals = playableClip?.intent
      ? evaluateMotionIntentAtTime(playableClip.intent, graph, timeSeconds)
      : EMPTY_GOALS;
    const solved = solvePoseFromGoals(graph, goals, restPose);
    applyPoseToSvg(svgRef.current, graph, solved.layout, activeView);
  }, [activeView, graph, playableClip, restPose]);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    svgRef.current = mountRigSvg(containerEl, rig, activeView);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = null;
      svgRef.current = null;
      containerEl.innerHTML = "";
    };
  }, [activeView, renderAtTime, rig]);

  useEffect(() => {
    currentTimeRef.current = playheadTime;
    if (!isPlaying) {
      renderAtTime(playheadTime);
    }
  }, [isPlaying, playheadTime, renderAtTime]);

  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastFrameRef.current = null;

    if (!isPlaying) return;

    const minFrameMs = 1000 / Math.max(1, frameRate);

    const step = (now: number) => {
      if (lastFrameRef.current === null) {
        lastFrameRef.current = now;
      }

      const elapsedMs = now - lastFrameRef.current;
      if (elapsedMs >= minFrameMs) {
        const elapsedSeconds = elapsedMs / 1000;
        let nextTime = currentTimeRef.current + elapsedSeconds;
        if (durationSeconds > 0) {
          if (loop) {
            nextTime = nextTime % durationSeconds;
          } else {
            nextTime = Math.min(durationSeconds, nextTime);
          }
        }

        currentTimeRef.current = nextTime;
        lastFrameRef.current = now;
        renderAtTime(nextTime);
        onPlayheadUpdate?.(nextTime);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = null;
    };
  }, [durationSeconds, frameRate, isPlaying, loop, onPlayheadUpdate, renderAtTime]);

  if (!validation.ok) {
    return (
      <div className="relative h-full min-h-[420px] overflow-hidden rounded-2xl bg-[#07090e] shadow-inner">
        <div className="absolute inset-0 opacity-90" style={{ backgroundImage: "linear-gradient(rgba(42,48,62,0.42) 1px, transparent 1px), linear-gradient(90deg, rgba(42,48,62,0.42) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
        <div className="absolute inset-6 rounded-2xl border border-red-500/30 bg-[#11151d]/90 p-5 text-left">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-red-300">Preview Blocked</div>
          <div className="mt-3 text-lg font-semibold text-white">{clipId}</div>
          <div className="mt-2 max-w-xl text-sm text-red-100">
            {validation.errors[0]}
          </div>
          {validation.warnings.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {validation.warnings[0]}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden rounded-2xl bg-[#07090e] shadow-inner">
      <div
        className="absolute inset-0 opacity-90"
        style={{
          backgroundImage: "linear-gradient(rgba(42,48,62,0.42) 1px, transparent 1px), linear-gradient(90deg, rgba(42,48,62,0.42) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
      <div
        ref={containerRef}
        className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full [&>svg]:max-h-none [&>svg]:max-w-none"
      />
    </div>
  );
}
