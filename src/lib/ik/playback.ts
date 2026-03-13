import gsap from "gsap";
import { DraftsmanData, RigMotionIntent } from "../schema/rig";
import { buildPoseGraph, PoseGraph } from "./graph";
import { clampLocalRotation, computePoseLayout, createRestPoseState, PoseState } from "./pose";
import { applyPoseToSvg } from "./svgPose";
import { solvePoseFromGoals } from "./goal_solver";
import { EvaluatedMotionGoals, evaluateMotionIntentAtTime } from "../motion/intent";

type PlaybackViewState = {
  graph: PoseGraph;
  nodeIdByBoneId: Map<string, string>;
  restPose: PoseState;
  currentPose?: PoseState;
  appliedIntent?: RigMotionIntent;
};

type ActorPlaybackState = {
  clipTimeSeconds: number;
  durationSeconds: number;
  currentIntent?: RigMotionIntent;
  currentGoals?: EvaluatedMotionGoals;
};

export type IKPlaybackActor = {
  actorId: string;
  actorGroup: SVGGElement;
  rig: DraftsmanData;
  defaultView: string;
  renderState: {
    currentView: string;
  };
  playbackState: ActorPlaybackState;
  viewStates: Map<string, PlaybackViewState>;
};

function resolveViewId(actor: IKPlaybackActor, requestedView?: string): string {
  if (requestedView && actor.rig.rig_data.ik?.views[requestedView]) return requestedView;
  if (actor.renderState.currentView && actor.rig.rig_data.ik?.views[actor.renderState.currentView]) {
    return actor.renderState.currentView;
  }
  return actor.defaultView;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeDegrees(value: number): number {
  let next = value;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return round2(next);
}

function clampStep(value: number, maxStep: number): number {
  return Math.max(-maxStep, Math.min(maxStep, value));
}

function stabilizePoseForPlayback(
  graph: PoseGraph,
  currentPose: PoseState,
  targetPose: PoseState,
): PoseState {
  const nextPose: PoseState = {
    rootTranslations: {},
    localRotations: {},
  };

  graph.roots.forEach((rootId) => {
    const current = currentPose.rootTranslations[rootId] || { x: 0, y: 0 };
    const target = targetPose.rootTranslations[rootId] || current;
    const dx = clampStep((target.x - current.x) * 0.62, 18);
    const dy = clampStep((target.y - current.y) * 0.62, 18);
    nextPose.rootTranslations[rootId] = {
      x: round2(current.x + dx),
      y: round2(current.y + dy),
    };
  });

  graph.nodes.forEach((node) => {
    const current = currentPose.localRotations[node.id] ?? 0;
    const target = targetPose.localRotations[node.id] ?? current;
    const delta = normalizeDegrees(target - current);
    const stepped = current + clampStep(delta * 0.62, 8);
    nextPose.localRotations[node.id] = clampLocalRotation(graph, node.id, stepped);
  });

  return nextPose;
}

function buildNodeLookup(graph: PoseGraph): Map<string, string> {
  const lookup = new Map<string, string>();
  graph.nodes.forEach((node) => {
    Object.values(node.bindings).forEach((binding) => {
      lookup.set(binding.boneId, node.id);
    });
    node.sourceBoneIds.forEach((boneId) => {
      if (!lookup.has(boneId)) {
        lookup.set(boneId, node.id);
      }
    });
  });
  return lookup;
}

function createPlaybackViewState(rig: DraftsmanData, viewId: string): PlaybackViewState {
  const graph = buildPoseGraph(rig, viewId);
  const restPose = createRestPoseState(graph);
  return {
    graph,
    nodeIdByBoneId: buildNodeLookup(graph),
    restPose,
  };
}

export function createIKPlaybackActor(
  container: ParentNode,
  actorId: string,
  rig: DraftsmanData,
): IKPlaybackActor | null {
  if (!rig.rig_data.ik?.nodes.length) return null;
  const actorGroup = container.querySelector<SVGGElement>(`#actor_group_${actorId}`);
  if (!actorGroup) return null;

  const defaultView = rig.rig_data.ik.defaultView
    || Object.keys(rig.rig_data.ik.views).sort()[0]
    || "view_default";

  return {
    actorId,
    actorGroup,
    rig,
    defaultView,
    renderState: {
      currentView: defaultView,
    },
    playbackState: {
      clipTimeSeconds: 0,
      durationSeconds: 1,
    },
    viewStates: new Map<string, PlaybackViewState>(),
  };
}

export function ensurePlaybackViewState(actor: IKPlaybackActor, requestedView?: string): PlaybackViewState {
  const viewId = resolveViewId(actor, requestedView);
  const existing = actor.viewStates.get(viewId);
  if (existing) return existing;
  const created = createPlaybackViewState(actor.rig, viewId);
  actor.viewStates.set(viewId, created);
  return created;
}

export function resolvePlaybackNodeId(
  actor: IKPlaybackActor,
  boneId: string,
  requestedView?: string,
): string | undefined {
  const viewState = ensurePlaybackViewState(actor, requestedView);
  return viewState.nodeIdByBoneId.get(boneId);
}

export function stagePlaybackView(
  timeline: gsap.core.Timeline,
  actor: IKPlaybackActor,
  requestedView: string | undefined,
  atTime: number,
): string {
  const viewId = resolveViewId(actor, requestedView);
  ensurePlaybackViewState(actor, viewId);
  timeline.set(actor.renderState, { currentView: viewId }, atTime);
  return viewId;
}

export function setPlaybackIntent(actor: IKPlaybackActor, intent: RigMotionIntent | undefined): void {
  actor.playbackState.currentIntent = intent;
  actor.playbackState.clipTimeSeconds = 0;
  actor.playbackState.durationSeconds = intent?.duration || 1;
  actor.playbackState.currentGoals = undefined;
  actor.viewStates.forEach((viewState) => {
    viewState.currentPose = undefined;
    viewState.appliedIntent = intent;
  });
}

export function syncPlaybackActors(actors: IKPlaybackActor[]): void {
  actors.forEach((actor) => {
    const viewId = resolveViewId(actor);
    const viewState = ensurePlaybackViewState(actor, viewId);
    const intent = actor.playbackState.currentIntent;

    if (!intent) {
      viewState.currentPose = undefined;
      viewState.appliedIntent = undefined;
      const restLayout = solvePoseFromGoals(viewState.graph, {
        normalizedTime: 0,
        effectorTargets: [],
        axialRotations: {},
        activePins: [],
        activeContacts: [],
      }, viewState.restPose);
      applyPoseToSvg(actor.actorGroup, viewState.graph, restLayout.layout, viewId);
      return;
    }

    if (viewState.appliedIntent !== intent) {
      viewState.currentPose = undefined;
      viewState.appliedIntent = intent;
    }

    const goals = evaluateMotionIntentAtTime(
      intent,
      viewState.graph,
      actor.playbackState.clipTimeSeconds,
    );
    actor.playbackState.currentGoals = goals;
    const solved = solvePoseFromGoals(viewState.graph, goals, viewState.restPose);
    viewState.currentPose = solved.pose;
    const layout = solved.layout;
    applyPoseToSvg(actor.actorGroup, viewState.graph, layout, viewId);
  });
}
