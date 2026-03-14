"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Stage from "@/components/Stage";
import { Send, Play, Image as ImageIcon, ImageOff, Volume2, Sparkles, LayoutList, SlidersHorizontal, ChevronDown, ChevronUp, Loader2, Film, Trash2, Pencil, Plus, Copy, Mountain, Bug } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { processScenePromptStream, processSceneImageEdit } from "@/app/actions/scene";
import { ClipBinding, CompiledSceneData, SpatialTransform, StoryBeatData, StoryGenerationData, getStageDims, StageOrientation } from "@/lib/schema/story";
import { loadStoryFromStorage, saveStoryToStorage, clearStoryStorage, getProjectsList, createProject, deleteProject, updateProjectTitle, ProjectMetadata, loadActorIdentities, saveActorIdentity, updateProjectOrientation } from "@/lib/storage/db";
import { generateMotionClipForRig, processDraftsmanPrompt, suggestRigViewsFromRaster, type DraftQualityMode, type DraftQualityReview, type MotionDebugReport } from "@/app/actions/draftsman";
import { processSetDesignerPrompt } from "@/app/actions/set_designer";
import { DraftsmanData } from "@/lib/schema/rig";
import { RigViewer } from "@/components/RigViewer";
import { IKLab } from "@/components/IKLab";
import { RigClipPreview } from "@/components/RigClipPreview";
import { ensureRigIK } from "@/lib/ik/graph";
import { matchLegacyViewPrefix, normalizeViewId, normalizeViewIds } from "@/lib/ik/view_ids";
import { inferRigProfile } from "@/lib/motion/affordance";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "@/lib/motion/semantics";
import { compileBeatToScene, inferTransformOnlyPlaybackPolicy } from "@/lib/motion/compiler";
import { motionClipToIKPlayback, resolvePlayableMotionClip } from "@/lib/motion/compiled_ik";
import { estimateMotionClipDuration } from "@/lib/motion/intent";

import { ThemeToggle } from "@/components/ThemeToggle";

const GEMINI_31_FLASH_IMAGE_INPUT_TOKEN_USD = 0.0000005;
const GEMINI_31_FLASH_IMAGE_TEXT_OUTPUT_TOKEN_USD = 0.000003;
const GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD = 0.00006;
const GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS = 747;
const GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD =
  Number((GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS * GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD).toFixed(5));
const GEMINI_31_PRO_PREVIEW_STANDARD_INPUT_TOKEN_USD = 0.000002;
const GEMINI_31_PRO_PREVIEW_STANDARD_TEXT_OUTPUT_TOKEN_USD = 0.000012;
const GEMINI_31_PRO_PREVIEW_LARGE_INPUT_TOKEN_USD = 0.000004;
const GEMINI_31_PRO_PREVIEW_LARGE_TEXT_OUTPUT_TOKEN_USD = 0.000018;
const GEMINI_31_PRO_PREVIEW_PROMPT_THRESHOLD = 200000;
const PLAYHEAD_UI_SYNC_MS = 50;

function estimateStoryboardGenerationCost(promptTokens: number, candidateTokens: number, imageCount: number) {
  const imageOutputTokens = Math.min(candidateTokens, imageCount * GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS);
  const textOutputTokens = Math.max(0, candidateTokens - imageOutputTokens);
  const totalCost =
    (promptTokens * GEMINI_31_FLASH_IMAGE_INPUT_TOKEN_USD) +
    (textOutputTokens * GEMINI_31_FLASH_IMAGE_TEXT_OUTPUT_TOKEN_USD) +
    (imageOutputTokens * GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD);

  return { totalCost, imageOutputTokens, textOutputTokens };
}

function estimateProPreviewTextCost(promptTokens: number, candidateTokens: number) {
  const usesLargePromptRates = promptTokens > GEMINI_31_PRO_PREVIEW_PROMPT_THRESHOLD;
  const inputRate = usesLargePromptRates
    ? GEMINI_31_PRO_PREVIEW_LARGE_INPUT_TOKEN_USD
    : GEMINI_31_PRO_PREVIEW_STANDARD_INPUT_TOKEN_USD;
  const outputRate = usesLargePromptRates
    ? GEMINI_31_PRO_PREVIEW_LARGE_TEXT_OUTPUT_TOKEN_USD
    : GEMINI_31_PRO_PREVIEW_STANDARD_TEXT_OUTPUT_TOKEN_USD;

  return (promptTokens * inputRate) + (candidateTokens * outputRate);
}

function findCompiledBinding(compiledScene: CompiledSceneData | null | undefined, actionIndex: number | null) {
  if (!compiledScene || actionIndex === null) return null;
  for (let trackIndex = 0; trackIndex < compiledScene.instance_tracks.length; trackIndex += 1) {
    const track = compiledScene.instance_tracks[trackIndex];
    const bindingIndex = track.clip_bindings.findIndex(binding => binding.source_action_index === actionIndex);
    if (bindingIndex >= 0) {
      return { trackIndex, bindingIndex, track, binding: track.clip_bindings[bindingIndex] };
    }
  }
  return null;
}

function buildClipPreviewScene(actorId: string, clipName: string, rig: DraftsmanData, stageDims: { width: number; height: number } = { width: 1920, height: 1080 }): {
  beat: StoryBeatData;
  compiledScene: CompiledSceneData;
} {
  const motionClip = rig.rig_data.motion_clips?.[clipName];
  const durationSeconds = estimateMotionClipDuration(motionClip);
  const playableClip = resolvePlayableMotionClip({
    rig,
    clipId: clipName,
    motionClip,
    durationSeconds,
  });
  const compiledIKPlayback = motionClipToIKPlayback(clipName, playableClip);
  const view = playableClip?.view;

  const cx = stageDims.width / 2;
  const cy = Math.round(stageDims.height * 0.8);

  const beat: StoryBeatData = {
    scene_number: 1,
    narrative: `${actorId} previewing ${clipName}`,
    camera: { zoom: 1, pan: "static" },
    audio: [],
    actions: [
      {
        actor_id: actorId,
        motion: clipName,
        style: "preview",
        duration_seconds: durationSeconds,
        spatial_transform: {
          x: cx,
          y: cy,
          scale: 0.9,
          z_index: 10,
        },
      },
    ],
    comic_panel_prompt: "",
  };

  const compiledScene: CompiledSceneData = {
    duration_seconds: durationSeconds,
    background_ambient: [],
    obstacles: [],
    instance_tracks: [
      {
        actor_id: actorId,
        clip_bindings: [
          {
            id: `${actorId}:preview:${clipName}`,
            actor_id: actorId,
            source_action_index: 0,
            motion: clipName,
            style: "preview",
            clip_id: clipName,
            view,
            start_time: 0,
            duration_seconds: durationSeconds,
            ik_playback: compiledIKPlayback,
            start_transform: {
              x: cx,
              y: cy,
              scale: 0.9,
              z_index: 10,
            },
          },
        ],
        transform_track: [
          {
            time: 0,
            x: cx,
            y: cy,
            scale: 0.9,
            z_index: 10,
          },
        ],
      },
    ],
  };

  return { beat, compiledScene };
}

function formatMotionDebugLines(report: MotionDebugReport): string[] {
  const lines = [
    `[DEBUG] Motion debug: duration=${report.durationSeconds.toFixed(2)}s, affordance=${report.affordance.articulationScore}, deformationBudget=${report.affordance.deformationBudget}.`,
    `[DEBUG] Spec summary: model amp=${report.modelSpec.amplitude}, final amp=${report.finalSpec.amplitude}, intensity=${report.finalSpec.intensity}, view=${report.finalSpec.preferredView || "auto"}, leads=${report.finalSpec.leadBones.join(", ") || "none"}.`,
  ];

  lines.push(
    `[DEBUG] Quality grade: profile=${report.qualityGrade.profile}, score=${report.qualityGrade.score}/5, rootSamples=${report.qualityGrade.metrics.rootSampleCount}, wholeObjectAnchors=${report.qualityGrade.metrics.wholeObjectAnchorCount}, meaningfulInterior=${report.qualityGrade.metrics.meaningfulInteriorRootSamples}, axes=${report.qualityGrade.metrics.activeRootAxes.join(", ") || "none"}, waves=${report.qualityGrade.metrics.waveCount}.`,
  );
  if (report.qualityGrade.reasons.length > 0) {
    lines.push(`[DEBUG] Quality notes: ${report.qualityGrade.reasons.join(" | ")}.`);
  }

  if (!report.preflight.ok) {
    lines.push(`[DEBUG] Preflight blocked: ${report.preflight.errors.join(" | ")}.`);
  }
  if (report.preflight.warnings.length > 0) {
    lines.push(`[DEBUG] Preflight warnings: ${report.preflight.warnings.slice(0, 3).join(" | ")}.`);
  }

  report.attempts.slice(0, 4).forEach((attempt) => {
    const waveSummary = attempt.waveChains
      .slice(0, 3)
      .map((wave) => `${wave.chainId}[${wave.nodeIds.length}n@${wave.amplitudeDeg}deg]`)
      .join(", ") || "none";
    lines.push(
      `[DEBUG] Attempt ${attempt.pass} @${attempt.attenuationFactor}x: view=${attempt.validation.debug.playableCoverage?.activeView || attempt.resolvedView || "none"}, leadNodes=${attempt.leadNodes.join(", ") || "none"}, waves=${waveSummary}.`,
    );

    const missingBindings = attempt.validation.debug.playableCoverage?.missingNodeIds || [];
    if (missingBindings.length > 0) {
      lines.push(`[DEBUG] Attempt ${attempt.pass} missing bindings: ${missingBindings.slice(0, 6).join(", ")}.`);
    }

    const saturatedNodes = (attempt.validation.debug.samples?.saturatedNodeStats || [])
      .filter((node) => node.ratio >= 0.5)
      .slice(0, 4)
      .map((node) => `${node.nodeId} ${node.count}/${attempt.validation.debug.samples?.sampleCount || 0}`);
    if (saturatedNodes.length > 0) {
      lines.push(`[DEBUG] Attempt ${attempt.pass} saturation: ${saturatedNodes.join(", ")}.`);
    }

    if (attempt.validation.errors.length > 0) {
      lines.push(`[DEBUG] Attempt ${attempt.pass} errors: ${attempt.validation.errors.join(" | ")}.`);
    }
  });

  return lines;
}

