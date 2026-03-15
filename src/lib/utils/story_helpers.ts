/**
 * Pure utility functions extracted from page.tsx.
 * No React state or component dependencies.
 */

import { CompiledSceneData, SpatialTransform, StoryBeatData, StoryGenerationData, getStageDims, StageOrientation } from "@/lib/schema/story";
import { DraftsmanData } from "@/lib/schema/rig";
import { ensureRigIK } from "@/lib/ik/graph";
import { matchLegacyViewPrefix, normalizeViewId, normalizeViewIds } from "@/lib/ik/view_ids";
import { inferRigProfile } from "@/lib/motion/affordance";
import { motionNeedsTarget, normalizeMotionKey, suggestMotionAliases } from "@/lib/motion/semantics";
import { motionClipToIKPlayback, resolvePlayableMotionClip } from "@/lib/motion/compiled_ik";
import { estimateMotionClipDuration } from "@/lib/motion/intent";
import type { MotionDebugReport } from "@/app/actions/draftsman";

// ── Cost estimation constants ──────────────────────────────────────────────────

const GEMINI_31_FLASH_IMAGE_INPUT_TOKEN_USD = 0.0000005;
const GEMINI_31_FLASH_IMAGE_TEXT_OUTPUT_TOKEN_USD = 0.000003;
const GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD = 0.00006;
export const GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS = 747;
export const GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD =
  Number((GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS * GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD).toFixed(5));
const GEMINI_31_PRO_PREVIEW_STANDARD_INPUT_TOKEN_USD = 0.000002;
const GEMINI_31_PRO_PREVIEW_STANDARD_TEXT_OUTPUT_TOKEN_USD = 0.000012;
const GEMINI_31_PRO_PREVIEW_LARGE_INPUT_TOKEN_USD = 0.000004;
const GEMINI_31_PRO_PREVIEW_LARGE_TEXT_OUTPUT_TOKEN_USD = 0.000018;
const GEMINI_31_PRO_PREVIEW_PROMPT_THRESHOLD = 200000;

export const PLAYHEAD_UI_SYNC_MS = 50;

export const BASE_EXPORT_RESOLUTIONS = {
  "720p": { label: "720p HD", width: 1280, height: 720 },
  "1080p": { label: "1080p FHD", width: 1920, height: 1080 },
  "4k": { label: "4K UHD", width: 3840, height: 2160 },
  "8k": { label: "8K UHD", width: 7680, height: 4320 },
} as const;

// ── Cost estimation ────────────────────────────────────────────────────────────

export function estimateStoryboardGenerationCost(promptTokens: number, candidateTokens: number, imageCount: number) {
  const imageOutputTokens = Math.min(candidateTokens, imageCount * GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS);
  const textOutputTokens = Math.max(0, candidateTokens - imageOutputTokens);
  const totalCost =
    (promptTokens * GEMINI_31_FLASH_IMAGE_INPUT_TOKEN_USD) +
    (textOutputTokens * GEMINI_31_FLASH_IMAGE_TEXT_OUTPUT_TOKEN_USD) +
    (imageOutputTokens * GEMINI_31_FLASH_IMAGE_IMAGE_OUTPUT_TOKEN_USD);

  return { totalCost, imageOutputTokens, textOutputTokens };
}

export function estimateProPreviewTextCost(promptTokens: number, candidateTokens: number) {
  const usesLargePromptRates = promptTokens > GEMINI_31_PRO_PREVIEW_PROMPT_THRESHOLD;
  const inputRate = usesLargePromptRates
    ? GEMINI_31_PRO_PREVIEW_LARGE_INPUT_TOKEN_USD
    : GEMINI_31_PRO_PREVIEW_STANDARD_INPUT_TOKEN_USD;
  const outputRate = usesLargePromptRates
    ? GEMINI_31_PRO_PREVIEW_LARGE_TEXT_OUTPUT_TOKEN_USD
    : GEMINI_31_PRO_PREVIEW_STANDARD_TEXT_OUTPUT_TOKEN_USD;

  return (promptTokens * inputRate) + (candidateTokens * outputRate);
}

