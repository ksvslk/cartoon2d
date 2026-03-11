import gsap from "gsap";
import { DraftsmanData } from "../schema/rig";
import { PoseGraph } from "./graph";
import { PoseLayout } from "./pose";
import { applyDeterministicRigAssembly } from "../svg/assembly";

const ALL_VIEWS = ["view_front", "view_side_right", "view_3q_right", "view_top", "view_back", "view_default"] as const;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function showRigView(scopeRoot: ParentNode, activeView?: string): void {
  ALL_VIEWS.forEach((viewId) => {
    const node = scopeRoot.querySelector(`[id="${viewId}"]`) as SVGGElement | null;
    if (!node) return;
    node.setAttribute("display", !activeView || viewId === activeView ? "inline" : "none");
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
