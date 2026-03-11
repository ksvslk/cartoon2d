import { ensureRigIK } from "../ik/graph";
import { MotionSpec } from "../schema/motion_spec";
import { buildMotionTopology } from "./topology";

export type RigMotionAffordance = {
  articulationScore: number;
  deformationBudget: number;
  nodeCount: number;
  movingNodeCount: number;
  chainCount: number;
  effectors: number;
  primaryChainLength: number;
  primaryChainSpan: number;
  notes: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function inferRigMotionAffordance(
  rigInput: ReturnType<typeof ensureRigIK> | Parameters<typeof ensureRigIK>[0],
): RigMotionAffordance {
  const rig = "svg_data" in rigInput ? ensureRigIK(rigInput) : rigInput;
  const ik = rig.rig_data.ik;
  const topology = buildMotionTopology(rig);
  const nodes = ik?.nodes || [];
  const spans = nodes
    .map((node) => {
      const limit = node.rotationLimit;
      if (!limit || limit.length < 2) return 0;
      return Math.abs(limit[1] - limit[0]);
    })
    .filter((span) => Number.isFinite(span) && span > 0);
  const movingNodeCount = spans.length;
  const meanSpan = average(spans);
  const movableRatio = nodes.length > 0 ? movingNodeCount / nodes.length : 0;
  const spanRatio = clamp(meanSpan / 120, 0, 1);
  const effectors = (ik?.effectors || []).length;
  const effectorRatio = clamp(effectors / Math.max(1, nodes.length * 0.35), 0, 1);
  const primaryChainLength = topology.primaryChain?.nodeIds.length || 0;
  const primaryChainSpan = topology.primaryChain?.span || 0;
  const chainRatio = clamp((primaryChainLength - 1) / 5, 0, 1);

  let articulationScore = (movableRatio * 0.34) + (spanRatio * 0.33) + (effectorRatio * 0.17) + (chainRatio * 0.16);
  articulationScore = clamp(articulationScore, 0.08, 1);

  let deformationBudget = articulationScore;
  if (primaryChainLength <= 2) deformationBudget *= 0.72;
  if (effectors <= 1) deformationBudget *= 0.85;
  if ((topology.branchChains || []).length === 0) deformationBudget *= 0.9;
  deformationBudget = clamp(deformationBudget, 0.12, 1);

  const notes: string[] = [];
  if (deformationBudget <= 0.25) {
    notes.push("Favor root translation or simple orientation changes over distributed internal deformation.");
  } else if (deformationBudget <= 0.5) {
    notes.push("Keep deformation modest and concentrated on the dominant continuous chain.");
  } else {
    notes.push("The rig can support multi-node procedural deformation while staying bounded.");
  }
  if (primaryChainLength <= 2) {
    notes.push("No long continuous chain is available; avoid large axial waves.");
  }

  return {
    articulationScore: round2(articulationScore),
    deformationBudget: round2(deformationBudget),
    nodeCount: nodes.length,
    movingNodeCount,
    chainCount: topology.chains.length,
    effectors,
    primaryChainLength,
    primaryChainSpan: round2(primaryChainSpan),
    notes,
  };
}

export function constrainMotionSpecToRig(
  rigInput: ReturnType<typeof ensureRigIK> | Parameters<typeof ensureRigIK>[0],
  motionSpec: MotionSpec,
): MotionSpec {
  const affordance = inferRigMotionAffordance(rigInput);
  const amplitude = round2(clamp((motionSpec.amplitude || 1) * affordance.deformationBudget, 0.02, 2));
  const intensity = round2(clamp((motionSpec.intensity || 0.5) * (0.5 + (affordance.deformationBudget * 0.5)), 0, 1));
  const leadBoneLimit = affordance.deformationBudget <= 0.3 ? 2 : affordance.deformationBudget <= 0.55 ? 3 : 5;
  const contactLimit = affordance.deformationBudget <= 0.3 ? 1 : 3;

  return {
    ...motionSpec,
    amplitude,
    intensity,
    leadBones: (motionSpec.leadBones || []).slice(0, leadBoneLimit),
    contacts: (motionSpec.contacts || []).slice(0, contactLimit),
    notes: [
      motionSpec.notes,
      `Affordance constrained: articulation=${affordance.articulationScore}, deformationBudget=${affordance.deformationBudget}.`,
    ].filter(Boolean).join(" "),
  };
}