// ── Compiled scene helpers ─────────────────────────────────────────────────────

export function findCompiledBinding(compiledScene: CompiledSceneData | null | undefined, actionIndex: number | null) {
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

export function buildClipPreviewScene(actorId: string, clipName: string, rig: DraftsmanData, stageDims: { width: number; height: number } = { width: 1920, height: 1080 }): {
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
    cameras: [{ start_time: 0, zoom: 1, x: cx, y: cy, rotation: 0 }],
    audio: [],
    actions: [
      {
        actor_id: actorId,
        motion: clipName,
        style: "preview",
        start_time: 0,
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

// ── Debug & log formatting ─────────────────────────────────────────────────────

export function formatMotionDebugLines(report: MotionDebugReport): string[] {
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

export function classifyCompileLogLine(line: string): "paid" | "reused" | "error" | "debug" | "review" | "neutral" {
  if (line.includes("[PAID]")) return "paid";
  if (line.includes("[REUSED]")) return "reused";
  if (line.includes("[BLOCKED]")) return "error";
  if (line.includes("[DEBUG]")) return "debug";
  if (line.includes("[REVIEW]")) return "review";
  if (line.includes("❌")) return "error";
  return "neutral";
}

export function getBeatImageGenerationCost(
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

// ── Duration & math ────────────────────────────────────────────────────────────

export function sanitizeDurationSeconds(value: number | null | undefined, fallback: number = 10) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.max(value, 0.1), 3600);
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// ── Rig view management ────────────────────────────────────────────────────────

export function extractRigViews(svgData: string): string[] {
  const matches = Array.from(svgData.matchAll(/id=['"](view_[^'"]+)['"]/g)).map((match) => match[1]);
  return normalizeViewIds(matches.length > 0 ? matches : ["view_3q_right"], "view_3q_right");
}

export function extractPrimaryRigView(svgData: string): string {
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

export function mergeRigViews(...viewGroups: Array<Array<string> | undefined>): string[] {
  return normalizeViewIds(viewGroups.flatMap((views) => views || []), "view_3q_right");
}

export function inferScopedViewId(value: string): string | undefined {
  const lower = value.toLowerCase();
  const genericPrefix = lower.match(/^([a-z0-9_]+)__/);
  if (genericPrefix) {
    return normalizeViewId(`view_${genericPrefix[1]}`);
  }
  return matchLegacyViewPrefix(lower)?.viewId;
}

export function mergeRigViewUpdate(existingRig: DraftsmanData, incomingRig: DraftsmanData, replacedViews: string[]): DraftsmanData {
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

export function selectRequiredRigViews(params: {
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

// ── Actor helpers ──────────────────────────────────────────────────────────────

export function buildActorRigDescription(actor: StoryGenerationData["actors_detected"][number]): string {
  return `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(", ")}. ${actor.visual_description}`;
}

export function inferRigRefreshReason(rig: DraftsmanData | undefined): string | null {
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

export function inferFallbackRigViews(
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

// ── Image/canvas helpers ───────────────────────────────────────────────────────

export function loadClientImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image."));
    image.src = src;
  });
}

// ── Reference transform helpers ────────────────────────────────────────────────

export function findActorReferenceTransform(beat: StoryBeatData, actorId: string) {
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

export function collectActorReferenceSamples(
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

export function estimateActorReferenceBounds(params: {
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

export async function extractActorReferenceCrop(params: {
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

// ── Clip reuse ─────────────────────────────────────────────────────────────────

export function buildActorReuseKey(actor: StoryGenerationData["actors_detected"][number]) {
  return [
    normalizeMotionKey(actor.name),
    normalizeMotionKey(actor.species),
  ].join("::");
}

export function cloneAnimationClip<T>(clip: T): T {
  return JSON.parse(JSON.stringify(clip)) as T;
}

export function findReusableActorClip(
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