function classifyCompileLogLine(line: string): "paid" | "reused" | "error" | "debug" | "review" | "neutral" {
  if (line.includes("[PAID]")) return "paid";
  if (line.includes("[REUSED]")) return "reused";
  if (line.includes("[BLOCKED]")) return "error";
  if (line.includes("[DEBUG]")) return "debug";
  if (line.includes("[REVIEW]")) return "review";
  if (line.includes("❌")) return "error";
  return "neutral";
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

function getBeatImageGenerationCost(
  beat: StoryBeatData | undefined,
  beatIndex: number,
  transientCosts: Record<number, { tokens: number; cost: number }>,
) {
  const exactCost = beat?.image_generation_cost || beat?.compile_report?.image_generation_cost || transientCosts[beatIndex];
  if (exactCost) return exactCost;
  if (!beat?.image_data) return null;

  return {
    tokens: GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS,
    cost: GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD,
  };
}

function sanitizeDurationSeconds(value: number | null | undefined, fallback: number = 10) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.max(value, 0.1), 3600);
}

function extractRigViews(svgData: string): string[] {
  const matches = Array.from(svgData.matchAll(/id=['"](view_[^'"]+)['"]/g)).map((match) => match[1]);
  return normalizeViewIds(matches.length > 0 ? matches : ["view_3q_right"], "view_3q_right");
}

function extractPrimaryRigView(svgData: string): string {
  try {
    const parser = new DOMParser();
    const document = parser.parseFromString(svgData, "image/svg+xml");
    const visibleView = Array.from(document.querySelectorAll<SVGGElement>('g[id^="view_"]')).find((viewGroup) => {
      const normalizedViewId = normalizeViewId(viewGroup.id);
      if (!normalizedViewId) return false;
      return (viewGroup.getAttribute("display") || "").toLowerCase() !== "none";
    });
    return normalizeViewId(visibleView?.id || null) || extractRigViews(svgData)[0] || "view_3q_right";
  } catch {
    return extractRigViews(svgData)[0] || "view_3q_right";
  }
}

function mergeRigViews(...viewGroups: Array<Array<string> | undefined>): string[] {
  return normalizeViewIds(viewGroups.flatMap((views) => views || []), "view_3q_right");
}

function inferScopedViewId(value: string): string | undefined {
  const lower = value.toLowerCase();
  const genericPrefix = lower.match(/^([a-z0-9_]+)__/);
  if (genericPrefix) {
    return normalizeViewId(`view_${genericPrefix[1]}`);
  }
  return matchLegacyViewPrefix(lower)?.viewId;
}

function mergeRigViewUpdate(existingRig: DraftsmanData, incomingRig: DraftsmanData, replacedViews: string[]): DraftsmanData {
  const replaceViews = new Set(normalizeViewIds(replacedViews, "view_3q_right"));
  if (replaceViews.size === 0) return incomingRig;

  try {
    const parser = new DOMParser();
    const existingDocument = parser.parseFromString(existingRig.svg_data, "image/svg+xml");
    const incomingDocument = parser.parseFromString(incomingRig.svg_data, "image/svg+xml");
    const existingSvg = existingDocument.querySelector("svg");
    const incomingSvg = incomingDocument.querySelector("svg");

    if (!existingSvg || !incomingSvg) {
      return incomingRig;
    }

    const existingVisibleView = extractPrimaryRigView(existingRig.svg_data);

    Array.from(existingSvg.querySelectorAll<SVGGElement>('g[id^="view_"]')).forEach((viewGroup) => {
      const normalizedViewId = normalizeViewId(viewGroup.id);
      if (!normalizedViewId || !replaceViews.has(normalizedViewId)) return;
      viewGroup.remove();
    });

    const importedViews = Array.from(incomingSvg.querySelectorAll<SVGGElement>('g[id^="view_"]'))
      .filter((viewGroup) => {
        const normalizedViewId = normalizeViewId(viewGroup.id);
        return Boolean(normalizedViewId && replaceViews.has(normalizedViewId));
      })
      .map((viewGroup) => existingDocument.importNode(viewGroup, true) as SVGGElement);

    importedViews.forEach((viewGroup) => existingSvg.appendChild(viewGroup));

    const preferredVisibleView = replaceViews.has(existingVisibleView)
      ? (normalizeViewId(importedViews[0]?.id || null) || existingVisibleView)
      : existingVisibleView;

    Array.from(existingSvg.querySelectorAll<SVGGElement>('g[id^="view_"]')).forEach((viewGroup) => {
      const normalizedViewId = normalizeViewId(viewGroup.id);
      if (!normalizedViewId) return;
      viewGroup.setAttribute("display", normalizedViewId === preferredVisibleView ? "inline" : "none");
    });

    const keepExistingScopedId = (id: string) => {
      const scopedViewId = inferScopedViewId(id);
      return !scopedViewId || !replaceViews.has(scopedViewId);
    };

    const mergedRig = ensureRigIK({
      ...existingRig,
      svg_data: existingSvg.outerHTML,
      rig_data: {
        ...existingRig.rig_data,
        ...incomingRig.rig_data,
        bones: [
          ...existingRig.rig_data.bones.filter((bone) => keepExistingScopedId(bone.id)),
          ...incomingRig.rig_data.bones,
        ],
        interactionNulls: Array.from(new Set([
          ...existingRig.rig_data.interactionNulls.filter((id) => keepExistingScopedId(id)),
          ...incomingRig.rig_data.interactionNulls,
        ])),
        visemes: Array.from(new Set([
          ...(existingRig.rig_data.visemes || []),
          ...(incomingRig.rig_data.visemes || []),
        ])),
        emotions: Array.from(new Set([
          ...(existingRig.rig_data.emotions || []),
          ...(incomingRig.rig_data.emotions || []),
        ])),
      },
    });

    const profile = inferRigProfile(mergedRig);
    return {
      ...mergedRig,
      rig_data: {
        ...mergedRig.rig_data,
        profile: profile.profile,
        profile_report: profile,
      },
    };
  } catch {
    return incomingRig;
  }
}

function selectRequiredRigViews(params: {
  plannedViews: string[];
  existingViews?: string[];
}): { requestedViews: string[]; missingViews: string[]; primaryObservedView: string } {
  const plannedViews = mergeRigViews(params.plannedViews);
  const existingViews = mergeRigViews(params.existingViews || []);
  const primaryObservedView = plannedViews[0] || "view_3q_right";

  if (existingViews.length === 0) {
    return {
      requestedViews: [primaryObservedView],
      missingViews: [primaryObservedView],
      primaryObservedView,
    };
  }

  if (existingViews.includes(primaryObservedView)) {
    return {
      requestedViews: [primaryObservedView],
      missingViews: [],
      primaryObservedView,
    };
  }

  return {
    requestedViews: [primaryObservedView],
    missingViews: [primaryObservedView],
    primaryObservedView,
  };
}

function buildActorRigDescription(actor: StoryGenerationData["actors_detected"][number]): string {
  return `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(", ")}. ${actor.visual_description}`;
}

function inferRigRefreshReason(rig: DraftsmanData | undefined): string | null {
  if (!rig?.rig_data.ik) {
    return "canonical IK is missing";
  }

  const confidence = rig.rig_data.ik.aiReport?.confidence ?? 1;
  if (confidence < 0.45) {
    return `IK confidence ${confidence.toFixed(2)}`;
  }

  const warnings = rig.rig_data.ik.aiReport?.warnings || [];
  const attachmentWarningCount = warnings.filter((warning) => /attachment gap|no explicit attachment socket/i.test(warning)).length;
  if (attachmentWarningCount >= 2) {
    return `${attachmentWarningCount} structural attachment warnings`;
  }

  return null;
}

function inferFallbackRigViews(
  beat: StoryBeatData,
  actorActions: StoryBeatData["actions"],
): string[] {
  const sceneText = `${beat.narrative} ${beat.comic_panel_prompt}`.toLowerCase();
  const viewSet = new Set<string>();
  const sceneMentionsLeft = /left[- ]facing|faces left|looking left|from the left|left profile|camera left/.test(sceneText);
  const sceneMentionsRight = /right[- ]facing|faces right|looking right|from the right|right profile|camera right/.test(sceneText);

  for (const action of actorActions) {
    const motionKey = normalizeMotionKey(action.motion);
    const startX = action.spatial_transform?.x;
    const endX = action.target_spatial_transform?.x;
    const movesLeft = typeof startX === "number" && typeof endX === "number" && endX < startX - 10;
    const lateralView = movesLeft || sceneMentionsLeft ? "view_side_left" : "view_side_right";
    const angledView = sceneMentionsLeft ? "view_3q_left" : sceneMentionsRight ? "view_3q_right" : "view_3q_right";

    if (motionNeedsTarget(motionKey)) {
      viewSet.add(lateralView);
    } else if (/wave|greet|salute|talk|speak|say|tip_hat|sing|shout|smile|dialogue/.test(motionKey)) {
      viewSet.add("view_front");
    } else {
      viewSet.add(angledView);
    }
  }

  if (/top[- ]?down|overhead|bird'?s[- ]eye|from above/.test(sceneText)) {
    viewSet.add("view_top");
  }
  if (/from behind|back view|walk away|turns away|retreats|seen from behind/.test(sceneText)) {
    viewSet.add("view_back");
  }

  return mergeRigViews(Array.from(viewSet.size > 0 ? viewSet : new Set(["view_3q_right"])));
}

function loadClientImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image."));
    image.src = src;
  });
}

function findActorReferenceTransform(beat: StoryBeatData, actorId: string) {
  const compiledTrack = beat.compiled_scene?.instance_tracks.find((track) => track.actor_id === actorId);
  const compiledBinding = compiledTrack?.clip_bindings[0];
  if (compiledBinding?.start_transform) {
    return compiledBinding.start_transform;
  }

  const action = beat.actions.find((candidate) => candidate.actor_id === actorId);
  if (action?.spatial_transform) {
    return action.spatial_transform;
  }

  return null;
}

