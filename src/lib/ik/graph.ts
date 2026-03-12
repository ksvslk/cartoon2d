import {
  DraftsmanData,
  RigBone,
  RigBoneContactRole,
  RigBoneIKRole,
  RigBoneKind,
  RigBoneMassClass,
  RigBoneSide,
  RigData,
  RigIKArchetype,
  RigIKChain,
  RigIKConstraint,
  RigIKData,
  RigIKEffector,
  RigIKEffectorRole,
  RigIKNode,
  RigIKView,
  RigIKViewBinding,
} from "../schema/rig";
import { analyzeDerivedIK, inferIKArchetype } from "./analyze";
import { matchLegacyViewPrefix, normalizeViewId } from "./view_ids";

export type Point = { x: number; y: number };

export interface PoseGraphNode {
  id: string;
  parentId?: string;
  childIds: string[];
  kind?: RigBoneKind;
  side?: RigBoneSide;
  ikRole?: RigBoneIKRole;
  restLength?: number;
  restRotation: number;
  rotationLimit?: [number, number];
  preferredBend?: number;
  massClass?: RigBoneMassClass;
  contactRole?: RigBoneContactRole;
  sourceBoneIds: string[];
  bindings: Record<string, RigIKViewBinding>;
  activeBinding?: RigIKViewBinding;
  restWorld: Point;
  world: Point;
}

export interface PoseGraph {
  version: 1;
  archetype: RigIKArchetype;
  defaultView?: string;
  activeView?: string;
  roots: string[];
  nodes: PoseGraphNode[];
  nodeMap: Map<string, PoseGraphNode>;
  chains: RigIKChain[];
  constraints: RigIKConstraint[];
  effectors: RigIKEffector[];
  views: Record<string, RigIKView>;
}

type LegacyBoneInfo = {
  bone: RigBone;
  canonicalId: string;
  canonicalParentId?: string;
  viewId: string;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageAngle(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce(
    (acc, value) => {
      const radians = (value * Math.PI) / 180;
      return {
        x: acc.x + Math.cos(radians),
        y: acc.y + Math.sin(radians),
      };
    },
    { x: 0, y: 0 },
  );
  if (Math.abs(sum.x) < 1e-6 && Math.abs(sum.y) < 1e-6) return undefined;
  return round2((Math.atan2(sum.y, sum.x) * 180) / Math.PI);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function angleBetween(a: Point, b: Point): number {
  return round2((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
}

function inferViewIdFromBoneId(boneId: string): string {
  const lower = boneId.toLowerCase();
  const genericPrefix = lower.match(/^([a-z0-9_]+)__/);
  if (genericPrefix) {
    return normalizeViewId(`view_${genericPrefix[1]}`) || "view_default";
  }
  const match = matchLegacyViewPrefix(lower);
  if (match?.viewId) return match.viewId;
  return "view_default";
}

function stripViewPrefix(boneId: string): string {
  const lower = boneId.toLowerCase();
  const genericPrefix = lower.match(/^([a-z0-9_]+)__(.+)$/);
  if (genericPrefix?.[2]) return genericPrefix[2];
  const match = matchLegacyViewPrefix(lower);
  if (match) return boneId.slice(match.prefix.length);
  return genericPrefix?.[2] || boneId;
}

function normalizeCanonicalStem(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|_)rear(?=_|$)/g, "$1left")
    .replace(/(^|_)fore(?=_|$)/g, "$1right")
    .replace(/(^|_)r(?=_|$)/g, "$1right")
    .replace(/(^|_)l(?=_|$)/g, "$1left")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function canonicalNodeIdForBone(bone: RigBone): string {
  const stripped = stripViewPrefix(bone.id);
  const normalized = normalizeCanonicalStem(stripped);
  return normalized || bone.id.toLowerCase();
}

function pickMostCommon<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, { value: T; count: number }>();
  values.forEach((value) => {
    const key = JSON.stringify(value);
    const current = counts.get(key);
    counts.set(key, { value, count: (current?.count || 0) + 1 });
  });
  return Array.from(counts.values())
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return JSON.stringify(left.value).localeCompare(JSON.stringify(right.value));
    })[0]?.value;
}

function pickMostCommonDefined<T>(values: Array<T | undefined>): T | undefined {
  return pickMostCommon(values.filter((value): value is T => value !== undefined));
}

function pickPreferredContactRole(values: Array<RigBoneContactRole | undefined>): RigBoneContactRole | undefined {
  const nonNone = values.filter((value): value is RigBoneContactRole => Boolean(value) && value !== "none");
  return pickMostCommon(nonNone) || pickMostCommonDefined(values);
}

