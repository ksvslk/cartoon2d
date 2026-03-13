"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DraftsmanData, RigIKConstraint, RigIKData } from "@/lib/schema/rig";
import { PoseGraph, buildPoseGraph, ensureRigIK } from "@/lib/ik/graph";
import { IKToolbar } from "./IKToolbar";
import { IKInspector } from "./IKInspector";
import { IKStage } from "./IKStage";
import { PoseState, computePoseLayout, createRestPoseState } from "@/lib/ik/pose";
import { RagdollState, createRagdollState, stepRagdoll } from "@/lib/ik/physics";

type SolverFeedback = {
  key: string;
  unreachableEffectorId?: string;
  saturatedNodeIds: string[];
};

function replaceConstraintList(ik: RigIKData, nextConstraints: RigIKConstraint[]): RigIKData {
  return {
    ...ik,
    constraints: nextConstraints,
  };
}

function updateIK(data: DraftsmanData, update: (ik: RigIKData) => RigIKData): DraftsmanData {
  const normalized = ensureRigIK(data);
  return {
    ...normalized,
    rig_data: {
      ...normalized.rig_data,
      ik: update(normalized.rig_data.ik!),
    },
  };
}

function pinnedNodeIds(graph: PoseGraph): Set<string> {
  return new Set(
    graph.constraints
      .filter((constraint) => constraint.type === "pin" && constraint.enabled)
      .map((constraint) => constraint.nodeId),
  );
}

