import {
  RigBoneKind,
  RigBoneSide,
  RigIKArchetype,
  RigIKConstraint,
  RigIKData,
  RigIKNode,
  RigIKView,
} from "../schema/rig";

type Point = { x: number; y: number };

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDegrees(value: number): number {
  let next = value;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return round2(next);
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function inferIKArchetype(nodes: RigIKNode[]): RigIKArchetype {
  const byKind = new Map<RigBoneKind, number>();
  nodes.forEach((node) => {
    if (!node.kind) return;
    byKind.set(node.kind, (byKind.get(node.kind) || 0) + 1);
  });

  const legCount = (byKind.get("leg_upper") || 0) + (byKind.get("leg_lower") || 0) + (byKind.get("foot") || 0);
  const armCount = (byKind.get("arm_upper") || 0) + (byKind.get("arm_lower") || 0) + (byKind.get("hand") || 0);
  const wingCount = byKind.get("wing") || 0;
  const finCount = byKind.get("fin") || 0;
  const tailCount = (byKind.get("tail_base") || 0) + (byKind.get("tail_mid") || 0) + (byKind.get("tail_tip") || 0);

  if (wingCount > 0) return "bird";
  if (finCount > 0 && tailCount > 0) return "fish";
  if (tailCount >= 2 && legCount === 0 && armCount === 0) return "serpent";
  if (legCount >= 4) return "quadruped";
  if (legCount >= 2 && (armCount >= 2 || (byKind.get("head") || 0) > 0)) return "biped";
  return "prop";
}

function structuralChildPriority(parentKind?: RigBoneKind, childKind?: RigBoneKind): number {
  if (!parentKind || !childKind) return 0;

  if (parentKind === "arm_upper") {
    if (childKind === "arm_lower") return 10;
    if (childKind === "hand") return 8;
  }

  if (parentKind === "arm_lower") {
    if (childKind === "hand") return 10;
  }

  if (parentKind === "leg_upper") {
    if (childKind === "leg_lower") return 10;
    if (childKind === "foot") return 8;
  }

  if (parentKind === "leg_lower") {
    if (childKind === "foot") return 10;
  }

  if (parentKind === "neck") {
    if (childKind === "head") return 10;
    if (childKind === "jaw") return 6;
  }

  if (parentKind === "head" && childKind === "jaw") return 10;
  if (parentKind === "tail_base" && childKind === "tail_mid") return 10;
  if (parentKind === "tail_base" && childKind === "tail_tip") return 8;
  if (parentKind === "tail_mid" && childKind === "tail_tip") return 10;

  if (parentKind === "torso" || parentKind === "body" || parentKind === "root") {
    if (childKind === "neck") return 8;
    if (childKind === "head") return 6;
    if (childKind === "tail_base") return 6;
  }

  return 1;
}

function signedAngle(a: Point, pivot: Point, b: Point): number {
  const va = { x: a.x - pivot.x, y: a.y - pivot.y };
  const vb = { x: b.x - pivot.x, y: b.y - pivot.y };
  const cross = va.x * vb.y - va.y * vb.x;
  const dot = va.x * vb.x + va.y * vb.y;
  return normalizeDegrees((Math.atan2(cross, dot) * 180) / Math.PI);
}

function sideSign(nodeId: string, side?: RigBoneSide): number {
  if (side === "left") return -1;
  if (side === "right") return 1;
  return /left/.test(nodeId) ? -1 : /right/.test(nodeId) ? 1 : 1;
}

function preferOneSidedHinge(kind?: RigBoneKind): boolean {
  return kind === "arm_lower" || kind === "leg_lower";
}

function defaultPreferredMagnitude(kind?: RigBoneKind): number {
  if (kind === "leg_lower") return 58;
  if (kind === "arm_lower") return 42;
  if (kind === "tail_base") return 10;
  if (kind === "tail_mid") return 14;
  if (kind === "tail_tip") return 18;
  return 0;
}

function templateRotationLimit(kind: RigBoneKind | undefined, preferredBend: number | undefined): [number, number] | undefined {
  if (!kind) return undefined;

  if (kind === "root" || kind === "torso" || kind === "body") return [-18, 18];
  if (kind === "neck") return [-25, 25];
  if (kind === "head") return [-28, 28];
  if (kind === "jaw") return [0, 30];
  if (kind === "arm_upper") return [-80, 80];
  if (kind === "hand") return [-35, 35];
  if (kind === "leg_upper") return [-70, 70];
  if (kind === "foot") return [-32, 32];
  if (kind === "tail_base") return [-40, 40];
  if (kind === "tail_mid") return [-48, 48];
  if (kind === "tail_tip") return [-60, 60];
  if (kind === "fin") return [-60, 60];
  if (kind === "wing") return [-88, 88];

  if (preferOneSidedHinge(kind)) {
    const sign = (preferredBend ?? 0) < 0 ? -1 : 1;
    return sign < 0 ? [-150, 0] : [0, 150];
  }

  return [-45, 45];
}

function tightenRotationLimit(
  node: RigIKNode,
  preferredBend: number | undefined,
): { rotationLimit?: [number, number]; changed: boolean } {
  const template = templateRotationLimit(node.kind, preferredBend);
  if (!template) {
    return { rotationLimit: node.rotationLimit as [number, number] | undefined, changed: false };
  }

  if (!node.rotationLimit) {
    return { rotationLimit: template, changed: true };
  }

  const existing = node.rotationLimit as [number, number];
  const span = existing[1] - existing[0];

  if (preferOneSidedHinge(node.kind)) {
    const crossesZero = existing[0] < 0 && existing[1] > 0;
    if (crossesZero || span > 165) {
      return { rotationLimit: template, changed: true };
    }
    return { rotationLimit: existing, changed: false };
  }

  if (span > 220) {
    return { rotationLimit: template, changed: true };
  }

  return { rotationLimit: existing, changed: false };
}

function inferPreferredBend(
  node: RigIKNode,
  childIdsByNode: Map<string, string[]>,
  nodeMap: Map<string, RigIKNode>,
  views: Record<string, RigIKView>,
): number | undefined {
  if (typeof node.preferredBend === "number" && Math.abs(node.preferredBend) > 0.5) {
    return round2(node.preferredBend);
  }

  if (!node.parent) {
    return 0;
  }

  const childIds = childIdsByNode.get(node.id) || [];
  const child = childIds
    .map((childId) => nodeMap.get(childId))
    .filter((candidate): candidate is RigIKNode => Boolean(candidate))
    .sort((left, right) => {
      const delta = structuralChildPriority(node.kind, right.kind) - structuralChildPriority(node.kind, left.kind);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    })[0];

  if (!child) {
    return node.kind === "tail_tip" ? defaultPreferredMagnitude(node.kind) * sideSign(node.id, node.side) : 0;
  }

  const signedAngles = Object.values(views).flatMap((view) => {
    const bindings = new Map(view.bindings.map((binding) => [binding.nodeId, binding]));
    const parent = bindings.get(node.parent || "");
    const current = bindings.get(node.id);
    const childBinding = bindings.get(child.id);
    if (!parent?.pivot || !current?.pivot || !childBinding?.pivot) return [];
    return [signedAngle(parent.pivot, current.pivot, childBinding.pivot)];
  });

  const meaningful = signedAngles.filter((value) => Math.abs(value) > 4);
  if (meaningful.length > 0) {
    return round2(average(meaningful) || 0);
  }

  const magnitude = defaultPreferredMagnitude(node.kind);
  if (magnitude === 0) return 0;
  return round2(sideSign(node.id, node.side) * magnitude);
}

function warningForTopology(nodes: RigIKNode[]): string[] {
  const byKind = new Map<RigBoneKind, number>();
  nodes.forEach((node) => {
    if (!node.kind) return;
    byKind.set(node.kind, (byKind.get(node.kind) || 0) + 1);
  });

  const warnings: string[] = [];
  const axialCount = (byKind.get("tail_base") || 0) + (byKind.get("tail_mid") || 0) + (byKind.get("tail_tip") || 0);
  const wingCount = byKind.get("wing") || 0;
  const finCount = byKind.get("fin") || 0;
  const upperLimbCount = (byKind.get("arm_upper") || 0) + (byKind.get("leg_upper") || 0);
  const endEffectorCount = (byKind.get("hand") || 0) + (byKind.get("foot") || 0);

  if (axialCount > 0 && axialCount < 3) {
    warnings.push("Axial control chain is short; add more joints for smoother motion.");
  }
  if (wingCount === 1 || finCount === 1) {
    warnings.push("One major appendage chain appears unpaired; check symmetry and view coverage.");
  }
  if (upperLimbCount >= 2 && endEffectorCount === 0) {
    warnings.push("Major limb chains are missing end effectors; contact stability will be weak.");
  }
  return warnings;
}

export function analyzeDerivedIK(ik: RigIKData): RigIKData {
  const archetype = ik.archetype !== "custom" ? ik.archetype : inferIKArchetype(ik.nodes);
  const nodeMap = new Map(ik.nodes.map((node) => [node.id, node]));
  const childIdsByNode = new Map<string, string[]>();
  ik.nodes.forEach((node) => {
    if (!node.parent) return;
    const list = childIdsByNode.get(node.parent) || [];
    list.push(node.id);
    childIdsByNode.set(node.parent, list);
  });

  const warnings: string[] = [];
  const suggestedFixes: string[] = [];

  const enhancedNodes = ik.nodes.map((node) => {
    const preferredBend = inferPreferredBend(node, childIdsByNode, nodeMap, ik.views);
    const tightened = tightenRotationLimit(node, preferredBend);

    if (tightened.changed && preferOneSidedHinge(node.kind)) {
      suggestedFixes.push(`Review ${node.id}: hinge limits were tightened to keep it bending one way.`);
    }

    if (!node.sourceBoneIds?.length) {
      warnings.push(`${node.id} has no source bone bindings.`);
    }

    return {
      ...node,
      preferredBend,
      rotationLimit: tightened.rotationLimit,
    } satisfies RigIKNode;
  });

  const defaultView = ik.defaultView || Object.keys(ik.views).sort()[0];
  if (!defaultView) {
    warnings.push("Rig has no default drawable view.");
  }

  if (ik.effectors.length === 0) {
    warnings.push("Rig has no draggable effectors.");
    suggestedFixes.push("Add hand, foot, head, tail, fin, or wing effectors so the lab can solve meaningful chains.");
  }

  enhancedNodes.forEach((node) => {
    if ((node.kind === "arm_lower" || node.kind === "leg_lower") && typeof node.preferredBend !== "number") {
      warnings.push(`${node.id} is missing a preferred bend direction.`);
    }

    if (defaultView && !ik.views[defaultView]?.bindings.some((binding) => binding.nodeId === node.id)) {
      warnings.push(`${node.id} is missing a binding in ${defaultView}.`);
    }
  });

  warnings.push(...warningForTopology(enhancedNodes));

  const nonAngleConstraints = ik.constraints.filter((constraint) => constraint.type !== "angle_limit");
  const angleConstraints: RigIKConstraint[] = enhancedNodes
    .filter((node) => node.rotationLimit)
    .map((node) => ({
      type: "angle_limit",
      nodeId: node.id,
      min: node.rotationLimit![0],
      max: node.rotationLimit![1],
      preferred: node.preferredBend,
    }));

  const confidencePenalty =
    (unique(warnings).length * 0.08) +
    (unique(suggestedFixes).length * 0.03) +
    Math.max(0, 0.12 - (ik.effectors.length * 0.02));

  return {
    ...ik,
    archetype,
    nodes: enhancedNodes,
    constraints: [...nonAngleConstraints, ...angleConstraints],
    aiReport: {
      confidence: clamp(round2(1 - confidencePenalty), 0.2, 0.98),
      warnings: unique(warnings).slice(0, 10),
      suggestedFixes: unique(suggestedFixes).slice(0, 10),
    },
  };
}
