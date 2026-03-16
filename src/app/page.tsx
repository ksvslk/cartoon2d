"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Stage from "@/components/Stage";
import TimelinePanel from "@/components/TimelinePanel";
import PropertiesPanel, { type ActionUpdate } from "@/components/PropertiesPanel";
import { Send, Play, Image as ImageIcon, ImageOff, Volume2, Sparkles, LayoutList, SlidersHorizontal, ChevronDown, ChevronUp, Loader2, Film, Trash2, Pencil, Plus, Copy, Mountain, Bug } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { processScenePromptStream, processSceneImageEdit } from "@/app/actions/scene";
import { ClipBinding, CompiledSceneData, SpatialTransform, StoryBeatData, StoryGenerationData, getStageDims, StageOrientation } from "@/lib/schema/story";
import { loadStoryFromStorage, saveStoryToStorage, clearStoryStorage, getProjectsList, createProject, deleteProject, updateProjectTitle, ProjectMetadata, loadActorIdentities, saveActorIdentity, updateProjectOrientation } from "@/lib/storage/db";
import { generateMotionClipForRig, processDraftsmanPrompt, suggestRigViewsFromRaster, type DraftQualityMode, type DraftQualityReview, type MotionDebugReport } from "@/app/actions/draftsman";
import { generateSpeechTTS } from "@/app/actions/tts";
import { executeSoundEffect } from "@/app/actions/sfx";
import { processSetDesignerPrompt } from "@/app/actions/set_designer";
import { VOICE_POOL, VoiceEntry } from "@/lib/voices";
import { DraftsmanData } from "@/lib/schema/rig";
import { RigViewer } from "@/components/RigViewer";
import { IKLab } from "@/components/IKLab";
import { RigClipPreview } from "@/components/RigClipPreview";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "@/lib/motion/semantics";
import { compileBeatToScene, inferTransformOnlyPlaybackPolicy } from "@/lib/motion/compiler";

import { ThemeToggle } from "@/components/ThemeToggle";

import {
  PLAYHEAD_UI_SYNC_MS,
  BASE_EXPORT_RESOLUTIONS,
  GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS,
  GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD,
  estimateStoryboardGenerationCost,
  estimateProPreviewTextCost,
  findCompiledBinding,
  buildClipPreviewScene,
  formatMotionDebugLines,
  classifyCompileLogLine,
  getBeatImageGenerationCost,
  sanitizeDurationSeconds,
  clampNumber,
  extractRigViews,
  extractPrimaryRigView,
  mergeRigViews,
  inferScopedViewId,
  mergeRigViewUpdate,
  selectRequiredRigViews,
  buildActorRigDescription,
  inferRigRefreshReason,
  inferFallbackRigViews,
  loadClientImage,
  findActorReferenceTransform,
  collectActorReferenceSamples,
  estimateActorReferenceBounds,
  extractActorReferenceCrop,
  buildActorReuseKey,
  cloneAnimationClip,
  findReusableActorClip,
} from "@/lib/utils/story_helpers";

async function getExactAudioDuration(dataUrl: string): Promise<number | null> {
  if (typeof window === "undefined") return null;
  try {
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();

    // Use an offline AudioContext so it doesn't require user interaction or hold audio devices
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    return audioBuffer.duration;
  } catch (err) {
    console.error(`[Audio Duration] Failed to exact decode track:`, err);
    return null;
  }
}

function renderCompileLogLine(line: string, key: string | number) {
  const kind = classifyCompileLogLine(line);
  const badgeClass =
    kind === "paid"
      ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
      : kind === "reused"
        ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-300"
        : kind === "error"
          ? "border-red-400/40 bg-red-500/10 text-red-300"
          : kind === "debug"
            ? "border-sky-400/30 bg-sky-500/10 text-sky-200"
            : kind === "review"
              ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
              : "border-neutral-700 bg-neutral-900 text-neutral-400";

  const lineClass =
    kind === "paid"
      ? "text-amber-300"
      : kind === "reused"
        ? "text-cyan-300"
        : kind === "error"
          ? "text-red-300"
          : kind === "debug"
            ? "text-sky-200"
            : kind === "review"
              ? "text-amber-200"
              : "text-emerald-400";

  return (
    <div key={key} className={`leading-relaxed flex items-start gap-2 ${lineClass}`}>
      {kind !== "neutral" && (
        <span className={`mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider ${badgeClass}`}>
          {kind}
        </span>
      )}
      <span className="min-w-0 break-words">{line}</span>
    </div>
  );
}