export function IKLab({
  data,
  onChange,
}: {
  data: DraftsmanData;
  onChange?: (next: DraftsmanData) => void;
}) {
  const normalizedData = useMemo(() => ensureRigIK(data), [data]);
  const availableViews = useMemo(() => {
    const viewIds = Object.keys(normalizedData.rig_data.ik?.views || {}).sort();
    return viewIds.length > 0 ? viewIds : ["view_default"];
  }, [normalizedData]);
  const defaultView = normalizedData.rig_data.ik?.defaultView || availableViews[0];
  const [viewPreference, setViewPreference] = useState<string>(defaultView);
  const activeView = availableViews.includes(viewPreference) ? viewPreference : defaultView;
  const [ragdollEnabled, setRagdollEnabled] = useState(false);
  const graphResetKey = useMemo(() => JSON.stringify({
    svg: normalizedData.svg_data,
    defaultView,
    nodes: normalizedData.rig_data.ik?.nodes.map((node) => ({
      id: node.id,
      parent: node.parent,
      rotationLimit: node.rotationLimit,
      restLength: node.restLength,
    })),
    constraints: normalizedData.rig_data.ik?.constraints,
  }), [defaultView, normalizedData]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(normalizedData.rig_data.ik?.effectors?.[0]?.nodeId || normalizedData.rig_data.ik?.roots?.[0] || null);
  const [poseSnapshot, setPoseSnapshot] = useState<{ key: string; pose: PoseState }>(() => ({
    key: graphResetKey,
    pose: createRestPoseState(buildPoseGraph(normalizedData, defaultView)),
  }));
  const [solverFeedback, setSolverFeedback] = useState<SolverFeedback>({ key: graphResetKey, saturatedNodeIds: [] });

  const poseRef = useRef(poseSnapshot.pose);
  const ragdollRef = useRef<RagdollState | null>(null);
  const dragTargetRef = useRef<{ nodeId: string; x: number; y: number } | null>(null);
  const graph = useMemo(() => buildPoseGraph(normalizedData, activeView), [normalizedData, activeView]);
  const graphResetKeyRef = useRef(graphResetKey);
  const ragdollEnabledRef = useRef(ragdollEnabled);
  const poseState = poseSnapshot.key === graphResetKey ? poseSnapshot.pose : createRestPoseState(graph);
  const activeSolverFeedback = useMemo(
    () => (solverFeedback.key === graphResetKey ? solverFeedback : { key: graphResetKey, saturatedNodeIds: [] }),
    [graphResetKey, solverFeedback],
  );
  const ragdollActive = ragdollEnabled && poseSnapshot.key === graphResetKey;
  const layout = useMemo(() => computePoseLayout(graph, poseState), [graph, poseState]);
  const pinnedIds = useMemo(() => pinnedNodeIds(graph), [graph]);
  const draggableNodeIds = useMemo(() => {
    const effectors = new Set(graph.effectors.filter((effector) => effector.draggable).map((effector) => effector.nodeId));
    graph.roots.forEach((rootId) => effectors.add(rootId));
    return effectors;
  }, [graph]);
  const resolvedSelectedNodeId = selectedNodeId && graph.nodeMap.has(selectedNodeId)
    ? selectedNodeId
    : graph.effectors[0]?.nodeId || graph.roots[0] || null;

  useEffect(() => {
    poseRef.current = poseState;
  }, [poseState]);

  useEffect(() => {
    graphResetKeyRef.current = graphResetKey;
  }, [graphResetKey]);

  useEffect(() => {
    ragdollEnabledRef.current = ragdollEnabled;
  }, [ragdollEnabled]);

  useEffect(() => {
    if (normalizedData !== data && onChange) {
      onChange(normalizedData);
    }
  }, [data, normalizedData, onChange]);

  useEffect(() => {
    if (!ragdollActive) {
      ragdollRef.current = null;
      return;
    }

    let frameId = 0;
    let lastTime = performance.now();

    const tick = () => {
      // Force a perfectly stable 60Hz physics step.
      // Dynamic `dt` from requestAnimationFrame causes Verlet integration and FABRIK limits 
      // to violently explode if the browser drops even a single 120hz frame.
      const fixedDt = 1 / 60;

      const currentPose = poseRef.current;
      const currentLayout = computePoseLayout(graph, currentPose);
      const ragdoll = ragdollRef.current || createRagdollState(currentLayout);
      const result = stepRagdoll(graph, currentPose, ragdoll, fixedDt, dragTargetRef.current);
      ragdollRef.current = result.ragdoll;
      poseRef.current = result.pose;

      setPoseSnapshot({ key: graphResetKey, pose: poseRef.current });
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [graph, graphResetKey, ragdollActive]);

  const invalidNodeIds = useMemo(() => {
    const invalid = new Set<string>(activeSolverFeedback.saturatedNodeIds);
    graph.nodes.forEach((node) => {
      if (activeView && !node.bindings[activeView]) {
        invalid.add(node.id);
      }
    });
    if (activeSolverFeedback.unreachableEffectorId) {
      invalid.add(activeSolverFeedback.unreachableEffectorId);
    }
    return invalid;
  }, [activeSolverFeedback, activeView, graph]);
  const analysisWarnings = normalizedData.rig_data.ik?.aiReport?.warnings || [];
  const analysisConfidence = normalizedData.rig_data.ik?.aiReport?.confidence;

  const persistView = (viewId: string) => {
    setViewPreference(viewId);
    if (!onChange) return;
    onChange(updateIK(normalizedData, (ik) => ({ ...ik, defaultView: viewId })));
  };

  const resetPose = () => {
    const rest = createRestPoseState(graph);
    poseRef.current = rest;
    ragdollRef.current = null;
    setRagdollEnabled(false);
    setPoseSnapshot({ key: graphResetKey, pose: rest });
    setSolverFeedback({ key: graphResetKey, saturatedNodeIds: [] });
  };

  const beginDrag = useCallback(() => {
    // We no longer turn off ragdoll when dragging. Physics handles the drag!
  }, []);

  const handleDragUpdate = useCallback((nodeId: string | null, target: { x: number; y: number } | null) => {
    if (nodeId && target) {
      dragTargetRef.current = { nodeId, x: target.x, y: target.y };
    } else {
      dragTargetRef.current = null;
    }
  }, []);

  const handleCommitDrag = useCallback((
    nextPose: PoseState,
    feedback: { unreachableEffectorId?: string; saturatedNodeIds: string[] },
  ) => {
    const activeGraphResetKey = graphResetKeyRef.current;
    poseRef.current = nextPose;
    setPoseSnapshot({ key: activeGraphResetKey, pose: nextPose });
    setSolverFeedback({
      key: activeGraphResetKey,
      unreachableEffectorId: feedback.unreachableEffectorId,
      saturatedNodeIds: feedback.saturatedNodeIds,
    });
  }, []);

  const togglePin = (nodeId: string) => {
    if (!onChange) return;
    const nextData = updateIK(normalizedData, (ik) => {
      const existingIndex = ik.constraints.findIndex((constraint) => constraint.type === "pin" && constraint.nodeId === nodeId);
      if (existingIndex === -1) {
        return replaceConstraintList(ik, [
          ...ik.constraints,
          {
            type: "pin",
            nodeId,
            enabled: true,
            x: layout.positions[nodeId].x,
            y: layout.positions[nodeId].y,
            stiffness: 1,
          },
        ]);
      }

      const nextConstraints = [...ik.constraints];
      const current = nextConstraints[existingIndex];
      if (current.type === "pin") {
        nextConstraints[existingIndex] = { ...current, enabled: !current.enabled };
      }
      return replaceConstraintList(ik, nextConstraints);
    });
    onChange(nextData);
  };

  const updatePinToCurrentPose = (nodeId: string) => {
    if (!onChange) return;
    const nextData = updateIK(normalizedData, (ik) => {
      const existingIndex = ik.constraints.findIndex((constraint) => constraint.type === "pin" && constraint.nodeId === nodeId);
      const pin = {
        type: "pin" as const,
        nodeId,
        enabled: true,
        x: layout.positions[nodeId].x,
        y: layout.positions[nodeId].y,
        stiffness: 1,
      };

      if (existingIndex === -1) {
        return replaceConstraintList(ik, [...ik.constraints, pin]);
      }

      const nextConstraints = [...ik.constraints];
      nextConstraints[existingIndex] = pin;
      return replaceConstraintList(ik, nextConstraints);
    });
    onChange(nextData);
  };

  return (
    <div className="grid h-full min-h-[620px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-h-[620px] flex-col gap-4">
        <IKToolbar
          activeView={activeView}
          availableViews={availableViews}
          ragdollEnabled={ragdollActive}
          onViewChange={persistView}
          onResetPose={resetPose}
          onToggleRagdoll={() => setRagdollEnabled((current) => !current)}
        />
        <div className="rounded-xl border border-cyan-200/70 bg-cyan-50/70 px-4 py-3 text-xs text-cyan-900 dark:border-cyan-900/50 dark:bg-cyan-950/20 dark:text-cyan-100">
          Drag cyan effectors or the root body handle. Skeleton lengths stay fixed, angle limits are shown as amber arcs, pins persist in <span className="font-mono">rig_data.ik.constraints</span>, and ragdoll exposes weak rigs immediately.
        </div>
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold uppercase tracking-[0.16em]">IK Analysis</span>
            <span className="font-mono text-[11px]">
              confidence {typeof analysisConfidence === "number" ? analysisConfidence.toFixed(2) : "n/a"}
            </span>
          </div>
          <div className="mt-2 space-y-1">
            {analysisWarnings.length > 0 ? analysisWarnings.slice(0, 3).map((warning) => (
              <div key={warning}>- {warning}</div>
            )) : <div>No structural warnings detected.</div>}
          </div>
        </div>
        <IKStage
          key={`${activeView}:${graphResetKey}`}
          data={normalizedData}
          graph={graph}
          poseState={poseState}
          layout={layout}
          activeView={activeView}
          selectedNodeId={resolvedSelectedNodeId}
          invalidNodeIds={invalidNodeIds}
          pinnedNodeIds={pinnedIds}
          draggableNodeIds={draggableNodeIds}
          ragdollEnabled={ragdollActive}
          onSelectNode={setSelectedNodeId}
          onBeginDrag={beginDrag}
          onDragUpdate={handleDragUpdate}
          onCommitDrag={handleCommitDrag}
        />
      </div>

      <IKInspector
        graph={graph}
        layout={layout}
        selectedNodeId={resolvedSelectedNodeId}
        pinnedNodeIds={pinnedIds}
        invalidNodeIds={invalidNodeIds}
        onTogglePin={togglePin}
        onUpdatePin={updatePinToCurrentPose}
      />
    </div>
  );
}
