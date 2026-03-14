import { AnimationKeyframe, DraftsmanData, RigMotionClip, RigMotionIntent } from "../schema/rig";
import { ClipBindingIKPlayback } from "../schema/story";
import { buildMotionIntentFromSpec, sanitizeMotionIntentForRig } from "./intent";
import { inferMotionSpecForRig } from "./spec";
import { ensureRigIK } from "../ik/graph";

function resolvePlayableView(params: {
  rig: DraftsmanData;
  requestedView?: string;
  motionClip?: RigMotionClip;
}): string | undefined {
  const normalized = ensureRigIK(params.rig);
  const ik = normalized.rig_data.ik;
  if (!ik) return params.requestedView;

  const requiredNodeIds = new Set<string>([
    ...ik.roots,
    ...(params.motionClip?.intent?.leadNodes || []),
    ...(params.motionClip?.intent?.effectorGoals || []).map((goal) => goal.nodeId),
    ...(params.motionClip?.intent?.rotationTracks || []).map((track) => track.nodeId),
    ...(params.motionClip?.intent?.axialWaves || []).flatMap((wave) => wave.nodeIds),
    ...(params.motionClip?.intent?.pins || []).map((pin) => pin.nodeId),
    ...(params.motionClip?.intent?.contacts || []).map((contact) => contact.nodeId),
  ]);

  const scoreView = (viewId: string) => {
    const view = ik.views[viewId];
    if (!view) return null;
    const bindingNodeIds = new Set(view.bindings.map((binding) => binding.nodeId));
    const requiredCoverage = requiredNodeIds.size === 0
      ? 1
      : Array.from(requiredNodeIds).filter((nodeId) => bindingNodeIds.has(nodeId)).length / requiredNodeIds.size;
    const totalCoverage = ik.nodes.length === 0
      ? 1
      : bindingNodeIds.size / ik.nodes.length;
    return { viewId, requiredCoverage, totalCoverage };
  };

  const requestedScore = params.requestedView ? scoreView(params.requestedView) : null;
  if (requestedScore && requestedScore.requiredCoverage >= 1 && requestedScore.totalCoverage >= 0.95) {
    return requestedScore.viewId;
  }

  const defaultScore = ik.defaultView ? scoreView(ik.defaultView) : null;
  if (defaultScore && defaultScore.requiredCoverage >= 1 && defaultScore.totalCoverage >= 0.95) {
    return defaultScore.viewId;
  }

  return Object.keys(ik.views)
    .map((viewId) => scoreView(viewId))
    .filter((score): score is NonNullable<typeof score> => Boolean(score))
    .sort((left, right) => {
      if (right.requiredCoverage !== left.requiredCoverage) return right.requiredCoverage - left.requiredCoverage;
      if (right.totalCoverage !== left.totalCoverage) return right.totalCoverage - left.totalCoverage;
      if (left.viewId === ik.defaultView) return -1;
      if (right.viewId === ik.defaultView) return 1;
      return left.viewId.localeCompare(right.viewId);
    })[0]?.viewId;
}

function restrictRigToView(rig: DraftsmanData, viewId?: string): DraftsmanData {
  const normalized = ensureRigIK(rig);
  const ik = normalized.rig_data.ik;
  if (!ik || !viewId || !ik.views[viewId]) return normalized;

  const view = ik.views[viewId];
  const nodeMap = new Map(ik.nodes.map((node) => [node.id, node]));
  const keepNodeIds = new Set<string>();

  view.bindings.forEach((binding) => {
    let cursor: string | undefined = binding.nodeId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      keepNodeIds.add(cursor);
      cursor = nodeMap.get(cursor)?.parent;
    }
  });

  const nodes = ik.nodes
    .filter((node) => keepNodeIds.has(node.id))
    .map((node) => ({
      ...node,
      parent: node.parent && keepNodeIds.has(node.parent) ? node.parent : undefined,
    }));

  return {
    ...normalized,
    rig_data: {
      ...normalized.rig_data,
      ik: {
        ...ik,
        defaultView: viewId,
        roots: nodes.filter((node) => !node.parent).map((node) => node.id).sort(),
        nodes,
        chains: (ik.chains || [])
          .map((chain) => ({
            ...chain,
            nodeIds: chain.nodeIds.filter((nodeId) => keepNodeIds.has(nodeId)),
          }))
          .filter((chain) => chain.nodeIds.length >= 2 && keepNodeIds.has(chain.effectorId)),
        constraints: (ik.constraints || []).filter((constraint) => keepNodeIds.has(constraint.nodeId)),
        effectors: (ik.effectors || []).filter((effector) => keepNodeIds.has(effector.nodeId)),
        views: {
          [viewId]: {
            bindings: view.bindings.filter((binding) => keepNodeIds.has(binding.nodeId)),
          },
        },
      },
    },
  };
}

