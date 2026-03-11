"use client";

import { useEffect, useMemo, useRef } from "react";
import { DraftsmanData } from "@/lib/schema/rig";
import { PoseGraph } from "@/lib/ik/graph";
import { PoseLayout } from "@/lib/ik/pose";
import { applyPoseToSvg, mountRigSvg } from "@/lib/ik/svgPose";

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const startRadians = (startAngle * Math.PI) / 180;
  const endRadians = (endAngle * Math.PI) / 180;
  const start = {
    x: round2(cx + Math.cos(startRadians) * radius),
    y: round2(cy + Math.sin(startRadians) * radius),
  };
  const end = {
    x: round2(cx + Math.cos(endRadians) * radius),
    y: round2(cy + Math.sin(endRadians) * radius),
  };
  const largeArcFlag = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

export function IKStage({
  data,
  graph,
  layout,
  activeView,
  selectedNodeId,
  invalidNodeIds,
  pinnedNodeIds,
  draggableNodeIds,
  onSelectNode,
  onDragNode,
  onEndDrag,
}: {
  data: DraftsmanData;
  graph: PoseGraph;
  layout: PoseLayout;
  activeView?: string;
  selectedNodeId: string | null;
  invalidNodeIds: Set<string>;
  pinnedNodeIds: Set<string>;
  draggableNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  onDragNode: (nodeId: string, target: { x: number; y: number }) => void;
  onEndDrag: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragNodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    svgRef.current = mountRigSvg(containerRef.current, data, activeView);
  }, [data, activeView]);

  useEffect(() => {
    if (!svgRef.current) return;
    applyPoseToSvg(svgRef.current, graph, layout, activeView);
  }, [graph, layout, activeView]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const nodeId = dragNodeRef.current;
      const container = containerRef.current;
      if (!nodeId || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      onDragNode(nodeId, {
        x: round2(((event.clientX - rect.left) / rect.width) * 1000),
        y: round2(((event.clientY - rect.top) / rect.height) * 1000),
      });
    };

    const handlePointerUp = () => {
      if (!dragNodeRef.current) return;
      dragNodeRef.current = null;
      onEndDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onDragNode, onEndDrag]);

  const nodeArcs = useMemo(() => {
    return graph.nodes
      .filter((node) => node.parentId && node.rotationLimit)
      .map((node) => {
        const parentPos = layout.positions[node.parentId!];
        if (!parentPos) return null;
        const restAngle = (Math.atan2(node.restWorld.y - graph.nodeMap.get(node.parentId!)!.restWorld.y, node.restWorld.x - graph.nodeMap.get(node.parentId!)!.restWorld.x) * 180) / Math.PI;
        const parentRotation = layout.absoluteRotations[node.parentId!] ?? 0;
        const radius = Math.max(30, Math.min((node.restLength || 60) * 0.45, 72));
        return {
          nodeId: node.id,
          path: describeArc(
            parentPos.x,
            parentPos.y,
            radius,
            restAngle + parentRotation + node.rotationLimit![0],
            restAngle + parentRotation + node.rotationLimit![1],
          ),
        };
      })
      .filter((entry): entry is { nodeId: string; path: string } => Boolean(entry));
  }, [graph, layout]);

  return (
    <div className="relative h-full min-h-[520px] overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100 shadow-inner dark:border-neutral-800 dark:bg-neutral-950">
      <div
        ref={containerRef}
        className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none [&>svg]:max-h-none"
      />

      <svg viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full">
        {graph.nodes.map((node) => {
          if (!node.parentId) return null;
          const parentPos = layout.positions[node.parentId];
          const currentPos = layout.positions[node.id];
          if (!parentPos || !currentPos) return null;
          return (
            <line
              key={`segment-${node.id}`}
              x1={parentPos.x}
              y1={parentPos.y}
              x2={currentPos.x}
              y2={currentPos.y}
              stroke={invalidNodeIds.has(node.id) ? "#ef4444" : "#38bdf8"}
              strokeWidth={invalidNodeIds.has(node.id) ? 5 : 3}
              strokeLinecap="round"
              opacity={0.95}
              pointerEvents="none"
            />
          );
        })}

        {nodeArcs.map((entry) => (
          <path
            key={`arc-${entry.nodeId}`}
            d={entry.path}
            fill="none"
            stroke={invalidNodeIds.has(entry.nodeId) ? "#ef4444" : "#f59e0b"}
            strokeDasharray="8 6"
            strokeWidth={selectedNodeId === entry.nodeId ? 4 : 2}
            opacity={selectedNodeId === entry.nodeId ? 0.9 : 0.55}
            pointerEvents="none"
          />
        ))}

        {graph.nodes.map((node) => {
          const point = layout.positions[node.id];
          if (!point) return null;
          const selected = selectedNodeId === node.id;
          const invalid = invalidNodeIds.has(node.id);
          const pinned = pinnedNodeIds.has(node.id);
          const draggable = draggableNodeIds.has(node.id);
          return (
            <g key={`handle-${node.id}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={selected ? 13 : draggable ? 10 : 7}
                fill={invalid ? "#ef4444" : draggable ? "#22d3ee" : "#e5e7eb"}
                stroke={selected ? "#ffffff" : "#0f172a"}
                strokeWidth={selected ? 4 : 2}
                className={draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectNode(node.id);
                  if (draggable) {
                    dragNodeRef.current = node.id;
                  }
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectNode(node.id);
                }}
              />
              {pinned && (
                <rect
                  x={point.x + 10}
                  y={point.y - 16}
                  width={28}
                  height={14}
                  rx={7}
                  fill="#0f172a"
                  opacity={0.92}
                  pointerEvents="none"
                />
              )}
              {pinned && (
                <text
                  x={point.x + 24}
                  y={point.y - 6}
                  fill="#f8fafc"
                  textAnchor="middle"
                  fontSize="8"
                  fontFamily="monospace"
                  pointerEvents="none"
                >
                  PIN
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