function pickDefaultView(viewIds: string[]): string | undefined {
  const preferredOrder = [
    "view_3q_right",
    "view_3q_left",
    "view_side_right",
    "view_side_left",
    "view_front",
    "view_top",
    "view_back",
    "view_default",
  ];
  return preferredOrder.find((viewId) => viewIds.includes(viewId)) || [...viewIds].sort()[0];
}

function inferIKRole(params: {
  existing?: RigBoneIKRole;
  parentId?: string;
  childCount: number;
}): RigBoneIKRole {
  if (params.existing) return params.existing;
  if (!params.parentId) return "root";
  if (params.childCount === 0) {
    return "effector";
  }
  return "joint";
}

function findBindingPivot(binding?: RigIKViewBinding): Point | undefined {
  if (!binding?.pivot) return undefined;
  return { x: binding.pivot.x, y: binding.pivot.y };
}

function sortNodeIdsByDepth(nodes: RigIKNode[]): string[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const depthCache = new Map<string, number>();

  const depthOf = (nodeId: string, seen = new Set<string>()): number => {
    if (depthCache.has(nodeId)) return depthCache.get(nodeId)!;
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const parentId = nodeMap.get(nodeId)?.parent;
    const depth = parentId ? 1 + depthOf(parentId, seen) : 0;
    depthCache.set(nodeId, depth);
    return depth;
  };

  return [...nodeMap.keys()].sort((left, right) => {
    const depthDelta = depthOf(left) - depthOf(right);
    return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
  });
}

function buildChains(effectors: RigIKEffector[], nodeMap: Map<string, RigIKNode>): RigIKChain[] {
  return effectors
    .map((effector) => {
      const path: string[] = [];
      let cursor = nodeMap.get(effector.nodeId);
      const seen = new Set<string>();

      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        path.push(cursor.id);
        cursor = cursor.parent ? nodeMap.get(cursor.parent) : undefined;
      }

      const nodeIds = path.reverse();
      if (nodeIds.length < 2) return null;

      const terminalNode = nodeMap.get(effector.nodeId);
      const contactBonus = terminalNode?.contactRole && terminalNode.contactRole !== "none" ? 36 : 0;
      const massBonus = terminalNode?.massClass === "light" ? 12 : terminalNode?.massClass === "medium" ? 6 : 0;
      const depthBonus = Math.min(32, Math.max(0, nodeIds.length - 1) * 8);
      const priority = 40 + contactBonus + massBonus + depthBonus;

      return {
        id: `chain_${effector.nodeId}`,
        nodeIds,
        effectorId: effector.nodeId,
        priority,
      } satisfies RigIKChain;
    })
    .filter((chain): chain is RigIKChain => Boolean(chain));
}