function collectActorReferenceSamples(
  beat: StoryBeatData,
  actorId: string,
  actorActions: StoryBeatData["actions"],
): Array<Pick<SpatialTransform, "x" | "y" | "scale">> {
  const samples = actorActions.flatMap((action) => {
    const points: Array<Pick<SpatialTransform, "x" | "y" | "scale">> = [];
    if (action.spatial_transform) {
      points.push({
        x: action.spatial_transform.x,
        y: action.spatial_transform.y,
        scale: action.spatial_transform.scale,
      });
    }
    if (action.target_spatial_transform) {
      points.push({
        x: action.target_spatial_transform.x,
        y: action.target_spatial_transform.y,
        scale: action.target_spatial_transform.scale,
      });
    }
    return points;
  });

  if (samples.length > 0) {
    return samples;
  }

  const fallback = findActorReferenceTransform(beat, actorId);
  return fallback
    ? [{ x: fallback.x, y: fallback.y, scale: fallback.scale }]
    : [];
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function estimateActorReferenceBounds(params: {
  samples: Array<Pick<SpatialTransform, "x" | "y" | "scale">>;
  stageW: number;
  stageH: number;
}) {
  const { samples, stageW, stageH } = params;
  if (samples.length === 0) return null;

  const xs = samples.map((sample) => sample.x);
  const ys = samples.map((sample) => sample.y);
  const scales = samples.map((sample) => clampNumber(sample.scale || 0.5, 0.18, 2.5));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centerX = (minX + maxX) * 0.5;
  const maxScale = Math.max(...scales);

  const baseHeight = clampNumber(stageH * (0.22 + (maxScale * 0.68)), stageH * 0.24, stageH * 0.82);
  const baseWidth = clampNumber(baseHeight * 1.22, stageW * 0.2, stageW * 0.84);
  const cropWidth = clampNumber(Math.max(baseWidth, (maxX - minX) + (stageW * 0.16)), stageW * 0.2, stageW * 0.88);
  const cropHeight = clampNumber(Math.max(baseHeight, (maxY - minY) + (stageH * 0.18)), stageH * 0.24, stageH * 0.9);
  const left = clampNumber(centerX - (cropWidth * 0.5), 0, stageW - cropWidth);
  const top = clampNumber(maxY - (cropHeight * 0.84), 0, stageH - cropHeight);

  return { x: left, y: top, width: cropWidth, height: cropHeight };
}

async function extractActorReferenceCrop(params: {
  imageSrc: string;
  beat: StoryBeatData;
  actorId: string;
  actorActions: StoryBeatData["actions"];
  orientation: StageOrientation;
}): Promise<string | null> {
  const { imageSrc, beat, actorId, actorActions, orientation } = params;
  if (!imageSrc) return null;

  const { width: stageW, height: stageH } = getStageDims(orientation);
  const samples = collectActorReferenceSamples(beat, actorId, actorActions);
  const bounds = estimateActorReferenceBounds({ samples, stageW, stageH });
  if (!bounds) return null;

  try {
    const image = await loadClientImage(imageSrc);
    const scaleX = image.naturalWidth / stageW;
    const scaleY = image.naturalHeight / stageH;
    const srcX = Math.max(0, Math.floor(bounds.x * scaleX));
    const srcY = Math.max(0, Math.floor(bounds.y * scaleY));
    const srcWidth = Math.max(1, Math.min(image.naturalWidth - srcX, Math.ceil(bounds.width * scaleX)));
    const srcHeight = Math.max(1, Math.min(image.naturalHeight - srcY, Math.ceil(bounds.height * scaleY)));

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const inset = 36;
    const fit = Math.min(
      (canvas.width - (inset * 2)) / srcWidth,
      (canvas.height - (inset * 2)) / srcHeight,
    );
    const drawWidth = srcWidth * fit;
    const drawHeight = srcHeight * fit;
    const dx = (canvas.width - drawWidth) * 0.5;
    const dy = (canvas.height - drawHeight) * 0.5;

    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, srcX, srcY, srcWidth, srcHeight, dx, dy, drawWidth, drawHeight);

    return canvas.toDataURL("image/jpeg", 0.92);
  } catch (error) {
    console.warn(`Failed to isolate actor reference for ${actorId}:`, error);
    return null;
  }
}

function buildActorReuseKey(actor: StoryGenerationData["actors_detected"][number]) {
  return [
    normalizeMotionKey(actor.name),
    normalizeMotionKey(actor.species),
  ].join("::");
}

function cloneAnimationClip<T>(clip: T): T {
  return JSON.parse(JSON.stringify(clip)) as T;
}


function findReusableActorClip(
  storyData: StoryGenerationData,
  actorId: string,
  motionKey: string,
) {
  const sourceActor = storyData.actors_detected.find((actor) => actor.id === actorId);
  if (!sourceActor) return null;

  const reuseKey = buildActorReuseKey(sourceActor);
  for (const candidate of storyData.actors_detected) {
    if (candidate.id === actorId || !candidate.drafted_rig) continue;
    if (buildActorReuseKey(candidate) !== reuseKey) continue;

    const reusableClipKey = suggestMotionAliases(motionKey).find((alias) =>
      candidate.drafted_rig?.rig_data.motion_clips?.[alias],
    );
    if (!reusableClipKey) continue;

    const reusableClip = candidate.drafted_rig.rig_data.motion_clips?.[reusableClipKey];
    if (!reusableClip) continue;

    return {
      clipKey: reusableClipKey,
      clip: cloneAnimationClip(reusableClip),
      sourceActorName: candidate.name,
    };
  }

  return null;
}

const BASE_EXPORT_RESOLUTIONS = {
  "720p": { label: "720p HD", width: 1280, height: 720 },
  "1080p": { label: "1080p FHD", width: 1920, height: 1080 },
  "4k": { label: "4K UHD", width: 3840, height: 2160 },
  "8k": { label: "8K UHD", width: 7680, height: 4320 },
} as const;

