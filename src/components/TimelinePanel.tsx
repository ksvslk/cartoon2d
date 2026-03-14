"use client";

import { ClipBinding, CompiledSceneData, StoryBeatData, StoryGenerationData, StageOrientation } from "@/lib/schema/story";
import { Play, Mountain, ChevronDown, ChevronUp, Bug } from "lucide-react";

// ── Props ──────────────────────────────────────────────────────────────────────

export interface TimelinePanelProps {
  // Data
  storyData: StoryGenerationData | null;
  selectedSceneIndex: number;
  selectedBeat: StoryBeatData | null | undefined;
  compiledScene: CompiledSceneData | null | undefined;
  actorReferences: Record<string, string>;

  // Playback state
  isPlaying: boolean;
  fps: number;
  totalDuration: number;
  totalFrames: number;
  currentFrame: number;
  playheadPos: number;
  isDraggingPlayhead: boolean;
  loopPlayback: boolean;
  playbackScope: "scene" | "all";
  exportProgress: string | null;

  // Timeline UI state
  timelineZoom: number;
  showObstacleDebug: boolean;

  // Selection state
  selectedActionIndex: number | null;
  selectedActorId: string | null;
  isCameraSelected: boolean;
  selectedKeyframe: "start" | "end" | null;

  // Refs
  timelineRef: React.RefObject<HTMLDivElement | null>;
  tracksRef: React.RefObject<HTMLDivElement | null>;

  // Data handlers
  onSceneSelect: (index: number) => void;
  onSetFps: (fps: 12 | 24 | 30 | 60) => void;
  onSetTimelineZoom: (zoom: number) => void;
  onToggleObstacleDebug: () => void;

  // Transport handlers
  onJumpToStart: () => void;
  onTogglePlayback: () => void;
  onJumpToEnd: () => void;
  onSetPlaybackScope: (scope: "scene" | "all") => void;
  onToggleLoop: () => void;
  onSetDraggingPlayhead: (dragging: boolean) => void;

  // Selection handlers
  onSelectAction: (actionIndex: number | null) => void;
  onSelectActor: (actorId: string | null) => void;
  onSelectCamera: (selected: boolean) => void;
  onSelectKeyframe: (keyframe: "start" | "end" | null) => void;

  // Playhead
  onSetIsPlaying: (playing: boolean) => void;
  onSetPlayheadPos: (pos: number) => void;
  onPlayheadUpdate: (time: number) => void;

