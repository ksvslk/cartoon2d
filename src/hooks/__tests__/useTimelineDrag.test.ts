import { describe, it, expect } from "vitest";
import { snapToGrid, pixelDeltaToTimeDelta, clientXToTime } from "@/hooks/useTimelineDrag";

// ── snapToGrid ─────────────────────────────────────────────────────────────────

describe("snapToGrid", () => {
  it("snaps to nearest second when within threshold", () => {
    expect(snapToGrid(1.05, false)).toBe(1);
    expect(snapToGrid(2.97, false)).toBe(3);
    expect(snapToGrid(0.04, false)).toBe(0);
  });

  it("does not snap when outside threshold", () => {
    expect(snapToGrid(1.15, false)).toBe(1.15);
    expect(snapToGrid(2.5, false)).toBe(2.5);
    expect(snapToGrid(0.3, false)).toBe(0.3);
  });

  it("bypasses snap when Shift is held", () => {
    expect(snapToGrid(1.05, true)).toBe(1.05);
    expect(snapToGrid(2.97, true)).toBe(2.97);
  });

  it("respects custom threshold", () => {
    expect(snapToGrid(1.15, false, 0.2)).toBe(1);
    expect(snapToGrid(1.15, false, 0.1)).toBe(1.15);
  });

  it("handles zero and negative values", () => {
    expect(snapToGrid(0, false)).toBe(0);
    expect(Math.abs(snapToGrid(-0.03, false))).toBe(0);
  });
});

// ── pixelDeltaToTimeDelta ──────────────────────────────────────────────────────

describe("pixelDeltaToTimeDelta", () => {
  it("converts pixels to seconds proportionally", () => {
    // 100px of 1000px at 10s total = 1s
    expect(pixelDeltaToTimeDelta(100, 1000, 10)).toBe(1);
  });

  it("handles negative delta (drag left)", () => {
    expect(pixelDeltaToTimeDelta(-200, 1000, 10)).toBe(-2);
  });

  it("returns 0 for zero track width", () => {
    expect(pixelDeltaToTimeDelta(100, 0, 10)).toBe(0);
  });

  it("returns 0 for zero total duration", () => {
    expect(pixelDeltaToTimeDelta(100, 1000, 0)).toBe(0);
  });

  it("handles fractional pixels", () => {
    const result = pixelDeltaToTimeDelta(50, 1000, 10);
    expect(result).toBeCloseTo(0.5);
  });
});

// ── clientXToTime ──────────────────────────────────────────────────────────────

describe("clientXToTime", () => {
  const makeDomRect = (x: number, width: number): DOMRect => ({
    x,
    y: 0,
    width,
    height: 40,
    top: 0,
    right: x + width,
    bottom: 40,
    left: x,
    toJSON: () => ({}),
  });

  const sidebarWidth = 192;

  it("returns 0 at the sidebar boundary", () => {
    const rect = makeDomRect(0, 1000);
    const time = clientXToTime(sidebarWidth, rect, 0, sidebarWidth, 10);
    expect(time).toBe(0);
  });

  it("returns totalDuration at the right edge", () => {
    const rect = makeDomRect(0, 1000);
    const time = clientXToTime(1000, rect, 0, sidebarWidth, 10);
    expect(time).toBe(10);
  });

  it("returns proportional time in the middle", () => {
    const rect = makeDomRect(0, 1000);
    // 192 (sidebar) + 404 (half of 808 track area) = 596
    const time = clientXToTime(596, rect, 0, sidebarWidth, 10);
    expect(time).toBeCloseTo(5, 0);
  });

  it("clamps to 0 for positions before sidebar", () => {
    const rect = makeDomRect(0, 1000);
    const time = clientXToTime(50, rect, 0, sidebarWidth, 10);
    expect(time).toBe(0);
  });

  it("accounts for scrollLeft", () => {
    const rect = makeDomRect(0, 1000);
    // Without scroll, clientX=596 gives ~5s
    // With scrollLeft=100, effectively shifts right by 100px
    const time = clientXToTime(596, rect, 100, sidebarWidth, 10);
    expect(time).toBeGreaterThan(5);
  });
});