export default function Home() {

  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [storyData, setStoryData] = useState<StoryGenerationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

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

  // Auto-Animate Macro State
  const [animatingSceneIndex, setAnimatingSceneIndex] = useState<number | null>(null);
  const [animatingLogs, setAnimatingLogs] = useState<string[]>([]);
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

  // Generation Mode: 'sequence' | 'single'
  const [generateMode, setGenerateMode] = useState<'sequence' | 'single'>('single');

  // Stage Selection State
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState<number | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] = useState<'start' | 'end' | null>(null);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
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

  // Playhead callbacks — called by Stage when GSAP timeline ticks or completes
  const handlePlayheadUpdate = useCallback((timeSeconds: number) => {
    const pct = Math.min(100, totalDuration > 0 ? (timeSeconds / totalDuration) * 100 : 0);
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
  }, [totalDuration]);

  // Pill Drag Handlers
  const handlePillMouseDown = useCallback((e: React.MouseEvent, idx: number, actorId: string, delay: number, duration: number, mode: 'move' | 'resize') => {
    e.stopPropagation();
    setIsPlaying(false);
    dragPillRef.current = {
      idx,
      actorId,
      mode,
      startX: e.clientX,
      initialDelay: delay,
      initialDuration: duration,
    };
    setSelectedActionIndex(idx);
    setSelectedActorId(actorId);

    const handleWindowMouseMove = (eMouse: MouseEvent) => {
      if (!timelineRef.current || !dragPillRef.current) return;
      
      const timelineTrack = timelineRef.current.querySelector('div')?.getBoundingClientRect();
      const trackWidthPixels = Math.max(1, (timelineTrack?.width || timelineRef.current.clientWidth) - 192);
      const deltaX = eMouse.clientX - dragPillRef.current.startX;
      const deltaSeconds = (deltaX / trackWidthPixels) * totalDuration;

      setStoryData(prev => {
        if (!prev || !dragPillRef.current) return prev;
        const newBeats = [...prev.beats];
        const newActions = [...newBeats[selectedSceneIndex].actions];
        const action = { ...newActions[dragPillRef.current.idx] };

        if (dragPillRef.current.mode === 'move') {
          const newDelay = Math.max(0, dragPillRef.current.initialDelay + deltaSeconds);
          action.animation_overrides = { ...action.animation_overrides, delay: newDelay };
          
          // Live scrub the stage to the start time being dragged
          const scrubTime = newDelay;
          setPlayheadPos(totalDuration > 0 ? (scrubTime / totalDuration) * 100 : 0);
          handlePlayheadUpdate(scrubTime);
        } else if (dragPillRef.current.mode === 'resize') {
          const newDuration = Math.max(0.1, dragPillRef.current.initialDuration + deltaSeconds);
          action.duration_seconds = newDuration;
          
          // Live scrub the stage to the end frame we are resizing
          const scrubTime = dragPillRef.current.initialDelay + newDuration;
          setPlayheadPos(totalDuration > 0 ? (scrubTime / totalDuration) * 100 : 0);
          handlePlayheadUpdate(scrubTime);
        }

        newActions[dragPillRef.current.idx] = action;
        const nextBeat = { ...newBeats[selectedSceneIndex], actions: newActions };
        
        // Recompile live so the UI (which depends on compiled_scene) updates immediately
        const previousCompiledScene = selectedSceneIndex > 0
          ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
          : null;
        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
        nextBeat.compiled_scene = recompiled;
        
        newBeats[selectedSceneIndex] = nextBeat;
        return { ...prev, beats: newBeats };
      });
    };

    const handleWindowMouseUp = () => {
      dragPillRef.current = null;
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);

      // Recompile on drop so changes take effect
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        const currentBeat = newBeats[selectedSceneIndex];
        const previousCompiledScene = selectedSceneIndex > 0
          ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
          : null;
        const recompiled = compileBeatToScene(currentBeat, availableRigs, previousCompiledScene, stageOrientation);
        newBeats[selectedSceneIndex] = { ...currentBeat, compiled_scene: recompiled };
        return { ...prev, beats: newBeats };
      });
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
  }, [totalDuration, selectedSceneIndex, availableRigs, stageOrientation, handlePlayheadUpdate]);

  const currentTimeSeconds = (playheadPos / 100) * totalDuration;
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
    livePlayheadPosRef.current = 100;
    setPlayheadPos(100);
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
    livePlayheadPosRef.current = 100;
    setPlayheadPos(100);
  };

  const handleTogglePlayback = () => {
    if (!selectedBeat) return;
    if (isPlaying) {
      setPlayheadPos(livePlayheadPosRef.current);
      setIsPlaying(false);
      return;
    }
    if (playheadPos >= 99.9) {
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

  const handleCreateProject = async () => {
    try {
      const newProj = await createProject(`New Cartoon ${projects.length + 1}`);
      setProjects(prev => [...prev, newProj]);
      setCurrentProjectId(newProj.id);
      setStoryData({ title: "", actors_detected: [], beats: [] });
      setActorReferences({});
      setIsProjectDropdownOpen(false);
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
      const stream = await processScenePromptStream(prompt, contextBeats, { singleBeat: generateMode === 'single', orientation: stageOrientation }, actorReferences);
      for await (const chunk of stream) {
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
    } catch (err: unknown) {
      console.error("Generation failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to connect to generation service: ${errorMessage}`);
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
      // 1. Generate Background if missing
      if (!workingBeat.drafted_background && workingBeat.image_data) {
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
        addLog("[REUSED] ✓ Environment rig found in cache.");
      }

      // 2. Generate Actors if missing
      const actorIdsInScene = new Set(workingBeat.actions.map(a => a.actor_id));
      const sceneRigs: Record<string, DraftsmanData> = {};
      for (const actorId of Array.from(actorIdsInScene)) {
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

      for (let sceneOffset = 0; sceneOffset < beatsToExport.length; sceneOffset += 1) {
        const beat = beatsToExport[sceneOffset];
        const compiledScene = beat.compiled_scene!;

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
      }

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
        <aside className="w-16 md:w-48 lg:w-64 border-r border-neutral-200/50 dark:border-neutral-800/50 bg-white/60 dark:bg-[#070707]/60 backdrop-blur-md flex flex-col pt-4 hidden sm:flex shrink-0 transition-colors duration-300">
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
                  <button
                    onClick={handleCreateProject}
                    className="w-full py-1.5 flex items-center justify-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/20 rounded transition-colors"
                  >
                    <Plus size={12} /> New Cartoon
                  </button>
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
                                        style: "normal",
                                        duration_seconds: 2,
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

          <div className="p-4 border-t border-neutral-200/50 dark:border-neutral-800/50">
            <button className="w-full py-2 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-xs font-semibold text-neutral-700 dark:text-neutral-300 rounded-lg transition-colors flex items-center justify-center gap-2">
              + Import Asset
            </button>
          </div>
        </aside>

        <PanelGroup direction="horizontal" className="flex-1 w-full h-full">

          {/* Left Panel: Director's Prompt & Comic Timeline */}
          <Panel defaultSize={30} minSize={20}>
            <div className="w-full h-full flex flex-col bg-white/40 dark:bg-[#0a0a0a]/40 backdrop-blur-sm transition-colors duration-300">
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
                      placeholder={generateMode === 'single' ? "Describe a single scene... e.g., 'A robot cat stares at a vacuum cleaner suspiciously.'" : "Describe a sequence... e.g., 'A robot cat runs in panic from a loud vacuum cleaner. Then it hides under the couch.'"}
                      disabled={isGenerating}
                    />
                    <div className="flex items-center justify-between px-3 pb-3 pt-1">
                      {/* Mode Toggle */}
                      <div className="flex items-center bg-neutral-100 dark:bg-neutral-800/80 rounded-lg p-0.5 border border-neutral-200/80 dark:border-neutral-700/50">
                        <button
                          onClick={() => setGenerateMode('single')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-200 ${generateMode === 'single' ? 'bg-white dark:bg-neutral-700 text-cyan-700 dark:text-cyan-300 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
                        >
                          Single Scene
                        </button>
                        <button
                          onClick={() => setGenerateMode('sequence')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-200 ${generateMode === 'sequence' ? 'bg-white dark:bg-neutral-700 text-cyan-700 dark:text-cyan-300 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
                        >
                          Sequence
                        </button>
                      </div>
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !prompt.trim()}
                        className="bg-neutral-900 dark:bg-white disabled:bg-neutral-300 dark:disabled:bg-neutral-600 disabled:text-neutral-500 dark:disabled:text-neutral-400 hover:bg-neutral-700 dark:hover:bg-neutral-200 text-white dark:text-black px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 shadow-md dark:hover:shadow-[0_0_15px_rgba(255,255,255,0.4)] disabled:shadow-none transform hover:-translate-y-0.5 disabled:transform-none font-medium text-sm"
                      >
                        {isGenerating ? (
                          <><Loader2 size={14} className="animate-spin" /> <span>Directing...</span></>
                        ) : (
                          <><span>{generateMode === 'single' ? 'Generate Scene' : 'Generate Sequence'}</span><Send size={14} /></>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mt-4 p-3 rounded bg-red-100 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 text-xs text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="mt-10 flex-1 flex flex-col min-h-0 overflow-hidden">
                  <div className="mb-4 flex items-center justify-between gap-3 shrink-0">
                    <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2.5">
                      <LayoutList size={16} className="text-blue-500 dark:text-blue-400" /> Storyboard Timeline
                    </h2>
                    <div className="flex items-center gap-2 rounded-full border border-amber-200/70 bg-amber-50/80 px-3 py-1 text-[10px] font-mono text-amber-800 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
                      <span className="uppercase tracking-wider text-amber-600 dark:text-amber-400">Project</span>
                      <span className="font-semibold">~${projectCostSummary.cost.toFixed(4)}</span>
                      <span className="text-amber-500/80 dark:text-amber-400/80">{projectCostSummary.tokens.toLocaleString()} tokens</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{projectCostSummary.compiledScenes}/{storyData?.beats.length || 0} compiled</span>
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
                                <div className="flex flex-wrap gap-1.5">
                                  {beat.audio.map((audio, i) => (
                                    <span key={`audio-${i}`} className={`group/tag inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[9px] font-medium ${audio.type === 'dialogue' ? 'bg-amber-100 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-400' : 'bg-cyan-100 dark:bg-cyan-500/10 border-cyan-200 dark:border-cyan-500/20 text-cyan-700 dark:text-cyan-400'}`}>
                                      <Volume2 size={8} /> {audio.type === 'dialogue' ? `"${audio.text}"` : audio.description}
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
                                    </span>
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
                                          <Loader2 size={12} className="animate-spin text-emerald-500 opacity-50" />
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
                      <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2.5">
                        <Play size={16} className="text-emerald-500 dark:text-emerald-400" /> Performance Stage
                      </h2>

                      {/* Stage Output Controls */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded-lg p-1 shadow-sm dark:shadow-inner transition-colors duration-300">
                          {/* Resolution Dropdown */}
                          <div className="relative group/dropdown">
                            <button
                              onClick={() => setIsExportDropdownOpen(prev => !prev)}
                              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 hover:text-black dark:hover:text-white bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded transition-colors group"
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
                          stageOrientation={stageOrientation}
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
                  <div className="w-full h-full flex flex-col">
                    <div className="flex-1 rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/90 dark:bg-[#0a0a0a]/90 backdrop-blur-xl shadow-lg dark:shadow-2xl mx-6 mb-6 flex flex-col overflow-hidden transition-colors duration-300">

                      {/* 1. Timeline Toolbar (Global Transport Controls) */}
                      <div className="min-h-12 border-b border-neutral-200 dark:border-neutral-800/60 bg-neutral-50 dark:bg-[#0a0a0a] flex flex-wrap items-center gap-3 px-4 py-2 shrink-0 shadow-sm z-30 relative transition-colors duration-300">
                        {/* Left Side: Scene info + FPS */}
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <div className="text-[10px] font-bold text-neutral-600 dark:text-neutral-300 uppercase tracking-widest bg-white dark:bg-neutral-900 px-2 py-1.5 rounded border border-neutral-200 dark:border-neutral-800 shadow-sm dark:shadow-none transition-colors">
                            Scene {selectedSceneIndex + 1}
                          </div>
                          {storyData && storyData.beats.length > 1 && (
                            <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar max-w-40">
                              {storyData.beats.map((beat, index) => (
                                <button
                                  key={`timeline-scene-tab-${beat.scene_number}-${index}`}
                                  type="button"
                                  onClick={() => setSelectedSceneIndex(index)}
                                  className={`shrink-0 rounded border px-1.5 py-1 text-[9px] font-bold transition-colors ${selectedSceneIndex === index
                                      ? "border-cyan-400 bg-cyan-500 text-white"
                                      : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                                    }`}
                                  title={`Switch to Scene ${beat.scene_number}`}
                                >
                                  {beat.scene_number}
                                </button>
                              ))}
                            </div>
                          )}
                          {/* FPS selector */}
                          <div className="flex items-center bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden shadow-sm">
                            {([12, 24, 30, 60] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => setFps(f)}
                                className={`px-1.5 py-1 text-[9px] font-bold transition-colors ${fps === f ? 'bg-cyan-500 text-white' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'}`}
                              >{f}</button>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowObstacleDebug(prev => !prev)}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[9px] font-bold transition-colors ${showObstacleDebug
                                ? "border-amber-400 bg-amber-500 text-black"
                                : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                              }`}
                            title="Toggle obstacle debug overlay"
                          >
                            <Bug size={10} />
                            Collision
                          </button>
                        </div>

                        {/* Center: Transport Controls */}
                        <div className="flex min-w-0 flex-1 items-center justify-center gap-4">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleJumpToStart}
                              className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group"
                              title="Jump to start"
                            >
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                            </button>
                            <button
                              type="button"
                              onClick={handleTogglePlayback}
                              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all group ${isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-[#0a0a0a] shadow-[0_0_10px_rgba(245,158,11,0.3)]' : 'bg-emerald-500 hover:bg-emerald-400 text-white dark:text-[#0a0a0a] shadow-[0_0_10px_rgba(16,185,129,0.3)] hover:shadow-[0_0_15px_rgba(16,185,129,0.4)]'}`}
                              title={isPlaying ? "Pause" : "Play"}
                              disabled={!selectedBeat}
                            >
                              {isPlaying ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg> : <Play size={15} className="fill-current ml-0.5 group-hover:scale-110 transition-transform" />}
                            </button>
                            <button
                              type="button"
                              onClick={handleJumpToEnd}
                              className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group"
                              title="Jump to end"
                            >
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M4 18l8.5-6L4 6v12zm13-12v12h2V6h-2z" /></svg>
                            </button>
                          </div>

                          <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-800/60" />

                          {/* Playback Modes */}
                          <div className="flex items-center gap-1 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded p-1 shadow-sm dark:shadow-none transition-colors">
                            <button
                              onClick={() => setPlaybackScope("scene")}
                              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'scene' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                              title="Export or operate on this scene only"
                            >
                              Scene
                            </button>
                            <button
                              onClick={() => setPlaybackScope("all")}
                              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'all' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                              title="Export all compiled scenes sequentially"
                            >
                              All
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => setLoopPlayback(prev => !prev)}
                            className={`transition-colors p-1.5 rounded ${loopPlayback
                                ? "text-emerald-500 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                                : "text-neutral-400 dark:text-neutral-600 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                              }`}
                            title={loopPlayback ? "Loop playback enabled" : "Enable loop playback"}
                          >
                            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8" /><path d="M21 3v5h-5" /><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" /><path d="M3 21v-5h5" /></svg>
                          </button>
                        </div>

                        {/* Right Side: frame counter */}
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          {exportProgress && (
                            <span className="max-w-40 truncate text-[9px] font-mono text-cyan-600 dark:text-cyan-400" title={exportProgress}>
                              {exportProgress}
                            </span>
                          )}
                          <span className="text-[10px] font-mono text-neutral-500 dark:text-neutral-500">{fps}fps</span>
                          <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-500 font-bold bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-500/20 shadow-sm dark:shadow-none transition-colors">
                            {String(currentFrame).padStart(3, '0')} / {String(totalFrames).padStart(3, '0')}
                          </span>
                        </div>
                      </div>

                      {/* 2. Timeline Ruler Header (Track Labels & Time Ticks) */}
                      <div className="h-8 border-b border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#111] shrink-0 z-30 relative transition-colors duration-300 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" ref={timelineRef} onScroll={(e) => {
                        if (tracksRef.current && tracksRef.current.scrollLeft !== e.currentTarget.scrollLeft) {
                          tracksRef.current.scrollLeft = e.currentTarget.scrollLeft;
                        }
                      }}>
                        <div className="flex h-full" style={{ minWidth: `${Math.max(100, (totalDuration / 15) * 100)}%` }}>
                          <div className="w-48 border-r border-neutral-200 dark:border-neutral-800/60 h-full flex items-center px-4 bg-neutral-50 dark:bg-[#0a0a0a] shrink-0 transition-colors z-40 sticky left-0">
                            <span className="text-[10px] text-neutral-500 dark:text-neutral-600 font-bold uppercase tracking-wider">Layers</span>
                          </div>
                          <div className="flex-1 h-full relative transition-colors pointer-events-none">
                            {/* Playhead line + knob */}
                          <div className="absolute top-0 bottom-0 w-[2px] bg-emerald-500/80 z-50 pointer-events-none dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)]" style={{ left: `${playheadPos}%` }}>
                            <div
                              className={`absolute top-0 left-1/2 -translate-x-1/2 w-4 h-5 bg-gradient-to-b from-emerald-400 to-emerald-600 rounded-b-[4px] cursor-grab active:cursor-grabbing border-b border-l border-r border-emerald-300 shadow-[0_2px_10px_rgba(16,185,129,0.5)] pointer-events-auto flex items-center justify-center flex-col gap-[2px] ${isDraggingPlayhead ? 'scale-110' : ''}`}
                              onMouseDown={() => setIsDraggingPlayhead(true)}
                            >
                              <span className="w-2 h-px bg-emerald-200/80"></span>
                              <span className="w-2 h-px bg-emerald-200/80"></span>
                              <span className="w-2 h-px bg-emerald-200/80"></span>
                            </div>
                          </div>

                          {/* Frame grid + second labels */}
                          <div className="absolute inset-0 flex items-end pb-1 pointer-events-none select-none overflow-hidden">
                            {Array.from({ length: Math.ceil(totalDuration) + 1 }).map((_, s) => {
                              const pct = (s / totalDuration) * 100;
                              return (
                                <div key={s} className="absolute top-0 bottom-0 flex flex-col items-center" style={{ left: `${pct}%` }}>
                                  <div className="w-px h-3 bg-neutral-300 dark:bg-neutral-700 mt-auto" />
                                  <span className="text-[8px] font-mono text-neutral-400 dark:text-neutral-600 mt-0.5 -translate-x-1/2">{s}s</span>
                                </div>
                              );
                            })}
                            {/* Minor frame ticks (every N frames based on fps) */}
                            {Array.from({ length: totalFrames + 1 }).map((_, f) => {
                              if (f % fps === 0) return null; // skip second marks (already drawn)
                              const tickInterval = fps <= 12 ? 1 : fps <= 24 ? 4 : 6;
                              if (f % tickInterval !== 0) return null;
                              const pct = (f / totalFrames) * 100;
                              return (
                                <div key={`f${f}`} className="absolute bottom-1" style={{ left: `${pct}%` }}>
                                  <div className="w-px h-1.5 bg-neutral-200 dark:bg-neutral-800" />
                                </div>
                              );
                            })}
                          </div>
                          </div>
                        </div>
                      </div>

                      {/* 3. Timeline Tracks */}
                      <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar flex flex-col relative pb-8" ref={tracksRef} onScroll={(e) => {
                        if (timelineRef.current && timelineRef.current.scrollLeft !== e.currentTarget.scrollLeft) {
                          timelineRef.current.scrollLeft = e.currentTarget.scrollLeft;
                        }
                      }}>
                        <div className="flex flex-col relative" style={{ minWidth: `${Math.max(100, (totalDuration / 15) * 100)}%` }}>
                          
                          {/* Playhead line extension correctly overlaying all tracks */}
                          <div className="absolute inset-0 flex pointer-events-none z-[100]">
                            <div className="w-48 shrink-0" />
                            <div className="flex-1 relative overflow-hidden">
                              <div className="absolute top-0 bottom-0 w-[2px] bg-emerald-500/80 dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)]" style={{ left: `${playheadPos}%` }} />
                            </div>
                          </div>

                        {!storyData || storyData.beats.length === 0 ? (
                          <div className="h-full flex items-center justify-center text-xs text-neutral-500 font-mono">No scene selected.</div>
                        ) : (() => {
                          const beat = storyData.beats[selectedSceneIndex];
                          return (
                            <>
                              {/* Background / Environment Layer */}
                              <div className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                                <div className="w-48 h-full flex items-center gap-2 px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors z-30 sticky left-0">
                                  <Mountain size={10} className="text-neutral-400 dark:text-neutral-600 shrink-0" />
                                  <span className="text-[10px] text-neutral-500 dark:text-neutral-500 font-medium truncate">Background</span>
                                  {beat.drafted_background && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-auto shrink-0" title="Background generated" />}
                                </div>
                                <div className="flex-1 h-full relative overflow-hidden pointer-events-none">
                                  {beat.compiled_scene?.background_ambient?.length ? (
                                    beat.compiled_scene.background_ambient.map(binding => {
                                      const duration = totalDuration > 0 ? totalDuration : Math.max(beat.compiled_scene?.duration_seconds || 1, 1);
                                      const visibleDuration = Math.min(binding.duration_seconds, duration);
                                      const left = `${(binding.start_time / duration) * 100}%`;
                                      const width = `${Math.max((visibleDuration / duration) * 100, 3)}%`;
                                      return (
                                        <div
                                          key={binding.id}
                                          className="absolute inset-y-1.5 rounded bg-repeating-gradient opacity-50 dark:opacity-30 pointer-events-auto cursor-pointer"
                                          style={{
                                            left,
                                            width,
                                            background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.15) 8px, rgba(99,102,241,0.15) 9px)',
                                          }}
                                          title={`${binding.target_id} (${binding.label})`}
                                        >
                                          <div className="absolute inset-0 border border-indigo-200 dark:border-indigo-700/30 rounded" />
                                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-indigo-400 dark:text-indigo-500 select-none truncate max-w-[85%]">
                                            {binding.label} ↻
                                          </span>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div className="absolute inset-y-1.5 left-0 right-0 rounded bg-repeating-gradient opacity-20 dark:opacity-10 pointer-events-auto"
                                      style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.15) 8px, rgba(99,102,241,0.15) 9px)' }}>
                                      <div className="absolute inset-0 border border-indigo-200 dark:border-indigo-700/20 rounded" />
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-indigo-300 dark:text-indigo-700 select-none">no bg motion</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Actor Layers */}
                              {(() => {
                                const tracks = beat.compiled_scene?.instance_tracks.length
                                  ? beat.compiled_scene.instance_tracks.map(track => {
                                      // Fallback to actions array if compiled scene has no z-index
                                      const fallbackZ = Math.max(
                                        ...(beat.actions.filter(a => a.actor_id === track.actor_id).map(a => a.spatial_transform?.z_index ?? 10))
                                      );
                                      const trackZ = track.transform_track[0]?.z_index;
                                      return {
                                        actorId: track.actor_id,
                                        zIndexLevel: trackZ !== undefined ? trackZ : fallbackZ,
                                        bindings: track.clip_bindings,
                                      };
                                    })
                                  : Array.from(new Set(beat.actions.map(a => a.actor_id))).map(actorId => {
                                      const actorActions = beat.actions.filter(a => a.actor_id === actorId);
                                      return {
                                        actorId,
                                        zIndexLevel: Math.max(...actorActions.map(a => a.spatial_transform?.z_index ?? 10)),
                                        bindings: beat.actions
                                          .map((action, idx) => ({ action, idx }))
                                          .filter(entry => entry.action.actor_id === actorId)
                                          .map(entry => ({
                                            id: `${actorId}:${entry.idx}:${entry.action.motion}`,
                                            actor_id: actorId,
                                            source_action_index: entry.idx,
                                            motion: entry.action.motion,
                                            style: entry.action.style,
                                            clip_id: entry.action.motion,
                                            start_time: entry.action.animation_overrides?.delay ?? 0,
                                            duration_seconds: entry.action.duration_seconds || 2,
                                            start_transform: {
                                              x: entry.action.spatial_transform?.x ?? 960,
                                              y: entry.action.spatial_transform?.y ?? 950,
                                              scale: entry.action.spatial_transform?.scale ?? 0.5,
                                              z_index: entry.action.spatial_transform?.z_index ?? 10,
                                            },
                                          })),
                                      };
                                  });
                                  
                                return tracks.sort((a, b) => b.zIndexLevel - a.zIndexLevel);
                              })().map(({ actorId, bindings }) => {
                                const actorData = storyData.actors_detected.find(a => a.id === actorId);
                                const hasRig = !!actorData?.drafted_rig;
                                const hasIdleClip = !!actorData?.drafted_rig?.rig_data.motion_clips?.idle;

                                return (
                                  <div key={`track-${actorId}`} className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                                    <div className="w-48 h-full flex items-center gap-2 px-3 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors group/trackheader relative z-20">
                                      <div className="w-5 h-5 rounded shrink-0 bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                                        {actorReferences[actorId]
                                          ? <img src={actorReferences[actorId]} alt="" className="w-full h-full object-cover" />
                                          : <div className="w-full h-full flex items-center justify-center text-[8px] text-neutral-400">?</div>}
                                      </div>
                                      <span className="text-[10px] text-neutral-700 dark:text-neutral-300 font-medium truncate flex-1">{actorData?.name || actorId}</span>
                                      
                                      <div className="hidden group-hover/trackheader:flex items-center gap-0.5 absolute right-6 bg-white dark:bg-[#0f0f0f] px-1 shadow-sm rounded">
                                        <button 
                                          onClick={() => handleLayerMove(actorId, -1)}
                                          className="text-neutral-400 hover:text-cyan-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded p-0.5 transition-colors" title="Bring Forward">
                                          <ChevronUp size={12}/>
                                        </button>
                                        <button 
                                          onClick={() => handleLayerMove(actorId, 1)}
                                          className="text-neutral-400 hover:text-cyan-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded p-0.5 transition-colors" title="Send Backward">
                                          <ChevronDown size={12}/>
                                        </button>
                                      </div>

                                      {hasRig && <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0 ml-auto" title="Rig ready" />}
                                    </div>
                                    <div className="flex-1 h-full relative overflow-visible">
                                      {hasIdleClip && (
                                        <div
                                          className="absolute inset-y-1.5 left-0 right-0 rounded"
                                          style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.08) 8px, rgba(99,102,241,0.08) 9px)', border: '1px solid rgba(99,102,241,0.15)' }}
                                        >
                                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-indigo-300 dark:text-indigo-700 select-none">idle ↻</span>
                                        </div>
                                      )}

                                      {bindings.map((binding: ClipBinding) => {
                                        const clipStartPct = Math.min(100, ((binding.start_time || 0) / totalDuration) * 100);
                                        const clipWidthPct = Math.min(100, ((binding.duration_seconds || 2) / totalDuration) * 100);
                                        const isSelected = selectedActionIndex === binding.source_action_index;
                                        const isIdleMotion = ['idle', 'stare'].includes(binding.motion.toLowerCase());
                                        const bindingLabel = binding.clip_id === "base_object" ? `${binding.motion} • object` : binding.motion;
                                        return (
                                          <div
                                            key={binding.id}
                                            className={`absolute inset-y-2 rounded flex items-center px-2 cursor-pointer transition-all z-10 group/pill ${isSelected
                                                ? 'bg-cyan-500/10 border border-cyan-400 text-cyan-800 dark:text-cyan-200 shadow-sm'
                                                : isIdleMotion 
                                                  ? 'bg-neutral-100 dark:bg-neutral-700/50 border border-neutral-300 dark:border-neutral-600/50 hover:bg-neutral-200 dark:hover:bg-neutral-600/70 text-neutral-600 dark:text-neutral-300'
                                                  : 'bg-blue-100 dark:bg-blue-600/25 border border-blue-300 dark:border-blue-500/50 hover:bg-blue-200 dark:hover:bg-blue-600/35 text-blue-700 dark:text-blue-300'
                                              }`}
                                            style={{ left: `${clipStartPct}%`, width: `${clipWidthPct}%`, minWidth: '24px' }}
                                            onMouseDown={(e) => {
                                              if (e.button !== 0) return; // Only left click
                                              setSelectedKeyframe(null);
                                              handlePillMouseDown(e, binding.source_action_index, actorId, binding.start_time, binding.duration_seconds, 'move');
                                            }}
                                            onClick={() => {
                                              setSelectedActionIndex(binding.source_action_index);
                                              setSelectedActorId(actorId);
                                              setSelectedKeyframe(null);
                                              setPlayheadPos(totalDuration > 0 ? (binding.start_time / totalDuration) * 100 : 0);
                                            }}
                                          >
                                            <div 
                                              className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 flex items-center justify-center group-hover/pill:scale-110 transition-transform z-20 cursor-pointer" 
                                              title="Select Start Keyframe"
                                              onClick={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setIsPlaying(false);
                                                setSelectedActionIndex(binding.source_action_index);
                                                setSelectedActorId(actorId);
                                                setSelectedKeyframe('start');
                                                const newTime = binding.start_time;
                                                const newPos = totalDuration > 0 ? (newTime / totalDuration) * 100 : 0;
                                                setPlayheadPos(newPos);
                                                handlePlayheadUpdate(newTime);
                                              }}
                                            >
                                              <div className={`w-2.5 h-2.5 outline outline-2 ${isSelected && selectedKeyframe === 'start' ? 'outline-cyan-400 bg-cyan-100 dark:bg-cyan-900 shadow-[0_0_8px_rgba(6,182,212,0.8)]' : isSelected ? 'outline-cyan-500 bg-white dark:bg-neutral-900' : 'outline-blue-400 dark:outline-blue-500 bg-white dark:bg-neutral-800 group-hover/pill:outline-blue-500 dark:group-hover/pill:outline-blue-400'}`} />
                                            </div>

                                            <span className="text-[10px] font-mono font-medium truncate pl-2 user-select-none opacity-90 mx-auto pointer-events-none">{bindingLabel}</span>
                                            {binding.style && <span className="text-[9px] font-mono ml-1 truncate user-select-none opacity-70 pointer-events-none">({binding.style})</span>}
                                            
                                            {/* End Keyframe Node */}
                                            <div 
                                              className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 flex items-center justify-center group-hover/pill:scale-110 transition-transform z-20 cursor-pointer" 
                                              title="Select End Keyframe"
                                              onClick={(e) => e.stopPropagation()}
                                              onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setIsPlaying(false);
                                                setSelectedActionIndex(binding.source_action_index);
                                                setSelectedActorId(actorId);
                                                setSelectedKeyframe('end');
                                                const newTime = binding.start_time + binding.duration_seconds;
                                                const newPos = totalDuration > 0 ? (newTime / totalDuration) * 100 : 0;
                                                setPlayheadPos(newPos);
                                                handlePlayheadUpdate(newTime);
                                              }}
                                            >
                                              <div className={`w-2.5 h-2.5 outline outline-2 ${isSelected && selectedKeyframe === 'end' ? 'outline-cyan-400 bg-cyan-100 dark:bg-cyan-900 shadow-[0_0_8px_rgba(6,182,212,0.8)]' : isSelected ? 'outline-cyan-500 bg-white dark:bg-neutral-900' : 'outline-blue-400 dark:outline-blue-500 bg-white dark:bg-neutral-800 group-hover/pill:outline-blue-500 dark:group-hover/pill:outline-blue-400'}`} />
                                            </div>
                                            
                                            {/* Edge Grabber for Resizing Duration (physically distinct handle separated from the keyframe) */}
                                            <div 
                                              className="absolute -right-3.5 top-0 bottom-0 w-3 cursor-col-resize z-30 flex items-center justify-center opacity-0 group-hover/pill:opacity-100 transition-opacity"
                                              onMouseDown={(e) => {
                                                if (e.button !== 0) return;
                                                e.stopPropagation();
                                                handlePillMouseDown(e, binding.source_action_index, actorId, binding.start_time, binding.duration_seconds, 'resize');
                                              }}
                                              title="Drag to resize clip duration"
                                            >
                                              <div className="w-[3px] h-3 bg-cyan-500/80 rounded-full" />
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <button 
                                      className="w-10 flex flex-col items-center justify-center shrink-0 border-l border-neutral-200 dark:border-neutral-800/40 bg-neutral-50/50 hover:bg-neutral-100 dark:bg-neutral-900/30 dark:hover:bg-neutral-800/50 transition-colors opacity-0 group-hover/track:opacity-100"
                                      title={`Add action for ${actorData?.name || actorId}`}
                                      onClick={() => {
                                        setStoryData(prev => {
                                          if (!prev) return prev;
                                          const newBeats = [...prev.beats];
                                          const currentBeat = newBeats[selectedSceneIndex];
                                          const newActions = [...currentBeat.actions, {
                                            actor_id: actorId,
                                            motion: "idle",
                                            style: "normal",
                                            duration_seconds: 2,
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
                                    >
                                      <span className="text-neutral-400 dark:text-neutral-500 font-mono text-base leading-none block pb-0.5">+</span>
                                    </button>
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                        </div>
                      </div>
                    </div>
                  </div>
                </Panel>
              </PanelGroup>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-cyan-500/50 transition-colors cursor-col-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center">
            <div className="w-0.5 h-8 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </PanelResizeHandle>

          {/* Right Panel: Properties Panel (for Timeline Editing) */}
          <Panel defaultSize={20} minSize={15} maxSize={30}>
            <div className="w-full h-full flex flex-col bg-white/60 dark:bg-[#070707]/80 backdrop-blur-md border-l border-neutral-200/50 dark:border-neutral-800/50 z-20 transition-colors duration-300">
              <div className="h-10 border-b border-neutral-200/60 dark:border-neutral-800/60 flex items-center px-4 bg-white dark:bg-[#0a0a0a] shrink-0 transition-colors">
                <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2"><SlidersHorizontal size={14} className="text-cyan-600 dark:text-cyan-500" /> Properties</span>
              </div>

              <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
                {(() => {
                  if (!storyData || storyData.beats.length === 0) {
                    return <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>;
                  }

                  const beat = storyData.beats[selectedSceneIndex];
                  if (!beat) {
                    return <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>;
                  }
                  const selectedBindingRef = findCompiledBinding(beat.compiled_scene, selectedActionIndex);

                  // ── Animation Overview (shown when nothing selected) ──────
                  if (selectedActionIndex === null || !beat.actions[selectedActionIndex]) {
                    return (
                      <div className="space-y-5">
                        <div>
                          <h3 className="text-[9px] font-bold uppercase tracking-widest text-neutral-400 dark:text-neutral-600 mb-2">Compiled Scene Timeline</h3>
                          <div className="space-y-1.5">
                            <div className="rounded border border-indigo-100 dark:border-indigo-800/20 overflow-hidden">
                              <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 dark:bg-indigo-900/10">
                                <span className="text-indigo-400 text-[9px] font-mono">↻</span>
                                <span className="text-[10px] text-neutral-600 dark:text-neutral-400 flex-1">Background ambient</span>
                                <span className="text-[9px] text-indigo-400 font-mono">
                                  {beat.compiled_scene?.background_ambient?.length || 0} bind
                                </span>
                              </div>
                              {beat.compiled_scene?.background_ambient?.length ? (
                                beat.compiled_scene.background_ambient.map(binding => (
                                  <div
                                    key={binding.id}
                                    className="flex items-center gap-2 px-2 py-1 border-t border-indigo-100/60 dark:border-indigo-800/20 bg-indigo-50/40 dark:bg-indigo-900/5"
                                  >
                                    <span className="text-indigo-400 text-[9px] font-mono">≈</span>
                                    <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">
                                      {binding.target_id}
                                      <span className="ml-1 text-indigo-400 font-mono">({binding.label})</span>
                                    </span>
                                    <span className="text-[8px] text-indigo-400 font-mono">
                                      {binding.start_time.toFixed(1)}s + {binding.duration_seconds.toFixed(1)}s
                                    </span>
                                  </div>
                                ))
                              ) : (
                                <div className="px-2 py-1.5 border-t border-indigo-100/60 dark:border-indigo-800/20 bg-indigo-50/20 dark:bg-indigo-900/5 text-[9px] text-neutral-500 dark:text-neutral-400">
                                  No compiled background motion.
                                </div>
                              )}
                            </div>
                            {beat.compiled_scene?.instance_tracks.length ? (
                              beat.compiled_scene.instance_tracks.map(track => {
                                const actorData = storyData.actors_detected.find(a => a.id === track.actor_id);
                                return (
                                  <div key={track.actor_id} className="rounded border border-neutral-100 dark:border-neutral-800/40 overflow-hidden">
                                    <div className="px-2 py-1 bg-neutral-50 dark:bg-neutral-900/50 flex items-center gap-1.5">
                                      <div className="w-3 h-3 rounded-sm bg-neutral-200 dark:bg-neutral-800 overflow-hidden shrink-0">
                                        {actorReferences[track.actor_id] && <img src={actorReferences[track.actor_id]} alt="" className="w-full h-full object-cover" />}
                                      </div>
                                      <span className="text-[10px] font-semibold text-neutral-600 dark:text-neutral-300 flex-1 truncate">{actorData?.name || track.actor_id}</span>
                                    </div>
                                    {track.clip_bindings.map(binding => (
                                      <div
                                        key={binding.id}
                                        className="flex items-center gap-2 px-2 py-1 border-t border-neutral-100 dark:border-neutral-800/30 bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer hover:bg-blue-100/60 dark:hover:bg-blue-900/20 transition-colors"
                                        onClick={() => { setSelectedActionIndex(binding.source_action_index); setSelectedActorId(track.actor_id); }}
                                      >
                                        <span className="text-blue-400 text-[9px] font-mono">▶</span>
                                        <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">
                                          {binding.motion} <span className="text-neutral-400">({binding.style})</span>
                                          <span className="ml-1 text-cyan-500 font-mono">→ {binding.clip_id === "base_object" ? "object" : binding.clip_id}</span>
                                        </span>
                                        <span className="text-[8px] text-blue-400 font-mono">{binding.start_time.toFixed(1)}s + {binding.duration_seconds.toFixed(1)}s</span>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })
                            ) : (
                              beat.actions.map((action, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-center gap-2 px-2 py-1 border border-neutral-100 dark:border-neutral-800/40 bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer hover:bg-blue-100/60 dark:hover:bg-blue-900/20 transition-colors rounded"
                                  onClick={() => { setSelectedActionIndex(idx); setSelectedActorId(action.actor_id); }}
                                >
                                  <span className="text-blue-400 text-[9px] font-mono">▶</span>
                                  <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">{action.motion} <span className="text-neutral-400">({action.style})</span></span>
                                  <span className="text-[8px] text-blue-400 font-mono">{action.duration_seconds}s</span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const action = beat.actions[selectedActionIndex];
                  const binding = selectedBindingRef?.binding;

                  const updateCollisionBehavior = (value: "halt" | "slide" | "bounce") => {
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
                      const nextBeat = {
                        ...currentBeat,
                        actions: newActions,
                      };
                      const previousCompiledScene = selectedSceneIndex > 0
                        ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
                        : null;
                      const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                      newBeats[selectedSceneIndex] = {
                        ...nextBeat,
                        compiled_scene: recompiled,
                      };
                      return { ...prev, beats: newBeats };
                    });
                  };

                  return (
                    <div className="flex flex-col gap-5 transition-opacity">
                      <div>
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-1 uppercase tracking-wider flex justify-between">
                          <span>{binding ? "Selected Binding" : "Selected Action"}</span>
                          <span className="text-cyan-500">{action.actor_id}</span>
                        </div>
                        <div className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 flex items-center px-3 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm dark:shadow-none transition-colors">
                          {action.motion}({action.style}){binding ? ` -> ${binding.clip_id === "base_object" ? "object" : binding.clip_id}` : ""}
                        </div>
                        {binding?.collision && (
                          <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">
                            Collision stop: {binding.collision.obstacle_id} at x={Math.round(binding.collision.stop_x)}
                            {binding.collision.stop_time !== undefined ? ` @ ${binding.collision.stop_time.toFixed(2)}s` : ""}
                          </div>
                        )}
                      </div>

                      {/* Motion Editor */}
                      <div>
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider flex items-center gap-2">
                          <Play size={12} /> Motion
                        </div>
                        <select
                          value={action.motion}
                          onChange={e => {
                            const newMotion = e.target.value;
                            setStoryData(prev => {
                              if (!prev) return prev;
                              const newBeats = [...prev.beats];
                              const currentBeat = newBeats[selectedSceneIndex];
                              const newActions = [...currentBeat.actions];
                              newActions[selectedActionIndex] = {
                                ...newActions[selectedActionIndex],
                                motion: newMotion,
                                // Clear target transform for non-movement motions
                                target_spatial_transform: motionNeedsTarget(newMotion)
                                  ? newActions[selectedActionIndex].target_spatial_transform
                                  : undefined,
                              };
                              const nextBeat = { ...currentBeat, actions: newActions };
                              const previousCompiledScene = selectedSceneIndex > 0
                                ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
                                : null;
                              const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                              newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                              return { ...prev, beats: newBeats };
                            });
                          }}
                          className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 text-xs text-neutral-700 dark:text-neutral-300 shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500/50 cursor-pointer appearance-none"
                        >
                          {(() => {
                            const rig = storyData?.actors_detected.find(a => a.id === action.actor_id)?.drafted_rig;
                            const availableMotions = new Set<string>();
                            availableMotions.add(action.motion); // Always keep current motion as an option
                            if (rig?.rig_data.motion_clips) {
                              Object.keys(rig.rig_data.motion_clips).forEach(m => availableMotions.add(m));
                            } else {
                              // If no rig, at least allow idle and whatever it is now
                              availableMotions.add('idle');
                            }
                            return Array.from(availableMotions).map(m => (
                              <option key={m} value={m}>{m}</option>
                            ));
                          })()}
                        </select>
                      </div>

                      {/* Transforms Editor */}
                      <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800/40 relative mt-4">
                        {selectedKeyframe && (
                          <div className="absolute -top-3 left-0 bg-cyan-100/90 text-cyan-800 dark:bg-cyan-900/80 dark:text-cyan-200 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest uppercase border border-cyan-200 dark:border-cyan-800 backdrop-blur shadow-sm">
                            Editing {selectedKeyframe} Keyframe
                          </div>
                        )}
                        {(!selectedKeyframe || selectedKeyframe === 'start') && (
                          <div className={`p-2 rounded-lg transition-colors ${selectedKeyframe === 'start' ? 'bg-cyan-50 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : ''}`}>
                            <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
                              <span className={selectedKeyframe === 'start' ? 'text-cyan-600 dark:text-cyan-400 font-bold' : ''}>Start Keyframe</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2 mb-2">
                              {[
                                { label: 'X', prop: 'x', val: action.spatial_transform?.x ?? 960 },
                                { label: 'Y', prop: 'y', val: action.spatial_transform?.y ?? 950 },
                                { label: 'Scale', prop: 'scale', val: action.spatial_transform?.scale ?? 0.5, step: 0.05 }
                              ].map((field) => (
                                <div key={`start-${field.prop}`} className="flex flex-col gap-1">
                                  <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                                  <input
                                    type="number"
                                    step={field.step || 1}
                                    value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value);
                                      if (isNaN(val)) return;
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        const currentBeat = newBeats[selectedSceneIndex];
                                        const newActions = [...currentBeat.actions];
                                        const currentAction = newActions[selectedActionIndex];
                                        
                                        const oldVal = (currentAction.spatial_transform as any)?.[field.prop] ?? (field.prop === 'scale' ? 0.5 : (field.prop === 'x' ? 960 : 950));
                                        const diff = val - oldVal;
                                        
                                        const newSpatialTransform = {
                                          ...(currentAction.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
                                          [field.prop]: val
                                        };
                                        
                                        // Shift target if available
                                        const newTargetSpatialTransform = currentAction.target_spatial_transform ? { ...currentAction.target_spatial_transform } : undefined;
                                        if (newTargetSpatialTransform) {
                                          if (field.prop === 'x' || field.prop === 'y') {
                                            newTargetSpatialTransform[field.prop] = (newTargetSpatialTransform[field.prop] ?? oldVal) + diff;
                                          } else if (field.prop === 'scale') {
                                            newTargetSpatialTransform.scale = (newTargetSpatialTransform.scale ?? oldVal) * (val / oldVal);
                                          }
                                        }

                                        newActions[selectedActionIndex] = {
                                          ...currentAction,
                                          spatial_transform: newSpatialTransform,
                                          target_spatial_transform: newTargetSpatialTransform
                                        };

                                        const nextBeat = { ...currentBeat, actions: newActions };
                                        const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
                                        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                                        newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                    className={`w-full h-7 bg-white dark:bg-neutral-900 rounded border px-1.5 text-xs font-mono shadow-inner focus:outline-none focus:ring-1 transition-colors ${selectedKeyframe === 'start' ? 'border-cyan-300 dark:border-cyan-700/50 text-cyan-800 dark:text-cyan-300 focus:ring-cyan-500/50' : 'border-neutral-200 dark:border-neutral-700/50 text-neutral-700 dark:text-neutral-300 focus:ring-cyan-500/30'}`}
                                  />
                                </div>
                              ))}
                            </div>
                            <div className="flex gap-4">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={action.spatial_transform?.flip_x ?? false}
                                  onChange={(e) => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      const currentBeat = newBeats[selectedSceneIndex];
                                      const newActions = [...currentBeat.actions];
                                      newActions[selectedActionIndex] = {
                                        ...newActions[selectedActionIndex],
                                        spatial_transform: {
                                          ...(newActions[selectedActionIndex].spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
                                          flip_x: e.target.checked
                                        }
                                      };
                                      const nextBeat = { ...currentBeat, actions: newActions };
                                      const recompiled = compileBeatToScene(nextBeat, availableRigs, selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null, stageOrientation);
                                      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                  className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'start' ? 'ring-1 ring-cyan-400' : ''}`}
                                />
                                <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'start' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip X</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={action.spatial_transform?.flip_y ?? false}
                                  onChange={(e) => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      const currentBeat = newBeats[selectedSceneIndex];
                                      const newActions = [...currentBeat.actions];
                                      newActions[selectedActionIndex] = {
                                        ...newActions[selectedActionIndex],
                                        spatial_transform: {
                                          ...(newActions[selectedActionIndex].spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
                                          flip_y: e.target.checked
                                        }
                                      };
                                      const nextBeat = { ...currentBeat, actions: newActions };
                                      const recompiled = compileBeatToScene(nextBeat, availableRigs, selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null, stageOrientation);
                                      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                  className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'start' ? 'ring-1 ring-cyan-400' : ''}`}
                                />
                                <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'start' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip Y</span>
                              </label>
                            </div>
                          </div>
                        )}

                        {motionNeedsTarget(action.motion) && (!selectedKeyframe || selectedKeyframe === 'end') && (
                          <div className={`mt-2 p-2 rounded-lg transition-colors ${selectedKeyframe === 'end' ? 'bg-cyan-50 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : ''}`}>
                            <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
                              <span className={selectedKeyframe === 'end' ? 'text-cyan-600 dark:text-cyan-400 font-bold' : ''}>End Keyframe</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2 mb-2">
                              {[
                                { label: 'X', prop: 'x', val: action.target_spatial_transform?.x ?? (action.spatial_transform?.x ?? 960) },
                                { label: 'Y', prop: 'y', val: action.target_spatial_transform?.y ?? (action.spatial_transform?.y ?? 950) },
                                { label: 'Scale', prop: 'scale', val: action.target_spatial_transform?.scale ?? (action.spatial_transform?.scale ?? 0.5), step: 0.05 }
                              ].map((field) => (
                                <div key={`end-${field.prop}`} className="flex flex-col gap-1">
                                  <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                                  <input
                                    type="number"
                                    step={field.step || 1}
                                    value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                                    onChange={(e) => {
                                      const val = parseFloat(e.target.value);
                                      if (isNaN(val)) return;
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        const currentBeat = newBeats[selectedSceneIndex];
                                        const newActions = [...currentBeat.actions];
                                        const fallbackTarget = newActions[selectedActionIndex].spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
                                        newActions[selectedActionIndex] = {
                                          ...newActions[selectedActionIndex],
                                          target_spatial_transform: {
                                            ...fallbackTarget,
                                            ...(newActions[selectedActionIndex].target_spatial_transform || {}),
                                            [field.prop]: val
                                          }
                                        };
                                        const nextBeat = { ...currentBeat, actions: newActions };
                                        const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
                                        const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                                        newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                        return { ...prev, beats: newBeats };
                                      });
                                    }}
                                    className={`w-full h-7 bg-white dark:bg-neutral-900 rounded border px-1.5 text-xs font-mono shadow-inner focus:outline-none focus:ring-1 transition-colors ${selectedKeyframe === 'end' ? 'border-cyan-300 dark:border-cyan-700/50 text-cyan-800 dark:text-cyan-300 focus:ring-cyan-500/50' : 'border-neutral-200 dark:border-neutral-700/50 text-cyan-700 dark:text-cyan-400 focus:ring-cyan-500/30'}`}
                                  />
                                </div>
                              ))}
                            </div>
                            <div className="flex gap-4">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={action.target_spatial_transform?.flip_x ?? action.spatial_transform?.flip_x ?? false}
                                  onChange={(e) => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      const currentBeat = newBeats[selectedSceneIndex];
                                      const newActions = [...currentBeat.actions];
                                      const fallbackTarget = newActions[selectedActionIndex].spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
                                      newActions[selectedActionIndex] = {
                                        ...newActions[selectedActionIndex],
                                        target_spatial_transform: {
                                          ...fallbackTarget,
                                          ...(newActions[selectedActionIndex].target_spatial_transform || {}),
                                          flip_x: e.target.checked
                                        }
                                      };
                                      const nextBeat = { ...currentBeat, actions: newActions };
                                      const recompiled = compileBeatToScene(nextBeat, availableRigs, selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null, stageOrientation);
                                      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                  className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'end' ? 'ring-1 ring-cyan-400' : ''}`}
                                />
                                <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'end' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip X</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={action.target_spatial_transform?.flip_y ?? action.spatial_transform?.flip_y ?? false}
                                  onChange={(e) => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      const currentBeat = newBeats[selectedSceneIndex];
                                      const newActions = [...currentBeat.actions];
                                      const fallbackTarget = newActions[selectedActionIndex].spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
                                      newActions[selectedActionIndex] = {
                                        ...newActions[selectedActionIndex],
                                        target_spatial_transform: {
                                          ...fallbackTarget,
                                          ...(newActions[selectedActionIndex].target_spatial_transform || {}),
                                          flip_y: e.target.checked
                                        }
                                      };
                                      const nextBeat = { ...currentBeat, actions: newActions };
                                      const recompiled = compileBeatToScene(nextBeat, availableRigs, selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null, stageOrientation);
                                      newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                  className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'end' ? 'ring-1 ring-cyan-400' : ''}`}
                                />
                                <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'end' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip Y</span>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Timeline Editor */}
                      <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800/40 mt-4">
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider">
                          Timeline Properties
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] text-neutral-400 font-mono tracking-widest">Delay (s)</label>
                            <input
                              type="number"
                              step={0.1}
                              min={0}
                              value={Number((action.animation_overrides?.delay ?? 0).toFixed(2))}
                              onChange={(e) => {
                                const val = Math.max(0, parseFloat(e.target.value) || 0);
                                setStoryData(prev => {
                                  if (!prev) return prev;
                                  const newBeats = [...prev.beats];
                                  const currentBeat = newBeats[selectedSceneIndex];
                                  const newActions = [...currentBeat.actions];
                                  newActions[selectedActionIndex] = {
                                    ...newActions[selectedActionIndex],
                                    animation_overrides: {
                                      ...(newActions[selectedActionIndex].animation_overrides || {}),
                                      delay: val
                                    }
                                  };
                                  const nextBeat = { ...currentBeat, actions: newActions };
                                  const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
                                  const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                                  newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                  return { ...prev, beats: newBeats };
                                });
                              }}
                              className="w-full h-7 bg-white dark:bg-neutral-900 rounded border border-neutral-200 dark:border-neutral-700/50 px-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-inner focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-colors"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] text-neutral-400 font-mono tracking-widest">Duration (s)</label>
                            <input
                              type="number"
                              step={0.1}
                              min={0.1}
                              value={Number((action.duration_seconds).toFixed(2))}
                              onChange={(e) => {
                                const val = Math.max(0.1, parseFloat(e.target.value) || 0.1);
                                setStoryData(prev => {
                                  if (!prev) return prev;
                                  const newBeats = [...prev.beats];
                                  const currentBeat = newBeats[selectedSceneIndex];
                                  const newActions = [...currentBeat.actions];
                                  newActions[selectedActionIndex] = {
                                    ...newActions[selectedActionIndex],
                                    duration_seconds: val
                                  };
                                  const nextBeat = { ...currentBeat, actions: newActions };
                                  const previousCompiledScene = selectedSceneIndex > 0 ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null : null;
                                  const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                                  newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                                  return { ...prev, beats: newBeats };
                                });
                              }}
                              className="w-full h-7 bg-white dark:bg-neutral-900 rounded border border-neutral-200 dark:border-neutral-700/50 px-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-inner focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-colors"
                            />
                          </div>
                        </div>
                      </div>

                      {binding && (
                        <div>
                          <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider flex items-center gap-2">
                            <Bug size={12} /> Collision Response
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {(["halt", "slide", "bounce"] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => updateCollisionBehavior(mode)}
                                className={`rounded border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${(binding.collision_behavior || "halt") === mode
                                    ? "border-amber-400 bg-amber-500 text-black"
                                    : "border-neutral-200 dark:border-neutral-700/50 bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                                  }`}
                              >
                                {mode}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}


                      <div className="pt-5 flex justify-end">
                        <button 
                          type="button"
                          className="px-3 py-1.5 rounded bg-red-50 text-red-600 border border-red-200 text-xs font-semibold hover:bg-red-100 dark:bg-red-900/20 dark:border-red-800/50 dark:text-red-400 dark:hover:bg-red-900/40 transition-colors"
                          onClick={() => {
                            setStoryData(prev => {
                              if (!prev) return prev;
                              const newBeats = [...prev.beats];
                              const currentBeat = newBeats[selectedSceneIndex];
                              const newActions = [...currentBeat.actions];
                              newActions.splice(selectedActionIndex, 1);
                              const nextBeat = { ...currentBeat, actions: newActions };
                              const previousCompiledScene = selectedSceneIndex > 0
                                ? newBeats[selectedSceneIndex - 1]?.compiled_scene ?? null
                                : null;
                              const recompiled = compileBeatToScene(nextBeat, availableRigs, previousCompiledScene, stageOrientation);
                              newBeats[selectedSceneIndex] = { ...nextBeat, compiled_scene: recompiled };
                              return { ...prev, beats: newBeats };
                            });
                            setSelectedActionIndex(null);
                          }}
                        >
                          Delete Action
                        </button>
                      </div>

                    </div>
                  );
                })()}
              </div>
            </div>
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
