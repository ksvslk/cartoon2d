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

export function applyDeterministicRigAssembly(
  scopeRoot: ParentNode,
  data: DraftsmanData,
): void {
  if (!data?.rig_data?.bones?.length) return;

  softenStrokeGeometry(scopeRoot);

  data.rig_data.bones.forEach((bone) => {
    if (!bone.parent) return;
    const childEl = scopeRoot.querySelector(`g[id="${bone.id}"]`) as SVGGElement | null;
    const parentEl = scopeRoot.querySelector(`g[id="${bone.parent}"]`) as SVGGElement | null;
    if (!childEl || !parentEl) return;
    if (childEl === parentEl) return;

    if (!isDescendantOf(childEl, parentEl)) {
      parentEl.appendChild(childEl);
    }
  });
}
