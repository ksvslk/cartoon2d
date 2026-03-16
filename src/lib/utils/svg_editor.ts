export type ZIndexAction = 'forward' | 'backward' | 'front' | 'back';

export function modifySvgNodeAppearance(
  svgString: string,
  nodeId: string,
  action: ZIndexAction | { type: 'color'; color: string }
): string {
  if (typeof window === "undefined") return svgString; // Safe guard for server-side

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const el = doc.getElementById(nodeId);
    
    if (!el) {
      console.warn(`[SVG Editor] Node with ID '${nodeId}' not found in SVG document.`);
      return svgString;
    }

    if (typeof action === 'object' && action.type === 'color') {
      // Prioritize setting fill on inner shapes rather than the group wrapper
      // because sometimes groups have transforms and inner paths carry the colors.
      const shapes = el.querySelectorAll('path, rect, circle, ellipse, polygon');
      if (shapes.length > 0) {
        shapes.forEach(shape => shape.setAttribute("fill", action.color));
      } else {
        // Fallback to the element itself if it's a leaf node
        el.setAttribute("fill", action.color);
      }
    } else {
      let currentEl: Element | null = el;
      
      while (currentEl) {
        const parent: Element | null = currentEl.parentElement;
        if (!parent || parent.tagName.toLowerCase() === 'svg' || (parent.tagName.toLowerCase() === 'g' && parent.id.startsWith('view_'))) {
          // Reached the document root or a top-level view container, stop bubbling.
          break;
        }

        let moved = false;

        if (action === 'forward') {
          const next = currentEl.nextElementSibling;
          if (next && next.nextElementSibling) {
            parent.insertBefore(currentEl, next.nextElementSibling);
            moved = true;
          } else if (next) {
            parent.appendChild(currentEl);
            moved = true;
          }
        } else if (action === 'backward') {
          const prev = currentEl.previousElementSibling;
          if (prev) {
            parent.insertBefore(currentEl, prev);
            moved = true;
          }
        } else if (action === 'front') {
          if (parent.lastElementChild !== currentEl) {
            parent.appendChild(currentEl);
            moved = true;
          }
        } else if (action === 'back') {
          const first = parent.firstElementChild;
          if (first && first !== currentEl) {
            parent.insertBefore(currentEl, first);
            moved = true;
          }
        }

        if (moved) {
          // We successfully moved the element within its parent. We don't need to bubble.
          break;
        } else {
          // The element is already at the physical boundary of its current container.
          // Bubble up and try to move the container itself.
          currentEl = parent;
        }
      }
    }

    const serializer = new XMLSerializer();
    return serializer.serializeToString(doc);
  } catch (error) {
    console.error("[SVG Editor] Failed to parse and modify SVG:", error);
    return svgString;
  }
}

export function extractSvgNodeColor(svgString: string, nodeId: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const el = doc.getElementById(nodeId);
    if (!el) return null;

    // First try the element itself
    let color = el.getAttribute("fill");
    
    // If not, find the first colored child
    if (!color || color === "none") {
      const shapes = el.querySelectorAll('path, rect, circle, ellipse, polygon');
      for (let i = 0; i < shapes.length; i++) {
        const shapeFill = shapes[i].getAttribute("fill");
        if (shapeFill && shapeFill !== "none") {
          return shapeFill;
        }
      }
    }

    return color;
  } catch (error) {
    return null;
  }
}