export function deriveIKFromRigData(rigData: RigData): RigIKData {
  const boneInfos = rigData.bones
    .map((bone) => {
      const canonicalId = canonicalNodeIdForBone(bone);
      const canonicalParentId = bone.parent
        ? canonicalNodeIdForBone({ ...bone, id: bone.parent })
        : undefined;

      return {
        bone,
        canonicalId,
        canonicalParentId: canonicalParentId === canonicalId ? undefined : canonicalParentId,
        viewId: inferViewIdFromBoneId(bone.id),
      } satisfies LegacyBoneInfo;
    })
    .sort((left, right) => {
      const canonicalDelta = left.canonicalId.localeCompare(right.canonicalId);
      if (canonicalDelta !== 0) return canonicalDelta;
      const viewDelta = left.viewId.localeCompare(right.viewId);
      if (viewDelta !== 0) return viewDelta;
      return left.bone.id.localeCompare(right.bone.id);
    });

  const infosByCanonicalId = new Map<string, LegacyBoneInfo[]>();
  const viewBindings = new Map<string, RigIKViewBinding[]>();

  boneInfos.forEach((info) => {
    const group = infosByCanonicalId.get(info.canonicalId) || [];
    group.push(info);
    infosByCanonicalId.set(info.canonicalId, group);

    const bindings = viewBindings.get(info.viewId) || [];
    bindings.push({
      nodeId: info.canonicalId,
      boneId: info.bone.id,
      pivot: info.bone.pivot,
      socket: info.bone.socket,
    });
    viewBindings.set(info.viewId, bindings);
  });

  const preliminaryNodes = Array.from(infosByCanonicalId.entries())
    .map(([nodeId, infos]) => {
      const sourceBoneIds = infos.map((info) => info.bone.id);
      const parent = pickMostCommonDefined(infos.map((info) => info.canonicalParentId));
      const kind = pickMostCommonDefined(infos.map((info) => info.bone.kind));
      const side = pickMostCommonDefined(infos.map((info) => info.bone.side));
      const rotationLimit = pickMostCommonDefined(infos.map((info) => info.bone.rotationLimit as [number, number] | undefined));
      const massClass = pickMostCommonDefined(infos.map((info) => info.bone.massClass));
      const contactRole = pickPreferredContactRole(infos.map((info) => info.bone.contactRole));

      return {
        id: nodeId,
        parent,
        kind,
        side,
        ikRole: pickMostCommonDefined(infos.map((info) => info.bone.ikRole)),
        restLength: average(infos.map((info) => info.bone.length).filter((value): value is number => typeof value === "number")),
        restRotation: averageAngle(infos.map((info) => info.bone.restRotation).filter((value): value is number => typeof value === "number")),
        rotationLimit,
        preferredBend: rotationLimit ? round2((rotationLimit[0] + rotationLimit[1]) / 2) : undefined,
        contactRole,
        massClass,
        sourceBoneIds,
      } satisfies RigIKNode;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const childIdsByNode = new Map<string, string[]>();
  preliminaryNodes.forEach((node) => {
    if (!node.parent) return;
    const list = childIdsByNode.get(node.parent) || [];
    list.push(node.id);
    childIdsByNode.set(node.parent, list);
  });

  const nodes = preliminaryNodes.map((node) => {
    const infos = infosByCanonicalId.get(node.id) || [];
    const parentInfos = node.parent ? infosByCanonicalId.get(node.parent) || [] : [];
    const sharedDistances = infos.flatMap((info) => {
      const parentInfo = parentInfos.find((candidate) => candidate.viewId === info.viewId);
      if (!info.bone.pivot || !parentInfo?.bone.pivot) return [];
      return [distance(parentInfo.bone.pivot, info.bone.pivot)];
    });
    const sharedAngles = infos.flatMap((info) => {
      const parentInfo = parentInfos.find((candidate) => candidate.viewId === info.viewId);
      if (!info.bone.pivot || !parentInfo?.bone.pivot) return [];
      return [angleBetween(parentInfo.bone.pivot, info.bone.pivot)];
    });

    const childCount = childIdsByNode.get(node.id)?.length || 0;

    return {
      ...node,
      restLength: round2(average(sharedDistances) ?? node.restLength ?? 0),
      restRotation: round2(averageAngle(sharedAngles) ?? node.restRotation ?? 0),
      ikRole: inferIKRole({
        existing: node.ikRole,
        parentId: node.parent,
        childCount,
      }),
    } satisfies RigIKNode;
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes.filter((node) => !node.parent || !nodeMap.has(node.parent)).map((node) => node.id);

  const effectors = nodes
    .filter((node) => node.ikRole === "effector")
    .map((node) => ({
      nodeId: node.id,
      role: "custom" as RigIKEffectorRole,
      draggable: true,
    }) satisfies RigIKEffector)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  const defaultView = pickDefaultView(Array.from(viewBindings.keys()));
  const defaultBindings = viewBindings.get(defaultView || "") || [];
  const defaultBindingMap = new Map(defaultBindings.map((binding) => [binding.nodeId, binding]));

  const constraints: RigIKConstraint[] = [];
  nodes.forEach((node) => {
    if (node.parent && node.restLength && node.restLength > 0) {
      constraints.push({
        type: "length",
        nodeId: node.id,
        value: round2(node.restLength),
        stiffness: 1,
      });
    }

    if (node.rotationLimit) {
      constraints.push({
        type: "angle_limit",
        nodeId: node.id,
        min: node.rotationLimit[0],
        max: node.rotationLimit[1],
        preferred: node.preferredBend,
      });
    }

    if (!node.parent) {
      const rootBinding = defaultBindingMap.get(node.id);
      if (rootBinding?.pivot) {
        constraints.push({
          type: "pin",
          nodeId: node.id,
          enabled: true,
          x: rootBinding.pivot.x,
          y: rootBinding.pivot.y,
          stiffness: 1,
        });
      }
    }

    if (node.contactRole === "ground" || node.contactRole === "wall" || node.contactRole === "water") {
      constraints.push({
        type: "contact",
        nodeId: node.id,
        medium: node.contactRole,
        enabled: false,
      });
    }
  });

  const views = Array.from(viewBindings.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .reduce<Record<string, RigIKView>>((acc, [viewId, bindings]) => {
      acc[viewId] = {
        bindings: [...bindings].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      };
      return acc;
    }, {});

  return analyzeDerivedIK({
    version: 1,
    archetype: inferIKArchetype(nodes),
    defaultView,
    roots,
    nodes,
    chains: buildChains(effectors, nodeMap),
    constraints,
    effectors,
    views,
  });
}

export function ensureRigIK(data: DraftsmanData): DraftsmanData {
  if (data.rig_data.ik?.nodes?.length) {
    const needsAnalysis =
      !data.rig_data.ik.aiReport ||
      data.rig_data.ik.nodes.some((node) => node.rotationLimit === undefined || node.preferredBend === undefined) ||
      !data.rig_data.ik.constraints.some((constraint) => constraint.type === "angle_limit");

    if (!needsAnalysis) return data;

    return {
      ...data,
      rig_data: {
        ...data.rig_data,
        ik: analyzeDerivedIK(data.rig_data.ik),
      },
    };
  }
  return {
    ...data,
    rig_data: {
      ...data.rig_data,
      ik: deriveIKFromRigData(data.rig_data),
    },
  };
}

export function buildPoseGraph(data: DraftsmanData, requestedView?: string): PoseGraph {
  const normalized = ensureRigIK(data);
  const ik = normalized.rig_data.ik!;
  const activeView = requestedView && ik.views[requestedView]
    ? requestedView
    : ik.defaultView && ik.views[ik.defaultView]
      ? ik.defaultView
      : Object.keys(ik.views).sort()[0];
  // Preserve the authored canonical graph instead of silently welding detached islands.
  const runtimeNodes = ik.nodes;

  const runtimeRootIds = runtimeNodes
    .filter((node) => !node.parent || !runtimeNodes.some((candidate) => candidate.id === node.parent))
    .map((node) => node.id);

  const bindingMaps = Object.entries(ik.views).reduce<Record<string, Map<string, RigIKViewBinding>>>((acc, [viewId, view]) => {
    acc[viewId] = new Map(view.bindings.map((binding) => [binding.nodeId, binding]));
    return acc;
  }, {});

  const topologicalNodeIds = sortNodeIdsByDepth(runtimeNodes);
  const runtimeNodeMap = new Map<string, PoseGraphNode>();

  topologicalNodeIds.forEach((nodeId) => {
    const node = runtimeNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;

    const bindings = Object.entries(bindingMaps).reduce<Record<string, RigIKViewBinding>>((acc, [viewId, map]) => {
      const binding = map.get(node.id);
      if (binding) acc[viewId] = binding;
      return acc;
    }, {});

    const activeBinding = activeView ? bindings[activeView] : undefined;
    const fallbackBinding = activeBinding || Object.values(bindings).sort((left, right) => left.boneId.localeCompare(right.boneId))[0];
    const parent = node.parent ? runtimeNodeMap.get(node.parent) : undefined;
    const directRestWorld = findBindingPivot(fallbackBinding);
    const restRotation = node.restRotation ?? 0;
    const restWorld = directRestWorld || (
      parent && typeof node.restLength === "number"
        ? {
            x: round2(parent.restWorld.x + Math.cos((restRotation * Math.PI) / 180) * node.restLength),
            y: round2(parent.restWorld.y + Math.sin((restRotation * Math.PI) / 180) * node.restLength),
          }
        : { x: 0, y: 0 }
    );

    runtimeNodeMap.set(node.id, {
      id: node.id,
      parentId: node.parent,
      childIds: [],
      kind: node.kind,
      side: node.side,
      ikRole: node.ikRole,
      restLength: node.restLength,
      restRotation,
      rotationLimit: node.rotationLimit as [number, number] | undefined,
      preferredBend: node.preferredBend,
      massClass: node.massClass,
      contactRole: node.contactRole,
      sourceBoneIds: node.sourceBoneIds || [],
      bindings,
      activeBinding: fallbackBinding,
      restWorld,
      world: { ...restWorld },
    });
  });

  runtimeNodeMap.forEach((node) => {
    if (!node.parentId) return;
    const parent = runtimeNodeMap.get(node.parentId);
    if (!parent) return;
    parent.childIds.push(node.id);
  });

  const nodes = Array.from(runtimeNodeMap.values()).sort((left, right) => left.id.localeCompare(right.id));
  const runtimeConstraints = ik.constraints.filter((constraint) => (
    constraint.type !== "pin" || runtimeRootIds.includes(constraint.nodeId)
  ));

  return {
    version: 1,
    archetype: ik.archetype,
    defaultView: ik.defaultView,
    activeView,
    roots: runtimeRootIds,
    nodes,
    nodeMap: runtimeNodeMap,
    chains: ik.chains,
    constraints: runtimeConstraints,
    effectors: ik.effectors,
    views: ik.views,
  };
}