function filterDisplayKeyframesToView(
  rig: DraftsmanData,
  viewId: string | undefined,
  displayKeyframes: RigMotionClip["displayKeyframes"],
): RigMotionClip["displayKeyframes"] {
  if (!viewId) return displayKeyframes || [];
  const view = ensureRigIK(rig).rig_data.ik?.views[viewId];
  if (!view) return displayKeyframes || [];
  const boundBoneIds = new Set(view.bindings.map((binding) => binding.boneId));
  return (displayKeyframes || []).filter((keyframe) => boundBoneIds.has(keyframe.boneId));
}

function finalizePlayableMotionClip(
  rig: DraftsmanData,
  motionClip: RigMotionClip,
  requestedView?: string,
): RigMotionClip {
  let resolvedView = resolvePlayableView({
    rig,
    requestedView,
    motionClip,
  });

  let restrictedRig = restrictRigToView(rig, resolvedView);
  let intent = sanitizeMotionIntentForRig(restrictedRig, motionClip.intent) || motionClip.intent;
  let displayKeyframes = filterDisplayKeyframesToView(rig, resolvedView, motionClip.displayKeyframes);

  const refinedView = resolvePlayableView({
    rig,
    requestedView: resolvedView,
    motionClip: {
      ...motionClip,
      view: resolvedView,
      intent,
      displayKeyframes,
    },
  });

  if (refinedView && refinedView !== resolvedView) {
    resolvedView = refinedView;
    restrictedRig = restrictRigToView(rig, resolvedView);
    intent = sanitizeMotionIntentForRig(restrictedRig, motionClip.intent) || motionClip.intent;
    displayKeyframes = filterDisplayKeyframesToView(rig, resolvedView, motionClip.displayKeyframes);
  }

  return {
    ...motionClip,
    view: resolvedView,
    intent,
    displayKeyframes,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function sampleTimesFromKeyframes(keyframes: AnimationKeyframe[], durationSeconds: number): number[] {
  const times = new Set<number>([0, round3(durationSeconds)]);
  keyframes.forEach((keyframe) => {
    const start = keyframe.delay ?? 0;
    if (start >= durationSeconds) return;

    const tweenDuration = Math.max(0.0001, keyframe.duration || 0.5);
    const cycleDuration = tweenDuration * (keyframe.yoyo ? 2 : 1);
    const totalCycles = keyframe.repeat === -1 ? Number.POSITIVE_INFINITY : Math.max(1, (keyframe.repeat ?? 0) + 1);
    const activeEnd = Math.min(durationSeconds, start + (cycleDuration * totalCycles));

    times.add(round3(start));
    times.add(round3(activeEnd));
  });
  
  // Dense-sample the entire timeline at 30 fps to perfectly capture easing curves.
  // The IK motion intent evaluates linearly, so we need dense points to represent sine waves cleanly.
  const fps = 30;
  const frameCount = Math.ceil(durationSeconds * fps);
  for (let i = 0; i <= frameCount; i++) {
    times.add(round3(i / fps));
  }
  
  return Array.from(times).sort((left, right) => left - right);
}

function lerpDegrees(from: number, to: number, alpha: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  let next = from + (delta * alpha);
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function valueAtTime(keyframes: AnimationKeyframe[], time: number, defaultValue = 0, isRotation = false): number {
  const ordered = [...keyframes].sort((left, right) => (left.delay ?? 0) - (right.delay ?? 0));
  let current = defaultValue;

  for (const keyframe of ordered) {
    const start = keyframe.delay ?? 0;
    if (time < start) {
      return round2(current);
    }

    const tweenDuration = Math.max(0.0001, keyframe.duration || 0.5);
    const from = keyframe.from ?? current;
    const to = keyframe.to;
    const cycleDuration = tweenDuration * (keyframe.yoyo ? 2 : 1);
    const totalCycles = keyframe.repeat === -1 ? Number.POSITIVE_INFINITY : Math.max(1, (keyframe.repeat ?? 0) + 1);
    const activeEnd = start + (cycleDuration * totalCycles);

    if (Number.isFinite(activeEnd) && time >= activeEnd) {
      current = keyframe.yoyo ? from : to;
      continue;
    }

    const elapsed = Math.max(0, time - start);
    const cycleTime = cycleDuration > 0 ? elapsed % cycleDuration : 0;
    
    // Default to sine.inOut for Cartoon2D aesthetics unless explicit linear/none
    const applyEase = (alpha: number) => {
      if (keyframe.ease === "linear" || keyframe.ease === "none") return alpha;
      return -(Math.cos(Math.PI * alpha) - 1) / 2;
    };

    if (cycleTime <= tweenDuration) {
      const alpha = applyEase(clamp(cycleTime / tweenDuration, 0, 1));
      return isRotation ? round2(lerpDegrees(from, to, alpha)) : round2(from + ((to - from) * alpha));
    }

    if (keyframe.yoyo) {
      const alpha = applyEase(clamp((cycleTime - tweenDuration) / tweenDuration, 0, 1));
      return isRotation ? round2(lerpDegrees(to, from, alpha)) : round2(to + ((from - to) * alpha));
    }

    return round2(to);
  }

  return round2(current);
}

function buildNodeIdByBoneId(rig: DraftsmanData, preferredView?: string): Map<string, string> {
  const normalized = ensureRigIK(rig);
  const lookup = new Map<string, string>();
  const ik = normalized.rig_data.ik;
  if (!ik) return lookup;

  ik.nodes.forEach((node) => {
    (node.sourceBoneIds || []).forEach((boneId) => {
      if (!lookup.has(boneId)) {
        lookup.set(boneId, node.id);
      }
    });
  });

  const applyViewBindings = (viewId?: string) => {
    if (!viewId) return;
    ik.views[viewId]?.bindings.forEach((binding) => {
      lookup.set(binding.boneId, binding.nodeId);
    });
  };

  applyViewBindings(preferredView);
  Object.keys(ik.views).forEach((viewId) => {
    if (viewId !== preferredView) {
      applyViewBindings(viewId);
    }
  });

  return lookup;
}

function buildRotationTracksFromSourceClip(params: {
  rig: DraftsmanData;
  sourceClip: {
    view?: string;
    keyframes: AnimationKeyframe[];
  };
  durationSeconds: number;
}): RigMotionIntent["rotationTracks"] {
  const nodeIdByBoneId = buildNodeIdByBoneId(params.rig, params.sourceClip.view);
  const keyframesByNodeId = new Map<string, AnimationKeyframe[]>();

  const ikNodes = ensureRigIK(params.rig).rig_data.ik?.nodes || [];
  const ikNodeMap = new Map(ikNodes.map(n => [n.id, n]));
  const getDepthOffset = (nodeId: string): number => {
    let depth = 0;
    let curr = ikNodeMap.get(nodeId);
    while (curr?.parent) {
      depth++;
      curr = ikNodeMap.get(curr.parent);
    }
    return depth * 0.04; // 40ms follow-through delay per hierarchy level
  };

  params.sourceClip.keyframes
    .filter((keyframe) => keyframe.prop === "rotation")
    .forEach((keyframe) => {
      const nodeId = nodeIdByBoneId.get(keyframe.bone);
      if (!nodeId) return;
      const list = keyframesByNodeId.get(nodeId) || [];
      list.push(keyframe);
      keyframesByNodeId.set(nodeId, list);
    });

  return Array.from(keyframesByNodeId.entries())
    .map(([nodeId, keyframes]) => {
      const timeOffset = getDepthOffset(nodeId);

      const samples = sampleTimesFromKeyframes(keyframes, params.durationSeconds)
        .map((time) => {
          let evalTime = time - timeOffset;
          if (evalTime < 0) {
             evalTime = (evalTime % params.durationSeconds) + params.durationSeconds;
          }

          return {
            t: params.durationSeconds > 0 ? round3(clamp(time / params.durationSeconds, 0, 1)) : 0,
            rotation: valueAtTime(keyframes, evalTime, 0, true),
          };
        })
        .filter((sample, index, all) => (
          index === 0 ||
          index === all.length - 1 ||
          sample.t !== all[index - 1].t ||
          Math.abs(sample.rotation - all[index - 1].rotation) > 0.01
        ));

      // Force cyclic looping continuity by ensuring the last frame perfectly
      // matches the first frame if the duration is meant to seamlessly loop.
      if (samples.length > 1) {
        samples[samples.length - 1].rotation = samples[0].rotation;
      }

      if (samples.length === 0 || samples.every((sample) => Math.abs(sample.rotation) < 0.01)) {
        return null;
      }

      return { nodeId, samples };
    })
    .filter((track): track is NonNullable<typeof track> => Boolean(track))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function buildRigMotionClipFromGeneratedClip(params: {
  rig: DraftsmanData;
  sourceClip: {
    view?: string;
    keyframes: AnimationKeyframe[];
  };
  motion: string;
  style?: string;
  durationSeconds?: number;
  motionSpec?: ReturnType<typeof inferMotionSpecForRig>;
  assumeRefined?: boolean;
}): RigMotionClip | undefined {
  const durationSeconds = params.durationSeconds || 2;
  const motionSpec = params.motionSpec || inferMotionSpecForRig({
    motion: params.motion,
    style: params.style,
    durationSeconds,
    rig: params.rig,
  });

  const displayKeyframes = params.sourceClip.keyframes
    .filter((keyframe) => keyframe.prop === "opacity")
    .map((keyframe) => ({
      boneId: keyframe.bone,
      prop: "opacity" as const,
      from: keyframe.from,
      to: keyframe.to,
      duration: keyframe.duration,
      delay: keyframe.delay ?? 0,
      yoyo: keyframe.yoyo ?? false,
      repeat: keyframe.repeat ?? 0,
      ease: keyframe.ease ?? "sine.inOut",
    }));

  const fallbackIntent = buildMotionIntentFromSpec({
    rig: params.rig,
    motion: params.motion,
    durationSeconds,
    motionSpec,
  });
  const rotationTracks = buildRotationTracksFromSourceClip({
    rig: params.rig,
    sourceClip: params.sourceClip,
    durationSeconds,
  });
  const intent = rotationTracks.length > 0
    ? {
        ...fallbackIntent,
        rotationTracks,
        axialWaves: [],
      }
    : fallbackIntent;

  return finalizePlayableMotionClip(params.rig, {
    view: params.sourceClip.view || motionSpec.preferredView,
    intent,
    displayKeyframes,
  }, params.sourceClip.view || motionSpec.preferredView);
}

export function resolvePlayableMotionClip(params: {
  rig: DraftsmanData;
  clipId: string;
  motionClip: RigMotionClip | undefined;
  style?: string;
  durationSeconds?: number;
}): RigMotionClip | undefined {
  const { rig, clipId, motionClip } = params;
  if (!motionClip) return undefined;
  if (motionClip.intent) {
    return finalizePlayableMotionClip(rig, motionClip, motionClip.view);
  }

  const durationSeconds = params.durationSeconds || 2;
  const motionSpec = inferMotionSpecForRig({
    motion: clipId,
    style: params.style,
    durationSeconds,
    rig,
  });

  const intent = buildMotionIntentFromSpec({
      rig,
      motion: clipId,
      durationSeconds,
      motionSpec,
    });

  return finalizePlayableMotionClip(rig, {
    ...motionClip,
    view: motionClip.view,
    intent,
    displayKeyframes: motionClip.displayKeyframes || [],
  }, motionClip.view);
}

export function motionClipToIKPlayback(
  clipId: string,
  motionClip: RigMotionClip | undefined,
): ClipBindingIKPlayback | undefined {
  if (!motionClip) return undefined;

  return {
    source_clip_id: clipId,
    view: motionClip.view,
      motion_spec: {
        motionFamily: motionClip.intent.family,
        tempo: 1,
        amplitude: 1,
        intensity: 0.5,
        blockedReasons: [],
        locomotion: {
          mode: motionClip.intent.locomotion.mode,
          preferredDirection: motionClip.intent.locomotion.direction,
        },
      contacts: motionClip.intent.contacts.map((contact) => ({
        boneId: contact.nodeId,
        target: contact.target,
        phaseStart: contact.t0,
        phaseEnd: contact.t1,
      })),
      leadBones: motionClip.intent.leadNodes,
      wholeObjectMotion: motionClip.intent.wholeObjectMotion,
      notes: motionClip.intent.notes,
    },
    motion_intent: motionClip.intent,
    sampled_root_motion: motionClip.intent.rootMotion,
  };
}
