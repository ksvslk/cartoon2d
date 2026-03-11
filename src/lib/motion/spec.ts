import { ensureRigIK } from "../ik/graph";
import { DraftsmanData } from "../schema/rig";
import { MotionSpec, MotionSpecSchema } from "../schema/motion_spec";
import { buildMotionTopology } from "./topology";

function resolveMotionFamily(motion: string): MotionSpec["motionFamily"] {
  const lower = motion.toLowerCase();
  if (/idle|stand|wait|breathe/.test(lower)) return "idle";
  if (/walk|crawl|step|march/.test(lower)) return "walk";
  if (/run|dash|sprint|charge/.test(lower)) return "run";
  if (/jump|hop|leap/.test(lower)) return "jump";
  if (/swim|dive|paddle/.test(lower)) return "swim";
  if (/glide|cruise/.test(lower)) return "glide";
  if (/drift|float/.test(lower)) return "drift";
  if (/halt|stop|freeze|brace/.test(lower)) return "halt";
  if (/crash|slam|impact|hit/.test(lower)) return "crash";
  if (/wave/.test(lower)) return "wave";
  if (/turn|pivot/.test(lower)) return "turn";
  if (/hover|fly|soar/.test(lower)) return "hover";
  if (/drive|roll/.test(lower)) return "drive";
  if (/retreat|back away|back/.test(lower)) return "retreat";
  return "custom";
}

function inferLocomotionMode(motionFamily: MotionSpec["motionFamily"]): MotionSpec["locomotion"]["mode"] {
  if (
    motionFamily === "walk" ||
    motionFamily === "run" ||
    motionFamily === "drive" ||
    motionFamily === "retreat" ||
    motionFamily === "swim" ||
    motionFamily === "glide" ||
    motionFamily === "drift" ||
    motionFamily === "hover"
  ) {
    return "translate";
  }
  if (motionFamily === "halt") return "stop_at_contact";
  if (motionFamily === "crash") return "bounce_on_contact";
  return "none";
}

function preferredDirectionForMotion(motion: string): MotionSpec["locomotion"]["preferredDirection"] {
  const lower = motion.toLowerCase();
  if (/left/.test(lower)) return "left";
  if (/right/.test(lower)) return "right";
  if (/up/.test(lower)) return "up";
  if (/down/.test(lower)) return "down";
  if (/back|retreat/.test(lower)) return "backward";
  return "forward";
}

function amplitudeForStyle(style: string): number {
  if (/subtle|gentle|soft|slow|calm|silent/.test(style)) return 0.65;
  if (/frantic|wild|aggressive|violent/.test(style)) return 1.25;
  return 0.95;
}

function intensityForStyle(style: string): number {
  if (/subtle|gentle|soft|slow|calm|silent/.test(style)) return 0.35;
  if (/frantic|wild|aggressive|violent/.test(style)) return 0.85;
  return 0.55;
}

function tempoForStyle(style: string): number {
  if (/slow|calm|gentle|subtle/.test(style)) return 0.8;
  if (/fast|quick|frantic|wild/.test(style)) return 1.3;
  return 1.0;
}

function depthOfBone(boneId: string, parentByBone: Map<string, string | undefined>): number {
  let depth = 0;
  let cursor = parentByBone.get(boneId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = parentByBone.get(cursor);
  }
  return depth;
}

function resolveBoneIdForNode(rig: DraftsmanData, nodeId: string): string | undefined {
  const ik = rig.rig_data.ik;
  if (!ik) return undefined;

  const preferredView = ik.defaultView || Object.keys(ik.views || {}).sort()[0];
  const preferredBinding = preferredView
    ? ik.views[preferredView]?.bindings.find((binding) => binding.nodeId === nodeId)
    : undefined;
  if (preferredBinding?.boneId) return preferredBinding.boneId;

  for (const view of Object.values(ik.views || {})) {
    const binding = view.bindings.find((candidate) => candidate.nodeId === nodeId);
    if (binding?.boneId) return binding.boneId;
  }

  return (ik.nodes.find((node) => node.id === nodeId)?.sourceBoneIds || [])[0];
}

export function inferMotionSpecForRig(params: {
  motion: string;
  style?: string;
  durationSeconds?: number;
  rig: DraftsmanData;
}): MotionSpec {
  const normalizedRig = ensureRigIK(params.rig);
  const topology = buildMotionTopology(normalizedRig);
  const lowerStyle = (params.style || "").toLowerCase();
  const motionFamily = resolveMotionFamily(params.motion);
  const locomotionMode = inferLocomotionMode(motionFamily);

  const parentByBone = new Map(normalizedRig.rig_data.bones.map((bone) => [bone.id, bone.parent]));
  const contacts = normalizedRig.rig_data.bones
    .filter((bone) => bone.contactRole && bone.contactRole !== "none")
    .sort((left, right) => {
      const depthDelta = depthOfBone(right.id, parentByBone) - depthOfBone(left.id, parentByBone);
      if (depthDelta !== 0) return depthDelta;
      return left.id.localeCompare(right.id);
    })
    .slice(0, 3)
    .map((bone) => ({
      boneId: bone.id,
      target: bone.contactRole === "grip" ? "wall" : bone.contactRole,
      phaseStart: 0,
      phaseEnd: 1,
    }));

  const leadNodes = Array.from(new Set([
    ...topology.rootNodeIds,
    ...(topology.primaryChain ? topology.primaryChain.nodeIds.slice(0, 2) : []),
    ...topology.branchChains.slice(0, 2).map((chain) => chain.terminalNodeId),
  ]));
  const leadBones = leadNodes
    .map((nodeId) => resolveBoneIdForNode(normalizedRig, nodeId))
    .filter((boneId): boneId is string => Boolean(boneId));

  return MotionSpecSchema.parse({
    motionFamily,
    tempo: tempoForStyle(lowerStyle),
    amplitude: amplitudeForStyle(lowerStyle),
    intensity: intensityForStyle(lowerStyle),
    preferredView: normalizedRig.rig_data.ik?.defaultView || Object.keys(normalizedRig.rig_data.ik?.views || {}).sort()[0],
    locomotion: {
      mode: locomotionMode,
      preferredDirection: preferredDirectionForMotion(params.motion),
    },
    contacts,
    leadBones,
    blockedReasons: [],
    notes: `Locally inferred topology-driven motion spec for ${params.motion}.`,
  });
}
