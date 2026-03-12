import gsap from "gsap";
import { DraftsmanData } from "../schema/rig";
import { PoseGraph } from "./graph";
import { PoseLayout } from "./pose";
import { applyDeterministicRigAssembly } from "../svg/assembly";

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function collectRigViewIds(scopeRoot: ParentNode): string[] {
  return Array.from(new Set(
    Array.from(scopeRoot.querySelectorAll<SVGGElement>('[id^="view_"]'))
      .map((node) => node.id)
      .sort(),
  ));
}

function resolveDisplayedViewId(scopeRoot: ParentNode, activeView?: string): string | undefined {
  const viewIds = collectRigViewIds(scopeRoot);
  if (viewIds.length === 0) return activeView;
  if (activeView && viewIds.includes(activeView)) return activeView;
  return viewIds[0];
}

export function showRigView(scopeRoot: ParentNode, activeView?: string): void {
  const resolvedViewId = resolveDisplayedViewId(scopeRoot, activeView);
  collectRigViewIds(scopeRoot).forEach((viewId) => {
    const node = scopeRoot.querySelector(`[id="${viewId}"]`) as SVGGElement | null;
    if (!node) return;
    node.setAttribute("display", !resolvedViewId || viewId === resolvedViewId ? "inline" : "none");
  });
}

export function mountRigSvg(container: HTMLDivElement, data: DraftsmanData, activeView?: string): SVGSVGElement | null {
  container.innerHTML = data.svg_data;
  const svgElement = container.querySelector("svg");
  if (!svgElement) return null;
  applyDeterministicRigAssembly(svgElement, data);
  showRigView(svgElement, activeView);
  return svgElement;
}

export function applyPoseToSvg(scopeRoot: ParentNode, graph: PoseGraph, layout: PoseLayout, activeView?: string): void {
  showRigView(scopeRoot, activeView);

  graph.nodes.forEach((node) => {
    const binding = activeView ? node.bindings[activeView] : node.activeBinding;
    if (!binding?.pivot) return;
    const group = scopeRoot.querySelector(`[id="${binding.boneId}"]`) as SVGGElement | null;
    if (!group) return;

    const rootOffset = !node.parentId
      ? {
          x: round2(layout.positions[node.id].x - node.restWorld.x),
          y: round2(layout.positions[node.id].y - node.restWorld.y),
        }
      : { x: 0, y: 0 };

    gsap.set(group, {
      x: rootOffset.x,
      y: rootOffset.y,
      rotation: round2(layout.localRotations[node.id] ?? 0),
      svgOrigin: `${binding.pivot.x} ${binding.pivot.y}`,
      overwrite: true,
    });
  });
}