  // Track actions
  onLayerMove: (actorId: string, direction: -1 | 1) => void;
  onPillMouseDown: (e: React.MouseEvent, actionIndex: number, actorId: string, startTime: number, duration: number, mode: "move" | "resize") => void;
  onAddAction: (actorId: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function TimelinePanel(props: TimelinePanelProps) {
  const {
    storyData,
    selectedSceneIndex,
    selectedBeat,
    compiledScene,
    actorReferences,
    isPlaying,
    fps,
    totalDuration,
    totalFrames,
    currentFrame,
    playheadPos,
    isDraggingPlayhead,
    loopPlayback,
    playbackScope,
    exportProgress,
    timelineZoom,
    showObstacleDebug,
    selectedActionIndex,
    selectedActorId,
    isCameraSelected,
    selectedKeyframe,
    timelineRef,
    tracksRef,
    onSceneSelect,
    onSetFps,
    onSetTimelineZoom,
    onToggleObstacleDebug,
    onJumpToStart,
    onTogglePlayback,
    onJumpToEnd,
    onSetPlaybackScope,
    onToggleLoop,
    onSetDraggingPlayhead,
    onSelectAction,
    onSelectActor,
    onSelectCamera,
    onSelectKeyframe,
    onSetIsPlaying,
    onSetPlayheadPos,
    onPlayheadUpdate,
    onLayerMove,
    onPillMouseDown,
    onAddAction,
  } = props;

  const beat = selectedBeat;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/90 dark:bg-[#0a0a0a]/90 backdrop-blur-xl shadow-lg dark:shadow-2xl mx-6 mb-6 flex flex-col overflow-hidden transition-colors duration-300">

        {/* 1. Timeline Toolbar (Global Transport Controls) */}
        <div className="min-h-12 border-b border-neutral-200 dark:border-neutral-800/60 bg-neutral-50 dark:bg-[#0a0a0a] flex flex-wrap items-center gap-3 px-4 py-2 shrink-0 shadow-sm z-30 relative transition-colors duration-300">
          {/* Left Side: Scene info + FPS */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="text-[10px] font-bold text-neutral-600 dark:text-neutral-300 uppercase tracking-widest bg-white dark:bg-neutral-900 px-2 py-1.5 rounded border border-neutral-200 dark:border-neutral-800 shadow-sm dark:shadow-none transition-colors">
              Scene {selectedSceneIndex + 1}
            </div>
            {storyData && storyData.beats.length > 1 && (
              <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar max-w-40">
                {storyData.beats.map((b, index) => (
                  <button
                    key={`timeline-scene-tab-${b.scene_number}-${index}`}
                    type="button"
                    onClick={() => onSceneSelect(index)}
                    className={`shrink-0 rounded border px-1.5 py-1 text-[9px] font-bold transition-colors ${selectedSceneIndex === index
                        ? "border-cyan-400 bg-cyan-500 text-white"
                        : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                      }`}
                    title={`Switch to Scene ${b.scene_number}`}
                  >
                    {b.scene_number}
                  </button>
                ))}
              </div>
            )}
            {/* FPS selector */}
            <div className="flex items-center bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden shadow-sm">
              {([12, 24, 30, 60] as const).map(f => (
                <button
                  key={f}
                  onClick={() => onSetFps(f)}
                  className={`px-1.5 py-1 text-[9px] font-bold transition-colors ${fps === f ? 'bg-cyan-500 text-white' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'}`}
                >{f}</button>
              ))}
            </div>

            <div className="flex items-center gap-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1 shadow-sm h-6">
              <span className="text-[8px] font-bold text-neutral-400">ZOOM</span>
              <input type="range" min="0.5" max="4" step="0.1" value={timelineZoom} onChange={(e) => onSetTimelineZoom(parseFloat(e.target.value))} className="w-16 h-1 scale-75 transform origin-left bg-neutral-200 dark:bg-neutral-700 rounded appearance-none" />
            </div>
            <button
              type="button"
              onClick={onToggleObstacleDebug}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[9px] font-bold transition-colors ${showObstacleDebug
                  ? "border-amber-400 bg-amber-500 text-black"
                  : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                }`}
              title="Toggle obstacle debug overlay"
            >
              <Bug size={10} />
              Collision
            </button>
          </div>

          {/* Center: Transport Controls */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onJumpToStart}
                className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group"
                title="Jump to start"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
              </button>
              <button
                type="button"
                onClick={onTogglePlayback}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all group ${isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-[#0a0a0a] shadow-[0_0_10px_rgba(245,158,11,0.3)]' : 'bg-emerald-500 hover:bg-emerald-400 text-white dark:text-[#0a0a0a] shadow-[0_0_10px_rgba(16,185,129,0.3)] hover:shadow-[0_0_15px_rgba(16,185,129,0.4)]'}`}
                title={isPlaying ? "Pause" : "Play"}
                disabled={!selectedBeat}
              >
                {isPlaying ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg> : <Play size={15} className="fill-current ml-0.5 group-hover:scale-110 transition-transform" />}
              </button>
              <button
                type="button"
                onClick={onJumpToEnd}
                className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group"
                title="Jump to end"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M4 18l8.5-6L4 6v12zm13-12v12h2V6h-2z" /></svg>
              </button>
            </div>

            <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-800/60" />

            {/* Playback Modes */}
            <div className="flex items-center gap-1 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded p-1 shadow-sm dark:shadow-none transition-colors">
              <button
                onClick={() => onSetPlaybackScope("scene")}
                className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'scene' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                title="Export or operate on this scene only"
              >
                Scene
              </button>
              <button
                onClick={() => onSetPlaybackScope("all")}
                className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'all' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                title="Export all compiled scenes sequentially"
              >
                All
              </button>
            </div>

            <button
              type="button"
              onClick={onToggleLoop}
              className={`transition-colors p-1.5 rounded ${loopPlayback
                  ? "text-emerald-500 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                  : "text-neutral-400 dark:text-neutral-600 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                }`}
              title={loopPlayback ? "Loop playback enabled" : "Enable loop playback"}
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8" /><path d="M21 3v5h-5" /><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" /><path d="M3 21v-5h5" /></svg>
            </button>
          </div>

          {/* Right Side: frame counter */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {exportProgress && (
              <span className="max-w-40 truncate text-[9px] font-mono text-cyan-600 dark:text-cyan-400" title={exportProgress}>
                {exportProgress}
              </span>
            )}
            <span className="text-[10px] font-mono text-neutral-500 dark:text-neutral-500">{fps}fps</span>
            <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-500 font-bold bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-500/20 shadow-sm dark:shadow-none transition-colors">
              {String(currentFrame).padStart(3, '0')} / {String(totalFrames).padStart(3, '0')}
            </span>
          </div>
        </div>

        {/* 2. Timeline Ruler Header (Track Labels & Time Ticks) */}
        <div className="h-8 border-b border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#111] shrink-0 z-30 relative transition-colors duration-300 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" ref={timelineRef} onScroll={(e) => {
          if (tracksRef.current && tracksRef.current.scrollLeft !== e.currentTarget.scrollLeft) {
            tracksRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}>
          <div className="flex h-full" style={{ minWidth: `${Math.max(100, (totalDuration / 15) * 100 * timelineZoom)}%` }}>
            <div className="w-48 border-r border-neutral-200 dark:border-neutral-800/60 h-full flex items-center px-4 bg-neutral-50 dark:bg-[#0a0a0a] shrink-0 transition-colors z-40 sticky left-0">
              <span className="text-[10px] text-neutral-500 dark:text-neutral-600 font-bold uppercase tracking-wider">Layers</span>
            </div>
            <div className="flex-1 h-full relative transition-colors pointer-events-none">
              {/* Playhead line + knob */}
            <div className="absolute top-0 bottom-0 w-[2px] bg-emerald-500/80 z-50 pointer-events-none dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)]" style={{ left: `${playheadPos}%` }}>
              <div
                className={`absolute top-0 left-1/2 -translate-x-1/2 w-4 h-5 bg-gradient-to-b from-emerald-400 to-emerald-600 rounded-b-[4px] cursor-grab active:cursor-grabbing border-b border-l border-r border-emerald-300 shadow-[0_2px_10px_rgba(16,185,129,0.5)] pointer-events-auto flex items-center justify-center flex-col gap-[2px] ${isDraggingPlayhead ? 'scale-110' : ''}`}
                onMouseDown={() => onSetDraggingPlayhead(true)}
              >
                <span className="w-2 h-px bg-emerald-200/80"></span>
                <span className="w-2 h-px bg-emerald-200/80"></span>
                <span className="w-2 h-px bg-emerald-200/80"></span>
              </div>
            </div>

            {/* Frame grid + second labels */}
            <div className="absolute inset-0 flex items-end pb-1 pointer-events-none select-none overflow-hidden">
              {Array.from({ length: Math.ceil(totalDuration) + 1 }).map((_, s) => {
                const pct = (s / totalDuration) * 100;
                return (
                  <div key={s} className="absolute top-0 bottom-0 flex flex-col items-center" style={{ left: `${pct}%` }}>
                    <div className="w-px h-3 bg-neutral-300 dark:bg-neutral-700 mt-auto" />
                    <span className="text-[8px] font-mono text-neutral-400 dark:text-neutral-600 mt-0.5 -translate-x-1/2">{s}s</span>
                  </div>
                );
              })}
              {/* Minor frame ticks (every N frames based on fps) */}
              {Array.from({ length: totalFrames + 1 }).map((_, f) => {
                if (f % fps === 0) return null; // skip second marks (already drawn)
                const tickInterval = fps <= 12 ? 1 : fps <= 24 ? 4 : 6;
                if (f % tickInterval !== 0) return null;
                const pct = (f / totalFrames) * 100;
                return (
                  <div key={`f${f}`} className="absolute bottom-1" style={{ left: `${pct}%` }}>
                    <div className="w-px h-1.5 bg-neutral-200 dark:bg-neutral-800" />
                  </div>
                );
              })}
            </div>
            </div>
          </div>
        </div>

        {/* 3. Timeline Tracks */}
        <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar flex flex-col relative pb-8" ref={tracksRef} onScroll={(e) => {
          if (timelineRef.current && timelineRef.current.scrollLeft !== e.currentTarget.scrollLeft) {
            timelineRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}>
          <div className="flex flex-col relative" style={{ minWidth: `${Math.max(100, (totalDuration / 15) * 100 * timelineZoom)}%` }}>
            
            {/* Playhead line extension correctly overlaying all tracks */}
            <div className="absolute inset-0 flex pointer-events-none z-[100]">
              <div className="w-48 shrink-0" />
              <div className="flex-1 relative overflow-hidden">
                <div className="absolute top-0 bottom-0 w-[2px] bg-emerald-500/80 dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)]" style={{ left: `${playheadPos}%` }} />
              </div>
            </div>

          {!storyData || storyData.beats.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-neutral-500 font-mono">No scene selected.</div>
          ) : (() => {
            if (!beat) return null;
            return (
              <>
                {/* Background / Environment Layer */}
                <div className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                  <div className="w-48 h-full flex items-center gap-2 px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors z-30 sticky left-0">
                    <Mountain size={10} className="text-neutral-400 dark:text-neutral-600 shrink-0" />
                    <span className="text-[10px] text-neutral-500 dark:text-neutral-500 font-medium truncate">Background</span>
                    {beat.drafted_background && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-auto shrink-0" title="Background generated" />}
                  </div>
                  <div className="flex-1 h-full relative overflow-hidden pointer-events-none">
                    {beat.compiled_scene?.background_ambient?.length ? (
                      beat.compiled_scene.background_ambient.map(binding => {
                        const duration = totalDuration > 0 ? totalDuration : Math.max(beat.compiled_scene?.duration_seconds || 1, 1);
                        const visibleDuration = Math.min(binding.duration_seconds, duration);
                        const left = `${(binding.start_time / duration) * 100}%`;
                        const width = `${Math.max((visibleDuration / duration) * 100, 3)}%`;
                        return (
                          <div
                            key={binding.id}
                            className="absolute inset-y-1.5 rounded bg-repeating-gradient opacity-50 dark:opacity-30 pointer-events-auto cursor-pointer"
                            onClick={() => { onSelectAction(null); onSelectActor(null); onSelectCamera(false); }}
                            style={{
                              left,
                              width,
                              background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.15) 8px, rgba(99,102,241,0.15) 9px)',
                            }}
                            title={`${binding.target_id} (${binding.label})`}
                          >
                            <div className="absolute inset-0 border border-indigo-200 dark:border-indigo-700/30 rounded" />
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-indigo-400 dark:text-indigo-500 select-none truncate max-w-[85%]">
                              {binding.label} ↻
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="absolute inset-y-1.5 left-0 right-0 rounded bg-repeating-gradient opacity-20 dark:opacity-10 pointer-events-auto"
                        style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.15) 8px, rgba(99,102,241,0.15) 9px)' }}>
                        <div className="absolute inset-0 border border-indigo-200 dark:border-indigo-700/20 rounded" />
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-indigo-300 dark:text-indigo-700 select-none">no bg motion</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Camera Layer */}
                <div 
                  className={`h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track transition-colors cursor-pointer ${isCameraSelected ? 'bg-amber-50 dark:bg-amber-900/10' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/50'}`}
                  onClick={() => {
                    onSelectCamera(true);
                    onSelectAction(null);
                    onSelectActor(null);
                    onSelectKeyframe(null);
                  }}
                >
                  <div className={`w-48 h-full flex items-center gap-2 px-4 border-r border-neutral-200 dark:border-neutral-800/60 shrink-0 transition-colors z-30 sticky left-0 ${isCameraSelected ? 'bg-amber-100 dark:bg-amber-900/20' : 'bg-white dark:bg-[#0f0f0f]'}`}>
                    <svg viewBox="0 0 24 24" className="w-3 h-3 text-neutral-400 dark:text-neutral-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                    <span className={`text-[10px] font-medium truncate ${isCameraSelected ? 'text-amber-700 dark:text-amber-500' : 'text-neutral-500 dark:text-neutral-500'}`}>Camera</span>
                  </div>
                  <div className="flex-1 h-full relative overflow-visible pointer-events-none">
                    <div
                      className={`absolute inset-y-2 left-0 right-0 rounded flex items-center px-2 transition-all z-10 pointer-events-auto border ${isCameraSelected ? 'bg-amber-100/80 dark:bg-amber-900/40 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 shadow-sm' : 'bg-neutral-100 dark:bg-neutral-800/60 border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400'}`}
                    >
                      <div 
                        className="absolute left-1 top-1/2 -translate-y-1/2 flex items-center justify-center transition-transform z-20 cursor-pointer shadow-sm hover:scale-105" 
                        title="Jump to Start"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetIsPlaying(false);
                          onSetPlayheadPos(0);
                          onPlayheadUpdate(0);
                          onSelectKeyframe('start');
                        }}
                      >
                        <div className={`flex items-center justify-center px-1.5 py-0.5 rounded-[4px] outline outline-2 ${isCameraSelected && selectedKeyframe === 'start' ? 'outline-amber-500 bg-amber-100 dark:bg-amber-900 shadow-[0_0_8px_rgba(245,158,11,0.8)] text-amber-700 dark:text-amber-300' : isCameraSelected ? 'outline-amber-400 bg-white dark:bg-neutral-900 text-amber-600 dark:text-amber-500' : 'outline-neutral-400 dark:outline-neutral-500 bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400'} text-[8px] font-bold uppercase tracking-widest pointer-events-none`}>
                          Start
                        </div>
                      </div>

                      <span className="text-[10px] font-mono font-medium truncate pl-2 mx-auto select-none opacity-80 pointer-events-none">
                        {beat.camera && (beat.camera.target_x !== undefined || beat.camera.target_actor_id) ? "Cinematic Pan / Follow" : "Static Camera"}
                      </span>

                      <div 
                        className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center transition-transform z-20 cursor-pointer shadow-sm hover:scale-105" 
                        title="Jump to End"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetIsPlaying(false);
                          const newTime = totalDuration > 0 ? totalDuration : Math.max(beat.compiled_scene?.duration_seconds || 1, 1);
                          onSetPlayheadPos(100);
                          onPlayheadUpdate(newTime);
                          onSelectKeyframe('end');
                        }}
                      >
                        <div className={`flex items-center justify-center px-1.5 py-0.5 rounded-[4px] outline outline-2 ${isCameraSelected && selectedKeyframe === 'end' ? 'outline-amber-500 bg-amber-100 dark:bg-amber-900 shadow-[0_0_8px_rgba(245,158,11,0.8)] text-amber-700 dark:text-amber-300' : isCameraSelected ? 'outline-amber-400 bg-white dark:bg-neutral-900 text-amber-600 dark:text-amber-500' : 'outline-neutral-400 dark:outline-neutral-500 bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400'} text-[8px] font-bold uppercase tracking-widest pointer-events-none`}>
                          End
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actor Layers */}
                {(() => {
                  const tracks = beat.compiled_scene?.instance_tracks.length
                    ? beat.compiled_scene.instance_tracks.map(track => {
                        const fallbackZ = Math.max(
                          ...(beat.actions.filter(a => a.actor_id === track.actor_id).map(a => a.spatial_transform?.z_index ?? 10))
                        );
                        const trackZ = track.transform_track[0]?.z_index;
                        return {
                          actorId: track.actor_id,
                          zIndexLevel: trackZ !== undefined ? trackZ : fallbackZ,
                          bindings: track.clip_bindings,
                        };
                      })
                    : Array.from(new Set(beat.actions.map(a => a.actor_id))).map(actorId => {
                        const actorActions = beat.actions.filter(a => a.actor_id === actorId);
                        return {
                          actorId,
                          zIndexLevel: Math.max(...actorActions.map(a => a.spatial_transform?.z_index ?? 10)),
                          bindings: beat.actions
                            .map((action, idx) => ({ action, idx }))
                            .filter(entry => entry.action.actor_id === actorId)
                            .map(entry => ({
                              id: `${actorId}:${entry.idx}:${entry.action.motion}`,
                              actor_id: actorId,
                              source_action_index: entry.idx,
                              motion: entry.action.motion,
                              style: entry.action.style,
                              clip_id: entry.action.motion,
                              start_time: entry.action.animation_overrides?.delay ?? 0,
                              duration_seconds: entry.action.duration_seconds || 2,
                              start_transform: {
                                x: entry.action.spatial_transform?.x ?? 960,
                                y: entry.action.spatial_transform?.y ?? 950,
                                scale: entry.action.spatial_transform?.scale ?? 0.5,
                                z_index: entry.action.spatial_transform?.z_index ?? 10,
                              },
                            })),
                        };
                    });
                    
                  return tracks.sort((a, b) => b.zIndexLevel - a.zIndexLevel);
                })().map(({ actorId, bindings }) => {
                  const actorData = storyData?.actors_detected.find(a => a.id === actorId);
                  const hasRig = !!actorData?.drafted_rig;
                  const hasIdleClip = !!actorData?.drafted_rig?.rig_data.motion_clips?.idle;

                  return (
                    <div key={`track-${actorId}`} className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                      <div className="w-48 h-full flex items-center gap-2 px-3 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors group/trackheader relative z-20">
                        <div className="w-5 h-5 rounded shrink-0 bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                          {actorReferences[actorId]
                            ? <img src={actorReferences[actorId]} alt="" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-[8px] text-neutral-400">?</div>}
                        </div>
                        <span className="text-[10px] text-neutral-700 dark:text-neutral-300 font-medium truncate flex-1">{actorData?.name || actorId}</span>
                        
                        <div className="hidden group-hover/trackheader:flex items-center gap-0.5 absolute right-6 bg-white dark:bg-[#0f0f0f] px-1 shadow-sm rounded">
                          <button 
                            onClick={() => onLayerMove(actorId, -1)}
                            className="text-neutral-400 hover:text-cyan-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded p-0.5 transition-colors" title="Bring Forward">
                            <ChevronUp size={12}/>
                          </button>
                          <button 
                            onClick={() => onLayerMove(actorId, 1)}
                            className="text-neutral-400 hover:text-cyan-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded p-0.5 transition-colors" title="Send Backward">
                            <ChevronDown size={12}/>
                          </button>
                        </div>

                        {hasRig && <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0 ml-auto" title="Rig ready" />}
                      </div>
                      <div className="flex-1 h-full relative overflow-visible">
                        {hasIdleClip && (
                          <div
                            className="absolute inset-y-1.5 left-0 right-0 rounded"
                            style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.08) 8px, rgba(99,102,241,0.08) 9px)', border: '1px solid rgba(99,102,241,0.15)' }}
                          >
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-indigo-300 dark:text-indigo-700 select-none">idle ↻</span>
                          </div>
                        )}

                        {bindings.map((binding: ClipBinding) => {
                          const clipStartPct = Math.min(100, ((binding.start_time || 0) / totalDuration) * 100);
                          const clipWidthPct = Math.min(100, ((binding.duration_seconds || 2) / totalDuration) * 100);
                          const isSelected = selectedActionIndex === binding.source_action_index;
                          const isIdleMotion = ['idle', 'stare'].includes(binding.motion.toLowerCase());
                          const bindingLabel = binding.clip_id === "base_object" ? `${binding.motion} • object` : binding.motion;
                          return (
                            <div
                              key={binding.id}
                              className={`absolute inset-y-2 rounded flex items-center px-2 cursor-pointer transition-all z-10 group/pill ${isSelected
                                  ? 'bg-cyan-500/10 border border-cyan-400 text-cyan-800 dark:text-cyan-200 shadow-sm'
                                  : isIdleMotion 
                                    ? 'bg-neutral-100 dark:bg-neutral-700/50 border border-neutral-300 dark:border-neutral-600/50 hover:bg-neutral-200 dark:hover:bg-neutral-600/70 text-neutral-600 dark:text-neutral-300'
                                    : 'bg-blue-100 dark:bg-blue-600/25 border border-blue-300 dark:border-blue-500/50 hover:bg-blue-200 dark:hover:bg-blue-600/35 text-blue-700 dark:text-blue-300'
                                }`}
                              style={{ left: `${clipStartPct}%`, width: `${clipWidthPct}%`, minWidth: '24px' }}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                onSelectKeyframe(null);
                                onPillMouseDown(e, binding.source_action_index, actorId, binding.start_time, binding.duration_seconds, 'move');
                              }}
                              onClick={() => {
                                onSelectCamera(false);
                                onSelectAction(binding.source_action_index);
                                onSelectActor(actorId);
                                onSelectKeyframe(null);
                                onSetPlayheadPos(totalDuration > 0 ? (binding.start_time / totalDuration) * 100 : 0);
                              }}
                            >
                              <div 
                                className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 flex items-center justify-center group-hover/pill:scale-110 transition-transform z-20 cursor-pointer" 
                                title="Select Start Keyframe"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  onSelectCamera(false);
                                  onSetIsPlaying(false);
                                  onSelectAction(binding.source_action_index);
                                  onSelectActor(actorId);
                                  onSelectKeyframe('start');
                                  const newTime = binding.start_time;
                                  const newPos = totalDuration > 0 ? (newTime / totalDuration) * 100 : 0;
                                  onSetPlayheadPos(newPos);
                                  onPlayheadUpdate(newTime);
                                }}
                              >
                                <div className={`w-2.5 h-2.5 outline outline-2 ${isSelected && selectedKeyframe === 'start' ? 'outline-cyan-400 bg-cyan-100 dark:bg-cyan-900 shadow-[0_0_8px_rgba(6,182,212,0.8)]' : isSelected ? 'outline-cyan-500 bg-white dark:bg-neutral-900' : 'outline-blue-400 dark:outline-blue-500 bg-white dark:bg-neutral-800 group-hover/pill:outline-blue-500 dark:group-hover/pill:outline-blue-400'}`} />
                              </div>

                              <span className="text-[10px] font-mono font-medium truncate pl-2 user-select-none opacity-90 mx-auto pointer-events-none">{bindingLabel}</span>
                              {binding.style && <span className="text-[9px] font-mono ml-1 truncate user-select-none opacity-70 pointer-events-none">({binding.style})</span>}
                              
                              {/* End Keyframe Node */}
                              <div 
                                className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 flex items-center justify-center group-hover/pill:scale-110 transition-transform z-20 cursor-pointer" 
                                title="Select End Keyframe"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  onSelectCamera(false);
                                  onSetIsPlaying(false);
                                  onSelectAction(binding.source_action_index);
                                  onSelectActor(actorId);
                                  onSelectKeyframe('end');
                                  const newTime = binding.start_time + binding.duration_seconds;
                                  const newPos = totalDuration > 0 ? (newTime / totalDuration) * 100 : 0;
                                  onSetPlayheadPos(newPos);
                                  onPlayheadUpdate(newTime);
                                }}
                              >
                                <div className={`w-2.5 h-2.5 outline outline-2 ${isSelected && selectedKeyframe === 'end' ? 'outline-cyan-400 bg-cyan-100 dark:bg-cyan-900 shadow-[0_0_8px_rgba(6,182,212,0.8)]' : isSelected ? 'outline-cyan-500 bg-white dark:bg-neutral-900' : 'outline-blue-400 dark:outline-blue-500 bg-white dark:bg-neutral-800 group-hover/pill:outline-blue-500 dark:group-hover/pill:outline-blue-400'}`} />
                              </div>
                              
                              {/* Edge Grabber for Resizing Duration */}
                              <div 
                                className="absolute -right-3.5 top-0 bottom-0 w-3 cursor-col-resize z-30 flex items-center justify-center opacity-0 group-hover/pill:opacity-100 transition-opacity"
                                onMouseDown={(e) => {
                                  if (e.button !== 0) return;
                                  e.stopPropagation();
                                  onPillMouseDown(e, binding.source_action_index, actorId, binding.start_time, binding.duration_seconds, 'resize');
                                }}
                                title="Drag to resize clip duration"
                              >
                                <div className="w-[3px] h-3 bg-cyan-500/80 rounded-full" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <button 
                        className="w-10 flex flex-col items-center justify-center shrink-0 border-l border-neutral-200 dark:border-neutral-800/40 bg-neutral-50/50 hover:bg-neutral-100 dark:bg-neutral-900/30 dark:hover:bg-neutral-800/50 transition-colors opacity-0 group-hover/track:opacity-100"
                        title={`Add action for ${actorData?.name || actorId}`}
                        onClick={() => onAddAction(actorId)}
                      >
                        <span className="text-neutral-400 dark:text-neutral-500 font-mono text-base leading-none block pb-0.5">+</span>
                      </button>
                    </div>
                  );
                })}
              </>
            );
          })()}
          </div>
        </div>
      </div>
    </div>
  );
}
