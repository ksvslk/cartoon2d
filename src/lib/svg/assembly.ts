import { DraftsmanData } from "@/lib/schema/rig";

function isDescendantOf(child: Element, parent: Element): boolean {
  let cursor: Element | null = child.parentElement;
  while (cursor) {
    if (cursor === parent) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function softenStrokeGeometry(scopeRoot: ParentNode): void {
  scopeRoot.querySelectorAll<SVGElement>("[stroke]").forEach((element) => {
    if (!element.getAttribute("stroke-linecap")) {
      element.setAttribute("stroke-linecap", "round");
    }
    if (!element.getAttribute("stroke-linejoin")) {
      element.setAttribute("stroke-linejoin", "round");
    }
  });
}

export function captureElementDrawOrder(scopeRoot: ParentNode): Map<Element, number> {
  const order = new Map<Element, number>();
  Array.from(scopeRoot.querySelectorAll("*")).forEach((element, index) => {
    order.set(element, index);
  });
  return order;
}

export function reparentPreservingDrawOrder(
  parentEl: Element,
  childEl: Element,
  drawOrder: Map<Element, number>,
  zIndexById?: Map<string, number>,
): void {
  const childId = childEl.getAttribute("id") || "";
  const childOrder = zIndexById?.get(childId) ?? drawOrder.get(childEl) ?? Number.MAX_SAFE_INTEGER;
  const insertBefore = Array.from(parentEl.children).find((sibling) => {
    if (sibling === childEl) return false;
    const siblingId = sibling.getAttribute("id") || "";
    const siblingOrder = zIndexById?.get(siblingId) ?? drawOrder.get(sibling) ?? Number.MAX_SAFE_INTEGER;
    return siblingOrder > childOrder;
  }) ?? null;
  parentEl.insertBefore(childEl, insertBefore);
}

function reorderChildrenByLayerOrder(
  parentEl: Element,
  drawOrder: Map<Element, number>,
  zIndexById: Map<string, number>,
): void {
  const orderedChildren = Array.from(parentEl.children).sort((left, right) => {
    const leftId = left.getAttribute("id") || "";
    const rightId = right.getAttribute("id") || "";
    const leftOrder = zIndexById.get(leftId) ?? drawOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = zIndexById.get(rightId) ?? drawOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (drawOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (drawOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
  });
  orderedChildren.forEach((child) => parentEl.appendChild(child));
}

export function applyDeterministicRigAssembly(
  scopeRoot: ParentNode,
  data: DraftsmanData,
): void {
  if (!data?.rig_data?.bones?.length) return;

  softenStrokeGeometry(scopeRoot);
  const drawOrder = captureElementDrawOrder(scopeRoot);
  const zIndexById = new Map(
    data.rig_data.bones
      .filter((bone) => typeof bone.zIndex === "number")
      .map((bone) => [bone.id, bone.zIndex as number]),
  );

  data.rig_data.bones.forEach((bone) => {
    if (!bone.parent) return;
    const childEl = scopeRoot.querySelector(`g[id="${bone.id}"]`) as SVGGElement | null;
    const parentEl = scopeRoot.querySelector(`g[id="${bone.parent}"]`) as SVGGElement | null;
    if (!childEl || !parentEl) return;
    if (childEl === parentEl) return;

    if (!isDescendantOf(childEl, parentEl)) {
      reparentPreservingDrawOrder(parentEl, childEl, drawOrder, zIndexById);
    }
  });

  const containers = Array.from(scopeRoot.querySelectorAll<SVGElement>("svg, g[id]"));
  containers.forEach((container) => reorderChildrenByLayerOrder(container, drawOrder, zIndexById));
}
