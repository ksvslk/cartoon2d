import {
  RigBoneSide,
  RigIKArchetype,
  RigIKConstraint,
  RigIKData,
  RigIKNode,
  RigIKView,
  RigIKViewBinding,
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

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function resolveAttachmentPoint(binding?: RigIKViewBinding): Point | undefined {
  if (binding?.socket) {
    return { x: binding.socket.x, y: binding.socket.y };
  }
  if (binding?.pivot) {
    return { x: binding.pivot.x, y: binding.pivot.y };
  }
  return undefined;
}

export function inferIKArchetype(nodes: RigIKNode[]): RigIKArchetype {
  return nodes.length > 0 ? "custom" : "prop";
}

function signedAngle(a: Point, pivot: Point, b: Point): number {
  const va = { x: a.x - pivot.x, y: a.y - pivot.y };
  const vb = { x: b.x - pivot.x, y: b.y - pivot.y };
  const cross = va.x * vb.y - va.y * vb.x;
  const dot = va.x * vb.x + va.y * vb.y;
  return normalizeDegrees((Math.atan2(cross, dot) * 180) / Math.PI);
}

function sideSign(side?: RigBoneSide): number {
  if (side === "left") return -1;
  if (side === "right") return 1;
  return 0;
}

function structuralChildPriority(
  child: RigIKNode,
  childIdsByNode: Map<string, string[]>,
): number {
  const childCount = childIdsByNode.get(child.id)?.length || 0;
  const contactBonus = child.contactRole && child.contactRole !== "none" ? 20 : 0;
  const massBonus = child.massClass === "light" ? 8 : child.massClass === "medium" ? 4 : 0;
  const lengthBonus = child.restLength ? clamp(child.restLength / 20, 0, 12) : 0;
  return contactBonus + massBonus + lengthBonus + (childCount === 0 ? 6 : 0);
}

function prefersDirectionalClamp(
  node: RigIKNode,
  childCount: number,
  preferredBend: number | undefined,
): boolean {
  return Boolean(node.parent)
    && childCount === 1
    && (!node.contactRole || node.contactRole === "none")
    && typeof preferredBend === "number"
    && Math.abs(preferredBend) >= 18;
}

function defaultRotationSpan(node: RigIKNode, childCount: number): number {
  let span = !node.parent
    ? 36
    : childCount === 0
      ? 88
      : childCount === 1
        ? 128
        : 84;

  if (node.contactRole && node.contactRole !== "none") span *= 0.78;
  if (node.massClass === "heavy") span *= 0.72;
  else if (node.massClass === "medium") span *= 0.88;
  if (typeof node.restLength === "number" && node.restLength > 0) {
    span *= clamp(0.8 + (node.restLength / 240), 0.85, 1.3);
  }

  return round2(clamp(span, 28, 170));
}

function templateRotationLimit(
  node: RigIKNode,
  preferredBend: number | undefined,
  childIdsByNode: Map<string, string[]>,
): [number, number] {
  const childCount = childIdsByNode.get(node.id)?.length || 0;
  const span = defaultRotationSpan(node, childCount);

  if (prefersDirectionalClamp(node, childCount, preferredBend)) {
    const slack = round2(Math.max(18, span * 0.22));
    return (preferredBend || 0) < 0 ? [-span, slack] : [-slack, span];
  }

  const half = round2(span * 0.5);
  return [-half, half];
}

function tightenRotationLimit(
  node: RigIKNode,
  preferredBend: number | undefined,
  childIdsByNode: Map<string, string[]>,
): { rotationLimit?: [number, number]; changed: boolean } {
  const template = templateRotationLimit(node, preferredBend, childIdsByNode);

  if (!node.rotationLimit) {
    return { rotationLimit: template, changed: true };
  }

  const existing = node.rotationLimit as [number, number];
  const span = existing[1] - existing[0];
  const childCount = childIdsByNode.get(node.id)?.length || 0;

  if (prefersDirectionalClamp(node, childCount, preferredBend)) {
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
      const delta = structuralChildPriority(right, childIdsByNode) - structuralChildPriority(left, childIdsByNode);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    })[0];

  if (!child) {
    return 0;
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

  const magnitude = Math.min(24, Math.max(8, (node.restLength || 40) * 0.18));
  if (magnitude === 0) return 0;
  return round2(sideSign(node.side) * magnitude);
}

function warningForTopology(
  nodes: RigIKNode[],
  childIdsByNode: Map<string, string[]>,
  effectorCount: number,
): string[] {
  const warnings: string[] = [];
  const branchCount = nodes.filter((node) => (childIdsByNode.get(node.id)?.length || 0) > 1).length;
  const terminalCount = nodes.filter((node) => (childIdsByNode.get(node.id)?.length || 0) === 0).length;
  const rootIds = nodes.filter((node) => !node.parent).map((node) => node.id);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const depthOf = (nodeId: string): number => {
    let depth = 0;
    let cursor = nodeMap.get(nodeId);
    const seen = new Set<string>();
    while (cursor?.parent && !seen.has(cursor.parent)) {
      seen.add(cursor.parent);
      depth += 1;
      cursor = nodeMap.get(cursor.parent);
    }
    return depth;
  };

  const longestChainLength = nodes.reduce((max, node) => Math.max(max, depthOf(node.id) + 1), 0);
  if (nodes.length > 3 && longestChainLength < 3) {
    warnings.push("Dominant continuous chains are short; smoother motion may require longer parent-child sequences.");
  }
  if (branchCount > 0 && terminalCount <= 1) {
    warnings.push("Branching structure has few terminal controls; secondary motion coverage may be weak.");
  }
  if (terminalCount > 0 && effectorCount === 0) {
    warnings.push("Terminal chains have no explicit effectors; interaction stability will be weak.");
  }
  if (rootIds.length > 1) {
    warnings.push("Multiple structural roots remain after analysis; connected objects should converge to a single root when possible.");
  }
  return warnings;
}

function warningForAttachmentIntegrity(ik: RigIKData, nodes: RigIKNode[]): string[] {
  const warnings: string[] = [];
  const defaultView = ik.defaultView || Object.keys(ik.views).sort()[0];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const detachedRoots = nodes
    .filter((node) => !node.parent || !nodeMap.has(node.parent))
    .map((node) => node.id)
    .sort();

  if (detachedRoots.length > 1) {
    warnings.push(`Rig resolves to ${detachedRoots.length} detached structural islands; connected objects should share a single root.`);
  }

  if (!defaultView || !ik.views[defaultView]) {
    return warnings;
  }

  const bindingByNode = new Map(ik.views[defaultView].bindings.map((binding) => [binding.nodeId, binding]));
  nodes.forEach((node) => {
    if (!node.parent || !nodeMap.has(node.parent)) return;
    if (node.ikRole === "decorative") return;

    const childBinding = bindingByNode.get(node.id);
    const parentBinding = bindingByNode.get(node.parent);
    if (!childBinding || !parentBinding) return;

    if (!childBinding.socket && !parentBinding.socket) {
      warnings.push(`${node.id} has no explicit attachment socket in ${defaultView}; connected parts should declare how they attach.`);
      return;
    }

    const childAttachment = resolveAttachmentPoint(childBinding);
    const parentAttachment = resolveAttachmentPoint(parentBinding);
    if (!childAttachment || !parentAttachment) return;

    const attachmentGap = distance(parentAttachment, childAttachment);
    const tolerance = Math.max(14, Math.min(32, (node.restLength || 0) * 0.18 || 18));
    if (attachmentGap > tolerance) {
      warnings.push(`${node.id} attachment gap in ${defaultView} is ${attachmentGap.toFixed(1)}px from parent ${node.parent}.`);
    }
  });

  return warnings;
}

export function analyzeDerivedIK(ik: RigIKData): RigIKData {
  const archetype = inferIKArchetype(ik.nodes);
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
    const tightened = tightenRotationLimit(node, preferredBend, childIdsByNode);

    if (tightened.changed) {
      suggestedFixes.push(`Review ${node.id}: rotation limits were tightened to keep the local range stable.`);
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
    suggestedFixes.push("Add explicit terminal effectors so the lab can solve meaningful chains.");
  }

  enhancedNodes.forEach((node) => {
    const childCount = childIdsByNode.get(node.id)?.length || 0;
    if (node.parent && childCount === 1 && typeof node.preferredBend !== "number") {
      warnings.push(`${node.id} is missing a preferred bend direction.`);
    }

    if (defaultView && !ik.views[defaultView]?.bindings.some((binding) => binding.nodeId === node.id)) {
      warnings.push(`${node.id} is missing a binding in ${defaultView}.`);
    }
  });

  warnings.push(...warningForTopology(enhancedNodes, childIdsByNode, ik.effectors.length));
  warnings.push(...warningForAttachmentIntegrity(ik, enhancedNodes));

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
