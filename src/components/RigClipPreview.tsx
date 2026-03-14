"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { DraftsmanData } from "@/lib/schema/rig";
import { resolvePlayableMotionClip } from "@/lib/motion/compiled_ik";
import { EvaluatedMotionGoals, estimateMotionClipDuration, evaluateMotionIntentAtTime } from "@/lib/motion/intent";
import { Play, Pause, AlertCircle } from "lucide-react";
import gsap from "gsap";
import { buildPoseGraph } from "@/lib/ik/graph";
import { createRestPoseState, PoseState } from "@/lib/ik/pose";
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
  playbackSpeed = 1.0,
  onPlayheadUpdate,
}: {
  rig: DraftsmanData;
  clipId: string;
  isPlaying: boolean;
  playheadTime: number;
  frameRate?: number;
  loop?: boolean;
  playbackSpeed?: number;
  onPlayheadUpdate?: (timeSeconds: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<gsap.core.Timeline | number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const currentTimeRef = useRef(playheadTime);
  const lastPoseRef = useRef<PoseState | null>(null);
  const lastDebugRotationsRef = useRef<Record<string, number> | null>(null);

  const motionClip = rig.rig_data.motion_clips?.[clipId];
  const estimatedDuration = useMemo(() => estimateMotionClipDuration(motionClip), [motionClip]);
  const playableClip = useMemo(() => resolvePlayableMotionClip({
    rig,
    clipId,
    motionClip,
    durationSeconds: estimatedDuration,
  }), [clipId, estimatedDuration, motionClip, rig]);

  // Use the TRUE duration bound from the evaluator for absolute cycle matching
  const durationSeconds = playableClip?.intent?.duration || estimatedDuration || 2.0;

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

  const renderAtTime = useCallback((timeSeconds: number, resetContinuity = false) => {
    if (!svgRef.current) return;
    if (resetContinuity) {
      lastPoseRef.current = null;
    }
    const goals = playableClip?.intent
      ? evaluateMotionIntentAtTime(playableClip.intent, graph, timeSeconds)
      : EMPTY_GOALS;
    const solved = solvePoseFromGoals(graph, goals, lastPoseRef.current ?? restPose);
    applyPoseToSvg(svgRef.current, graph, solved.layout, activeView);
    
    // Debug jumps in Modal
    if (lastDebugRotationsRef.current) {
      for (const [nodeId, rot] of Object.entries(solved.pose.localRotations)) {
        const prev = lastDebugRotationsRef.current[nodeId];
        if (prev !== undefined && Math.abs(rot - prev) > 20 && Math.abs(rot - prev) < 340) {
          console.error(`[MODAL JUMP] Node ${nodeId} jumped from ${prev.toFixed(2)} to ${rot.toFixed(2)} (delta: ${(rot - prev).toFixed(2)}) at t=${timeSeconds.toFixed(3)}s`);
        }
      }
    }
    lastDebugRotationsRef.current = { ...solved.pose.localRotations };
    
    lastPoseRef.current = solved.pose;
  }, [activeView, graph, playableClip, restPose]);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    svgRef.current = mountRigSvg(containerEl, rig, activeView);
    lastPoseRef.current = null;
    return () => {
      if (rafRef.current !== null) {
        if (typeof rafRef.current === "number") {
          cancelAnimationFrame(rafRef.current);
        } else {
          (rafRef.current as gsap.core.Timeline).kill();
        }
        rafRef.current = null;
      }
      lastFrameRef.current = null;
      lastPoseRef.current = null;
      svgRef.current = null;
      containerEl.innerHTML = "";
    };
  }, [activeView, renderAtTime, rig]);

  useEffect(() => {
    if (!isPlaying) {
      currentTimeRef.current = playheadTime;
      renderAtTime(playheadTime, true);
    }
  }, [isPlaying, playheadTime, renderAtTime]);

  useEffect(() => {
    if (rafRef.current !== null) {
      (rafRef.current as gsap.core.Timeline).kill();
      rafRef.current = null;
    }
    lastFrameRef.current = null;
    if (!isPlaying) {
      lastPoseRef.current = null;
    }

    if (!isPlaying) return;

    // To prevent float accumulation frame jitter from desyncing loop boundaries
    // use a true GSAP Timeline exactly as the Stage uses.
    const tlDuration = durationSeconds;
    const tl = gsap.timeline({
      repeat: loop ? -1 : 0,
      onUpdate: function () {
        const nextTime = this.time();
        currentTimeRef.current = nextTime;
        renderAtTime(nextTime);
        onPlayheadUpdate?.(nextTime);
      },
    });

    const clock = { time: 0 };
    tl.to(clock, {
      time: tlDuration,
      duration: tlDuration / (playbackSpeed || 1.0),
      ease: "none",
    });

    rafRef.current = tl as any;

    return () => {
      if (rafRef.current !== null) {
        (rafRef.current as gsap.core.Timeline).kill();
        rafRef.current = null;
      }
      lastFrameRef.current = null;
    };
  }, [durationSeconds, isPlaying, loop, playbackSpeed, onPlayheadUpdate, renderAtTime]);

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
