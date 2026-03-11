import { ensureRigIK } from "../ik/graph";

type CanonicalRig = ReturnType<typeof ensureRigIK>;
type CanonicalNode = NonNullable<CanonicalRig["rig_data"]["ik"]>["nodes"][number];

export type MotionTopologyChain = {
  id: string;
  nodeIds: string[];
  anchorNodeId: string;
  terminalNodeId: string;
  primary: boolean;
  depth: number;
  span: number;
};

export type MotionTopology = {
  rootNodeIds: string[];
  primaryChain?: MotionTopologyChain;
  branchChains: MotionTopologyChain[];
  chains: MotionTopologyChain[];
  nodeDepths: Map<string, number>;
  childIdsByNode: Map<string, string[]>;
  parentByNode: Map<string, string | undefined>;
  leafNodeIds: string[];
  branchNodeIds: string[];
};

function sortIds(ids: string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function comparePaths(
  left: string[],
  right: string[],
  spanByPath: Map<string, number>,
): number {
  const leftSpan = spanByPath.get(left.join(">")) || 0;
  const rightSpan = spanByPath.get(right.join(">")) || 0;
  if (rightSpan !== leftSpan) return rightSpan - leftSpan;
  if (right.length !== left.length) return right.length - left.length;
  return left.join(">").localeCompare(right.join(">"));
}

function collectRootToLeafPaths(
  nodeId: string,
  childIdsByNode: Map<string, string[]>,
  trail: string[] = [],
): string[][] {
  const nextTrail = [...trail, nodeId];
  const children = sortIds(childIdsByNode.get(nodeId) || []);
  if (children.length === 0) return [nextTrail];
  return children.flatMap((childId) => collectRootToLeafPaths(childId, childIdsByNode, nextTrail));
}

function trimDecorativeTerminalNodes(
  nodeIds: string[],
  nodeById: Map<string, CanonicalNode>,
): string[] {
  const trimmed = [...nodeIds];
  while (trimmed.length > 1) {
    const terminal = nodeById.get(trimmed[trimmed.length - 1]);
    if (!terminal || terminal.ikRole !== "decorative") break;
    trimmed.pop();
  }
  return trimmed;
}

function computeNodeDepths(
  rootIds: string[],
  childIdsByNode: Map<string, string[]>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (nodeId: string, depth: number) => {
    const current = depths.get(nodeId);
    if (current !== undefined && current <= depth) return;
    depths.set(nodeId, depth);
    (childIdsByNode.get(nodeId) || []).forEach((childId) => visit(childId, depth + 1));
  };
  rootIds.forEach((rootId) => visit(rootId, 0));
  return depths;
}

function sharedPrefixLength(left: string[], right: string[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function pathSpan(
  nodeIds: string[],
  nodeById: Map<string, CanonicalNode>,
): number {
  return nodeIds.reduce((sum, nodeId, index) => {
    if (index === 0) return sum;
    const node = nodeById.get(nodeId);
    if (!node) return sum;
    if (typeof node.restLength === "number" && Number.isFinite(node.restLength)) {
      return sum + node.restLength;
    }
    return sum;
  }, 0);
}

function buildChain(
  nodeIds: string[],
  primary: boolean,
  nodeDepths: Map<string, number>,
  index: number,
  span: number,
): MotionTopologyChain {
  return {
    id: primary ? "primary" : `branch_${index}`,
    nodeIds,
    anchorNodeId: nodeIds[0],
    terminalNodeId: nodeIds[nodeIds.length - 1],
    primary,
    depth: nodeDepths.get(nodeIds[nodeIds.length - 1]) || 0,
    span,
  };
}

export function isContinuousNodeChain(
  nodeIds: string[],
  parentByNode: Map<string, string | undefined>,
): boolean {
  if (nodeIds.length < 2) return false;
  return nodeIds.every((nodeId, index) => index === 0 || parentByNode.get(nodeId) === nodeIds[index - 1]);
}

export function buildMotionTopology(
  rigInput: CanonicalRig | Parameters<typeof ensureRigIK>[0],
): MotionTopology {
  const rig = "svg_data" in rigInput ? ensureRigIK(rigInput) : rigInput;
  const nodes = rig.rig_data.ik?.nodes || [];

  const parentByNode = new Map(nodes.map((node) => [node.id, node.parent]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childIdsByNode = new Map<string, string[]>();
  nodes.forEach((node) => childIdsByNode.set(node.id, []));
  nodes.forEach((node) => {
    if (!node.parent) return;
    const children = childIdsByNode.get(node.parent) || [];
    children.push(node.id);
    childIdsByNode.set(node.parent, sortIds(children));
  });

  const rootNodeIds = sortIds(
    (rig.rig_data.ik?.roots || []).length > 0
      ? (rig.rig_data.ik?.roots || [])
      : nodes.filter((node) => !node.parent).map((node) => node.id),
  );
  const nodeDepths = computeNodeDepths(rootNodeIds, childIdsByNode);
  const rootToLeafPaths = rootNodeIds
    .flatMap((rootId) => collectRootToLeafPaths(rootId, childIdsByNode))
    .map((path) => trimDecorativeTerminalNodes(path, nodeById))
    .filter((path) => path.length >= 2);
  const spanByPath = new Map(rootToLeafPaths.map((path) => [path.join(">"), pathSpan(path, nodeById)]));
  rootToLeafPaths.sort((left, right) => comparePaths(left, right, spanByPath));

  const primaryPath = rootToLeafPaths[0];
  const chains: MotionTopologyChain[] = [];
  const seen = new Set<string>();

  if (primaryPath) {
    const key = primaryPath.join(">");
    seen.add(key);
    chains.push(buildChain(primaryPath, true, nodeDepths, 0, spanByPath.get(key) || 0));
  }

  rootToLeafPaths.slice(primaryPath ? 1 : 0).forEach((path, index) => {
    const prefixLength = primaryPath ? sharedPrefixLength(primaryPath, path) : 0;
    const startIndex = Math.max(0, prefixLength - 1);
    const candidate = path.slice(startIndex);
    if (candidate.length < 2) return;

    const key = candidate.join(">");
    if (seen.has(key)) return;
    seen.add(key);
    chains.push(buildChain(candidate, false, nodeDepths, index, pathSpan(candidate, nodeById)));
  });

  const branchChains = chains.filter((chain) => !chain.primary);
  const leafNodeIds = sortIds(
    nodes
      .filter((node) => (childIdsByNode.get(node.id) || []).length === 0)
      .map((node) => node.id),
  );
  const branchNodeIds = sortIds(
    nodes
      .filter((node) => (childIdsByNode.get(node.id) || []).length > 1)
      .map((node) => node.id),
  );

  return {
    rootNodeIds,
    primaryChain: chains.find((chain) => chain.primary),
    branchChains,
    chains,
    nodeDepths,
    childIdsByNode,
    parentByNode,
    leafNodeIds,
    branchNodeIds,
  };
}
