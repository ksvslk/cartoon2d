"use client";

import { useCallback, useRef } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TimelineDragCallbacks {
  /** Update an action's delay (for pill move) or duration (for pill resize). */
  onClipDrag: (actionIndex: number, update: { delay?: number; duration?: number }) => void;
  /** Called once when pill drag ends — used for final recompile. */
  onClipDragEnd: () => void;
  /** Scrub playhead to a time in seconds. */
  onPlayheadSeek: (timeSeconds: number) => void;
  /** Update selection state. */
  onSelect: (actionIndex: number | null, actorId: string | null, keyframe: "start" | "end" | null) => void;
  /** Stop playback (called when user starts dragging). */
  onStopPlayback: () => void;
}

export interface TimelineDragState {
  type: "pill-move" | "pill-resize" | "playhead" | null;
  actionIndex: number;
  actorId: string;
}

interface DragRef {
  type: "pill-move" | "pill-resize" | "playhead";
  actionIndex: number;
  actorId: string;
  startClientX: number;
  initialDelay: number;
  initialDuration: number;
}

/**
 * Snap-to-grid: snaps a time value to the nearest second if within threshold.
 * Hold Shift to disable snapping.
 */
export function snapToGrid(
  timeSeconds: number,
  shiftKey: boolean,
  snapThresholdSeconds: number = 0.08,
): number {
  if (shiftKey) return timeSeconds; // bypass snap
  const nearestSecond = Math.round(timeSeconds);
  return Math.abs(timeSeconds - nearestSecond) <= snapThresholdSeconds
    ? nearestSecond
    : timeSeconds;
}

/**
 * Convert a pixel delta on the timeline track area to a time delta in seconds.
 */
export function pixelDeltaToTimeDelta(
  deltaPixels: number,
  trackWidthPixels: number,
  totalDurationSeconds: number,
): number {
  if (trackWidthPixels <= 0 || totalDurationSeconds <= 0) return 0;
  return (deltaPixels / trackWidthPixels) * totalDurationSeconds;
}

/**
 * Convert a client X position to a time position on the timeline.
 */
export function clientXToTime(
  clientX: number,
  trackRect: DOMRect,
  scrollLeft: number,
  sidebarWidth: number,
  totalDurationSeconds: number,
): number {
  const localX = clientX - trackRect.left + scrollLeft - sidebarWidth;
  const trackWidth = trackRect.width - sidebarWidth;
  if (trackWidth <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, localX / trackWidth));
  return ratio * totalDurationSeconds;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useTimelineDrag(
  callbacks: TimelineDragCallbacks,
  totalDuration: number,
  getTrackWidth: () => number,
) {
  const dragRef = useRef<DragRef | null>(null);

  const handlePillPointerDown = useCallback(
    (
      e: React.PointerEvent | React.MouseEvent,
      actionIndex: number,
      actorId: string,
      startTime: number,
      duration: number,
      mode: "move" | "resize",
    ) => {
      if ((e as React.MouseEvent).button !== undefined && (e as React.MouseEvent).button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      callbacks.onStopPlayback();
      callbacks.onSelect(actionIndex, actorId, null);

      dragRef.current = {
        type: mode === "move" ? "pill-move" : "pill-resize",
        actionIndex,
        actorId,
        startClientX: e.clientX,
        initialDelay: startTime,
        initialDuration: duration,
      };

      const handleMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const trackWidth = getTrackWidth();
        const deltaX = ev.clientX - drag.startClientX;
        const deltaSec = pixelDeltaToTimeDelta(deltaX, trackWidth, totalDuration);

        if (drag.type === "pill-move") {
          const rawDelay = drag.initialDelay + deltaSec;
          const snappedDelay = snapToGrid(Math.max(0, rawDelay), ev.shiftKey);
          callbacks.onClipDrag(drag.actionIndex, { delay: snappedDelay });
          callbacks.onPlayheadSeek(snappedDelay);
        } else {
          const rawDuration = drag.initialDuration + deltaSec;
          const snappedDuration = Math.max(0.1, snapToGrid(rawDuration, ev.shiftKey, 0.08));
          callbacks.onClipDrag(drag.actionIndex, { duration: snappedDuration });
          callbacks.onPlayheadSeek(drag.initialDelay + snappedDuration);
        }
      };

      const handleUp = () => {
        const wasPill = dragRef.current?.type === "pill-move" || dragRef.current?.type === "pill-resize";
        dragRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        if (wasPill) callbacks.onClipDragEnd();
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [callbacks, totalDuration, getTrackWidth],
  );

  const handlePlayheadPointerDown = useCallback(
    (e: React.PointerEvent | React.MouseEvent) => {
      if ((e as React.MouseEvent).button !== undefined && (e as React.MouseEvent).button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      callbacks.onStopPlayback();

      dragRef.current = {
        type: "playhead",
        actionIndex: -1,
        actorId: "",
        startClientX: e.clientX,
        initialDelay: 0,
        initialDuration: 0,
      };

      // We need the ruler element to compute position
      const rulerEl = (e.target as HTMLElement).closest("[data-timeline-ruler]");
      if (!rulerEl) return;

      const sidebarWidth = 192;

      const seekFromEvent = (ev: MouseEvent) => {
        const rect = rulerEl.getBoundingClientRect();
        const scrollLeft = (rulerEl as HTMLElement).scrollLeft || 0;
        const time = clientXToTime(ev.clientX, rect, scrollLeft, sidebarWidth, totalDuration);
        callbacks.onPlayheadSeek(snapToGrid(Math.max(0, Math.min(totalDuration, time)), ev.shiftKey));
      };

      seekFromEvent(e as unknown as MouseEvent);

      const handleMove = (ev: MouseEvent) => seekFromEvent(ev);
      const handleUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [callbacks, totalDuration],
  );

  const handleRulerClick = useCallback(
    (e: React.MouseEvent, rulerEl: HTMLElement) => {
      const sidebarWidth = 192;
      const rect = rulerEl.getBoundingClientRect();
      const scrollLeft = rulerEl.scrollLeft || 0;
      const time = clientXToTime(e.clientX, rect, scrollLeft, sidebarWidth, totalDuration);
      callbacks.onStopPlayback();
      callbacks.onPlayheadSeek(snapToGrid(Math.max(0, Math.min(totalDuration, time)), e.shiftKey));
    },
    [callbacks, totalDuration],
  );

  return {
    isDragging: !!dragRef.current,
    handlePillPointerDown,
    handlePlayheadPointerDown,
    handleRulerClick,
  };
}