export default function Home() {

  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStartTime, setGenerationStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [storyData, setStoryData] = useState<StoryGenerationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [newCartoonName, setNewCartoonName] = useState<string | null>(null);

  const abortRef = useRef(false);

  const handleCancelAll = useCallback(() => {
    abortRef.current = true;
    setIsGenerating(false);
    setGenerationStartTime(null);
    setAnimatingSceneIndex(null);
    setAnimatingLogs(prev => [...prev, "❌ All active operations cancelled by user."]);
  }, []);


  // Actor Identity State (projectId -> actorId -> base64Image)
  const [actorReferences, setActorReferences] = useState<Record<string, string>>({});

  // Project Management State
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjectTitle, setEditProjectTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteBeatIndex, setConfirmDeleteBeatIndex] = useState<number | null>(null);
  const [confirmDeleteActorId, setConfirmDeleteActorId] = useState<string | null>(null);
  const [confirmClearStory, setConfirmClearStory] = useState(false);

  // Draftsman / Rigging State
  const [draftingActorId, setDraftingActorId] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isAiFixingRig, setIsAiFixingRig] = useState(false);
  const [draftedRig, setDraftedRig] = useState<DraftsmanData | null>(null);
  const [originalDraftedRig, setOriginalDraftedRig] = useState<DraftsmanData | null>(null);
  const [draftReview, setDraftReview] = useState<DraftQualityReview | null>(null);
  const [rigFixPrompt, setRigFixPrompt] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  // Set Designer State
  const [draftingBackgroundSceneIndex, setDraftingBackgroundSceneIndex] = useState<number | null>(null);
  const [isDraftingBackground, setIsDraftingBackground] = useState(false);
  const [draftBackgroundError, setDraftBackgroundError] = useState<string | null>(null);

  const [generatingAudioIndex, setGeneratingAudioIndex] = useState<number | null>(null);

  // Auto-Animate Macro State
  const [animatingSceneIndex, setAnimatingSceneIndex] = useState<number | null>(null);
  const [animatingLogs, setAnimatingLogs] = useState<string[]>([]);

  // Ticking elapsed timer for generation & animation
  useEffect(() => {
    const isBusy = isGenerating || animatingSceneIndex !== null;
    if (isBusy && !generationStartTime) {
      setGenerationStartTime(Date.now());
      setElapsedSeconds(0);
    } else if (!isBusy && generationStartTime) {
      setGenerationStartTime(null);
    }
    if (!isBusy) return;
    const interval = setInterval(() => {
      if (generationStartTime) {
        setElapsedSeconds(Math.floor((Date.now() - generationStartTime) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isGenerating, animatingSceneIndex, generationStartTime]);
  // Persistent per-scene logs that survive after animation completes
  const [completedAnimLogs, setCompletedAnimLogs] = useState<Record<number, string[]>>({});
  const [dismissedCompileReports, setDismissedCompileReports] = useState<Record<number, boolean>>({});
  // Per-beat image generation cost (from Gemini usage metadata)
  const [beatGenerationCosts, setBeatGenerationCosts] = useState<Record<number, { tokens: number; cost: number }>>({});
  const [playbackScope, setPlaybackScope] = useState<"scene" | "all">("scene");
  const [exportResolution, setExportResolution] = useState<keyof typeof BASE_EXPORT_RESOLUTIONS>("1080p");
  const [isExportDropdownOpen, setIsExportDropdownOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [exportPlayheadTime, setExportPlayheadTime] = useState(0);
  const [exportBeatState, setExportBeatState] = useState<{
    beat: StoryGenerationData["beats"][number];
    compiledScene: CompiledSceneData;
    key: string;
  } | null>(null);
  const exportStageHostRef = useRef<HTMLDivElement>(null);
  const exportTimelineDurationRef = useRef(0);
  const exportTimelineReadyResolverRef = useRef<((duration: number) => void) | null>(null);

  // Stage Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [sceneTimelineDurations, setSceneTimelineDurations] = useState<Record<number, number>>({});



  // Stage Selection State
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState<number | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] = useState<'start' | 'end' | null>(null);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number | null>(null);
  const [selectedCameraIndex, setSelectedCameraIndex] = useState<number | null>(null);
  const [scenePreviewIndex, setScenePreviewIndex] = useState<number | null>(null);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [clipPreviewState, setClipPreviewState] = useState<{ actorId: string; clipName: string } | null>(null);
  const [clipPreviewPlaying, setClipPreviewPlaying] = useState(true);
  const [clipPreviewPlayhead, setClipPreviewPlayhead] = useState(0);
  const clipPreviewPlayheadRef = useRef(0);
  const clipPreviewPlayingRef = useRef(clipPreviewPlaying);

  // Timeline Playhead & Frame State
  const [playheadPos, setPlayheadPos] = useState<number>(0);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [fps, setFps] = useState<12 | 24 | 30 | 60>(60);
  const [timelineZoom, setTimelineZoom] = useState<number>(1);
  const isPlayingRef = useRef(isPlaying);
  const livePlayheadPosRef = useRef(0);
  const lastPlayheadUiSyncAtRef = useRef(0);

  // Timeline Pill Drag State
  const dragPillRef = useRef<{
    idx: number;
    actorId: string;
    mode: 'move' | 'resize';
    startX: number;
    initialDelay: number;
    initialDuration: number;
    isDialogue?: boolean;
  } | null>(null);
  const [showObstacleDebug, setShowObstacleDebug] = useState(false);
  const [stageOrientation, setStageOrientation] = useState<StageOrientation>("landscape");
  const stageDims = getStageDims(stageOrientation);
  const storyboardImageFrameClass = stageOrientation === "portrait"
    ? "w-full max-w-[17rem] aspect-[9/16] mx-auto"
    : "w-full aspect-video";
  const previewImageFrameClass = stageOrientation === "portrait"
    ? "w-full max-w-[20rem] aspect-[9/16] mx-auto"
    : "w-full aspect-video";
  const referenceImageFrameClass = stageOrientation === "portrait"
    ? "w-36 aspect-[9/16]"
    : "w-48 aspect-video";
  const EXPORT_RESOLUTIONS = Object.fromEntries(
    Object.entries(BASE_EXPORT_RESOLUTIONS).map(([key, value]) => [
      key,
      stageOrientation === "portrait"
        ? { label: value.label, width: value.height, height: value.width }
        : value,
    ])
  ) as { [K in keyof typeof BASE_EXPORT_RESOLUTIONS]: { label: string; width: number; height: number } };
  const timelineRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clipPreviewPlayingRef.current = clipPreviewPlaying;
    if (!clipPreviewPlaying) {
      setClipPreviewPlayhead(prev => {
        const next = clipPreviewPlayheadRef.current;
        return Math.abs(prev - next) > 0.0001 ? next : prev;
      });
    }
  }, [clipPreviewPlaying]);

  useEffect(() => {
    if (!clipPreviewPlaying) {
      clipPreviewPlayheadRef.current = clipPreviewPlayhead;
    }
  }, [clipPreviewPlayhead, clipPreviewPlaying]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (!isPlaying) {
      lastPlayheadUiSyncAtRef.current = 0;
      setPlayheadPos(prev => {
        const next = livePlayheadPosRef.current;
        return Math.abs(prev - next) > 0.0001 ? next : prev;
      });
    }
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      livePlayheadPosRef.current = playheadPos;
    }
  }, [isPlaying, playheadPos]);

  const selectedBeat = useMemo(
    () => (storyData && storyData.beats.length > 0 ? storyData.beats[selectedSceneIndex] : null),
    [storyData, selectedSceneIndex]
  );
  const selectedCompiledScene = selectedBeat?.compiled_scene ?? null;
  const projectCostSummary = useMemo(() => {
    if (!storyData) {
      return { cost: 0, tokens: 0, compiledScenes: 0 };
    }

    return storyData.beats.reduce((acc, beat, beatIndex) => {
      const imageCost = getBeatImageGenerationCost(beat, beatIndex, beatGenerationCosts);
      acc.cost += imageCost?.cost || 0;
      acc.tokens += imageCost?.tokens || 0;
      acc.cost += beat.compile_report?.scene_cost_estimate || 0;
      acc.tokens += beat.compile_report?.total_tokens || 0;

      const audioCost = beat.audio?.reduce((sum, a) => sum + (a.generation_cost?.cost || 0), 0) || 0;
      const audioChars = beat.audio?.reduce((sum, a) => sum + (a.generation_cost?.characters || 0), 0) || 0;
      acc.cost += audioCost;
      acc.tokens += audioChars;

      if (beat.compiled_scene) acc.compiledScenes += 1;
      return acc;
    }, { cost: 0, tokens: 0, compiledScenes: 0 });
  }, [beatGenerationCosts, storyData]);

  const clipPreviewBundle = useMemo(() => {
    if (!clipPreviewState || !storyData) return null;
    const actor = storyData.actors_detected.find(candidate => candidate.id === clipPreviewState.actorId);
    const rig = actor?.drafted_rig;
    if (!actor || !rig) return null;
    return {
      actor,
      ...buildClipPreviewScene(actor.id, clipPreviewState.clipName, rig, stageDims),
    };
  }, [clipPreviewState, storyData, stageDims]);

  const availableRigs = useMemo(
    () =>
      storyData
        ? storyData.actors_detected.reduce((acc, actor) => {
          if (actor.drafted_rig) acc[actor.id] = actor.drafted_rig;
          return acc;
        }, {} as Record<string, DraftsmanData>)
        : {},
    [storyData]
  );

  // Total duration of the selected scene (seconds), used for frame math
  const totalDuration = useMemo(() => {
    const compiledDuration = sceneTimelineDurations[selectedSceneIndex];
    if (typeof compiledDuration === "number" && Number.isFinite(compiledDuration) && compiledDuration > 0) {
      return sanitizeDurationSeconds(compiledDuration);
    }
    if (
      typeof selectedCompiledScene?.duration_seconds === "number" &&
      Number.isFinite(selectedCompiledScene.duration_seconds) &&
      selectedCompiledScene.duration_seconds > 0
    ) {
      return sanitizeDurationSeconds(selectedCompiledScene.duration_seconds);
    }

    if (!selectedBeat || selectedBeat.actions.length === 0) return 10;
    const fallbackDuration = Math.max(
      2,
      ...selectedBeat.actions.map(a => {
        const delay = sanitizeDurationSeconds(a.animation_overrides?.delay, 0);
        const actionDuration = sanitizeDurationSeconds(a.duration_seconds, 2);
        return delay + actionDuration;
      }),
    );
    return sanitizeDurationSeconds(fallbackDuration);
  }, [sceneTimelineDurations, selectedSceneIndex, selectedBeat, selectedCompiledScene]);

  // Display duration: fixed visual scale for timeline (accounts for all layer durations + buffer)
  const cameraDuration = selectedBeat?.cameras?.[0]?.duration ?? totalDuration;
  const computedDisplayDuration = Math.max(Math.ceil(Math.max(totalDuration, cameraDuration) * 1.3), 3);
  // Freeze during drag so the visual scale doesn't shift while the user is dragging
  const [frozenDisplayDuration, setFrozenDisplayDuration] = useState<number | null>(null);
  const displayDuration = frozenDisplayDuration ?? computedDisplayDuration;

  // Playhead callbacks — called by Stage when GSAP timeline ticks or completes
  const handlePlayheadUpdate = useCallback((timeSeconds: number) => {
    const pct = Math.min(100, displayDuration > 0 ? (timeSeconds / displayDuration) * 100 : 0);
    livePlayheadPosRef.current = pct;
    if (!isPlayingRef.current) {
      setPlayheadPos(pct);
      return;
    }

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if ((now - lastPlayheadUiSyncAtRef.current) < PLAYHEAD_UI_SYNC_MS && pct < 99.9) {
      return;
    }

    lastPlayheadUiSyncAtRef.current = now;
    setPlayheadPos(pct);
  }, [displayDuration]);

  // Pill Drag Handlers — zero React re-renders during drag for instant response
  const handlePillMouseDown = useCallback((e: React.MouseEvent, idx: number, actorId: string, delay: number, duration: number, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    setIsPlaying(false);

    const capturedDisplayDuration = displayDuration;

    // Get the pill DOM element BEFORE any state updates could replace it
    const pillEl = mode === 'resize'
      ? (e.currentTarget as HTMLElement).parentElement as HTMLElement
      : e.currentTarget as HTMLElement;

    const parentWidthPx = Math.max(1, pillEl.parentElement?.clientWidth ?? 400);

    // Snap targets built from compiled scene bindings (same source as pill rendering)
    const beat = storyData?.beats[selectedSceneIndex];
    const endTimeSnapTargets: number[] = [];
    const durationSnapTargets: number[] = [];
    if (beat) {
      const camDur = beat.cameras?.[0]?.duration ?? totalDuration;
      endTimeSnapTargets.push(camDur);
      durationSnapTargets.push(camDur);

      // Use compiled bindings for accurate snap targets (matches pill rendering)
      const compiledTracks = beat.compiled_scene?.instance_tracks ?? [];
      for (const track of compiledTracks) {
        for (const binding of track.clip_bindings) {
          if (binding.source_action_index === idx) continue; // skip self
          const bindStart = binding.start_time ?? 0;
          const bindDur = binding.duration_seconds ?? 2;
          endTimeSnapTargets.push(bindStart + bindDur);
          durationSnapTargets.push(bindDur);
        }
      }

      // Fallback: if no compiled scene, use raw actions
      if (compiledTracks.length === 0) {
        beat.actions.forEach((a, i) => {
          if (i === idx) return;
          const actionDelay = a.animation_overrides?.delay ?? 0;
          const actionDur = a.duration_seconds || 2;
          endTimeSnapTargets.push(actionDelay + actionDur);
          durationSnapTargets.push(actionDur);
        });
      }
    }
    const snapThresholdSec = (8 / parentWidthPx) * capturedDisplayDuration;

    dragPillRef.current = { idx, actorId, mode, startX: e.clientX, initialDelay: delay, initialDuration: duration };
    // Disable CSS transitions during drag so the pill follows the mouse instantly
    pillEl.style.transition = 'none';

    let finalValue = mode === 'resize' ? duration : delay;

    const handleWindowMouseMove = (eMouse: MouseEvent) => {
      if (!dragPillRef.current) return;
      const deltaX = eMouse.clientX - dragPillRef.current.startX;

      if (mode === 'resize') {
        const deltaSec = (deltaX / parentWidthPx) * capturedDisplayDuration;
        let newDuration = Math.max(0.1, dragPillRef.current.initialDuration + deltaSec);
        const endTime = delay + newDuration;

        // Snap to other layer end positions
        for (const target of endTimeSnapTargets) {
          if (Math.abs(endTime - target) < snapThresholdSec) {
            newDuration = Math.max(0.1, target - delay);
            break;
          }
        }
        // Snap to matching duration (same length as another layer)
        for (const target of durationSnapTargets) {
          if (Math.abs(newDuration - target) < snapThresholdSec) {
            newDuration = Math.max(0.1, target);
            break;
          }
        }

        finalValue = newDuration;
        pillEl.style.width = `${(newDuration / capturedDisplayDuration) * 100}%`;
      } else {
        const deltaSec = (deltaX / parentWidthPx) * capturedDisplayDuration;
        const newDelay = Math.max(0, dragPillRef.current.initialDelay + deltaSec);
        finalValue = newDelay;
        pillEl.style.left = `${(newDelay / capturedDisplayDuration) * 100}%`;
      }
    };

    const handleWindowMouseUp = () => {
      dragPillRef.current = null;
      pillEl.style.transition = '';
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);

      // ALL state updates happen here, after drag is done
      setSelectedActionIndex(idx);
      setSelectedActorId(actorId);
      setFrozenDisplayDuration(null);

      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        const newActions = [...newBeats[selectedSceneIndex].actions];
        const action = { ...newActions[idx] };

        if (mode === 'resize') {
          action.duration_seconds = finalValue;
        } else {
          action.animation_overrides = { ...action.animation_overrides, delay: finalValue };
        }

        newActions[idx] = action;
        const nextBeat = { ...newBeats[selectedSceneIndex], actions: newActions };
        const previousCompiledScene = selectedSceneIndex > 0
          ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
          : null;
        nextBeat.compiled_scene = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
        newBeats[selectedSceneIndex] = nextBeat;
        return { ...prev, beats: newBeats };
      });
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
  }, [totalDuration, selectedSceneIndex, displayDuration, storyData, availableRigs, stageOrientation]);

  const handleCameraPillMouseDown = useCallback((e: React.MouseEvent, index: number, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    setIsPlaying(false);

    const capturedDisplayDuration = displayDuration;

    const pillEl = mode === 'resize'
      ? (e.currentTarget as HTMLElement).parentElement as HTMLElement
      : e.currentTarget as HTMLElement;
    pillEl.style.transition = 'none';

    const parentWidthPx = Math.max(1, pillEl.parentElement?.clientWidth ?? 400);

    const endTimeSnapTargets: number[] = [];
    const durationSnapTargets: number[] = [];
    const beat = storyData?.beats[selectedSceneIndex];
    let totalDuration = 0;

    const initialCamera = beat?.cameras?.[index];
    const initialStartTime = initialCamera?.start_time || 0;
    const initialDuration = initialCamera?.duration || 2;
    const startX = e.clientX;
    let finalValue = mode === 'resize' ? initialDuration : initialStartTime;

    if (beat) {
      const audioMax = Math.max(0, ...(beat.audio || []).map(a => (a.start_time || 0) + (a.duration_seconds || 0)));
      const actionMax = Math.max(0, ...(beat.actions || []).map(a => (a.start_time || 0) + (a.duration_seconds || 0)));
      totalDuration = Math.max(audioMax, actionMax);

      const firstCam = beat.cameras?.[0];
      const camDur = (firstCam?.start_time || 0) + (firstCam?.duration ?? totalDuration);

      endTimeSnapTargets.push(camDur);
      durationSnapTargets.push(camDur);

      const compiledTracks = beat.compiled_scene?.instance_tracks ?? [];
      for (const track of compiledTracks) {
        for (const binding of track.clip_bindings) {
          const bindStart = binding.start_time ?? 0;
          const bindDur = binding.duration_seconds ?? 2;
          endTimeSnapTargets.push(bindStart + bindDur);
          durationSnapTargets.push(bindDur);
        }
      }
      if (compiledTracks.length === 0) {
        beat.actions.forEach(a => {
          const actionDelay = a.animation_overrides?.delay ?? 0;
          const actionDur = a.duration_seconds || 2;
          endTimeSnapTargets.push(actionDelay + actionDur);
          durationSnapTargets.push(actionDur);
        });
      }
    }
    const snapThresholdSec = (8 / parentWidthPx) * capturedDisplayDuration;

    const handleWindowMouseMove = (eMouse: MouseEvent) => {
      const deltaX = eMouse.clientX - startX;
      const deltaSec = (deltaX / parentWidthPx) * capturedDisplayDuration;

      if (mode === 'resize') {
        let newDuration = Math.max(0.5, initialDuration + deltaSec);

        for (const target of endTimeSnapTargets) {
          if (Math.abs(newDuration - target) < snapThresholdSec) {
            newDuration = Math.max(0.5, target);
            break;
          }
        }
        for (const target of durationSnapTargets) {
          if (Math.abs(newDuration - target) < snapThresholdSec) {
            newDuration = Math.max(0.5, target);
            break;
          }
        }

        finalValue = newDuration;
        pillEl.style.width = `${(newDuration / capturedDisplayDuration) * 100}%`;
      } else {
        const newStart = Math.max(0, initialStartTime + deltaSec);
        finalValue = newStart;
        pillEl.style.left = `${(newStart / capturedDisplayDuration) * 100}%`;
      }
    };

    const handleWindowMouseUp = () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      pillEl.style.transition = '';
      setFrozenDisplayDuration(null);

      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        const currentBeat = { ...newBeats[selectedSceneIndex] };

        const updatedBeats = newBeats.map(b => {
          let maxTime = 0;

          b.actions?.forEach(action => {
            const end = (action.start_time || 0) + (action.duration_seconds || 0);
            if (end > maxTime) maxTime = end;
          });

          b.audio?.forEach(audio => {
            const end = (audio.start_time || 0) + (audio.duration_seconds || 0);
            if (end > maxTime) maxTime = end;
          });

          const firstCamDur = b.cameras?.[index]?.duration;
          if (firstCamDur && firstCamDur > maxTime) maxTime = firstCamDur;

          const currentFirstCam = b.cameras?.[index] || { zoom: 1, x: 960, y: 540, rotation: 0, start_time: 0 };
          const updatedFirstCam = { ...currentFirstCam, duration: currentFirstCam.duration || maxTime };

          return b; // Skip maxTime modification since cameras can overlap
        });

        if (!currentBeat.cameras) currentBeat.cameras = [];
        const newCameras = [...currentBeat.cameras];

        if (newCameras.length > index) {
          const camToUpdate = { ...newCameras[index] };
          if (mode === 'resize') {
            camToUpdate.duration = finalValue;
          } else {
            camToUpdate.start_time = finalValue;
          }
          newCameras[index] = camToUpdate;
        } else {
          newCameras[0] = { start_time: mode === 'move' ? finalValue : 0, zoom: 1, x: 960, y: 540, rotation: 0, duration: mode === 'resize' ? finalValue : undefined };
        }

        currentBeat.cameras = newCameras;

        if (currentBeat.compiled_scene && index === 0 && mode === 'resize') {
          currentBeat.compiled_scene = { ...currentBeat.compiled_scene, duration_seconds: finalValue };
        }
        updatedBeats[selectedSceneIndex] = currentBeat;
        return { ...prev, beats: updatedBeats };
      });
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
  }, [totalDuration, selectedSceneIndex, displayDuration, storyData, availableRigs, stageOrientation]);

  const handleDialoguePillMouseDown = useCallback((e: React.MouseEvent, actorId: string, audioIndex: number, startTime: number, duration: number, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    setIsPlaying(false);

    const capturedDisplayDuration = displayDuration;

    const pillEl = mode === 'resize'
      ? (e.currentTarget as HTMLElement).parentElement as HTMLElement
      : e.currentTarget as HTMLElement;
    pillEl.style.transition = 'none';

    const parentWidthPx = Math.max(1, pillEl.parentElement?.clientWidth ?? 400);

    dragPillRef.current = { idx: audioIndex, actorId, mode, startX: e.clientX, initialDelay: startTime, initialDuration: duration, isDialogue: true };

    let finalValue = mode === 'resize' ? duration : startTime;

    const handleWindowMouseMove = (eMouse: MouseEvent) => {
      if (!dragPillRef.current) return;
      const deltaX = eMouse.clientX - dragPillRef.current.startX;
      const deltaSec = (deltaX / parentWidthPx) * capturedDisplayDuration;

      if (mode === 'resize') {
        const newDuration = Math.max(0.1, dragPillRef.current.initialDuration + deltaSec);
        finalValue = newDuration;
        pillEl.style.width = `${(newDuration / capturedDisplayDuration) * 100}%`;
      } else { // mode === 'move'
        const newStart = Math.max(0, dragPillRef.current.initialDelay + deltaSec);
        finalValue = newStart;
        pillEl.style.left = `${(newStart / capturedDisplayDuration) * 100}%`;
      }
    };

    const handleWindowMouseUp = () => {
      dragPillRef.current = null;
      pillEl.style.transition = '';
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      setFrozenDisplayDuration(null);

      setSelectedAudioIndex(audioIndex);
      setSelectedActionIndex(null);
      setSelectedCameraIndex(null);
      setSelectedKeyframe(null);

      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        const currentBeat = newBeats[selectedSceneIndex];
        if (!currentBeat || !currentBeat.audio) return prev;

        const newAudio = [...currentBeat.audio];
        const audioItem = { ...newAudio[audioIndex] };

        if (mode === 'resize') {
          audioItem.duration_seconds = finalValue;
        } else {
          audioItem.start_time = finalValue;
        }

        newAudio[audioIndex] = audioItem;
        newBeats[selectedSceneIndex] = { ...currentBeat, audio: newAudio };
        return { ...prev, beats: newBeats };
      });
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
  }, [selectedSceneIndex, displayDuration, storyData]);

  const currentTimeSeconds = (playheadPos / 100) * displayDuration;
  const currentFrame = Math.round(currentTimeSeconds * fps);
  const totalFrames = Math.max(1, Math.min(Math.round(totalDuration * fps), 216000));
  const selectedStageKey = selectedBeat
    ? `scene-${selectedSceneIndex}-${selectedBeat.scene_number}-${selectedCompiledScene?.duration_seconds ?? selectedBeat.actions.length}`
    : "scene-empty";

  useEffect(() => {
    if (!isDraggingPlayhead) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const scrollLeft = timelineRef.current.scrollLeft;

      const sidebarWidth = 192; // 'w-48' is 192px
      const innerWidth = timelineRef.current.scrollWidth - sidebarWidth;

      let newX = (e.clientX - rect.left + scrollLeft) - sidebarWidth;
      newX = Math.max(0, Math.min(newX, innerWidth));
      const newPercent = (newX / innerWidth) * 100;
      setPlayheadPos(newPercent);
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead]);


  // Audio Generation
  const handleGenerateVoices = async (sceneIndex: number) => {
    if (!storyData || !storyData.beats[sceneIndex]) return;
    try {
      setGeneratingAudioIndex(sceneIndex);
      const beat = storyData.beats[sceneIndex];
      const prevAudio = beat.audio || [];

      const audioToGenerate = prevAudio.filter(a => a.type === 'dialogue' && a.text && (!a.audio_data_url || !a.visemes || a.visemes.length === 0));
      if (audioToGenerate.length === 0) {
        setGeneratingAudioIndex(null);
        return;
      }

      console.log(`[TTS] Requesting ${audioToGenerate.length} voice tracks in parallel...`);

      // Run parallel GCP TTS generation
      const voicePromises = audioToGenerate.map(async (audio) => {
        const voiceId = audio.voice_id || "en-US-Standard-F";
        const ttsResult = await generateSpeechTTS(audio.text!, voiceId, audio.delivery_style);
        const exactDuration = await getExactAudioDuration(ttsResult.audioDataUrl);
        return { audio, ttsResult, exactDuration };
      });

      const results = await Promise.all(voicePromises);

      // Merge results back into the beat's audio array
      const newAudio = prevAudio.map(audio => {
        const matchingResult = results.find(r => r.audio === audio);
        if (matchingResult) {
          console.log(`[TTS Client] Received visemes for track:`, matchingResult.ttsResult.visemes?.length || 0);
          console.log(`[TTS Client Debug] Words:`, matchingResult.ttsResult.debugWords?.length, `Timepoints:`, matchingResult.ttsResult.debugTimepoints?.length);
          console.log(`[TTS Client Debug Raw Data]:`, { words: matchingResult.ttsResult.debugWords, timepoints: matchingResult.ttsResult.debugTimepoints });
          const lastViseme = matchingResult.ttsResult.visemes?.[matchingResult.ttsResult.visemes.length - 1];
          const backupDuration = lastViseme ? lastViseme.time + lastViseme.duration : 2.0;
          const exactDur = matchingResult.exactDuration ?? (matchingResult.ttsResult.durationSeconds || backupDuration);

          let stretchedVisemes = matchingResult.ttsResult.visemes;

          // If the backend had to estimate duration (e.g. Journey voices with no timepoints),
          // stretch the visemes to perfectly span the true decoded browser audio length.
          if (exactDur && matchingResult.ttsResult.durationSeconds && stretchedVisemes && stretchedVisemes.length > 0) {
            const ratio = exactDur / matchingResult.ttsResult.durationSeconds;
            // Only stretch if the estimate is off by more than 5%
            if (Math.abs(ratio - 1.0) > 0.05) {
              stretchedVisemes = stretchedVisemes.map(v => ({
                ...v,
                time: v.time * ratio,
                duration: v.duration * ratio
              }));
            }
          }

          return {
            ...audio,
            audio_data_url: matchingResult.ttsResult.audioDataUrl,
            visemes: stretchedVisemes,
            duration_seconds: exactDur,
            generation_cost: {
              cost: matchingResult.ttsResult.costEstimate,
              characters: matchingResult.ttsResult.billedCharacters
            }
          };
        }
        return audio;
      });

      // Generate SFX/music audio for items without audio_data_url
      const sfxToGenerate = prevAudio.filter(a => (a.type === 'sfx' || a.type === 'music') && a.description && !a.audio_data_url);
      if (sfxToGenerate.length > 0) {
        console.log(`[SFX] Generating ${sfxToGenerate.length} sound effects...`);
        const sfxPromises = sfxToGenerate.map(async (audio) => {
          const result = await executeSoundEffect({ prompt: audio.description! });
          return { audio, result };
        });
        const sfxResults = await Promise.all(sfxPromises);
        sfxResults.forEach(({ audio, result }) => {
          if (result.url) {
            const idx = newAudio.findIndex(a => a === audio);
            if (idx !== -1) {
              newAudio[idx] = { ...newAudio[idx], audio_data_url: result.url };
            }
          } else if (result.error) {
            console.error(`[SFX] Failed for '${audio.description}': ${result.error}`);
          }
        });
      }

      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        newBeats[sceneIndex] = { ...beat, audio: newAudio };
        return { ...prev, beats: newBeats };
      });

    } catch (err: any) {
      console.error("[TTS ERROR]", err);
    } finally {
      setGeneratingAudioIndex(null);
    }
  };

  const generateRigDraft = async ({
    generationReference,
    description,
    requiredViews,
    reviewImages,
    qualityMode,
  }: {
    generationReference: string;
    description: string;
    requiredViews?: string[];
    reviewImages?: string[];
    qualityMode?: DraftQualityMode;
  }) => {
    return processDraftsmanPrompt(generationReference, description, requiredViews, reviewImages, qualityMode);
  };

  const handlePlayComplete = () => {
    setIsPlaying(false);
    // Reset playhead to start — keeping it at 100 (end) causes Effect 3 to seek
    // the timeline to the end, where stale opacity/display states cause dissolve.
    livePlayheadPosRef.current = 0;
    setPlayheadPos(0);
  };

  const handleTimelineReady = (durationSeconds: number) => {
    const safeDuration = sanitizeDurationSeconds(durationSeconds, 0);
    if (safeDuration <= 0) return;
    setSceneTimelineDurations(prev => {
      const current = prev[selectedSceneIndex];
      if (current === safeDuration) return prev;
      return { ...prev, [selectedSceneIndex]: safeDuration };
    });
  };

  const handleJumpToStart = () => {
    setIsPlaying(false);
    livePlayheadPosRef.current = 0;
    setPlayheadPos(0);
  };

  const handleJumpToEnd = () => {
    setIsPlaying(false);
    const endPct = displayDuration > 0 ? (totalDuration / displayDuration) * 100 : 100;
    livePlayheadPosRef.current = endPct;
    setPlayheadPos(endPct);
  };

  const handleTogglePlayback = () => {
    if (!selectedBeat) return;
    if (isPlaying) {
      setPlayheadPos(livePlayheadPosRef.current);
      setIsPlaying(false);
      return;
    }
    const endPct = displayDuration > 0 ? (totalDuration / displayDuration) * 100 : 100;
    if (playheadPos >= endPct * 0.999) {
      livePlayheadPosRef.current = 0;
      setPlayheadPos(0);
    }
    setIsPlaying(true);
  };

  useEffect(() => {
    setIsPlaying(false);
    livePlayheadPosRef.current = 0;
    setPlayheadPos(0);
    setSelectedActionIndex(null);
    setSelectedActorId(null);

    // Auto-compile if the selected beat has no compiled_scene
    if (storyData?.beats[selectedSceneIndex] && !storyData.beats[selectedSceneIndex].compiled_scene) {
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        const beat = newBeats[selectedSceneIndex];
        if (!beat || beat.compiled_scene) return prev;
        const previousCompiledScene = selectedSceneIndex > 0
          ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
          : null;
        const recompiled = compileBeatToScene(beat, availableRigs, previousCompiledScene, stageOrientation);
        newBeats[selectedSceneIndex] = { ...beat, compiled_scene: recompiled };
        console.log('[auto-compile] Compiled missing scene data for scene', selectedSceneIndex + 1);
        return { ...prev, beats: newBeats };
      });
    }
  }, [selectedSceneIndex]);

  const handleClipPreviewToggle = useCallback(() => {
    if (clipPreviewPlayingRef.current) {
      setClipPreviewPlayhead(clipPreviewPlayheadRef.current);
      setClipPreviewPlaying(false);
      return;
    }
    setClipPreviewPlaying(true);
  }, []);

  const handleClipPreviewPlayheadUpdate = useCallback((timeSeconds: number) => {
    const duration = clipPreviewBundle?.compiledScene.duration_seconds || 1;
    const next = Math.min(duration, timeSeconds);
    clipPreviewPlayheadRef.current = next;
    if (!clipPreviewPlayingRef.current) {
      setClipPreviewPlayhead(next);
    }
  }, [clipPreviewBundle]);

  const waitForAnimationFrames = (count: number = 2) =>
    new Promise<void>((resolve) => {
      const tick = (remaining: number) => {
        if (remaining <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(() => tick(remaining - 1));
      };
      tick(count);
    });

  const waitForExportTimelineReady = () =>
    new Promise<number>((resolve) => {
      exportTimelineReadyResolverRef.current = resolve;
    });

  const sanitizeSvgMarkup = (svgMarkup: string) => {
    if (svgMarkup.includes('xmlns="http://www.w3.org/2000/svg"')) {
      return svgMarkup;
    }
    return svgMarkup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  };

  const captureExportStageSvg = async (timeSeconds: number) => {
    setExportPlayheadTime(timeSeconds);
    await waitForAnimationFrames(2);
    const svg = exportStageHostRef.current?.querySelector("svg");
    if (!svg) {
      throw new Error("Export stage did not render an SVG frame.");
    }
    return sanitizeSvgMarkup(svg.outerHTML);
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const loadSvgIntoImage = (svgMarkup: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const blob = new Blob([sanitizeSvgMarkup(svgMarkup)], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      };
      img.src = url;
    });

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const canvasToPngBlob = (canvas: HTMLCanvasElement) =>
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to encode a frame as PNG."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });

  // Panel Editing State
  const [editingBeatIndex, setEditingBeatIndex] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [isEditingImage, setIsEditingImage] = useState(false);

  // Panel Insertion State
  const [insertAtIndex, setInsertAtIndex] = useState<number | null>(null);
  const [insertPrompt, setInsertPrompt] = useState("");

  // Load from local IndexedDB on mount
  useEffect(() => {
    const initializeApp = async () => {
      let activeProjectId: string | null = null;
      try {
        const loadedProjects = await getProjectsList();

        if (loadedProjects.length === 0) {
          // First time user: create default project
          const newProj = await createProject("My First Cartoon");
          setProjects([newProj]);
          activeProjectId = newProj.id;
        } else {
          setProjects(loadedProjects);
          // Load most recently updated project
          const recent = [...loadedProjects].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          activeProjectId = recent.id;
        }

        setCurrentProjectId(activeProjectId);

        // Load the actual story data for the active project
        const data = await loadStoryFromStorage(activeProjectId);
        setStoryData(data || { title: "", actors_detected: [], beats: [] });

        // Load project's actor ID registry
        const actors = await loadActorIdentities(activeProjectId);
        setActorReferences(actors);

        // Restore orientation for the active project
        const activeProject = loadedProjects.find(p => p.id === activeProjectId);
        setStageOrientation(activeProject?.orientation ?? "landscape");
      } catch (err) {
        console.error("Failed to initialize projects:", err);
      } finally {
        setIsLoaded(true);
      }
    };
    initializeApp();
  }, []);

  // Save to local IndexedDB whenever storyData changes
  useEffect(() => {
    if (isLoaded && storyData && currentProjectId) {
      saveStoryToStorage(currentProjectId, storyData).then(() => {
        // Silently refresh project list to get updated timestamps
        getProjectsList().then(setProjects);
      });
    }
  }, [storyData, isLoaded, currentProjectId]);

  // Utility to compress context images before sending to API to save tokens/payload
  const downscaleBase64Image = (base64Str: string, maxWidth: number = 512): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64Str;
      img.onload = () => {
        if (img.width <= maxWidth) {
          return resolve(base64Str);
        }
        const scaleSize = maxWidth / img.width;
        const canvas = document.createElement('canvas');
        canvas.width = maxWidth;
        canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve(base64Str); // fallback if it fails
    });
  };

  // --- Project Management Handlers ---

  const handleCreateProject = async (name?: string) => {
    try {
      const title = (name || '').trim() || `New Cartoon ${projects.length + 1}`;
      const newProj = await createProject(title);
      setProjects(prev => [...prev, newProj]);
      setCurrentProjectId(newProj.id);
      setStoryData({ title: "", actors_detected: [], beats: [] });
      setActorReferences({});
      setIsProjectDropdownOpen(false);
      setNewCartoonName(null);
    } catch (err) {
      console.error("Failed to create project", err);
    }
  };

  const handleSwitchProject = async (id: string) => {
    if (id === currentProjectId) return;
    try {
      setCurrentProjectId(id);
      const data = await loadStoryFromStorage(id);
      setStoryData(data || { title: "", actors_detected: [], beats: [] });

      const actors = await loadActorIdentities(id);
      setActorReferences(actors);

      const proj = projects.find(p => p.id === id);
      setStageOrientation(proj?.orientation ?? "landscape");

      setIsProjectDropdownOpen(false);
    } catch (err) {
      console.error("Failed to switch project", err);
    }
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // Inline Confirmation Flow
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);

      // Auto-cancel confirmation after 3 seconds
      setTimeout(() => {
        setConfirmDeleteId(current => current === id ? null : current);
      }, 3000);
      return;
    }

    try {
      await deleteProject(id);
      const remaining = projects.filter(p => p.id !== id);
      setProjects(remaining);

      if (currentProjectId === id) {
        if (remaining.length > 0) {
          handleSwitchProject(remaining[0].id);
        } else {
          // Explicitly wipe the screen before creating a new dummy project
          setStoryData({ title: "", actors_detected: [], beats: [] });
          setActorReferences({});
          handleCreateProject();
        }
      }
      setConfirmDeleteId(null);
    } catch (err) {
      console.error("Failed to delete project", err);
      setConfirmDeleteId(null);
    }
  };

  const handleDeleteActor = (actorId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (confirmDeleteActorId !== actorId) {
      setConfirmDeleteActorId(actorId);

      // Auto-cancel confirmation after 3 seconds
      setTimeout(() => {
        setConfirmDeleteActorId(current => current === actorId ? null : current);
      }, 3000);
      return;
    }

    setStoryData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        actors_detected: prev.actors_detected.filter(a => a.id !== actorId)
      };
    });

    if (selectedActorId === actorId) {
      setSelectedActorId(null);
    }

    setConfirmDeleteActorId(null);
  };

  const handleUpdateProjectTitle = async (id: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    try {
      await updateProjectTitle(id, newTitle);
      setProjects(prev => prev.map(p => p.id === id ? { ...p, title: newTitle } : p));
      setEditingProjectId(null);
    } catch (err) {
      console.error("Failed to update project title", err);
    }
  };

  const handleOrientationChange = async (orientation: StageOrientation) => {
    setStageOrientation(orientation);
    if (currentProjectId) {
      await updateProjectOrientation(currentProjectId, orientation);
    }
  };

  // --- Generation Handlers ---

  const handleGenerate = async () => {
    // ... existing function remains unchanged
    if (!prompt.trim()) return;

    abortRef.current = false;
    setIsGenerating(true);
    setError(null);

    // We do NOT clear storyData here anymore, because we are appending!
    const initialBeatsLength = storyData ? storyData.beats.length : 0;

    let contextBeats;
    if (storyData && storyData.beats.length > 0) {
      // Deep copy the last two beats to avoid mutating React state
      contextBeats = JSON.parse(JSON.stringify(storyData.beats.slice(-2)));
      // Downscale images for API payload to save tokens/MB limits
      for (const beat of contextBeats) {
        if (beat.image_data) {
          beat.image_data = await downscaleBase64Image(beat.image_data, 512);
        }
      }
    }

    try {
      // Auto-detect screenplay-style prompts that need multiple beats
      const dialogueLineCount = (prompt.match(/^[A-Z][a-zA-Z\s]+:/gm) || []).length;
      const cameraDirectionCount = (prompt.match(/\[Camera[:\s]/gi) || []).length;
      const isLongScript = dialogueLineCount >= 5 || cameraDirectionCount >= 3;
      console.log(`[Director] Screenplay detection: ${dialogueLineCount} dialogue lines, ${cameraDirectionCount} camera dirs → ${isLongScript ? 'MULTI-BEAT' : 'single-beat'}`);
      const finalPrompt = isLongScript
        ? `${prompt}\n\n[SCREENPLAY MODE: This is a scripted dialogue. You MUST preserve EVERY spoken line as a separate audio dialogue entry. Split the script into multiple beats at natural camera cut points. Each beat should contain the dialogue lines that belong to that scene. Do NOT summarize or skip any dialogue.]`
        : prompt;
      const stream = await processScenePromptStream(finalPrompt, contextBeats, { singleBeat: !isLongScript, orientation: stageOrientation }, actorReferences);
      for await (const chunk of stream) {
        if (abortRef.current) break;
        if (chunk.type === 'error') {
          setError(chunk.error);
          break;
        } else if (chunk.type === 'story') {
          setStoryData(prev => {
            if (!prev) return chunk.data;

            // Merge actors seamlessly
            const newActors = chunk.data.actors_detected.filter(
              newActor => !prev.actors_detected.some(old => old.id === newActor.id)
            );

            return {
              title: prev.title || chunk.data.title, // Keep original title
              actors_detected: [...prev.actors_detected, ...newActors],
              beats: [...prev.beats, ...chunk.data.beats]
            };
          });
        } else if (chunk.type === 'image') {
          const compressedIncomingImage = await downscaleBase64Image(chunk.data, 512);

          // ACTOR IDENTITY LOCK: Intercept First Appearances
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            const targetIndex = initialBeatsLength + chunk.index;
            const currentBeat = newBeats[targetIndex];

            if (currentBeat) {
              currentBeat.image_data = compressedIncomingImage;

              // Save reference for ALL detected actors that don't have one yet
              if (currentProjectId) {
                // Collect actor IDs from this beat's actions
                const beatActorIds = new Set(
                  (currentBeat.actions || []).map(a => a.actor_id)
                );

                // Also check all globally detected actors
                prev.actors_detected.forEach(actor => {
                  beatActorIds.add(actor.id);
                });

                beatActorIds.forEach(actorId => {
                  setActorReferences(prevRefs => {
                    if (!prevRefs[actorId]) {
                      saveActorIdentity(currentProjectId, actorId, compressedIncomingImage);
                      return { ...prevRefs, [actorId]: compressedIncomingImage };
                    }
                    return prevRefs;
                  });
                });
              }
            }
            return { ...prev, beats: newBeats };
          });
        } else if (chunk.type === 'usage') {
          // Store generation cost split evenly across the newly generated beats
          // gemini-3.1-flash-image-preview pricing:
          // input $0.50/M, text output $3.00/M, image output $60.00/M.
          // 0.5K output images use 747 output tokens each ($0.045/image).
          const totalTokens = chunk.promptTokens + chunk.candidateTokens;
          const { totalCost } = estimateStoryboardGenerationCost(
            chunk.promptTokens,
            chunk.candidateTokens,
            chunk.imageCount,
          );
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeatCount = prev.beats.length - initialBeatsLength;
            if (newBeatCount <= 0) return prev;
            const costPerBeat = totalCost / newBeatCount;
            const tokensPerBeat = Math.round(totalTokens / newBeatCount);
            const newBeats = [...prev.beats];
            for (let i = initialBeatsLength; i < newBeats.length; i++) {
              newBeats[i] = {
                ...newBeats[i],
                image_generation_cost: { tokens: tokensPerBeat, cost: costPerBeat },
              };
            }
            setBeatGenerationCosts(prevCosts => {
              const updated = { ...prevCosts };
              for (let i = initialBeatsLength; i < prev.beats.length; i++) {
                updated[i] = { tokens: tokensPerBeat, cost: costPerBeat };
              }
              return updated;
            });
            return { ...prev, beats: newBeats };
          });
        }
      }

      // Multi-beat fallback: if some beats have no image, copy the first available image
      setStoryData(prev => {
        if (!prev) return prev;
        const firstImageBeat = prev.beats.slice(initialBeatsLength).find(b => b.image_data);
        if (!firstImageBeat?.image_data) return prev;
        const newBeats = prev.beats.map((beat, i) => {
          if (i >= initialBeatsLength && !beat.image_data) {
            return { ...beat, image_data: firstImageBeat.image_data };
          }
          return beat;
        });
        return { ...prev, beats: newBeats };
      });

    } catch (err: unknown) {
      console.error("Generation failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to connect to generation service: ${errorMessage}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateSpecificAudio = async (sceneIdx: number, audioIdx: number) => {
    if (!storyData || isGenerating) return;
    const beat = storyData.beats[sceneIdx];
    if (!beat || !beat.audio || !beat.audio[audioIdx]) return;

    const audio = beat.audio[audioIdx];
    if ((audio.type === 'dialogue' && !audio.text) || (audio.type !== 'dialogue' && !audio.description)) return;

    setIsGenerating(true);

    try {
      if (audio.type === 'dialogue') {
        const ttsResult = await generateSpeechTTS(audio.text!, audio.voice_id || "en-US-Standard-F", audio.delivery_style);
        const exactDuration = await getExactAudioDuration(ttsResult.audioDataUrl);

        const lastViseme = ttsResult.visemes?.[ttsResult.visemes.length - 1];
        const backupDuration = lastViseme ? lastViseme.time + lastViseme.duration : 2.0;
        const duration = exactDuration ?? (ttsResult.durationSeconds || backupDuration);

        let stretchedVisemes = ttsResult.visemes;
        if (duration && ttsResult.durationSeconds && stretchedVisemes && stretchedVisemes.length > 0) {
          const ratio = duration / ttsResult.durationSeconds;
          if (Math.abs(ratio - 1.0) > 0.05) {
            stretchedVisemes = stretchedVisemes.map(v => ({
              ...v, time: v.time * ratio, duration: v.duration * ratio
            }));
          }
        }

        let finalAudio = { ...audio };
        finalAudio.audio_data_url = ttsResult.audioDataUrl;
        finalAudio.visemes = stretchedVisemes;
        finalAudio.duration_seconds = duration;
        finalAudio.generation_cost = { cost: ttsResult.costEstimate, characters: ttsResult.billedCharacters };

        setStoryData((prev) => {
          if (!prev) return prev;
          const newStory = { ...prev };
          newStory.beats[sceneIdx].audio![audioIdx] = finalAudio;
          saveStoryToStorage(newStory.title, newStory).catch(console.error);
          return newStory;
        });

        // Give UI a tiny beat, then broadly alert the timeline that duration might have changed
        setTimeout(() => {
          setStoryData(prev => {
            if (!prev) return prev;
            // Simple state bump to trigger re-renders if duration expanded the track
            return { ...prev, beats: [...prev.beats] };
          });
        }, 100);

      } else {
        const result = await executeSoundEffect({ prompt: audio.description! });
        if (result.url) {
          setStoryData((prev) => {
            if (!prev) return prev;
            const newStory = { ...prev };
            newStory.beats[sceneIdx].audio![audioIdx] = {
              ...audio,
              audio_data_url: result.url
            };
            saveStoryToStorage(newStory.title, newStory).catch(console.error);
            return newStory;
          });
        } else if (result.error) {
          console.error(`[BLOCKED] SFX generation failed: ${result.error}`);
        }
      }
    } catch (err) {
      console.error("Audio generation failed:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEditImageSubmit = async (index: number) => {
    if (!storyData || !storyData.beats[index] || !storyData.beats[index].image_data || !editPrompt.trim() || isEditingImage) return;

    setIsEditingImage(true);
    setError(null);

    try {
      const originalImage = storyData.beats[index].image_data as string;

      // CRITICAL: Next.js Server Actions choke on massive base64 strings (array nesting error)
      // We MUST compress the image on the client before sending it over the network to the server function.
      const compressedImage = await downscaleBase64Image(originalImage, 512);

      const result = await processSceneImageEdit(compressedImage, editPrompt, stageOrientation);

      if (result.error) {
        setError(result.error);
      } else if (result.data) {
        // Automatically append the edited image data to the story state
        setStoryData(prev => {
          if (!prev) return prev;
          const newBeats = [...prev.beats];
          newBeats[index] = { ...newBeats[index], image_data: result.data };
          return { ...prev, beats: newBeats };
        });

        // Close the edit prompt overlay
        setEditingBeatIndex(null);
        setEditPrompt("");
      }
    } catch (error: unknown) {
      console.error("Image editing failed:", error);
      setError(error instanceof Error ? error.message : "Failed to edit image");
    } finally {
      setIsEditingImage(false);
    }
  };

  const handleInsertScene = async (insertIndex: number) => {
    if (!insertPrompt.trim() || isGenerating) return;

    abortRef.current = false;
    setIsGenerating(true);
    setError(null);

    // Build context from surrounding beats (the one before and one after the insertion point)
    let contextBeats;
    if (storyData && storyData.beats.length > 0) {
      const surroundingBeats = [];
      if (insertIndex > 0) surroundingBeats.push(storyData.beats[insertIndex - 1]);
      if (insertIndex < storyData.beats.length) surroundingBeats.push(storyData.beats[insertIndex]);
      contextBeats = JSON.parse(JSON.stringify(surroundingBeats));
      for (const beat of contextBeats) {
        if (beat.image_data) {
          beat.image_data = await downscaleBase64Image(beat.image_data, 512);
        }
      }
    }

    try {
      const stream = await processScenePromptStream(insertPrompt, contextBeats, { singleBeat: true, orientation: stageOrientation }, actorReferences);
      for await (const chunk of stream) {
        if (abortRef.current) break;
        if (chunk.type === 'error') {
          setError(chunk.error);
          break;
        } else if (chunk.type === 'story') {
          setStoryData(prev => {
            if (!prev) return chunk.data;
            const newActors = chunk.data.actors_detected.filter(
              newActor => !prev.actors_detected.some(old => old.id === newActor.id)
            );
            const newBeats = [...prev.beats];
            // Splice the new beat(s) at the insertion point
            newBeats.splice(insertIndex, 0, ...chunk.data.beats);
            return {
              title: prev.title || chunk.data.title,
              actors_detected: [...prev.actors_detected, ...newActors],
              beats: newBeats
            };
          });
        } else if (chunk.type === 'image') {
          const compressedIncomingImage = await downscaleBase64Image(chunk.data, 512);

          // ACTOR IDENTITY LOCK for Scene Insertions
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            const targetIdx = insertIndex + chunk.index;
            const currentBeat = newBeats[targetIdx];

            if (currentBeat) {
              currentBeat.image_data = compressedIncomingImage;

              // Save reference for ALL detected actors that don't have one yet
              if (currentProjectId) {
                const beatActorIds = new Set(
                  (currentBeat.actions || []).map(a => a.actor_id)
                );
                prev.actors_detected.forEach(actor => {
                  beatActorIds.add(actor.id);
                });
                beatActorIds.forEach(actorId => {
                  setActorReferences(prevRefs => {
                    if (!prevRefs[actorId]) {
                      saveActorIdentity(currentProjectId, actorId, compressedIncomingImage);
                      return { ...prevRefs, [actorId]: compressedIncomingImage };
                    }
                    return prevRefs;
                  });
                });
              }
            }
            return { ...prev, beats: newBeats };
          });
        } else if (chunk.type === 'usage') {
          // gemini-3.1-flash-image-preview:
          // input $0.50/M, text output $3.00/M, image output $60.00/M.
          // 0.5K output images use 747 output tokens each ($0.045/image).
          const totalTokens = chunk.promptTokens + chunk.candidateTokens;
          const { totalCost } = estimateStoryboardGenerationCost(
            chunk.promptTokens,
            chunk.candidateTokens,
            chunk.imageCount,
          );
          setStoryData(prev => {
            if (!prev || !prev.beats[insertIndex]) return prev;
            const newBeats = [...prev.beats];
            newBeats[insertIndex] = {
              ...newBeats[insertIndex],
              image_generation_cost: { tokens: totalTokens, cost: totalCost },
            };
            setBeatGenerationCosts(prevCosts => ({
              ...prevCosts,
              [insertIndex]: { tokens: totalTokens, cost: totalCost },
            }));
            return { ...prev, beats: newBeats };
          });
        }
      }
      // Close the insert prompt
      setInsertAtIndex(null);
      setInsertPrompt("");
    } catch (err: unknown) {
      console.error("Insert scene failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to insert scene: ${errorMessage}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAnimateScene = async (index: number) => {
    if (!storyData || !storyData.beats[index]) return;

    // Clear any previous completed logs for this scene
    setCompletedAnimLogs(prev => { const n = { ...prev }; delete n[index]; return n; });
    setDismissedCompileReports(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });

    abortRef.current = false;
    setAnimatingSceneIndex(index);
    setAnimatingLogs(["Initializing automation macro..."]);
    setSelectedSceneIndex(index);
    const beat = storyData.beats[index];
    let didAugmentTargets = false;
    let workingBeat = {
      ...beat,
      actions: beat.actions.map(action => {
        if (action.target_spatial_transform || !motionNeedsTarget(action.motion)) return action;

        const start = action.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
        const inferred = inferAutoTargetTransform(
          action.motion,
          { x: start.x, y: start.y, scale: start.scale },
          action.duration_seconds || 2,
        );

        return inferred
          ? (() => {
            didAugmentTargets = true;
            return { ...action, target_spatial_transform: inferred };
          })()
          : action;
      }),
    };

    if (didAugmentTargets) {
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        newBeats[index] = workingBeat;
        return { ...prev, beats: newBeats };
      });
    }

    // Local accumulator so we can capture the full log on completion
    const localLogs: string[] = ["Initializing automation macro..."];
    const addLog = (msg: string) => {
      localLogs.push(msg);
      setAnimatingLogs([...localLogs]);
    };

    let totalTokens = 0;
    let apiCalls = 0;
    let totalCostEst = 0;
    let compileStatus: "success" | "error" = "error";

    const logUsage = (usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined, label?: string) => {
      const promptTokens = usage?.promptTokenCount || 0;
      const candidateTokens = usage?.candidatesTokenCount || 0;
      const total = promptTokens + candidateTokens;
      totalTokens += total;

      // gemini-3.1-pro-preview pricing:
      // input $2.00/M and text output $12.00/M up to 200k prompt tokens,
      // then $4.00/M input and $18.00/M output above that threshold.
      const cost = estimateProPreviewTextCost(promptTokens, candidateTokens);
      totalCostEst += cost;

      addLog(`[PAID] ${label || 'Usage'}: ${total} tokens | ~$${cost.toFixed(4)}`);
    };

    try {
      // 1. Generate Background if missing — try reusing from a previous beat first
      if (!abortRef.current && !workingBeat.drafted_background) {
        // Check earlier beats for a reusable background
        const reusableBg = storyData.beats
          .slice(0, index)
          .reverse()
          .find(b => b.drafted_background);

        if (reusableBg?.drafted_background) {
          workingBeat = { ...workingBeat, drafted_background: reusableBg.drafted_background };
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            newBeats[index] = { ...newBeats[index], drafted_background: reusableBg.drafted_background };
            return { ...prev, beats: newBeats };
          });
          addLog("[REUSED] ✓ Environment rig reused from earlier scene.");
        } else if (workingBeat.image_data) {
          addLog("> Starting Set Designer AI...");
          addLog("> Extracting 3-layer parallax environment...");

          apiCalls++;
          const result = await processSetDesignerPrompt(workingBeat.image_data, workingBeat.narrative, stageOrientation);

          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            newBeats[index] = { ...newBeats[index], drafted_background: result.data };
            return { ...prev, beats: newBeats };
          });

          addLog("[PAID] ✓ Environment vector rig compiled.");
          logUsage(result.usage, "Set Designer");
          workingBeat = { ...workingBeat, drafted_background: result.data };
        } else {
          addLog("[BLOCKED] No image data and no prior background to reuse.");
        }
      } else {
        addLog("[REUSED] ✓ Environment rig found in cache.");
      }

      // 2. Generate Actors if missing
      const actorIdsInScene = new Set(workingBeat.actions.map(a => a.actor_id));
      const sceneRigs: Record<string, DraftsmanData> = {};
      for (const actorId of Array.from(actorIdsInScene)) {
        if (abortRef.current) break;
        const actor = storyData.actors_detected.find(a => a.id === actorId);
        if (actor) {
          const actorActions = workingBeat.actions.filter(a => a.actor_id === actorId);
          const actorDescription = buildActorRigDescription(actor);
          const sceneReferenceImage = workingBeat.image_data
            ? await extractActorReferenceCrop({
              imageSrc: workingBeat.image_data,
              beat: workingBeat,
              actorId,
              actorActions,
              orientation: stageOrientation,
            })
            : null;
          if (sceneReferenceImage && currentProjectId && actorReferences[actorId] !== sceneReferenceImage) {
            void saveActorIdentity(currentProjectId, actorId, sceneReferenceImage);
            setActorReferences(prev => prev[actorId] === sceneReferenceImage ? prev : { ...prev, [actorId]: sceneReferenceImage });
          }
          const referenceImage = sceneReferenceImage || actorReferences[actorId];
          let actorRig = actor.drafted_rig;
          const existingViews = actorRig ? extractRigViews(actorRig.svg_data) : [];
          const rigRefreshReason = inferRigRefreshReason(actorRig);
          let plannedViews = inferFallbackRigViews(workingBeat, actorActions);

          if (referenceImage) {
            addLog(`> Reading raster pose for '${actor.name}'...`);
            try {
              apiCalls += 1;
              const suggestedViews = await suggestRigViewsFromRaster({
                base64Image: referenceImage,
                actorName: actor.name,
                actorDescription,
                sceneNarrative: `${workingBeat.narrative} ${workingBeat.comic_panel_prompt}`,
                actions: actorActions.map((action) => normalizeMotionKey(action.motion)),
                existingViews,
              });
              plannedViews = suggestedViews.views;
              addLog(`[PAID] ✓ Raster view plan for '${actor.name}': ${plannedViews.join(', ')}.`);
              logUsage(suggestedViews.usage, `View Planner (${actor.name})`);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              addLog(`[REUSED] View planner fallback for '${actor.name}': ${plannedViews.join(', ')} (${message}).`);
            }
          }

          const viewRequest = selectRequiredRigViews({
            plannedViews,
            existingViews,
          });
          const missingViews = viewRequest.missingViews;
          const requiredViews = viewRequest.requestedViews;

          if (plannedViews.length > requiredViews.length) {
            addLog(`[REVIEW] Limiting '${actor.name}' rig to the currently needed view '${viewRequest.primaryObservedView}'. Additional views will only be generated when explicitly required by a later scene.`);
          }

          if (!actorRig && referenceImage) {
            addLog(`> Starting Draftsman AI for '${actor.name}'...`);
            addLog(`> Rigging A-Pose skeleton & visemes (${requiredViews.join(', ')})...`);

            const generatedRig = await generateRigDraft({
              generationReference: referenceImage,
              description: actorDescription,
              requiredViews,
              qualityMode: "reviewable",
            });
            apiCalls += 1;
            logUsage(generatedRig.usage, `Draftsman (${actor.name})`);
            if (generatedRig.review && !generatedRig.review.acceptable) {
              addLog(`[REVIEW] Draft quality for '${actor.name}': ${generatedRig.review.reasons.slice(0, 3).join(" ")}`);
            }

            setStoryData(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                actors_detected: prev.actors_detected.map(a =>
                  a.id === actorId ? { ...a, drafted_rig: generatedRig.data } : a
                )
              };
            });

            actorRig = generatedRig.data;
            addLog(`[PAID] ✓ '${actor.name}' SVG rig assembled.`);
          } else if (actorRig && referenceImage && (missingViews.length > 0 || Boolean(rigRefreshReason))) {
            if (rigRefreshReason) {
              addLog(`> Rebuilding rig for '${actor.name}'...`);
              addLog(`> Refreshing weak draft (${rigRefreshReason}) with isolated raster reference...`);
            } else {
              addLog(`> Extending rig views for '${actor.name}'...`);
              addLog(`> Capturing additional views (${missingViews.join(', ')})...`);
            }

            const regeneratedRig = await generateRigDraft({
              generationReference: referenceImage,
              description: actorDescription,
              requiredViews,
              qualityMode: "reviewable",
            });
            apiCalls += 1;
            logUsage(regeneratedRig.usage, `Draftsman (${actor.name}:view update)`);
            if (regeneratedRig.review && !regeneratedRig.review.acceptable) {
              addLog(`[REVIEW] Draft quality for '${actor.name}': ${regeneratedRig.review.reasons.slice(0, 3).join(" ")}`);
            }

            const mergedRig = mergeRigViewUpdate(actorRig, regeneratedRig.data, requiredViews);
            const updatedRig = {
              ...mergedRig,
              rig_data: {
                ...mergedRig.rig_data,
                motion_clips: {},
              },
            };

            setStoryData(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                actors_detected: prev.actors_detected.map(a =>
                  a.id === actorId ? { ...a, drafted_rig: updatedRig } : a
                )
              };
            });

            actorRig = updatedRig;
            addLog(`[PAID] ✓ '${actor.name}' rig updated with view: ${requiredViews.join(', ')}.`);
          } else if (actorRig) {
            addLog(`[REUSED] ✓ '${actor.name}' rig found in cache.`);
          } else {
            addLog(`[BLOCKED] Actor '${actor.name}' has no raster reference image. Rig generation skipped.`);
          }

          if (actorRig) {
            let nextRig = actorRig;

            for (const actorAction of actorActions) {
              if (abortRef.current) break;
              const motionKey = normalizeMotionKey(actorAction.motion);
              const transformOnlyPolicy = inferTransformOnlyPlaybackPolicy(nextRig, motionKey);
              if (transformOnlyPolicy.prefer) {
                addLog(`[REVIEW] Motion '${motionKey}' for '${actor.name}' uses transform-only playback: ${transformOnlyPolicy.reason}. Compiling motion intent for rigid whole-object playback.`);
              }

              const existingClipKey = suggestMotionAliases(motionKey).find(
                (alias) => nextRig.rig_data.motion_clips?.[alias],
              );
              if (existingClipKey) {
                addLog(`[REUSED] ✓ Motion '${motionKey}' reused for '${actor.name}' from clip '${existingClipKey}'.`);
                continue;
              }

              const reusableClip = findReusableActorClip(storyData, actorId, motionKey);
              if (reusableClip) {
                nextRig = {
                  ...nextRig,
                  rig_data: {
                    ...nextRig.rig_data,
                    motion_clips: {
                      ...(nextRig.rig_data.motion_clips || {}),
                      [motionKey]: reusableClip.clip,
                    },
                  },
                };
                addLog(`[REUSED] ✓ Motion '${motionKey}' copied for '${actor.name}' from '${reusableClip.sourceActorName}:${reusableClip.clipKey}'.`);
                continue;
              }

              addLog(`> Compiling motion '${motionKey}' for '${actor.name}'...`);
              apiCalls++;

              let clipResult;
              try {
                clipResult = await generateMotionClipForRig({
                  rig: nextRig,
                  motion: motionKey,
                  style: actorAction.style,
                  durationSeconds: actorAction.duration_seconds,
                  actorName: actor.name,
                  actorDescription: actor.visual_description,
                  sceneNarrative: workingBeat.narrative,
                  referenceImage: workingBeat.image_data,
                });
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                addLog(`[BLOCKED] Motion '${motionKey}' blocked for '${actor.name}': ${message}`);
                continue;
              }

              if (clipResult.blocked) {
                addLog(`[BLOCKED] Motion '${motionKey}' blocked for '${actor.name}': ${clipResult.blocked.message}`);
                formatMotionDebugLines(clipResult.blocked.debugReport).forEach((line) => addLog(line));
                logUsage(clipResult.usage, `Motion (${actor.name}:${motionKey})`);
                continue;
              }

              if (!clipResult.clip) {
                addLog(`[BLOCKED] Motion '${motionKey}' blocked for '${actor.name}': clip generation returned no playable clip.`);
                logUsage(clipResult.usage, `Motion (${actor.name}:${motionKey})`);
                continue;
              }

              nextRig = {
                ...nextRig,
                rig_data: {
                  ...nextRig.rig_data,
                  motion_clips: {
                    ...(nextRig.rig_data.motion_clips || {}),
                    [motionKey]: clipResult.clip,
                  },
                },
              };

              addLog(`[PAID] ✓ Motion '${motionKey}' compiled for '${actor.name}'.`);
              if (clipResult.stabilization?.stabilized) {
                addLog(`[CHECK] Motion stabilized: ${clipResult.stabilization.refinedChains} chain${clipResult.stabilization.refinedChains === 1 ? "" : "s"} solved, ${clipResult.stabilization.suppressedKeyframes} unsafe keyframe${clipResult.stabilization.suppressedKeyframes === 1 ? "" : "s"} removed.`);
              }
              if (clipResult.stabilization?.validationWarnings?.length) {
                clipResult.stabilization.validationWarnings.slice(0, 2).forEach((warning: string) => {
                  addLog(`[REVIEW] Motion validation: ${warning}.`);
                });
              }
              if (clipResult.stabilization?.debugReport) {
                formatMotionDebugLines(clipResult.stabilization.debugReport).slice(0, 4).forEach((line) => addLog(line));
              }
              logUsage(clipResult.usage, `Motion (${actor.name}:${motionKey})`);
            }

            if (nextRig !== actorRig) {
              setStoryData(prev => {
                if (!prev) return prev;
                return {
                  ...prev,
                  actors_detected: prev.actors_detected.map(a =>
                    a.id === actorId ? { ...a, drafted_rig: nextRig } : a
                  )
                };
              });
            }

            sceneRigs[actorId] = nextRig;
          }
        }
      }

      // ── TTS & SFX Audio Generation ───────────────────────────────────────────
      const audioItems = workingBeat.audio || [];
      const dialogueToGenerate = audioItems.filter(a => a.type === 'dialogue' && a.text && (!a.audio_data_url || !a.visemes || a.visemes.length === 0));
      const sfxToGenerate = audioItems.filter(a => (a.type === 'sfx' || a.type === 'music') && a.description && !a.audio_data_url);

      if (dialogueToGenerate.length > 0 || sfxToGenerate.length > 0) {
        const updatedAudio = [...audioItems];

        if (dialogueToGenerate.length > 0) {
          addLog(`> Generating ${dialogueToGenerate.length} voice track${dialogueToGenerate.length > 1 ? 's' : ''}...`);
          try {
            const ttsResults = await Promise.all(dialogueToGenerate.map(async (audio) => {
              if (abortRef.current) return { audio, ttsResult: null, exactDuration: null };

              let finalVoiceId = audio.voice_id;
              if (!finalVoiceId && audio.actor_id && storyData) {
                const ALL_NATIVE_VOICE_IDS = [
                  "en-US-Journey-D", "en-US-Journey-F", "en-US-Journey-O",
                  "en-US-Standard-A", "en-US-Standard-B", "en-US-Standard-C"
                ];
                const actorIdx = storyData.actors_detected.findIndex(a => a.id === audio.actor_id);
                if (actorIdx >= 0) {
                  finalVoiceId = ALL_NATIVE_VOICE_IDS[actorIdx % ALL_NATIVE_VOICE_IDS.length];
                }
              }
              finalVoiceId = finalVoiceId || "en-US-Standard-F";

              const ttsResult = await generateSpeechTTS(audio.text!, finalVoiceId, audio.delivery_style);
              const exactDuration = await getExactAudioDuration(ttsResult.audioDataUrl);
              return { audio, ttsResult, exactDuration, finalVoiceId };
            }));

            let cumulativeTime = 0;
            // First, find the latest end time of any existing audio to start after it
            updatedAudio.forEach(a => {
              if (a.start_time !== undefined && a.duration_seconds) {
                cumulativeTime = Math.max(cumulativeTime, a.start_time + a.duration_seconds);
              }
            });

            ttsResults.forEach(({ audio, ttsResult, exactDuration, finalVoiceId }) => {
              if (!ttsResult) return;
              const idx = updatedAudio.indexOf(audio);
              if (idx !== -1) {
                // Use the server-provided accurate duration if available, fallback to viseme estimation
                const lastViseme = ttsResult.visemes?.[ttsResult.visemes.length - 1];
                const backupDuration = lastViseme ? lastViseme.time + lastViseme.duration : 2.0;
                const duration = exactDuration ?? (ttsResult.durationSeconds || backupDuration);

                let stretchedVisemes = ttsResult.visemes;
                if (duration && ttsResult.durationSeconds && stretchedVisemes && stretchedVisemes.length > 0) {
                  const ratio = duration / ttsResult.durationSeconds;
                  if (Math.abs(ratio - 1.0) > 0.05) {
                    stretchedVisemes = stretchedVisemes.map(v => ({
                      ...v,
                      time: v.time * ratio,
                      duration: v.duration * ratio
                    }));
                  }
                }

                updatedAudio[idx] = {
                  ...updatedAudio[idx],
                  voice_id: finalVoiceId,
                  audio_data_url: ttsResult.audioDataUrl,
                  visemes: stretchedVisemes,
                  start_time: updatedAudio[idx].start_time ?? cumulativeTime,
                  duration_seconds: duration,
                  generation_cost: { cost: ttsResult.costEstimate, characters: ttsResult.billedCharacters },
                };

                // Advance cumulative time for the NEXT generated line so they take turns by default
                if (updatedAudio[idx].start_time === cumulativeTime) {
                  cumulativeTime += duration + 0.2; // 0.2s pause between lines
                }
              }
            });
            addLog(`✓ Generated ${ttsResults.length} voice track${ttsResults.length > 1 ? 's' : ''}.`);
          } catch (e) {
            addLog(`[BLOCKED] TTS generation failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (sfxToGenerate.length > 0) {
          addLog(`> Generating ${sfxToGenerate.length} sound effect${sfxToGenerate.length > 1 ? 's' : ''}...`);
          try {
            const sfxResults = await Promise.all(sfxToGenerate.map(async (audio) => {
              const result = await executeSoundEffect({ prompt: audio.description! });
              return { audio, result };
            }));
            sfxResults.forEach(({ audio, result }) => {
              if (result.url) {
                const idx = updatedAudio.indexOf(audio);
                if (idx !== -1) {
                  updatedAudio[idx] = { ...updatedAudio[idx], audio_data_url: result.url };
                }
              } else if (result.error) {
                addLog(`[BLOCKED] SFX '${audio.description}': ${result.error}`);
              }
            });
            const successCount = sfxResults.filter(r => r.result.url).length;
            addLog(`✓ Generated ${successCount} sound effect${successCount > 1 ? 's' : ''}.`);
          } catch (e) {
            addLog(`[BLOCKED] SFX generation failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        workingBeat = { ...workingBeat, audio: updatedAudio };
        setStoryData(prev => {
          if (!prev) return prev;
          const newBeats = [...prev.beats];
          newBeats[index] = { ...newBeats[index], audio: updatedAudio };
          return { ...prev, beats: newBeats };
        });
      }

      const previousCompiledScene = index > 0 ? storyData.beats[index - 1]?.compiled_scene ?? null : null;
      const compiledScene = compileBeatToScene(workingBeat, sceneRigs, previousCompiledScene, stageOrientation);
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        newBeats[index] = { ...newBeats[index], compiled_scene: compiledScene };
        return { ...prev, beats: newBeats };
      });

      const bindingByActionIndex = new Map(
        compiledScene.instance_tracks.flatMap(track =>
          track.clip_bindings.map(binding => [binding.source_action_index, binding] as const),
        ),
      );

      const blockedActionLogs: string[] = [];
      workingBeat.actions.forEach((action, actionIndex) => {
        const actor = storyData.actors_detected.find(candidate => candidate.id === action.actor_id);
        const actorLabel = actor?.name || action.actor_id;
        const rig = sceneRigs[action.actor_id];
        const binding = bindingByActionIndex.get(actionIndex);
        const normalizedMotion = normalizeMotionKey(action.motion);

        if (!rig) {
          blockedActionLogs.push(`[BLOCKED] Scene action '${normalizedMotion}' for '${actorLabel}' has no rig. No playable actor clip was bound.`);
          return;
        }

        if (!binding) {
          const availableClips = Object.keys(rig.rig_data.motion_clips || {});
          blockedActionLogs.push(
            `[BLOCKED] Scene action '${normalizedMotion}' for '${actorLabel}' has no playable clip. Available reusable clips: ${availableClips.length ? availableClips.join(", ") : "none"}.`,
          );
        }
      });

      addLog(`✓ Compiled scene timeline (${compiledScene.instance_tracks.length} track${compiledScene.instance_tracks.length === 1 ? "" : "s"}, ${compiledScene.duration_seconds.toFixed(2)}s).`);
      blockedActionLogs.forEach(addLog);
      if (compiledScene.background_ambient.length > 0) {
        addLog(`✓ Compiled background ambient (${compiledScene.background_ambient.length} binding${compiledScene.background_ambient.length === 1 ? "" : "s"}).`);
      }
      if (compiledScene.obstacles.length > 0) {
        addLog(`✓ Detected ${compiledScene.obstacles.length} scene obstacle${compiledScene.obstacles.length === 1 ? "" : "s"} for collision clamping.`);
      }
      const collisionBindings = compiledScene.instance_tracks.flatMap(track =>
        track.clip_bindings.filter(binding => !!binding.collision),
      );
      if (collisionBindings.length > 0) {
        addLog(`✓ Applied ${collisionBindings.length} collision stop${collisionBindings.length === 1 ? "" : "s"}.`);
        collisionBindings.slice(0, 3).forEach((binding) => {
          addLog(`✓ ${binding.actor_id} "${binding.motion}" stopped at obstacle "${binding.collision?.obstacle_id}".`);
        });
      }

      addLog("✓ Stage ready. Dispatching GSAP context...");
      addLog("─────────────────────────────");
      const imageGen = getBeatImageGenerationCost(workingBeat, index, beatGenerationCosts);
      if (imageGen) {
        addLog(`[PAID] Image gen: ~$${imageGen.cost.toFixed(5)} | ${imageGen.tokens.toLocaleString()} tokens`);
      }
      addLog(`[PAID] API Calls: ${apiCalls} | Total tokens: ${totalTokens}`);
      addLog(`[PAID] Scene cost: ~$${totalCostEst.toFixed(5)}`);
      addLog("─────────────────────────────");
      compileStatus = blockedActionLogs.length > 0 ? "error" : "success";

    } catch (err: unknown) {
      console.error("Animation prep failed", err);
      addLog(`❌ Error: ${err instanceof Error ? err.message : 'Pipeline failed'}`);
    } finally {
      // Persist logs so they remain visible below the scene image
      setCompletedAnimLogs(prev => ({ ...prev, [index]: [...localLogs] }));
      setStoryData(prev => {
        if (!prev || !prev.beats[index]) return prev;
        const newBeats = [...prev.beats];
        const imageGen = getBeatImageGenerationCost(workingBeat, index, beatGenerationCosts);
        newBeats[index] = {
          ...newBeats[index],
          compile_report: {
            status: compileStatus,
            compiled_at: Date.now(),
            logs: [...localLogs],
            api_calls: apiCalls,
            total_tokens: totalTokens,
            scene_cost_estimate: Number(totalCostEst.toFixed(5)),
            image_generation_cost: imageGen
              ? { cost: imageGen.cost, tokens: imageGen.tokens }
              : undefined,
          },
        };
        return { ...prev, beats: newBeats };
      });
      setAnimatingSceneIndex(null);
      setAnimatingLogs([]);
    }
  };

  // --- Actor Selection Handlers ---

  const handleActorSelect = (actorId: string | null) => {
    setSelectedActorId(actorId);
    if (!actorId || !storyData) {
      setSelectedActionIndex(null);
      return;
    }
    const beat = storyData.beats[selectedSceneIndex];
    if (!beat) { setSelectedActionIndex(null); return; }

    let targetIdx: number | null = null;
    const compiledTrack = beat.compiled_scene?.instance_tracks.find(track => track.actor_id === actorId);

    if (compiledTrack?.clip_bindings.length) {
      // Find the clip binding active at the current playhead time
      const activeBinding = compiledTrack.clip_bindings.find(b =>
        currentTimeSeconds >= b.start_time &&
        currentTimeSeconds <= (b.start_time + b.duration_seconds)
      );
      if (activeBinding) {
        targetIdx = activeBinding.source_action_index;
      } else {
        // Fallback to the last binding that started before playhead, or just the first binding
        const previousBindings = compiledTrack.clip_bindings.filter(b => b.start_time <= currentTimeSeconds);
        if (previousBindings.length > 0) {
          targetIdx = previousBindings[previousBindings.length - 1].source_action_index;
        } else {
          targetIdx = compiledTrack.clip_bindings[0].source_action_index;
        }
      }
    } else {
      // Fallback before compilation
      const idx = beat.actions.findIndex(a => a.actor_id === actorId);
      targetIdx = idx >= 0 ? idx : null;
    }

    setSelectedActionIndex(targetIdx);
  };



  const handleLayerMove = (actorId: string, direction: -1 | 1) => {
    // direction: -1 = up the list (higher Z, visually forward), 1 = down the list (lower Z, visually backward)
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      // Extract current z-indices and sort actors
      const currentZs = Array.from(new Set(beat.actions.map(a => a.actor_id))).map(id => {
        const actions = beat.actions.filter(a => a.actor_id === id);
        return { id, z: Math.max(...actions.map(a => a.spatial_transform?.z_index ?? 10)) };
      }).sort((a, b) => b.z - a.z); // highest Z first

      const index = currentZs.findIndex(o => o.id === actorId);
      if (index === -1) return prev;
      if (direction === -1 && index === 0) return prev; // already at top
      if (direction === 1 && index === currentZs.length - 1) return prev; // already at bottom

      // Swap elements in our ordered list
      const swapIndex = index + direction;
      [currentZs[index], currentZs[swapIndex]] = [currentZs[swapIndex], currentZs[index]];

      // Re-assign z-indices from 10...N*10 in reverse order
      const zMap: Record<string, number> = {};
      currentZs.forEach((item, i) => {
        zMap[item.id] = (currentZs.length - i) * 10;
      });

      const newActions = beat.actions.map(a => ({
        ...a,
        spatial_transform: {
          ...(a.spatial_transform || { x: 960, y: 950, scale: 0.5 }),
          z_index: zMap[a.actor_id] ?? 10, // write the new Z!
        },
      }));

      const currentBeat = { ...beat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;
      const recompiled = compileBeatToScene(currentBeat, availableRigs, previousCompiledScene, stageOrientation);

      // Also forcefully overwrite the compiled tracks Z-index to match so the UI sorts immediately
      if (recompiled) {
        recompiled.instance_tracks = recompiled.instance_tracks.map(track => {
          const trackZ = zMap[track.actor_id] ?? 10;
          return {
            ...track,
            transform_track: track.transform_track.map(t => ({ ...t, z_index: trackZ }))
          };
        });
      }

      newBeats[selectedSceneIndex] = { ...currentBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleAddAction = (actorId: string) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const currentBeat = newBeats[selectedSceneIndex];
      const newActions = [...currentBeat.actions, {
        actor_id: actorId,
        motion: "idle",
        style: "neutral",
        start_time: 0,
        duration_seconds: 5.0,
      }];
      const nextBeat = { ...currentBeat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleAddCamera = () => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const currentBeat = newBeats[selectedSceneIndex];
      const newCameras = [...(currentBeat.cameras || [])];

      // Calculate start time based on previous cameras
      const lastCam = newCameras[newCameras.length - 1];
      const startTime = lastCam ? (lastCam.start_time || 0) + (lastCam.duration ?? 2.0) : 0;

      newCameras.push({
        start_time: startTime,
        zoom: 1,
        x: 960,
        y: 540,
        rotation: 0
      });

      const nextBeat = { ...currentBeat, cameras: newCameras };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };


  const handleUpdateAction = (update: ActionUpdate) => {
    if (selectedActionIndex === null) return;
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const currentBeat = newBeats[selectedSceneIndex];
      const newActions = [...currentBeat.actions];
      const currentAction = newActions[selectedActionIndex];

      // Merge spatial_transform
      let newSpatialTransform = currentAction.spatial_transform;
      if (update.spatial_transform) {
        const oldTransform = currentAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
        newSpatialTransform = { ...oldTransform, ...update.spatial_transform };
      }

      // Merge target_spatial_transform
      let newTargetSpatialTransform = currentAction.target_spatial_transform;
      if (update.target_spatial_transform !== undefined) {
        if (update.target_spatial_transform === null) {
          newTargetSpatialTransform = undefined;
        } else {
          const fallbackTarget = currentAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
          newTargetSpatialTransform = {
            ...fallbackTarget,
            ...(currentAction.target_spatial_transform || {}),
            ...update.target_spatial_transform,
          };
        }
      }

      // Merge animation_overrides
      let newAnimOverrides = currentAction.animation_overrides;
      if (update.animation_overrides) {
        newAnimOverrides = { ...(currentAction.animation_overrides || {}), ...update.animation_overrides };
      }

      newActions[selectedActionIndex] = {
        ...currentAction,
        ...(update.motion !== undefined ? { motion: update.motion } : {}),
        ...(update.style !== undefined ? { style: update.style } : {}),
        ...(update.duration_seconds !== undefined ? { duration_seconds: update.duration_seconds } : {}),
        spatial_transform: newSpatialTransform,
        target_spatial_transform: newTargetSpatialTransform,
        animation_overrides: newAnimOverrides,
      };

      const nextBeat = { ...currentBeat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleDeleteAction = () => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const currentBeat = newBeats[selectedSceneIndex];

      if (selectedCameraIndex !== null && currentBeat.cameras) {
        const newCameras = [...currentBeat.cameras];
        newCameras.splice(selectedCameraIndex, 1);
        const nextBeat = { ...currentBeat, cameras: newCameras };
        const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
        newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
        setSelectedCameraIndex(null);
        return { ...prev, beats: newBeats };
      }

      if (selectedAudioIndex !== null && currentBeat.audio) {
        const newAudio = [...currentBeat.audio];
        newAudio.splice(selectedAudioIndex, 1);
        const nextBeat = { ...currentBeat, audio: newAudio };
        newBeats[selectedSceneIndex] = nextBeat;
        setSelectedAudioIndex(null);
        return { ...prev, beats: newBeats };
      }

      if (selectedActionIndex !== null && currentBeat.actions) {
        const newActions = [...currentBeat.actions];
        newActions.splice(selectedActionIndex, 1);
        const nextBeat = { ...currentBeat, actions: newActions };
        const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
        newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
        setSelectedActionIndex(null);
        return { ...prev, beats: newBeats };
      }

      return prev;
    });
  };

  const handleUpdateCollisionBehavior = (value: "halt" | "slide" | "bounce") => {
    if (selectedActionIndex === null) return;
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const currentBeat = newBeats[selectedSceneIndex];
      const newActions = [...currentBeat.actions];
      const currentAction = newActions[selectedActionIndex];
      newActions[selectedActionIndex] = {
        ...currentAction,
        animation_overrides: {
          ...(currentAction.animation_overrides || {}),
          collision_behavior: value,
        },
      };
      const nextBeat = { ...currentBeat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleActorScaleChange = (actorId: string, scaleRatio: number) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      const targetActionIndex = selectedActionIndex !== null && beat.actions[selectedActionIndex]?.actor_id === actorId
        ? selectedActionIndex
        : beat.actions.findIndex(a => a.actor_id === actorId);

      if (targetActionIndex === -1) return prev;

      const newActions = [...beat.actions];
      const targetedAction = newActions[targetActionIndex];
      const actionDelay = targetedAction.animation_overrides?.delay ?? 0;
      const actionDuration = targetedAction.duration_seconds || 2;

      const isMovementMotion = motionNeedsTarget(targetedAction.motion);

      const newSpatialTransform = {
        ...(targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
      };
      let newTargetSpatialTransform = targetedAction.target_spatial_transform
        ? { ...targetedAction.target_spatial_transform }
        : undefined;

      const editStart = selectedKeyframe === 'start' || !selectedKeyframe;
      const editEnd = selectedKeyframe === 'end' || !selectedKeyframe;

      if (selectedKeyframe === 'start' && isMovementMotion && !newTargetSpatialTransform) {
        const oldScale = newSpatialTransform.scale;
        const duration = targetedAction.duration_seconds || 2;
        const travel = Math.max(220, Math.round(duration * 180));
        const stageW = 1920;
        const preferredDirection = (newSpatialTransform.x ?? 960) <= stageW / 2 ? 1 : -1;
        newTargetSpatialTransform = {
          x: (newSpatialTransform.x ?? 960) + travel * preferredDirection,
          y: newSpatialTransform.y,
          scale: oldScale
        };
      }

      const oldBaseScale = newSpatialTransform.scale;
      const newBaseScale = Math.max(0.1, Math.min(3.0, oldBaseScale * scaleRatio));

      if (editStart) {
        newSpatialTransform.scale = newBaseScale;
      }

      if (editEnd && isMovementMotion) {
        if (selectedKeyframe === 'end' && !newTargetSpatialTransform) {
          const fallbackTarget = targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
          newTargetSpatialTransform = { ...fallbackTarget };
        }

        if (newTargetSpatialTransform) {
          if (selectedKeyframe === 'end') {
            newTargetSpatialTransform.scale = Math.max(0.1, Math.min(3.0, (newTargetSpatialTransform.scale ?? oldBaseScale) * scaleRatio));
          } else {
            newTargetSpatialTransform.scale = Math.max(0.1, Math.min(3.0, (newTargetSpatialTransform.scale ?? oldBaseScale) * (newBaseScale / oldBaseScale)));
          }
        }
      }

      newActions[targetActionIndex] = {
        ...targetedAction,
        spatial_transform: newSpatialTransform,
        target_spatial_transform: newTargetSpatialTransform
      };

      const nextBeat = { ...beat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;

      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleActorRotationChange = (actorId: string, rotation: number) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      const targetActionIndex = selectedActionIndex !== null && beat.actions[selectedActionIndex]?.actor_id === actorId
        ? selectedActionIndex
        : beat.actions.findIndex(a => a.actor_id === actorId);

      if (targetActionIndex === -1) return prev;

      const newActions = [...beat.actions];
      const targetedAction = newActions[targetActionIndex];

      const newSpatialTransform = {
        ...(targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
      };
      let newTargetSpatialTransform = targetedAction.target_spatial_transform
        ? { ...targetedAction.target_spatial_transform }
        : undefined;

      const editStart = selectedKeyframe === 'start' || !selectedKeyframe;
      const editEnd = selectedKeyframe === 'end';

      if (editStart) {
        newSpatialTransform.rotation = Math.round(rotation);
      }
      if (editEnd && newTargetSpatialTransform) {
        newTargetSpatialTransform.rotation = Math.round(rotation);
      } else if (editEnd) {
        newTargetSpatialTransform = {
          ...(targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5 }),
          rotation: Math.round(rotation),
        };
      }

      newActions[targetActionIndex] = {
        ...targetedAction,
        spatial_transform: newSpatialTransform,
        target_spatial_transform: newTargetSpatialTransform,
      };

      const nextBeat = { ...beat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleActorFlip = (actorId: string) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      const targetActionIndex = selectedActionIndex !== null && beat.actions[selectedActionIndex]?.actor_id === actorId
        ? selectedActionIndex
        : beat.actions.findIndex(a => a.actor_id === actorId);

      if (targetActionIndex === -1) return prev;

      const newActions = [...beat.actions];
      const targetedAction = newActions[targetActionIndex];

      const newSpatialTransform = {
        ...(targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
      };

      // Toggle flip_x
      newSpatialTransform.flip_x = !(newSpatialTransform.flip_x ?? false);

      newActions[targetActionIndex] = {
        ...targetedAction,
        spatial_transform: newSpatialTransform,
      };

      const nextBeat = { ...beat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;
      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleCameraChange = useCallback((cameraUpdate: { zoom: number; x: number; y: number; rotation: number; isEndKeyframe?: boolean }) => {
    // Clamp to prevent extreme values from zoom-amplified drag
    const clampedX = Math.max(-3000, Math.min(3000, Math.round(cameraUpdate.x)));
    const clampedY = Math.max(-3000, Math.min(3000, Math.round(cameraUpdate.y)));
    const clampedZoom = Math.max(0.2, Math.min(3.0, cameraUpdate.zoom));

    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      const currentCamera = beat.cameras?.[0] || { zoom: 1, x: 960, y: 540, rotation: 0 };
      let newCamera = { ...currentCamera };

      if (cameraUpdate.isEndKeyframe) {
        newCamera.target_x = clampedX;
        newCamera.target_y = clampedY;
        newCamera.target_zoom = clampedZoom;
      } else {
        newCamera.x = clampedX;
        newCamera.y = clampedY;
        newCamera.zoom = clampedZoom;
        newCamera.rotation = cameraUpdate.rotation;
      }

      const updatedBeat = { ...beat, cameras: [newCamera, ...(beat.cameras?.slice(1) || [])] };
      const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
      const recompiled = compileBeatToScene(updatedBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...updatedBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  }, [selectedSceneIndex]);

  const handleActorPositionChange = (actorId: string, dx: number, dy: number) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;

      // Only apply position to the currently targeted action, or the first action if none selected
      const targetActionIndex = selectedActionIndex !== null && beat.actions[selectedActionIndex]?.actor_id === actorId
        ? selectedActionIndex
        : beat.actions.findIndex(a => a.actor_id === actorId);

      if (targetActionIndex === -1) return prev;

      const newActions = [...beat.actions];
      const targetedAction = newActions[targetActionIndex];
      const actionDelay = targetedAction.animation_overrides?.delay ?? 0;
      const actionDuration = targetedAction.duration_seconds || 2;

      const isMovementMotion = motionNeedsTarget(targetedAction.motion);

      const newSpatialTransform = {
        ...(targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
      };
      let newTargetSpatialTransform = targetedAction.target_spatial_transform
        ? { ...targetedAction.target_spatial_transform }
        : undefined;

      const editStart = selectedKeyframe === 'start' || !selectedKeyframe;
      const editEnd = selectedKeyframe === 'end' || !selectedKeyframe;

      // 1. If explicit 'start' edit, and no target, bake the target so it doesn't move.
      if (selectedKeyframe === 'start' && isMovementMotion && !newTargetSpatialTransform) {
        const oldX = newSpatialTransform.x;
        const duration = targetedAction.duration_seconds || 2;
        const travel = Math.max(220, Math.round(duration * 180));
        const stageW = 1920;
        const preferredDirection = oldX <= stageW / 2 ? 1 : -1;
        newTargetSpatialTransform = {
          x: oldX + travel * preferredDirection,
          y: newSpatialTransform.y,
          scale: newSpatialTransform.scale
        };
      }

      // 2. Apply Start edit
      if (editStart) {
        newSpatialTransform.x = Math.round(newSpatialTransform.x + dx);
        newSpatialTransform.y = Math.round(newSpatialTransform.y + dy);
      }

      // 3. Apply End edit
      if (editEnd && isMovementMotion) {
        // If explicit 'end' edit and no target, we must initialize it to edit it independently
        if (selectedKeyframe === 'end' && !newTargetSpatialTransform) {
          const fallbackTarget = targetedAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
          newTargetSpatialTransform = { ...fallbackTarget };
        }

        // Only apply dx/dy to target if it exists. (If it doesn't exist, editStart moved the base, which moves the implicit target).
        if (newTargetSpatialTransform) {
          newTargetSpatialTransform.x = Math.round((newTargetSpatialTransform.x ?? 960) + dx);
          newTargetSpatialTransform.y = Math.round((newTargetSpatialTransform.y ?? 950) + dy);
        }
      }

      newActions[targetActionIndex] = {
        ...targetedAction,
        spatial_transform: newSpatialTransform,
        target_spatial_transform: newTargetSpatialTransform
      };

      const nextBeat = { ...beat, actions: newActions };
      const previousCompiledScene = selectedSceneIndex > 0
        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
        : null;

      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
      return { ...prev, beats: newBeats };
    });
  };

  const handleExportTimelineReady = (durationSeconds: number) => {
    exportTimelineDurationRef.current = durationSeconds;
    exportTimelineReadyResolverRef.current?.(durationSeconds);
    exportTimelineReadyResolverRef.current = null;
  };

  const handleExport = async () => {
    if (!storyData) return;

    const beatsToExport = (playbackScope === "all"
      ? storyData.beats
      : storyData.beats[selectedSceneIndex]
        ? [storyData.beats[selectedSceneIndex]]
        : []
    ).filter(beat => beat.compiled_scene);

    if (beatsToExport.length === 0) {
      setError("No compiled scene is available to export. Run Animate Scene first.");
      return;
    }

    const missingCompiled = (playbackScope === "all"
      ? storyData.beats
      : storyData.beats[selectedSceneIndex]
        ? [storyData.beats[selectedSceneIndex]]
        : []
    ).filter(beat => !beat.compiled_scene);

    if (missingCompiled.length > 0) {
      const missingScenes = missingCompiled.map(beat => beat.scene_number).join(", ");
      setError(`Scene ${missingScenes} is not compiled yet. Run Animate Scene before exporting.`);
      return;
    }

    try {
      setIsExporting(true);
      setError(null);
      setExportProgress("Preparing export stage...");
      const resolution = EXPORT_RESOLUTIONS[exportResolution];
      const canvas = document.createElement("canvas");
      canvas.width = resolution.width;
      canvas.height = resolution.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas export context could not be created.");
      }

      const formData = new FormData();
      formData.append("fileName", `${storyData.title || "cartoon"}-${playbackScope}-${resolution.label}.mp4`);
      formData.append("fps", String(fps));
      formData.append("width", String(resolution.width));
      formData.append("height", String(resolution.height));

      let frameSerial = 1;
      let globalTimeOffset = 0;
      const audioTracks: { url: string; startTime: number; id: string }[] = [];

      for (let sceneOffset = 0; sceneOffset < beatsToExport.length; sceneOffset += 1) {
        const beat = beatsToExport[sceneOffset];
        const compiledScene = beat.compiled_scene!;

        if (beat.audio) {
          beat.audio.forEach((track, i) => {
            if (track.audio_data_url) {
              audioTracks.push({
                url: track.audio_data_url,
                startTime: globalTimeOffset + (track.start_time ?? 0),
                id: `t${sceneOffset}_${i}`
              });
            }
          });
        }

        setExportProgress(`Rendering Scene ${beat.scene_number}...`);
        const durationPromise = waitForExportTimelineReady();
        setExportBeatState({
          beat,
          compiledScene,
          key: `${beat.scene_number}-${Date.now()}-${sceneOffset}`,
        });
        setExportPlayheadTime(0);

        await waitForAnimationFrames(2);
        const timelineDuration = await durationPromise;
        const sceneDuration = timelineDuration > 0 ? timelineDuration : compiledScene.duration_seconds;
        const frameCount = Math.max(1, Math.ceil(sceneDuration * fps) + 1);

        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          const timeSeconds = Math.min(sceneDuration, frameIndex / fps);
          setExportProgress(`Rendering Scene ${beat.scene_number} frame ${frameIndex + 1}/${frameCount}...`);
          const svgMarkup = await captureExportStageSvg(timeSeconds);
          const image = await loadSvgIntoImage(svgMarkup);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const pngBlob = await canvasToPngBlob(canvas);
          const frameName = `frame-${String(frameSerial).padStart(6, "0")}.png`;
          formData.append("frames", pngBlob, frameName);
          frameSerial += 1;
        }

        globalTimeOffset += sceneDuration;
      }

      setExportProgress("Packaging audio tracks...");
      const audioMetadata: { filename: string; start: number }[] = [];
      for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        try {
          const r = await fetch(track.url);
          const blob = await r.blob();
          const filename = `audio_${track.id}.mp3`;
          formData.append("audio_files", blob, filename);
          audioMetadata.push({ filename, start: track.startTime });
        } catch (e) {
          console.error("Failed to package audio track", e);
        }
      }
      formData.append("audio_metadata", JSON.stringify(audioMetadata));

      setExportProgress(`Encoding MP4 (${resolution.label})...`);

      const response = await fetch("/api/export", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => null) }));
        throw new Error(payload?.error || `Export failed (${response.status}).`);
      }

      const blob = await response.blob();
      const suggestedName = response.headers.get("x-export-filename") || `${storyData.title || "cartoon"}-${playbackScope}.mp4`;
      downloadBlob(blob, suggestedName);
      setExportProgress(`Export complete: ${suggestedName}`);
    } catch (err) {
      console.error("Export failed", err);
      setError(err instanceof Error ? err.message : "Export failed.");
      setExportProgress(null);
    } finally {
      setIsExporting(false);
      setExportBeatState(null);
      exportTimelineDurationRef.current = 0;
      exportTimelineReadyResolverRef.current = null;
    }
  };

  return (

    <div className="h-screen h-[100dvh] w-screen bg-neutral-50 dark:bg-[#050505] text-neutral-900 dark:text-neutral-200 flex flex-col font-sans selection:bg-cyan-500/30 relative overflow-hidden transition-colors duration-300">

      {/* Background Ambience Layers */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />

      {/* Premium Glass Header */}
      <header className="h-16 border-b border-neutral-200/60 dark:border-neutral-800/60 bg-white/70 dark:bg-[#0a0a0a]/70 backdrop-blur-xl flex items-center px-6 shrink-0 z-10 sticky top-0 shadow-[0_4px_30px_rgba(0,0,0,0.05)] dark:shadow-[0_4px_30px_rgba(0,0,0,0.1)] transition-colors duration-300">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-[0_0_15px_rgba(34,211,238,0.3)]">
            <Play size={16} className="text-white fill-white ml-0.5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-gradient-to-br from-neutral-800 dark:from-white via-neutral-600 dark:via-neutral-200 to-neutral-500 dark:to-neutral-400 bg-clip-text text-transparent">
            Cartoon 2D
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <div className="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-xs font-medium text-cyan-600 dark:text-cyan-400 flex items-center gap-1.5 shadow-[0_0_10px_rgba(34,211,238,0.1)]">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 dark:bg-cyan-400 animate-pulse" /> Prototype v0.2
          </div>
        </div>
      </header>

      {/* Main Workspace (Now Resizable) */}
      <main className="flex-1 flex overflow-hidden z-10 w-full">

        {/* Far Left Column: Project Assets Sidebar */}
        <aside className={`${sidebarCollapsed ? 'w-12' : 'w-16 md:w-48 lg:w-64'} border-r border-neutral-200/50 dark:border-neutral-800/50 bg-white/60 dark:bg-[#070707]/60 backdrop-blur-md flex flex-col pt-2 hidden sm:flex shrink-0 transition-all duration-300`}>
          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={`w-6 h-6 rounded-md flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-cyan-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60 transition-colors mb-2 shrink-0 ${sidebarCollapsed ? 'mx-auto' : 'ml-auto mr-2'}`}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronDown size={14} className={`transform transition-transform ${sidebarCollapsed ? '-rotate-90' : 'rotate-90'}`} />
          </button>
          {!sidebarCollapsed && (<>
            {/* Project Switcher Dropdown */}
            <div className="px-3 mb-4 relative z-50">
              <button
                onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
                className="w-full bg-white dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700/50 rounded-lg px-3 py-2 flex items-center justify-between shadow-sm hover:border-cyan-500/50 transition-colors group"
              >
                <div className="flex flex-col items-start truncate">
                  <span className="text-[9px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">Current Draft</span>
                  <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200 truncate pr-2">
                    {projects.find(p => p.id === currentProjectId)?.title || "Loading..."}
                  </span>
                </div>
                <ChevronDown size={14} className="text-neutral-400 group-hover:text-cyan-500 transition-colors" />
              </button>

              {isProjectDropdownOpen && (
                <div className="absolute top-full left-3 right-3 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 z-50">
                  <div className="max-h-60 overflow-y-auto custom-scrollbar">
                    {projects.map(proj => (
                      <div
                        key={proj.id}
                        className={`group flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors border-l-2 ${proj.id === currentProjectId ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/10' : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                        onClick={() => handleSwitchProject(proj.id)}
                      >
                        {editingProjectId === proj.id ? (
                          <input
                            autoFocus
                            value={editProjectTitle}
                            onChange={(e) => setEditProjectTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleUpdateProjectTitle(proj.id, editProjectTitle);
                              if (e.key === 'Escape') setEditingProjectId(null);
                            }}
                            onBlur={() => handleUpdateProjectTitle(proj.id, editProjectTitle)}
                            className="flex-1 bg-white dark:bg-neutral-800 border-b border-cyan-500 focus:outline-none text-xs px-1 py-0.5"
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <span className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-300 pr-2">
                            {proj.title}
                          </span>
                        )}

                        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingProjectId(proj.id);
                              setEditProjectTitle(proj.title);
                              setConfirmDeleteId(null);
                            }}
                            className="p-1 hover:text-cyan-600 dark:hover:text-cyan-400 text-neutral-400"
                            title="Rename Cartoon"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={(e) => handleDeleteProject(proj.id, e)}
                            className={`p-1 transition-all ${confirmDeleteId === proj.id
                              ? 'text-red-500 scale-110 animate-pulse'
                              : 'text-neutral-400 hover:text-red-400'
                              }`}
                            title={confirmDeleteId === proj.id ? "Click again to delete" : "Delete Cartoon"}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="p-2 border-t border-neutral-100 dark:border-neutral-800">
                    {newCartoonName !== null ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={newCartoonName}
                          onChange={(e) => setNewCartoonName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreateProject(newCartoonName);
                            if (e.key === 'Escape') setNewCartoonName(null);
                          }}
                          placeholder={`New Cartoon ${projects.length + 1}`}
                          className="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-cyan-500 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400"
                        />
                        <button
                          onClick={() => handleCreateProject(newCartoonName)}
                          className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                          title="Create"
                        >✓</button>
                        <button
                          onClick={() => setNewCartoonName(null)}
                          className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                          title="Cancel"
                        >✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setNewCartoonName('')}
                        className="w-full py-1.5 flex items-center justify-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/20 rounded transition-colors"
                      >
                        <Plus size={12} /> New Cartoon
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-3 space-y-1 custom-scrollbar">
              {/* Asset Categories */}
              <div className="px-2 py-2 flex items-center gap-3 text-sm text-cyan-700 dark:text-cyan-400 font-medium bg-cyan-100/60 dark:bg-cyan-900/10 rounded-lg cursor-pointer hover:bg-cyan-200/60 dark:hover:bg-cyan-900/20 transition-colors group">
                <LayoutList size={14} /> <span className="flex-1">Scenes</span>
                {storyData && (
                  <button
                    title={confirmClearStory ? "Click again to confirm" : "Clear Story Database"}
                    className={`focus:outline-none transition-all ${confirmClearStory ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirmClearStory) {
                        if (currentProjectId) clearStoryStorage(currentProjectId);
                        setStoryData(null);
                        setConfirmClearStory(false);
                      } else {
                        setConfirmClearStory(true);
                        setTimeout(() => setConfirmClearStory(false), 3000);
                      }
                    }}
                  >
                    <Trash2
                      size={12}
                      className={`transition-colors ${confirmClearStory ? 'text-red-500 animate-pulse' : 'text-cyan-700/50 hover:text-red-500'}`}
                    />
                  </button>
                )}
                <span className="min-w-[1.5rem] text-center text-xs bg-cyan-200/60 dark:bg-cyan-900/40 px-1.5 py-0.5 rounded-md text-cyan-800 dark:text-cyan-300">{storyData?.beats.length || 0}</span>
              </div>
              {storyData && storyData.beats.length > 0 && (
                <div className="mt-1 space-y-1 pl-2 pr-1">
                  {storyData.beats.map((beat, index) => (
                    <div
                      key={`scene-nav-${index}`}
                      onClick={() => setSelectedSceneIndex(index)}
                      className={`px-2 py-1.5 rounded-md cursor-pointer transition-colors group ${selectedSceneIndex === index ? 'bg-cyan-100 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600">
                          {beat.image_data ? (
                            <img
                              src={beat.image_data}
                              alt={`Scene ${index + 1}`}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-neutral-400 dark:text-neutral-500">
                              <LayoutList size={12} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 truncate">Scene {index + 1}</div>
                          <div className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                            {beat.narrative}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setScenePreviewIndex(index);
                            setEditPrompt("");
                          }}
                          className="p-1.5 rounded text-neutral-400 hover:text-cyan-500 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors opacity-0 group-hover:opacity-100"
                          title="Inspect scene"
                        >
                          <LayoutList size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Empty Scene button */}
            <button
              onClick={() => {
                setStoryData(prev => {
                  const beats = prev?.beats || [];
                  const emptyBeat = {
                    scene_number: beats.length + 1,
                    narrative: "",
                    mood: "neutral",
                    actions: [],
                    dialogues: [],
                    cameras: [{ start_time: 0, zoom: 1, x: 0, y: 0, rotation: 0 }],
                    audio: [],
                    comic_panel_prompt: "",
                    duration_seconds: 5.0,
                  } satisfies Record<string, unknown> as unknown as typeof beats[number];
                  const newBeats = [...beats, emptyBeat];
                  const newData = prev
                    ? { ...prev, beats: newBeats }
                    : { title: "", actors_detected: [], beats: newBeats };
                  setSelectedSceneIndex(newBeats.length - 1);
                  return newData;
                });
              }}
              className="w-full mt-1 py-1 border border-dashed border-neutral-300/60 dark:border-neutral-700/40 hover:border-cyan-400 dark:hover:border-cyan-600 rounded-lg text-[10px] font-medium text-neutral-400 dark:text-neutral-600 hover:text-cyan-600 dark:hover:text-cyan-400 transition-all flex items-center justify-center gap-1.5 hover:bg-cyan-50/50 dark:hover:bg-cyan-950/20"
            >
              <Plus size={10} /> Empty Scene
            </button>
            {/* Backgrounds Section */}
            <div>
              <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
                <Mountain size={14} /> <span className="flex-1">Backgrounds</span>
                <span className="min-w-[1.5rem] text-center text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md text-neutral-700 dark:text-neutral-300">
                  {storyData?.beats.filter(b => b.drafted_background).length || 0}
                </span>
              </div>
              {storyData && storyData.beats.some(b => b.drafted_background) && (
                <div className="mt-1 space-y-1 pl-2 pr-1">
                  {storyData.beats.map((beat, bIdx) => {
                    if (!beat.drafted_background) return null;
                    return (
                      <div
                        key={`bg-${bIdx}`}
                        className="px-2 py-1.5 rounded-md cursor-pointer transition-colors group hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-6 rounded overflow-hidden flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600">
                            {beat.image_data ? (
                              <img src={beat.image_data} alt={`Scene ${bIdx + 1} bg`} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-neutral-400 dark:text-neutral-500">
                                <Mountain size={10} />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[10px] font-semibold text-neutral-700 dark:text-neutral-200 truncate">
                              {beat.narrative?.slice(0, 30) || `Scene ${bIdx + 1} BG`}
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setStoryData(prev => {
                                if (!prev || !prev.beats[selectedSceneIndex]) return prev;
                                const newBeats = [...prev.beats];
                                const currentBeat = newBeats[selectedSceneIndex];
                                newBeats[selectedSceneIndex] = {
                                  ...currentBeat,
                                  drafted_background: JSON.parse(JSON.stringify(beat.drafted_background)),
                                  image_data: beat.image_data,
                                };
                                return { ...prev, beats: newBeats };
                              });
                            }}
                            className="p-1 rounded text-neutral-400 hover:text-cyan-500 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors opacity-0 group-hover:opacity-100"
                            title={`Use this background in Scene ${selectedSceneIndex + 1}`}
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Actors Section */}
            <div>
                <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
                  <ImageIcon size={14} /> <span className="flex-1">Actors</span> <span className="min-w-[1.5rem] text-center text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md text-neutral-700 dark:text-neutral-300">{storyData?.actors_detected.length || 0}</span>
                </div>
                {storyData && storyData.actors_detected.length > 0 && (
                  <div className="mt-1 space-y-1 pl-2 pr-1">
                    {storyData.actors_detected.map(actor => (
                      (() => {
                        const hasRig = !!actor.drafted_rig;
                        const clipNames = Array.from(new Set([
                          ...Object.keys(actor.drafted_rig?.rig_data.motion_clips || {}),
                          ...Object.keys(actor.drafted_rig?.rig_data.animation_clips || {}),
                        ])).sort();
                        return (
                          <div
                            key={actor.id}
                            onClick={() => handleActorSelect(selectedActorId === actor.id ? null : actor.id)}
                            className={`px-2 py-1.5 rounded-md cursor-pointer transition-colors group ${selectedActorId === actor.id ? 'bg-cyan-100 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
                          >
                            <div className="flex items-center gap-2">
                              {/* Actor Thumbnail */}
                              <div className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600">
                                {actorReferences[actor.id] ? (
                                  <img
                                    src={actorReferences[actor.id]}
                                    alt={actor.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-neutral-400 dark:text-neutral-500">
                                    <ImageIcon size={12} />
                                  </div>
                                )}
                              </div>
                              {/* Actor Info & Draft Button */}
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 truncate">{actor.name}</div>
                                <div className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                                  {actor.species}
                                  {hasRig && (
                                    <span className="ml-1 text-cyan-600 dark:text-cyan-400">
                                      • object{clipNames.length > 0 ? ` + ${clipNames.length} action${clipNames.length === 1 ? "" : "s"}` : ""}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Actor Toolbar */}
                              {actorReferences[actor.id] && (
                                <div className="flex items-center gap-1">
                                  {/* Add to Timeline Button */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const actionIndex = storyData?.beats[selectedSceneIndex]?.actions.length ?? 0;
                                      setSelectedActorId(actor.id);
                                      setSelectedActionIndex(actionIndex);
                                      setStoryData(prev => {
                                        if (!prev || !prev.beats[selectedSceneIndex]) return prev;
                                        const newBeats = [...prev.beats];
                                        const currentBeat = newBeats[selectedSceneIndex];
                                        const newActions = [...currentBeat.actions, {
                                          actor_id: actor.id,
                                          motion: "idle",
                                          style: "neutral",
                                          start_time: 0,
                                          duration_seconds: 5.0,
                                        }];
                                        const nextBeat = { ...currentBeat, actions: newActions };
                                        const previousCompiledScene = selectedSceneIndex > 0
                                          ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
                                          : null;
                                        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                                        newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                    className="p-1.5 rounded text-neutral-400 hover:text-cyan-500 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors opacity-0 group-hover:opacity-100"
                                    title="Add to Timeline"
                                  >
                                    <Plus size={14} />
                                  </button>

                                  {/* Delete Actor Button */}
                                  <button
                                    onClick={(e) => handleDeleteActor(actor.id, e)}
                                    className={`p-1.5 rounded transition-all group-hover:opacity-100 ${confirmDeleteActorId === actor.id
                                        ? "text-red-500 bg-red-100 dark:bg-red-950/30 opacity-100 cursor-pointer"
                                        : "text-neutral-400 hover:text-red-500 opacity-0 bg-transparent hover:bg-red-50 dark:hover:bg-950/20"
                                      }`}
                                    title={confirmDeleteActorId === actor.id ? "Click again to delete" : "Delete Actor"}
                                  >
                                    <Trash2 size={14} />
                                  </button>

                                  {/* Draft Vector Rig Button */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDraftingActorId(actor.id);
                                      // Load cached rig if it exists, otherwise prepare for new generation
                                      setDraftedRig(actor.drafted_rig ? JSON.parse(JSON.stringify(actor.drafted_rig)) : null);
                                      setOriginalDraftedRig(actor.drafted_rig ? JSON.parse(JSON.stringify(actor.drafted_rig)) : null);
                                      setDraftReview(null);
                                      setRigFixPrompt("");
                                      setDraftError(null);
                                    }}
                                    className={`p-1.5 rounded transition-colors group-hover:opacity-100 ${actor.drafted_rig
                                      ? "text-emerald-500 hover:text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 opacity-100 border border-emerald-200 dark:border-emerald-700/50"
                                      : "text-neutral-400 hover:text-cyan-500 opacity-0 bg-transparent"
                                      }`}
                                    title={actor.drafted_rig ? "View Vector Rig" : "Generate SVG Vector Rig"}
                                  >
                                    {actor.drafted_rig ? (
                                      <div className="relative">
                                        <Sparkles size={14} />
                                        <div className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full border border-white dark:border-neutral-900"></div>
                                      </div>
                                    ) : (
                                      <Sparkles size={14} />
                                    )}
                                  </button>
                                </div>
                              )}
                            </div>

                            {selectedActorId === actor.id && hasRig && (
                              <div className="mt-2 flex flex-wrap gap-1 pl-10">
                                <button
                                  key={`${actor.id}-base-object`}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDraftingActorId(actor.id);
                                    setDraftedRig(actor.drafted_rig ? JSON.parse(JSON.stringify(actor.drafted_rig)) : null);
                                    setOriginalDraftedRig(actor.drafted_rig ? JSON.parse(JSON.stringify(actor.drafted_rig)) : null);
                                    setDraftReview(null);
                                    setRigFixPrompt("");
                                    setDraftError(null);
                                  }}
                                  className="inline-flex items-center rounded-full border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 text-[9px] font-mono text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors"
                                  title={`Open the base SVG rig for ${actor.name}`}
                                >
                                  object
                                </button>
                                {clipNames.map(clipName => (
                                  <button
                                    key={`${actor.id}-${clipName}`}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setClipPreviewState({ actorId: actor.id, clipName });
                                      clipPreviewPlayheadRef.current = 0;
                                      setClipPreviewPlayhead(0);
                                      setClipPreviewPlaying(true);
                                    }}
                                    className="inline-flex items-center rounded-full border border-cyan-200 dark:border-cyan-800/50 bg-cyan-50 dark:bg-cyan-900/20 px-2 py-0.5 text-[9px] font-mono text-cyan-700 dark:text-cyan-300 hover:bg-cyan-100 dark:hover:bg-cyan-900/30 transition-colors"
                                    title={`Preview reusable motion clip on ${actor.name}`}
                                  >
                                    {clipName}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()
                    ))}
                  </div>
                )}
              </div>
              {/* Background Props subsection */}
              {(() => {
                const beatProps = storyData?.beats[selectedSceneIndex]?.drafted_background?.rig_data?.interactionNulls;
                if (!beatProps || beatProps.length === 0) return null;
                return (
                  <div>
                    <div className="px-2 py-1.5 text-[10px] font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
                      <Mountain size={12} /> Props
                    </div>
                    <div className="mt-0.5 space-y-0.5 pl-2 pr-1">
                      {beatProps.map(propId => (
                        <div
                          key={propId}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition-colors"
                        >
                          <div className="w-2 h-2 rounded-sm bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                          <span className="text-[10px] text-neutral-600 dark:text-neutral-400 truncate">{propId}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
                <Volume2 size={14} /> <span className="flex-1">Audio</span> <span className="min-w-[1.5rem] text-center text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md text-neutral-700 dark:text-neutral-300">0</span>
              </div>
            </div>
          </>)}
        </aside>

        <PanelGroup direction="horizontal" className="flex-1 w-full h-full">

          {/* Left Panel: Director's Prompt & Comic Timeline */}
          <Panel defaultSize={30} minSize={20}>
            <div className="w-full h-full flex flex-col bg-white/40 dark:bg-[#111]/40 backdrop-blur-sm transition-colors duration-300">
              <section className="flex-1 flex flex-col px-6 py-8 pb-0 overflow-hidden">
                <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest mb-4 flex items-center gap-2.5">
                  <Sparkles size={16} className="text-cyan-500 dark:text-cyan-400" /> Director&apos;s Prompt
                </h2>

                <div className="relative group shrink-0">
                  <div className={`absolute -inset-0.5 bg-gradient-to-r from-cyan-400/30 dark:from-cyan-500/20 to-blue-400/30 dark:to-blue-500/20 rounded-2xl blur transition duration-500 ${isGenerating ? 'opacity-100 animate-pulse' : 'opacity-0 group-hover:opacity-100'}`} />
                  <div className="relative bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded-xl overflow-hidden shadow-sm dark:shadow-inner transition-colors duration-300">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      className="w-full h-28 bg-transparent p-5 pb-2 text-sm resize-none focus:outline-none placeholder-neutral-400 dark:placeholder-neutral-600 text-neutral-800 dark:text-neutral-200"
                      placeholder="Describe a scene... e.g., 'A robot cat stares at a vacuum cleaner suspiciously.'"
                      disabled={isGenerating}
                    />
                    <div className="flex items-center justify-end gap-2 px-3 pb-3 pt-1">
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !prompt.trim()}
                        className="bg-neutral-900 dark:bg-white disabled:bg-neutral-300 dark:disabled:bg-neutral-600 disabled:text-neutral-500 dark:disabled:text-neutral-400 hover:bg-neutral-700 dark:hover:bg-neutral-200 text-white dark:text-black px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 shadow-md dark:hover:shadow-[0_0_15px_rgba(255,255,255,0.4)] disabled:shadow-none transform hover:-translate-y-0.5 disabled:transform-none font-medium text-sm"
                      >
                        {isGenerating ? (
                          <><Loader2 size={14} className="animate-spin" /> <span>Directing...</span></>
                        ) : (
                          <><span>Generate Scene</span><Send size={14} /></>
                        )}
                      </button>
                      {(isGenerating || animatingSceneIndex !== null) && (
                        <button
                          onClick={handleCancelAll}
                          className="bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30 px-4 py-2 rounded-lg transition-all duration-300 shadow-md font-medium text-sm flex items-center justify-center min-w-[3rem]"
                          title="Cancel All Ongoing AI Operations"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mt-4 p-3 rounded bg-red-100 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 text-xs text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="mt-10 flex-1 flex flex-col min-h-0 overflow-hidden">
                  <div className="mb-4 flex items-center gap-3 shrink-0">
                    <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2.5 whitespace-nowrap shrink-0">
                      <LayoutList size={16} className="text-blue-500 dark:text-blue-400" /> Storyboard
                    </h2>
                    <div className="flex items-center gap-2 ml-auto shrink-0">
                      <span className="text-[9px] font-mono text-amber-600 dark:text-amber-400 whitespace-nowrap">~${projectCostSummary.cost.toFixed(4)}</span>
                      <span className="text-[9px] font-mono text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{projectCostSummary.compiledScenes}/{storyData?.beats.length || 0}</span>
                      {(isGenerating || animatingSceneIndex !== null) && (
                        <span className="flex items-center gap-1 text-[9px] font-mono text-cyan-600 dark:text-cyan-400 whitespace-nowrap">
                          <Loader2 size={9} className="animate-spin" />
                          {Math.floor(elapsedSeconds / 60)}:{(elapsedSeconds % 60).toString().padStart(2, '0')} {isGenerating ? 'gen' : 'anim'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Timeline Scroll Area */}
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 pb-8 custom-scrollbar">

                    {!storyData ? (
                      <div className="flex flex-col items-center justify-center h-full max-w-xs mx-auto text-center px-4">
                        <div className="w-16 h-16 mb-4 rounded-full bg-white dark:bg-[#111] flex items-center justify-center border border-neutral-200 dark:border-neutral-800/80 shadow-sm dark:shadow-[0_0_15px_rgba(0,0,0,0.5)] transition-colors duration-300">
                          <Film strokeWidth={1.5} className="w-8 h-8 text-neutral-400 dark:text-neutral-500" />
                        </div>
                        <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Awaiting Direction</h3>
                        <p className="text-xs text-neutral-500 dark:text-neutral-500 leading-relaxed">
                          Describe your sequence in the prompt above to generate the storyboard beats and comic panels.
                        </p>
                      </div>
                    ) : (
                      storyData.beats.map((beat, index) => {
                        const imageGenCost = getBeatImageGenerationCost(beat, index, beatGenerationCosts);
                        const hasExactImageGenCost = !!(
                          beat.image_generation_cost ||
                          beat.compile_report?.image_generation_cost ||
                          beatGenerationCosts[index]
                        );

                        return (
                          <div key={index} onClick={() => setSelectedSceneIndex(index)} className="cursor-pointer relative pl-1">
                            {/* Node Dot */}
                            <div className={`absolute left-0 top-6 w-3 h-3 rounded-full border-2 z-10 transition-all ${selectedSceneIndex === index ? 'bg-cyan-500 border-white shadow-[0_0_15px_rgba(34,211,238,0.8)] scale-125' : 'bg-white dark:bg-[#111] border-neutral-300 dark:border-neutral-700'}`} />

                            <div className={`ml-6 p-1 rounded-2xl border backdrop-blur-md shadow-lg transition-all duration-300 group/card ${selectedSceneIndex === index ? 'bg-cyan-50/50 dark:bg-cyan-900/20 border-cyan-400 dark:border-cyan-500/50 shadow-[0_8px_30px_rgba(34,211,238,0.15)]' : 'bg-white dark:bg-[#0f0f0f] border-neutral-200 dark:border-neutral-800/60 hover:border-cyan-300 dark:hover:border-neutral-700/80'}`}>
                              {/* Always-visible header with scene number + controls */}
                              <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-50 dark:bg-[#0a0a0a] border-b border-neutral-200/80 dark:border-neutral-800/50">
                                <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Scene {index + 1}</span>
                                <div className="flex items-center gap-0.5">
                                  {/* Move Up */}
                                  <button
                                    className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                    title="Move Up"
                                    disabled={index === 0}
                                    onClick={() => {
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        [newBeats[index - 1], newBeats[index]] = [newBeats[index], newBeats[index - 1]];
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                  >
                                    <ChevronUp size={12} />
                                  </button>
                                  {/* Move Down */}
                                  <button
                                    className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                    title="Move Down"
                                    disabled={index === storyData.beats.length - 1}
                                    onClick={() => {
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        [newBeats[index], newBeats[index + 1]] = [newBeats[index + 1], newBeats[index]];
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                  >
                                    <ChevronDown size={12} />
                                  </button>
                                  {/* Duplicate */}
                                  <button
                                    className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                                    title="Duplicate Scene"
                                    onClick={() => {
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        const clone = JSON.parse(JSON.stringify(prev.beats[index]));
                                        newBeats.splice(index + 1, 0, clone);
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                  >
                                    <Copy size={12} />
                                  </button>
                                  {/* Generate Audio */}
                                  <button
                                    className={`p-1 rounded transition-all ${generatingAudioIndex === index ? "text-amber-500 animate-pulse" : (beat.audio.some(a => a.type === 'dialogue' && a.audio_data_url) ? "text-amber-500 hover:text-amber-600 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700/50" : "text-neutral-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-neutral-200 dark:hover:bg-neutral-800")}`}
                                    title="Generate Dialogue Audio (TTS)"
                                    onClick={() => handleGenerateVoices(index)}
                                    disabled={generatingAudioIndex !== null}
                                  >
                                    <Volume2 size={12} />
                                  </button>
                                  {/* Draft Background */}
                                  <button
                                    className={`p-1 rounded transition-colors ${beat.drafted_background ? "text-emerald-500 hover:text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700/50" : "text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
                                    title={beat.drafted_background ? "View Vector Background" : "Generate SVG Background"}
                                    onClick={() => {
                                      setDraftingBackgroundSceneIndex(index);
                                      setDraftBackgroundError(null);
                                    }}
                                  >
                                    {beat.drafted_background ? (
                                      <div className="relative">
                                        <Mountain size={12} />
                                        <div className="absolute -top-0.5 -right-0.5 w-[5px] h-[5px] bg-emerald-500 rounded-full"></div>
                                      </div>
                                    ) : (
                                      <Mountain size={12} />
                                    )}
                                  </button>
                                  {/* Edit */}
                                  {editingBeatIndex !== index && (
                                    <button
                                      className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                                      title="Edit Panel"
                                      onClick={() => {
                                        setEditingBeatIndex(index);
                                        setEditPrompt("");
                                      }}
                                    >
                                      <Pencil size={12} />
                                    </button>
                                  )}
                                  {/* Delete (inline confirm) */}
                                  <button
                                    className={`p-1 rounded transition-all ${confirmDeleteBeatIndex === index ? 'bg-red-100 dark:bg-red-950/30 text-red-500 animate-pulse' : 'hover:bg-red-100 dark:hover:bg-red-950/30 text-neutral-400 hover:text-red-500'}`}
                                    title={confirmDeleteBeatIndex === index ? "Click again to delete" : "Delete Scene"}
                                    onClick={() => {
                                      if (confirmDeleteBeatIndex === index) {
                                        setStoryData(prev => {
                                          if (!prev) return prev;
                                          const newBeats = [...prev.beats];
                                          newBeats.splice(index, 1);
                                          return { ...prev, beats: newBeats };
                                        });
                                        setConfirmDeleteBeatIndex(null);
                                      } else {
                                        setConfirmDeleteBeatIndex(index);
                                        setTimeout(() => setConfirmDeleteBeatIndex(curr => curr === index ? null : curr), 3000);
                                      }
                                    }}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>

                              {/* Image area */}
                              <div className={`${storyboardImageFrameClass} bg-neutral-100 dark:bg-[#1a1a1a] flex items-center justify-center overflow-hidden relative`}>
                                {beat.image_data ? (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img src={beat.image_data} alt={`Scene ${beat.scene_number}`} className="w-full h-full object-cover" />
                                ) : isGenerating ? (
                                  <div className="w-full h-full flex flex-col items-center justify-center animate-pulse bg-neutral-200/50 dark:bg-neutral-900/40">
                                    <ImageIcon className="text-neutral-400 dark:text-neutral-700 mb-2" size={32} />
                                    <span className="text-xs text-neutral-500 uppercase font-mono tracking-widest text-center px-1">Drawing Scene {beat.scene_number}...</span>
                                  </div>
                                ) : !beat.comic_panel_prompt ? (
                                  <div className="w-full h-full flex flex-col items-center justify-center bg-neutral-100/50 dark:bg-neutral-900/40 text-neutral-400 dark:text-neutral-600">
                                    <Mountain className="mb-2 opacity-40" size={32} />
                                    <span className="text-xs font-medium text-center px-1">Empty Scene</span>
                                    <span className="text-[10px] mt-1 px-4 text-center opacity-60">Add a background and actors from the sidebar</span>
                                  </div>
                                ) : (
                                  <div className="w-full h-full flex flex-col items-center justify-center bg-red-50/50 dark:bg-red-950/20 text-red-500 border border-red-100 dark:border-red-900/50">
                                    <ImageOff className="text-red-400 dark:text-red-600 mb-2" size={32} />
                                    <span className="text-xs font-semibold text-center px-1">Image Generation Failed</span>
                                    <span className="text-[10px] text-red-400 mt-1 px-4 text-center">No image was returned. You can try editing the prompt or deleting this scene.</span>
                                  </div>
                                )}

                                {/* Image Inpainting Edit Overlay */}
                                {editingBeatIndex === index && (
                                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-30 flex flex-col p-3 transition-all">
                                    <div className="flex-1 flex flex-col">
                                      <label className="text-[10px] uppercase tracking-wider font-semibold text-white/70 mb-1 flex items-center gap-1.5"><Pencil size={10} /> Redraw Instructions</label>
                                      <textarea
                                        autoFocus
                                        value={editPrompt}
                                        onChange={(e) => setEditPrompt(e.target.value)}
                                        placeholder="e.g. Make it raining, give them a blue hat, add a car in the background..."
                                        className="w-full flex-1 bg-black/40 border border-white/20 rounded p-2 text-xs text-white placeholder-white/40 resize-none focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all custom-scrollbar"
                                        disabled={isEditingImage}
                                      />
                                    </div>
                                    <div className="flex items-center justify-end gap-2 mt-2">
                                      <button
                                        className="px-3 py-1.5 text-[10px] font-semibold text-white/70 hover:text-white hover:bg-white/10 rounded transition-colors"
                                        onClick={() => {
                                          setEditingBeatIndex(null);
                                          setEditPrompt("");
                                        }}
                                        disabled={isEditingImage}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        className="px-3 py-1.5 text-[10px] font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors flex items-center gap-1.5 disabled:bg-cyan-800 disabled:text-white/50"
                                        onClick={() => handleEditImageSubmit(index)}
                                        disabled={isEditingImage || !editPrompt.trim()}
                                      >
                                        {isEditingImage ? <><Loader2 size={10} className="animate-spin" /> Rendering...</> : "Apply Edit"}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Image generation cost badge */}
                              {imageGenCost && (
                                <div className="px-3 py-1 bg-neutral-50 dark:bg-[#0a0a0a] border-t border-neutral-100 dark:border-neutral-800/50 flex items-center gap-2 text-[9px] font-mono text-neutral-400 dark:text-neutral-600">
                                  <span className="text-neutral-500 dark:text-neutral-500">Image gen:</span>
                                  <span className="text-amber-600 dark:text-amber-500 font-semibold">~${imageGenCost.cost.toFixed(5)}</span>
                                  <span className="text-neutral-400 dark:text-neutral-600">{imageGenCost.tokens.toLocaleString()} tokens</span>
                                </div>
                              )}

                              {/* Audio generation cost badge */}
                              {(() => {
                                const audioCost = beat.audio?.reduce((sum, a) => sum + (a.generation_cost?.cost || 0), 0) || 0;
                                const audioChars = beat.audio?.reduce((sum, a) => sum + (a.generation_cost?.characters || 0), 0) || 0;
                                if (audioCost > 0) {
                                  return (
                                    <div className="px-3 py-1 bg-neutral-50 dark:bg-[#0a0a0a] border-t border-neutral-100 dark:border-neutral-800/50 flex items-center gap-2 text-[9px] font-mono text-neutral-400 dark:text-neutral-600">
                                      <span className="text-neutral-500 dark:text-neutral-500">Cloud TTS gen:</span>
                                      <span className="text-emerald-600 dark:text-emerald-500 font-semibold">~${audioCost.toFixed(5)}</span>
                                      <span className="text-neutral-400 dark:text-neutral-600">{audioChars.toLocaleString()} characters</span>
                                    </div>
                                  );
                                }
                                return null;
                              })()}

                              {/* Narrative + metadata */}
                              <div className="p-3 pt-2">
                                <p
                                  className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed mb-2 cursor-text hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 rounded px-1 -mx-1 transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const newText = e.currentTarget.textContent || '';
                                    if (newText !== beat.narrative) {
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        newBeats[index] = { ...newBeats[index], narrative: newText };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }
                                  }}
                                >
                                  {beat.narrative}
                                </p>
                                <div className="flex flex-col gap-1.5">
                                  {beat.audio.map((audio, i) => (
                                    <div key={`audio-${i}`} className={`group/tag flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[9px] font-medium ${audio.type === 'dialogue' ? 'bg-amber-100 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-400' : 'bg-cyan-100 dark:bg-cyan-500/10 border-cyan-200 dark:border-cyan-500/20 text-cyan-700 dark:text-cyan-400'}`}>
                                      <Volume2 size={8} />
                                      {audio.type === 'dialogue' && (
                                        <select
                                          className="bg-transparent border-none outline-none text-[8.5px] cursor-pointer font-semibold text-amber-800 dark:text-amber-300 max-w-[100px]"
                                          value={audio.actor_id || ''}
                                          onClick={(e) => e.stopPropagation()}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            setStoryData(prev => {
                                              if (!prev) return prev;
                                              const newBeats = [...prev.beats];
                                              const newAudio = [...newBeats[index].audio];
                                              newAudio[i] = { ...newAudio[i], actor_id: val };
                                              newBeats[index] = { ...newBeats[index], audio: newAudio };
                                              return { ...prev, beats: newBeats };
                                            });
                                          }}
                                        >
                                          {(storyData?.actors_detected || []).map(a => (
                                            <option key={a.id} value={a.id}>{a.name || a.id}</option>
                                          ))}
                                        </select>
                                      )}
                                      <input
                                        type="text"
                                        className="bg-transparent border-none outline-none text-[9px] font-medium min-w-[60px] max-w-[200px] placeholder-current/40 cursor-text"
                                        style={{ width: `${Math.max(60, (audio.type === 'dialogue' ? (audio.text?.length || 0) : (audio.description?.length || 0)) * 5.5 + 16)}px` }}
                                        value={audio.type === 'dialogue' ? (audio.text || '') : (audio.description || '')}
                                        placeholder={audio.type === 'dialogue' ? 'Type dialogue...' : 'Describe sound...'}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setStoryData(prev => {
                                            if (!prev) return prev;
                                            const newBeats = [...prev.beats];
                                            const newAudio = [...newBeats[index].audio];
                                            if (audio.type === 'dialogue') {
                                              newAudio[i] = { ...newAudio[i], text: val };
                                            } else {
                                              newAudio[i] = { ...newAudio[i], description: val };
                                            }
                                            newBeats[index] = { ...newBeats[index], audio: newAudio };
                                            return { ...prev, beats: newBeats };
                                          });
                                        }}
                                      />
                                      {audio.type === 'dialogue' && (
                                        <select
                                          className="bg-transparent border-none outline-none text-[8.5px] cursor-pointer ml-1 text-amber-900/60 hover:text-amber-900 dark:text-amber-400/60 dark:hover:text-amber-400"
                                          value={audio.voice_id || 'en-US-Standard-F'}
                                          onClick={(e) => e.stopPropagation()}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            setStoryData(prev => {
                                              if (!prev) return prev;
                                              const newBeats = [...prev.beats];
                                              const newAudio = [...newBeats[index].audio];
                                              newAudio[i] = { ...newAudio[i], voice_id: val as any };
                                              newBeats[index] = { ...newBeats[index], audio: newAudio };
                                              return { ...prev, beats: newBeats };
                                            });
                                          }}
                                        >
                                          {Object.entries(
                                            (VOICE_POOL as readonly VoiceEntry[]).reduce<Record<string, VoiceEntry[]>>((groups, v) => {
                                              const lang = v.lang;
                                              if (!groups[lang]) groups[lang] = [];
                                              groups[lang].push(v);
                                              return groups;
                                            }, {})
                                          ).map(([lang, voices]) => (
                                            <optgroup key={lang} label={lang}>
                                              {voices.map(v => (
                                                <option key={v.id} value={v.id}>{v.timbre}</option>
                                              ))}
                                            </optgroup>
                                          ))}
                                        </select>
                                      )}
                                      <button
                                        className="opacity-0 group-hover/tag:opacity-100 ml-0.5 hover:text-red-500 transition-all"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setStoryData(prev => {
                                            if (!prev) return prev;
                                            const newBeats = [...prev.beats];
                                            newBeats[index] = { ...newBeats[index], audio: newBeats[index].audio.filter((_, ai) => ai !== i) };
                                            return { ...prev, beats: newBeats };
                                          });
                                        }}
                                        title="Remove this audio cue"
                                      >×</button>
                                    </div>
                                  ))}
                                  {beat.actions.map((act, i) => (
                                    <span
                                      key={`act-${i}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedSceneIndex(index);
                                        setSelectedActionIndex(i);
                                        setSelectedActorId(act.actor_id);
                                      }}
                                      className={`group/tag inline-flex items-center gap-1 px-2 py-0.5 rounded-full border cursor-pointer text-[9px] font-mono transition-colors ${selectedSceneIndex === index && selectedActionIndex === i ? 'bg-cyan-500 text-white border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]' : 'bg-neutral-100 dark:bg-neutral-800/80 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:border-cyan-400 dark:hover:border-cyan-500/50'}`}
                                    >
                                      {act.actor_id}:{act.motion}({act.style})
                                      <button
                                        className="opacity-0 group-hover/tag:opacity-100 ml-0.5 hover:text-red-500 transition-all"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setStoryData(prev => {
                                            if (!prev) return prev;
                                            const newBeats = [...prev.beats];
                                            newBeats[index] = { ...newBeats[index], actions: newBeats[index].actions.filter((_, ai) => ai !== i) };
                                            return { ...prev, beats: newBeats };
                                          });
                                          if (selectedSceneIndex === index && selectedActionIndex === i) {
                                            setSelectedActionIndex(null);
                                          }
                                        }}
                                        title="Remove this action"
                                      >×</button>
                                    </span>
                                  ))}
                                  {/* Add Dialogue / SFX buttons */}
                                  <button
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-amber-300 dark:border-amber-600/40 text-amber-600 dark:text-amber-500 text-[9px] font-medium hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const actorIds = storyData?.actors_detected.map(a => a.id) || [];
                                      const defaultActorId = actorIds[0] || "";
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        const currentAudio = [...newBeats[index].audio];
                                        currentAudio.push({
                                          type: "dialogue" as const,
                                          actor_id: defaultActorId,
                                          text: "",
                                          delivery_style: "neutral",
                                          start_time: 0,
                                        });
                                        newBeats[index] = { ...newBeats[index], audio: currentAudio };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                    title="Add dialogue line"
                                  >
                                    + Dialogue
                                  </button>
                                  <button
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-cyan-300 dark:border-cyan-600/40 text-cyan-600 dark:text-cyan-500 text-[9px] font-medium hover:bg-cyan-50 dark:hover:bg-cyan-900/20 transition-colors"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        const currentAudio = [...newBeats[index].audio];
                                        currentAudio.push({
                                          type: "sfx" as const,
                                          description: "",
                                          start_time: 0,
                                        });
                                        newBeats[index] = { ...newBeats[index], audio: currentAudio };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                    title="Add sound effect"
                                  >
                                    + SFX
                                  </button>
                                </div>
                              </div>

                              {/* Auto-Animate Macro Button + Persistent Log Console */}
                              <div className="border-t border-neutral-200/80 dark:border-neutral-800/50 bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
                                {(() => {
                                  const persistedLogs = dismissedCompileReports[index]
                                    ? null
                                    : (completedAnimLogs[index] || beat.compile_report?.logs || null);

                                  if (animatingSceneIndex === index) {
                                    return (
                                      // Live: show spinning log while running
                                      <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                        <div className="absolute top-2 right-2">
                                          <Loader2 size={12} className="animate-spin" />
                                        </div>
                                        {animatingLogs.map((log, i) => (
                                          <div key={i} className="animate-in fade-in slide-in-from-bottom-1">
                                            {renderCompileLogLine(log, i)}
                                          </div>
                                        ))}
                                      </div>
                                    );
                                  }

                                  if (persistedLogs) {
                                    return (
                                      // Completed: persistent log with dismiss + re-run button
                                      <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 max-h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                        <div className="absolute top-2 right-2 flex items-center gap-1">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleAnimateScene(index);
                                            }}
                                            title="Re-run animation pipeline"
                                            className="text-neutral-500 hover:text-emerald-400 transition-colors"
                                          >
                                            <Play size={10} className="fill-current" />
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setDismissedCompileReports(prev => ({ ...prev, [index]: true }));
                                              setCompletedAnimLogs(prev => { const n = { ...prev }; delete n[index]; return n; });
                                            }}
                                            title="Dismiss log"
                                            className="text-neutral-500 hover:text-red-400 transition-colors text-[11px] leading-none"
                                          >
                                            ✕
                                          </button>
                                        </div>
                                        {persistedLogs.map((log, i) => renderCompileLogLine(log, i))}
                                      </div>
                                    );
                                  }

                                  if (beat.compiled_scene && !dismissedCompileReports[index]) {
                                    return (
                                      <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 max-h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                        <div className="absolute top-2 right-2 flex items-center gap-1">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleAnimateScene(index);
                                            }}
                                            title="Re-run animation pipeline"
                                            className="text-neutral-500 hover:text-emerald-400 transition-colors"
                                          >
                                            <Play size={10} className="fill-current" />
                                          </button>
                                        </div>
                                        <div>✓ Compiled scene timeline ({beat.compiled_scene.instance_tracks.length} track{beat.compiled_scene.instance_tracks.length === 1 ? "" : "s"}, {beat.compiled_scene.duration_seconds.toFixed(2)}s).</div>
                                        <div>✓ Persisted compiled scene found after refresh.</div>
                                        {beat.compile_report?.compiled_at && (
                                          <div>Last compile: {new Date(beat.compile_report.compiled_at).toLocaleString()}</div>
                                        )}
                                      </div>
                                    );
                                  }

                                  return (
                                    <div className="p-2 space-y-2">
                                      {beat.image_data ? (
                                        <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 max-h-28 overflow-y-auto flex flex-col gap-0.5 rounded-lg shadow-inner relative custom-scrollbar">
                                          <div>
                                            {imageGenCost
                                              ? hasExactImageGenCost
                                                ? "✓ Storyboard panel generated."
                                                : "✓ Storyboard panel generated. Showing fallback 0.5K image estimate."
                                              : "✓ Storyboard panel generated. Waiting for usage metadata..."}
                                          </div>
                                          {imageGenCost ? (
                                            <>
                                              {renderCompileLogLine(`[PAID] Image gen: ~$${imageGenCost.cost.toFixed(5)} | ${imageGenCost.tokens.toLocaleString()} tokens`, `${index}-image-cost`)}
                                              <div className="text-cyan-300">Ready for vector drafting and animation compile.</div>
                                            </>
                                          ) : null}
                                        </div>
                                      ) : null}
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleAnimateScene(index);
                                        }}
                                        disabled={isGenerating || !beat.image_data}
                                        className="w-full py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg shadow-sm flex items-center justify-center gap-2 transition-all group/animate"
                                      >
                                        <Play size={14} className="fill-white group-hover/animate:scale-110 transition-transform" /> Animate Scene
                                      </button>
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>

                            {/* Insert After Button (between this panel and the next, or at end) */}
                            <div className="my-1">
                              {insertAtIndex === index + 1 ? (
                                <div className="p-3 rounded-xl bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-800/60 border-dashed">
                                  <label className="text-[10px] uppercase tracking-wider font-semibold text-cyan-600 dark:text-cyan-400 mb-1.5 flex items-center gap-1.5">
                                    <Plus size={10} /> {index + 1 < storyData.beats.length ? `Insert Scene Between ${index + 1} & ${index + 2}` : `Add New Scene at End`}
                                  </label>
                                  <textarea
                                    autoFocus
                                    value={insertPrompt}
                                    onChange={(e) => setInsertPrompt(e.target.value)}
                                    placeholder="Describe what happens in this new scene..."
                                    className="w-full bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-700 rounded-lg p-2.5 text-xs text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 dark:placeholder-neutral-500 resize-none focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 h-20"
                                    disabled={isGenerating}
                                  />
                                  <div className="flex items-center justify-end gap-2 mt-2">
                                    <button className="px-3 py-1.5 text-[10px] font-semibold text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition-colors" onClick={() => { setInsertAtIndex(null); setInsertPrompt(""); }} disabled={isGenerating}>Cancel</button>
                                    <button className="px-3 py-1.5 text-[10px] font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50" onClick={() => handleInsertScene(index + 1)} disabled={isGenerating || !insertPrompt.trim()}>
                                      {isGenerating ? <><Loader2 size={10} className="animate-spin" /> Generating...</> : <><Plus size={10} /> Generate Scene</>}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => { setInsertAtIndex(index + 1); setInsertPrompt(""); }}
                                  className="w-full py-1 border border-dashed border-neutral-300/60 dark:border-neutral-700/40 hover:border-cyan-400 dark:hover:border-cyan-600 rounded-lg text-[10px] font-medium text-neutral-400 dark:text-neutral-600 hover:text-cyan-600 dark:hover:text-cyan-400 transition-all flex items-center justify-center gap-1.5 hover:bg-cyan-50/50 dark:hover:bg-cyan-950/20"
                                  disabled={isGenerating}
                                >
                                  <Plus size={10} /> Insert Scene
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}

                  </div>
                </div>
              </section>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-emerald-500/50 transition-colors cursor-col-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center">
            <div className="w-0.5 h-8 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </PanelResizeHandle>

          {/* Center Panel: Animation Stage & Horizontal Timeline */}
          <Panel defaultSize={50} minSize={30}>
            <div className="w-full h-full flex flex-col bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-neutral-100 dark:from-neutral-900/40 via-white dark:via-[#050505] to-white dark:to-[#050505] relative transition-colors duration-300">
              <PanelGroup direction="vertical" className="flex-1 w-full h-full">

                {/* Top Viewport: Stage */}
                <Panel defaultSize={60} minSize={30}>
                  <div className="w-full h-full flex flex-col p-6 min-h-0">
                    <div className="flex items-center justify-between mb-6 shrink-0 z-20">
                      <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2.5 whitespace-nowrap shrink-0">
                        <Play size={16} className="text-emerald-500 dark:text-emerald-400" /> Stage
                      </h2>

                      {/* Stage Output Controls */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded-lg p-1 shadow-sm dark:shadow-inner transition-colors duration-300">
                          {/* Resolution Dropdown */}
                          <div className="relative group/dropdown">
                            <button
                              onClick={() => setIsExportDropdownOpen(prev => !prev)}
                              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 hover:text-black dark:hover:text-white bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded transition-colors group whitespace-nowrap"
                            >
                              {EXPORT_RESOLUTIONS[exportResolution].label} <span className="text-[9px] font-mono text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-400">({EXPORT_RESOLUTIONS[exportResolution].width}x{EXPORT_RESOLUTIONS[exportResolution].height})</span> <ChevronDown size={14} className="text-neutral-400 dark:text-neutral-500 group-hover/dropdown:text-neutral-600 dark:group-hover/dropdown:text-neutral-300" />
                            </button>
                            {/* Dropdown Menu (Hidden by default, shown on hover for this prototype) */}
                            <div className={`absolute top-full mt-1 right-0 w-48 bg-white dark:bg-[#1a1a1a] border border-neutral-200 dark:border-neutral-700/50 rounded-lg shadow-xl transition-all duration-200 z-50 ${isExportDropdownOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
                              <div className="p-1 flex flex-col gap-0.5">
                                {Object.entries(EXPORT_RESOLUTIONS).map(([key, value]) => (
                                  <button
                                    key={key}
                                    onClick={() => {
                                      setExportResolution(key as keyof typeof BASE_EXPORT_RESOLUTIONS);
                                      setIsExportDropdownOpen(false);
                                    }}
                                    className={`text-left px-3 py-2 text-xs rounded flex items-center justify-between transition-colors ${exportResolution === key ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10' : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                                  >
                                    {value.label} <span className={`text-[9px] ${exportResolution === key ? 'text-emerald-500/70' : 'text-neutral-400 dark:text-neutral-500'}`}>{value.width}x{value.height}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-800" />

                          {/* Orientation Toggles */}
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => handleOrientationChange("landscape")}
                              className={`p-1.5 rounded transition-colors ${stageOrientation === "landscape" ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10" : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/50"}`}
                              title="Landscape (16:9)"
                            >
                              <div className="w-4 h-3 border-2 border-current rounded-[2px]" />
                            </button>
                            <button
                              onClick={() => handleOrientationChange("portrait")}
                              className={`p-1.5 rounded transition-colors ${stageOrientation === "portrait" ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10" : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/50"}`}
                              title="Portrait (9:16)"
                            >
                              <div className="w-3 h-4 border-2 border-current rounded-[2px]" />
                            </button>
                          </div>
                        </div>

                        {/* Export Button */}
                        <button
                          onClick={handleExport}
                          disabled={isExporting}
                          className="px-4 py-1.5 bg-gradient-to-br from-cyan-500 dark:from-cyan-600 to-blue-500 dark:to-blue-600 hover:from-cyan-600 hover:dark:from-cyan-500 hover:to-blue-600 hover:dark:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-[0_0_15px_rgba(34,211,238,0.3)] hover:shadow-[0_0_20px_rgba(34,211,238,0.5)] transition-all flex items-center gap-2 transform hover:-translate-y-0.5 disabled:transform-none"
                          title={`Export ${playbackScope === 'all' ? 'all compiled scenes' : 'selected scene'} to MP4`}
                        >
                          {isExporting ? <Loader2 size={12} className="animate-spin" /> : null}
                          Export <Send size={12} className="-mt-0.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 relative rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/80 dark:bg-[#0a0a0a]/80 shadow-lg dark:shadow-2xl overflow-hidden backdrop-blur-xl group/stage transition-colors duration-300">
                      {/* Stage Grid Pattern */}
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_10%,transparent_100%)]" />

                      <div className="absolute inset-0 grid place-items-center">
                        <Stage
                          key={selectedStageKey}
                          beat={selectedBeat}
                          compiledScene={selectedCompiledScene}
                          frameRate={fps}
                          showObstacleDebug={showObstacleDebug}
                          isPlaying={isPlaying}
                          loopOnComplete={loopPlayback}
                          playheadTime={currentTimeSeconds}
                          onTimelineReady={handleTimelineReady}
                          onPlayheadUpdate={handlePlayheadUpdate}
                          onPlayComplete={handlePlayComplete}
                          availableRigs={availableRigs}
                          selectedActorId={selectedActorId}
                          onActorSelect={handleActorSelect}
                          onActorPositionChange={handleActorPositionChange}
                          onActorScaleChange={handleActorScaleChange}
                          onActorRotationChange={handleActorRotationChange}
                          onActorFlip={handleActorFlip}
                          onCameraChange={handleCameraChange}
                          stageOrientation={stageOrientation}
                          selectedKeyframe={selectedKeyframe}
                        />
                      </div>

                      {/* Corner accoutrements */}
                      <div className="absolute bottom-4 left-4 text-[10px] text-neutral-400 dark:text-neutral-600 font-mono tracking-widest uppercase transition-colors">
                        SVG Render Engine
                      </div>
                    </div>
                  </div>
                </Panel>

                {/* Resize Handle for Vertical Splitting */}
                <PanelResizeHandle className="h-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-emerald-500/50 transition-colors cursor-row-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center relative">
                  <div className="w-8 h-0.5 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
                </PanelResizeHandle>

                {/* Bottom Viewport: Timeline Panel */}
                <Panel defaultSize={40} minSize={15}>
                  <TimelinePanel
                    storyData={storyData}
                    selectedSceneIndex={selectedSceneIndex}
                    selectedBeat={selectedBeat}
                    compiledScene={selectedBeat?.compiled_scene}
                    actorReferences={actorReferences}
                    isPlaying={isPlaying}
                    fps={fps}
                    totalDuration={totalDuration}
                    totalFrames={totalFrames}
                    currentFrame={currentFrame}
                    playheadPos={playheadPos}
                    isDraggingPlayhead={isDraggingPlayhead}
                    loopPlayback={loopPlayback}
                    playbackScope={playbackScope}
                    exportProgress={exportProgress}
                    timelineZoom={timelineZoom}
                    showObstacleDebug={showObstacleDebug}
                    selectedActionIndex={selectedActionIndex}
                    selectedActorId={selectedActorId}
                    selectedAudioIndex={selectedAudioIndex}
                    selectedCameraIndex={selectedCameraIndex}
                    selectedKeyframe={selectedKeyframe}
                    timelineRef={timelineRef}
                    tracksRef={tracksRef}
                    onSceneSelect={setSelectedSceneIndex}
                    onSetFps={setFps}
                    onSetTimelineZoom={setTimelineZoom}
                    onToggleObstacleDebug={() => setShowObstacleDebug(prev => !prev)}
                    onJumpToStart={handleJumpToStart}
                    onTogglePlayback={handleTogglePlayback}
                    onJumpToEnd={handleJumpToEnd}
                    onSetPlaybackScope={setPlaybackScope}
                    onToggleLoop={() => setLoopPlayback(prev => !prev)}
                    onSetDraggingPlayhead={setIsDraggingPlayhead}
                    onSelectAction={(idx) => { setSelectedActionIndex(idx); setSelectedAudioIndex(null); }}
                    onSelectActor={setSelectedActorId}
                    onSelectAudio={(idx) => { setSelectedAudioIndex(idx); setSelectedActionIndex(null); setSelectedCameraIndex(null); }}
                    onSelectCamera={(idx) => { setSelectedCameraIndex(idx); if (idx !== null) { setSelectedAudioIndex(null); setSelectedActionIndex(null); } }}
                    onSelectKeyframe={(kf) => { setSelectedKeyframe(kf); setSelectedAudioIndex(null); }}
                    onSetIsPlaying={setIsPlaying}
                    onSetPlayheadPos={setPlayheadPos}
                    onPlayheadUpdate={handlePlayheadUpdate}
                    onLayerMove={handleLayerMove}
                    onPillMouseDown={handlePillMouseDown}
                    onCameraPillMouseDown={handleCameraPillMouseDown}
                    onDialoguePillMouseDown={handleDialoguePillMouseDown}
                    onAddCamera={handleAddCamera}
                    onAddAction={(actorId) => {
                      if (!storyData) return;
                      const newStory = { ...storyData };
                      const beat = newStory.beats[selectedSceneIndex];
                      const newAction: any = {
                        actor_id: actorId,
                        motion: "idle",
                        start_time: 0,
                        duration_seconds: 4.0 // Changed default duration
                      };
                      if (!beat.actions) beat.actions = [];
                      beat.actions.push(newAction);
                      setStoryData(newStory);
                      saveStoryToStorage(newStory.title, newStory).catch(console.error);
                      setSelectedActionIndex(beat.actions.length - 1);
                      setSelectedActorId(actorId);
                    }}
                    onAddAudio={(actorId) => {
                      if (!storyData) return;
                      const newStory = { ...storyData };
                      const beat = newStory.beats[selectedSceneIndex];
                      if (!beat.audio) beat.audio = [];

                      // Default to first available voice or Journey-D
                      const firstVoiceId = storyData.actors_detected.find(a => a.id === actorId)?.attributes?.[0] === 'male' ? 'en-US-Journey-D' : 'en-US-Journey-F';

                      beat.audio.push({
                        type: 'dialogue',
                        actor_id: actorId,
                        text: 'New dialogue line',
                        start_time: 0,
                        voice_id: firstVoiceId
                      });
                      setStoryData(newStory);
                      saveStoryToStorage(newStory.title, newStory).catch(console.error);
                      setSelectedAudioIndex(beat.audio.length - 1);
                      setSelectedActorId(actorId);
                    }}
                  />
                </Panel>
              </PanelGroup>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-cyan-500/50 transition-colors cursor-col-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center">
            <div className="w-0.5 h-8 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </PanelResizeHandle>

          {/* Right Panel: Properties Panel (for Timeline Editing) */}
          <Panel defaultSize={20} minSize={15} maxSize={30}>
            <PropertiesPanel
              storyData={storyData}
              selectedSceneIndex={selectedSceneIndex}
              selectedActionIndex={selectedActionIndex}
              selectedActorId={selectedActorId}
              selectedAudioIndex={selectedAudioIndex}
              selectedCameraIndex={selectedCameraIndex}
              selectedKeyframe={selectedKeyframe}
              actorReferences={actorReferences}
              onSelectKeyframe={(kf) => { setSelectedKeyframe(kf); setSelectedAudioIndex(null); }}
              onSelectAction={(idx) => { setSelectedActionIndex(idx); setSelectedAudioIndex(null); }}
              onSelectActor={setSelectedActorId}
              onUpdateCamera={(key, value) => {
                setStoryData(prev => {
                  if (!prev || selectedCameraIndex === null) return prev;
                  const newBeats = [...prev.beats];
                  const beat = { ...newBeats[selectedSceneIndex] };
                  if (!beat.cameras) return prev;
                  const newCams = [...beat.cameras];
                  newCams[selectedCameraIndex] = { ...newCams[selectedCameraIndex], [key]: value };
                  newBeats[selectedSceneIndex] = { ...beat, cameras: newCams };
                  return { ...prev, beats: newBeats };
                });
              }}
              onUpdateAction={handleUpdateAction}
              onUpdateAudio={(idx, update) => {
                setStoryData(prev => {
                  if (!prev || selectedAudioIndex === null) return prev;
                  const newBeats = [...prev.beats];
                  const beat = { ...newBeats[selectedSceneIndex] };
                  if (!beat.audio) return prev;
                  const newAudio = [...beat.audio];
                  newAudio[idx] = { ...newAudio[idx], ...update };
                  beat.audio = newAudio;
                  newBeats[selectedSceneIndex] = beat;
                  return { ...prev, beats: newBeats };
                });
              }}
              onDeleteAction={handleDeleteAction}
              onUpdateCollisionBehavior={handleUpdateCollisionBehavior}
              onGenerateAudio={(audioIdx) => handleGenerateSpecificAudio(selectedSceneIndex, audioIdx)}
              isGeneratingAudio={isGenerating}
            />
          </Panel>
        </PanelGroup>
      </main>

      {/* Set Designer Modal */}
      {draftingBackgroundSceneIndex !== null && storyData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[90vh]">

            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <h3 className="font-semibold text-neutral-800 dark:text-neutral-200 flex items-center gap-2">
                <Mountain size={16} className="text-cyan-500" />
                Scene {draftingBackgroundSceneIndex + 1} - Vector Environment
              </h3>
              <button
                onClick={() => {
                  setDraftingBackgroundSceneIndex(null);
                  setDraftBackgroundError(null);
                }}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                disabled={isDraftingBackground}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto flex flex-col items-center justify-center min-h-[400px]">
              {(() => {
                const beat = storyData.beats[draftingBackgroundSceneIndex];
                if (!beat) return null;

                return (
                  <>
                    {!beat.drafted_background && !isDraftingBackground && (
                      <div className="flex flex-col items-center max-w-sm text-center">
                        <div className={`${referenceImageFrameClass} mb-6 rounded-xl overflow-hidden shadow-lg border-2 border-cyan-500/30`}>
                          {beat.image_data ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={beat.image_data} alt="Reference" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-neutral-200 dark:bg-neutral-800" />
                          )}
                        </div>
                        <h4 className="text-lg font-bold text-neutral-800 dark:text-neutral-200 mb-2">Build Environment Set</h4>
                        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
                          The Set Designer AI will extract the scenery from this panel and recreate it as a 3-layer parallax SVG (sky, midground, foreground).
                        </p>
                        <button
                          onClick={async () => {
                            if (!beat.image_data) {
                              setDraftBackgroundError("No image data available for this scene.");
                              return;
                            }
                            setIsDraftingBackground(true);
                            setDraftBackgroundError(null);
                            try {
                              const result = await processSetDesignerPrompt(beat.image_data, beat.narrative, stageOrientation);

                              setStoryData(prev => {
                                if (!prev) return prev;
                                const newBeats = [...prev.beats];
                                newBeats[draftingBackgroundSceneIndex] = {
                                  ...newBeats[draftingBackgroundSceneIndex],
                                  drafted_background: result.data,
                                };
                                return { ...prev, beats: newBeats };
                              });
                            } catch (err: unknown) {
                              setDraftBackgroundError(err instanceof Error ? err.message : "Failed to generate background.");
                            } finally {
                              setIsDraftingBackground(false);
                            }
                          }}
                          className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-all shadow-md shadow-cyan-900/20 flex items-center justify-center gap-2"
                        >
                          <Mountain size={16} /> Begin Set Design
                        </button>
                      </div>
                    )}

                    {isDraftingBackground && (
                      <div className="flex flex-col items-center">
                        <div className="relative mb-6">
                          <div className={`${referenceImageFrameClass} rounded-xl overflow-hidden opacity-50 blur-sm`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {beat.image_data && <img src={beat.image_data} alt="Reference" className="w-full h-full object-cover" />}
                          </div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 size={32} className="text-cyan-500 animate-spin" />
                          </div>
                        </div>
                        <h4 className="text-neutral-800 dark:text-neutral-200 font-medium">Painting Parallax Layers...</h4>
                        <p className="text-xs text-neutral-500 mt-2">This may take 15-20 seconds.</p>
                      </div>
                    )}

                    {draftBackgroundError && (
                      <div className="p-4 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg max-w-md text-center text-sm">
                        {draftBackgroundError}
                      </div>
                    )}

                    {beat.drafted_background && (
                      <div className="w-full h-full flex flex-col">
                        <div className="bg-emerald-100/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs px-4 py-2 rounded-lg mb-4 text-center border border-emerald-200 dark:border-emerald-800/50">
                          Set Designer Success: Found {beat.drafted_background.rig_data.interactionNulls.length} interaction props. Hover points to inspect anchor nulls.
                        </div>
                        <div className="flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-900 rounded-xl overflow-hidden relative shadow-inner">
                          <RigViewer data={beat.drafted_background} />
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Draftsman Modal */}
      {draftingActorId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[90vh]">

            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <h3 className="font-semibold text-neutral-800 dark:text-neutral-200 flex items-center gap-2">
                <Sparkles size={16} className="text-cyan-500" />
                {storyData?.actors_detected.find(a => a.id === draftingActorId)?.name} - Vector Drafting
              </h3>
              <button
                onClick={() => {
                  setDraftingActorId(null);
                  setDraftedRig(null);
                  setOriginalDraftedRig(null);
                  setDraftReview(null);
                  setRigFixPrompt("");
                  setDraftError(null);
                }}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                disabled={isDrafting}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 flex-1 overflow-y-auto flex flex-col items-center justify-center min-h-[400px]">

              {!draftedRig && !isDrafting && (
                <div className="flex flex-col items-center max-w-sm text-center">
                  <div className="w-24 h-24 mb-6 rounded-xl overflow-hidden shadow-lg border-2 border-cyan-500/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={actorReferences[draftingActorId]} alt="Reference" className="w-full h-full object-cover" />
                  </div>
                  <h4 className="text-lg font-bold text-neutral-800 dark:text-neutral-200 mb-2">Generate Animatable Rig</h4>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
                    The Draftsman AI will analyze this character and redraw them as a structured SVG vector puppet, complete with interaction pivot points.
                  </p>
                  <button
                    onClick={async () => {
                      setIsDrafting(true);
                      setDraftError(null);
                      setDraftReview(null);
                      try {
                        const actor = storyData?.actors_detected.find(a => a.id === draftingActorId);
                        if (!actor || !actorReferences[draftingActorId]) throw new Error("Missing actor data");
                        const description = `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(', ')}. ${actor.visual_description}`;
                        const generatedRig = await generateRigDraft({
                          generationReference: actorReferences[draftingActorId],
                          description,
                          qualityMode: "reviewable",
                        });
                        const existingClips = actor.drafted_rig?.rig_data.motion_clips;
                        const nextDraft = (existingClips && Object.keys(existingClips).length > 0)
                          ? { ...generatedRig.data, rig_data: { ...generatedRig.data.rig_data, motion_clips: existingClips } }
                          : generatedRig.data;

                        setDraftedRig(nextDraft);
                        setOriginalDraftedRig(JSON.parse(JSON.stringify(nextDraft)));
                        setDraftReview(generatedRig.review ?? null);
                      } catch (err: unknown) {
                        setDraftError(err instanceof Error ? err.message : "Failed to generate rig.");
                      } finally {
                        setIsDrafting(false);
                      }
                    }}
                    className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-all shadow-md shadow-cyan-900/20 flex items-center justify-center gap-2"
                  >
                    <Sparkles size={16} /> Begin Drafting Phase
                  </button>
                </div>
              )}

              {isDrafting && (
                <div className="flex flex-col items-center">
                  <div className="relative mb-6">
                    <div className="w-20 h-20 rounded-xl overflow-hidden opacity-50 blur-sm">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={actorReferences[draftingActorId]} alt="Reference" className="w-full h-full object-cover" />
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 size={32} className="text-cyan-500 animate-spin" />
                    </div>
                  </div>
                  <h4 className="text-neutral-800 dark:text-neutral-200 font-medium">Drawing Vector Arrays...</h4>
                  <p className="text-xs text-neutral-500 mt-2">This may take 15-20 seconds.</p>
                </div>
              )}

              {draftError && (
                <div className="p-4 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg max-w-md text-center text-sm">
                  {draftError}
                </div>
              )}

              {draftedRig && (
                <div className="w-full h-full flex flex-col">
                  <div className="bg-emerald-100/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs px-4 py-2 rounded-lg mb-4 text-center border border-emerald-200 dark:border-emerald-800/50">
                    Draftsman Success: Found {draftedRig.rig_data.bones.length} bones, {draftedRig.rig_data.visemes?.length || 0} visemes, and {draftedRig.rig_data.emotions?.length || 0} emotions.
                    Use the IK lab to drag effectors, inspect constraints, pin nodes, and stress-test the rig before saving.
                  </div>
                  {draftReview && !draftReview.acceptable && (
                    <div className="mb-4 rounded-lg border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
                      <div className="font-semibold uppercase tracking-wider text-[11px]">
                        Draft Review Warnings
                      </div>
                      <div className="mt-2 space-y-1">
                        {draftReview.reasons.map((reason) => (
                          <div key={reason}>- {reason}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mb-4 rounded-lg border border-cyan-200/70 bg-cyan-50/60 px-4 py-3 dark:border-cyan-800/60 dark:bg-cyan-950/20">
                    <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                      AI Rig Fix
                    </label>
                    <div className="flex items-start gap-2">
                      <textarea
                        value={rigFixPrompt}
                        onChange={(event) => setRigFixPrompt(event.target.value)}
                        placeholder="e.g. restore the missing tail and keep the side profile silhouette clean"
                        className="min-h-[64px] flex-1 rounded-lg border border-cyan-200/80 bg-white px-3 py-2 text-xs text-neutral-700 shadow-sm outline-none transition-colors focus:border-cyan-400 dark:border-cyan-800/60 dark:bg-neutral-950 dark:text-neutral-200"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          if (!draftedRig || !draftingActorId || !rigFixPrompt.trim()) return;
                          const actor = storyData?.actors_detected.find(a => a.id === draftingActorId);
                          const actorReference = actorReferences[draftingActorId];
                          if (!actor || !actorReference) {
                            setDraftError("Missing actor reference for AI rig fix.");
                            return;
                          }

                          setIsAiFixingRig(true);
                          setDraftError(null);
                          setDraftReview(null);

                          try {
                            const requestedView = extractPrimaryRigView(draftedRig.svg_data);
                            const description = `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(', ')}. ${actor.visual_description}. CRITICAL FIX REQUEST: ${rigFixPrompt}. Preserve the same character identity, proportions, rig structure, and existing good parts. Repair only the missing or malformed parts while keeping the current views usable.`;
                            const generatedRig = await generateRigDraft({
                              generationReference: actorReference,
                              description,
                              requiredViews: [requestedView],
                              qualityMode: "reviewable",
                            });
                            const mergedRig = mergeRigViewUpdate(draftedRig, generatedRig.data, [requestedView]);
                            const existingClips = actor.drafted_rig?.rig_data.motion_clips;
                            const nextDraft = (existingClips && Object.keys(existingClips).length > 0)
                              ? { ...mergedRig, rig_data: { ...mergedRig.rig_data, motion_clips: existingClips } }
                              : mergedRig;

                            setDraftedRig(nextDraft);
                            setOriginalDraftedRig(JSON.parse(JSON.stringify(nextDraft)));
                            setDraftReview(generatedRig.review ?? null);
                          } catch (error: unknown) {
                            setDraftError(error instanceof Error ? error.message : "Failed to apply AI rig fix.");
                          } finally {
                            setIsAiFixingRig(false);
                          }
                        }}
                        disabled={isAiFixingRig || !rigFixPrompt.trim()}
                        className="shrink-0 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isAiFixingRig ? "Fixing..." : "Apply AI Fix"}
                      </button>
                    </div>
                  </div>
                  <div className="mb-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!originalDraftedRig) return;
                        setDraftedRig(JSON.parse(JSON.stringify(originalDraftedRig)));
                      }}
                      className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    >
                      Reset Fixes
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!draftingActorId || !draftedRig) return;
                        setStoryData(prev => {
                          if (!prev) return prev;
                          return {
                            ...prev,
                            actors_detected: prev.actors_detected.map(a =>
                              a.id === draftingActorId ? { ...a, drafted_rig: draftedRig } : a
                            )
                          };
                        });
                        setOriginalDraftedRig(JSON.parse(JSON.stringify(draftedRig)));
                      }}
                      className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors"
                    >
                      Save Rig Fixes
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden relative">
                    <IKLab
                      data={draftedRig}
                      onChange={setDraftedRig}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {clipPreviewState && clipPreviewBundle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden max-h-[92vh]">
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <div>
                <h3 className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {clipPreviewBundle.actor.name} - {clipPreviewState.clipName}
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  Reusable actor clip preview
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleClipPreviewToggle}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${clipPreviewPlaying
                    ? "bg-amber-500 text-[#0a0a0a] hover:bg-amber-400"
                    : "bg-emerald-500 text-white hover:bg-emerald-400"
                    }`}
                  title={clipPreviewPlaying ? "Pause preview" : "Play preview"}
                >
                  {clipPreviewPlaying ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                  ) : (
                    <Play size={16} className="fill-current ml-0.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setClipPreviewState(null);
                    setClipPreviewPlaying(false);
                    clipPreviewPlayheadRef.current = 0;
                    setClipPreviewPlayhead(0);
                  }}
                  className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
            </div>

            <div className="p-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6 items-stretch">
              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/80 dark:bg-[#0a0a0a]/80 shadow-lg overflow-hidden min-h-[420px]">
                <RigClipPreview
                  key={`${clipPreviewBundle.actor.id}:${clipPreviewState.clipName}:${fps}`}
                  rig={clipPreviewBundle.actor.drafted_rig!}
                  clipId={clipPreviewState.clipName}
                  frameRate={fps}
                  isPlaying={clipPreviewPlaying}
                  playheadTime={clipPreviewPlayhead}
                  loop={true}
                  onPlayheadUpdate={handleClipPreviewPlayheadUpdate}
                />
              </div>

              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-neutral-50 dark:bg-[#0a0a0a]/70 p-4 space-y-4">
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">Clip</h4>
                  <div className="rounded-lg border border-cyan-200 dark:border-cyan-800/50 bg-cyan-50 dark:bg-cyan-900/20 px-3 py-2 text-xs font-mono text-cyan-700 dark:text-cyan-300">
                    {clipPreviewState.clipName}
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">Actor</h4>
                  <div className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{clipPreviewBundle.actor.name}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">{clipPreviewBundle.actor.species}</div>
                </div>
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">Preview Duration</h4>
                  <div className="text-sm text-neutral-700 dark:text-neutral-200">
                    {clipPreviewBundle.compiledScene.duration_seconds.toFixed(2)}s @ {fps}fps
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">Playback</h4>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    This preview loops continuously so you can inspect the reusable action without the scene resetting.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {scenePreviewIndex !== null && storyData?.beats[scenePreviewIndex] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-6xl flex flex-col overflow-hidden max-h-[92vh]">
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <div>
                <h3 className="font-semibold text-neutral-800 dark:text-neutral-200">
                  Scene {scenePreviewIndex + 1}
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  Inspect and fix scene panel
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setScenePreviewIndex(null);
                  setEditPrompt("");
                }}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            <div className="p-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-stretch overflow-y-auto">
              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/80 dark:bg-[#0a0a0a]/80 shadow-lg overflow-hidden min-h-[420px]">
                <div className={`${previewImageFrameClass} bg-neutral-100 dark:bg-[#1a1a1a] flex items-center justify-center overflow-hidden relative`}>
                  {storyData.beats[scenePreviewIndex].image_data ? (
                    <img
                      src={storyData.beats[scenePreviewIndex].image_data}
                      alt={`Scene ${scenePreviewIndex + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs font-mono text-neutral-500 dark:text-neutral-400">
                      No panel image
                    </div>
                  )}
                </div>
                <div className="p-4 border-t border-neutral-100 dark:border-neutral-800/50">
                  <textarea
                    value={storyData.beats[scenePreviewIndex].narrative}
                    onChange={(e) => {
                      const value = e.target.value;
                      setStoryData(prev => {
                        if (!prev) return prev;
                        const newBeats = [...prev.beats];
                        newBeats[scenePreviewIndex] = { ...newBeats[scenePreviewIndex], narrative: value };
                        return { ...prev, beats: newBeats };
                      });
                    }}
                    className="w-full min-h-28 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-sm text-neutral-800 dark:text-neutral-200 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-neutral-50 dark:bg-[#0a0a0a]/70 p-4 space-y-4">
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">AI Fix Scene</h4>
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="Describe what to fix in this scene image..."
                    className="w-full min-h-28 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-xs text-neutral-800 dark:text-neutral-200 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                  />
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleEditImageSubmit(scenePreviewIndex)}
                      disabled={isEditingImage || !editPrompt.trim()}
                      className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:text-white/50 text-white text-xs font-semibold transition-colors"
                    >
                      {isEditingImage ? "Rendering..." : "Apply AI Fix"}
                    </button>
                    {storyData.beats[scenePreviewIndex].drafted_background && (
                      <button
                        type="button"
                        onClick={() => setDraftingBackgroundSceneIndex(scenePreviewIndex)}
                        className="px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                      >
                        Open Background
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 dark:text-neutral-400 mb-2">Actions</h4>
                  <div className="space-y-1.5">
                    {storyData.beats[scenePreviewIndex].actions.map((action, actionIndex) => (
                      <div
                        key={`scene-preview-action-${actionIndex}`}
                        className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 py-2"
                      >
                        <div className="text-xs font-mono text-cyan-700 dark:text-cyan-300">
                          {action.actor_id}:{action.motion}({action.style})
                        </div>
                        <div className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">
                          {action.duration_seconds.toFixed(2)}s
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportBeatState && (
        <div
          ref={exportStageHostRef}
          className="pointer-events-none fixed -left-[10000px] top-0 h-[1080px] w-[1920px] opacity-0"
          aria-hidden="true"
        >
          <Stage
            stageDomId="cartoon2d-export-stage"
            beat={exportBeatState.beat}
            compiledScene={exportBeatState.compiledScene}
            availableRigs={availableRigs}
            frameRate={fps}
            disableAmbient={true}
            isPlaying={false}
            playheadTime={exportPlayheadTime}
            onTimelineReady={handleExportTimelineReady}
            selectedActorId={null}
            stageOrientation={stageOrientation}
          />
        </div>
      )}

    </div>
  );
}
