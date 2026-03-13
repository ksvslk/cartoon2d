"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DraftsmanData } from "@/lib/schema/rig";
import { PoseGraph } from "@/lib/ik/graph";
import { PoseLayout, PoseState, computePoseLayout, setRootPosition } from "@/lib/ik/pose";
import { applyPoseToSvg, mountRigSvg } from "@/lib/ik/svgPose";
import { rootIdForNode, solveEffectorCCD } from "@/lib/ik/solver";

function round2(value: number): number {
  return value;
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
  poseState,
  layout,
  activeView,
  selectedNodeId,
  invalidNodeIds,
  pinnedNodeIds,
  draggableNodeIds,
  ragdollEnabled,
  onSelectNode,
  onBeginDrag,
  onDragUpdate,
  onCommitDrag,
}: {
  data: DraftsmanData;
  graph: PoseGraph;
  poseState: PoseState;
  layout: PoseLayout;
  activeView?: string;
  selectedNodeId: string | null;
  invalidNodeIds: Set<string>;
  pinnedNodeIds: Set<string>;
  draggableNodeIds: Set<string>;
  ragdollEnabled?: boolean;
  onSelectNode: (nodeId: string) => void;
  onBeginDrag: () => void;
  onDragUpdate?: (nodeId: string | null, target: { x: number; y: number } | null) => void;
  onCommitDrag: (pose: PoseState, feedback: { unreachableEffectorId?: string; saturatedNodeIds: string[] }) => void;
}) {
  const [previewState, setPreviewState] = useState<{
    pose: PoseState;
    layout: PoseLayout;
    invalidNodeIds: Set<string>;
    feedback: { unreachableEffectorId?: string; saturatedNodeIds: string[] };
  } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [previewCommitPending, setPreviewCommitPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragNodeRef = useRef<string | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const lastDragTargetRef = useRef<{ x: number; y: number } | null>(null);
  const previewStateRef = useRef(previewState);
  const onBeginDragRef = useRef(onBeginDrag);
  const onCommitDragRef = useRef(onCommitDrag);
  const onDragUpdateRef = useRef(onDragUpdate);
  const ragdollEnabledRef = useRef(ragdollEnabled);
  const shouldRenderPreview = Boolean(previewState) && (
    dragActive ||
    (previewCommitPending && previewState?.pose !== poseState)
  );
  const renderLayout = shouldRenderPreview && previewState ? previewState.layout : layout;
  const renderInvalidNodeIds = shouldRenderPreview && previewState ? previewState.invalidNodeIds : invalidNodeIds;

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  useEffect(() => {
    onBeginDragRef.current = onBeginDrag;
  }, [onBeginDrag]);

  useEffect(() => {
    onCommitDragRef.current = onCommitDrag;
  }, [onCommitDrag]);

  useEffect(() => {
    onDragUpdateRef.current = onDragUpdate;
  }, [onDragUpdate]);

  useEffect(() => {
    ragdollEnabledRef.current = ragdollEnabled;
  }, [ragdollEnabled]);

  const overlayRef = useRef<SVGSVGElement>(null);

  const pointerToStagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = overlayRef.current;
    if (!svg) return null;
    let ctm = svg.getScreenCTM();
    if (!ctm) return null;
    
    // We must use the true SVG CTM to handle `preserveAspectRatio` letterboxing.
    // A raw React container bounding box calculation will offset and stretch incorrectly!
    const point = new DOMPoint(clientX, clientY);
    const transformed = point.matrixTransform(ctm.inverse());
    return {
      x: round2(transformed.x),
      y: round2(transformed.y),
    };
  };

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    svgRef.current = mountRigSvg(containerRef.current, data, activeView);
  }, [data, activeView]);

  useLayoutEffect(() => {
    if (!svgRef.current) return;
    applyPoseToSvg(svgRef.current, graph, renderLayout, activeView);
  }, [graph, renderLayout, activeView]);

  useEffect(() => {
    const invalidNodeIdsForFeedback = (feedback: { unreachableEffectorId?: string; saturatedNodeIds: string[] }) => {
      const nextInvalid = new Set<string>(feedback.saturatedNodeIds);
      graph.nodes.forEach((node) => {
        if (activeView && !node.bindings[activeView]) {
          nextInvalid.add(node.id);
        }
      });
      if (feedback.unreachableEffectorId) {
        nextInvalid.add(feedback.unreachableEffectorId);
      }
      return nextInvalid;
    };

    const finishDrag = () => {
      const nodeId = dragNodeRef.current;
      if (!nodeId) return;
      const preview = previewStateRef.current;
      dragNodeRef.current = null;
      dragPointerIdRef.current = null;
      lastDragTargetRef.current = null;
      setDragActive(false);

      if (ragdollEnabledRef.current) {
        if (onDragUpdateRef.current) onDragUpdateRef.current(null, null);
      } else if (preview) {
        setPreviewCommitPending(true);
        onCommitDragRef.current(preview.pose, preview.feedback);
        window.requestAnimationFrame(() => {
          setPreviewState(null);
          setPreviewCommitPending(false);
        });
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nodeId = dragNodeRef.current;
      if (!nodeId) return;
      if (dragPointerIdRef.current !== null && event.pointerId !== dragPointerIdRef.current) return;
      const target = pointerToStagePoint(event.clientX, event.clientY);
      if (!target) return;
      if (lastDragTargetRef.current && lastDragTargetRef.current.x === target.x && lastDragTargetRef.current.y === target.y) {
        return;
      }
      setPreviewCommitPending(false);
      lastDragTargetRef.current = target;

      if (ragdollEnabledRef.current) {
        if (onDragUpdateRef.current) onDragUpdateRef.current(nodeId, target);
        return;
      }

      const node = graph.nodeMap.get(nodeId);
      if (!node) return;

      let nextPose: PoseState;
      let nextLayout: PoseLayout;
      let feedback: { unreachableEffectorId?: string; saturatedNodeIds: string[] };
      const basePose = previewStateRef.current?.pose ?? poseState;

      if (!node.parentId || graph.roots.includes(nodeId)) {
        const rootId = rootIdForNode(graph, nodeId);
        nextPose = setRootPosition(graph, basePose, rootId, target);
        nextLayout = computePoseLayout(graph, nextPose);
        feedback = { saturatedNodeIds: [] };
      } else {
        const result = solveEffectorCCD(graph, basePose, nodeId, target);
        nextPose = result.pose;
        nextLayout = result.layout;
        feedback = {
          unreachableEffectorId: result.reached ? undefined : nodeId,
          saturatedNodeIds: result.saturatedNodeIds,
        };
      }

      setPreviewState({
        pose: nextPose,
        layout: nextLayout,
        invalidNodeIds: invalidNodeIdsForFeedback(feedback),
        feedback,
      });
    };

    const handlePointerUp = () => {
      finishDrag();
    };

    const handlePointerCancel = () => {
      finishDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [activeView, graph, poseState]);

  const nodeArcs = useMemo(() => {
    return graph.nodes
      .filter((node) => node.parentId && node.rotationLimit)
      .map((node) => {
        const parentPos = renderLayout.positions[node.parentId!];
        if (!parentPos) return null;
        const restAngle = (Math.atan2(node.restWorld.y - graph.nodeMap.get(node.parentId!)!.restWorld.y, node.restWorld.x - graph.nodeMap.get(node.parentId!)!.restWorld.x) * 180) / Math.PI;
        const parentRotation = renderLayout.absoluteRotations[node.parentId!] ?? 0;
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
  }, [graph, renderLayout]);

  return (
    <div className="relative h-full min-h-[520px] touch-none select-none overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100 shadow-inner dark:border-neutral-800 dark:bg-neutral-950">
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none [&>svg]:max-h-none"
      />

      <svg 
        ref={overlayRef}
        viewBox="0 0 1000 1000" 
        className="absolute inset-0 h-full w-full touch-none select-none"
      >
        {graph.nodes.map((node) => {
          if (!node.parentId) return null;
          const parentPos = renderLayout.positions[node.parentId];
          const currentPos = renderLayout.positions[node.id];
          if (!parentPos || !currentPos) return null;
          return (
            <line
              key={`segment-${node.id}`}
              x1={parentPos.x}
              y1={parentPos.y}
              x2={currentPos.x}
              y2={currentPos.y}
              stroke={renderInvalidNodeIds.has(node.id) ? "#ef4444" : "#38bdf8"}
              strokeWidth={renderInvalidNodeIds.has(node.id) ? 5 : 3}
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
            stroke={renderInvalidNodeIds.has(entry.nodeId) ? "#ef4444" : "#f59e0b"}
            strokeDasharray="8 6"
            strokeWidth={selectedNodeId === entry.nodeId ? 4 : 2}
            opacity={selectedNodeId === entry.nodeId ? 0.9 : 0.55}
            pointerEvents="none"
          />
        ))}

        {graph.nodes.map((node) => {
          const point = renderLayout.positions[node.id];
          if (!point) return null;
          const selected = selectedNodeId === node.id;
          const invalid = renderInvalidNodeIds.has(node.id);
          const pinned = pinnedNodeIds.has(node.id);
          const draggable = draggableNodeIds.has(node.id);
          const hitRadius = selected ? 22 : draggable ? 18 : 14;
          return (
            <g key={`handle-${node.id}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={hitRadius}
                fill="rgba(15, 23, 42, 0.001)"
                stroke="none"
                pointerEvents="all"
                className={draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectNode(node.id);
                  if (draggable) {
                    setDragActive(true);
                    setPreviewCommitPending(false);
                    onBeginDragRef.current();
                    dragNodeRef.current = node.id;
                    dragPointerIdRef.current = event.pointerId;
                    lastDragTargetRef.current = pointerToStagePoint(event.clientX, event.clientY);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }
                }}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={selected ? 13 : draggable ? 10 : 7}
                fill={invalid ? "#ef4444" : draggable ? "#22d3ee" : "#e5e7eb"}
                stroke={selected ? "#ffffff" : "#0f172a"}
                strokeWidth={selected ? 4 : 2}
                pointerEvents="none"
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
