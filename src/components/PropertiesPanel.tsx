"use client";

import { ClipBinding, CompiledSceneData, SpatialTransform, StoryBeatData, StoryGenerationData } from "@/lib/schema/story";
import { findCompiledBinding } from "@/lib/utils/story_helpers";
import { motionNeedsTarget } from "@/lib/motion/semantics";
import { Play, Bug, SlidersHorizontal } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Partial action update — any fields that should change on the action at selectedActionIndex */
export type ActionUpdate = {
  motion?: string;
  style?: string;
  duration_seconds?: number;
  spatial_transform?: Partial<SpatialTransform>;
  target_spatial_transform?: Partial<SpatialTransform> | null;
  animation_overrides?: Record<string, unknown>;
};

export interface PropertiesPanelProps {
  storyData: StoryGenerationData | null;
  selectedSceneIndex: number;
  selectedActionIndex: number | null;
  selectedActorId: string | null;
  selectedAudioIndex: number | null;
  selectedCameraIndex: number | null;
  selectedKeyframe: "start" | "end" | null;
  actorReferences: Record<string, string>;

  // Callbacks
  onSelectKeyframe: (kf: "start" | "end" | null) => void;
  onSelectAction: (actionIndex: number | null) => void;
  onSelectActor: (actorId: string | null) => void;

  /** Update camera start/end properties. key = camera field name, value = new value. */
  onUpdateCamera: (key: string, value: unknown) => void;

  /** Update an action field. Merges into the action at selectedActionIndex. */
  onUpdateAction: (update: ActionUpdate) => void;
  /** Update an audio track field. Merges into the audio at selectedAudioIndex. */
  onUpdateAudio: (idx: number, updates: Partial<StoryBeatData["audio"][0]>) => void;
  /** Delete the currently selected action. */
  onDeleteAction: () => void;
  /** Update collision behavior for the current action. */
  onUpdateCollisionBehavior: (value: "halt" | "slide" | "bounce") => void;
  onGenerateAudio?: (audioIdx: number) => void;
  isGeneratingAudio?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function PropertiesPanel({
  storyData,
  selectedSceneIndex,
  selectedActionIndex,
  selectedActorId,
  selectedAudioIndex,
  selectedCameraIndex,
  selectedKeyframe,
  actorReferences,
  onSelectKeyframe,
  onSelectAction,
  onSelectActor,
  onUpdateCamera,

  onUpdateAction,
  onUpdateAudio,
  onDeleteAction,
  onUpdateCollisionBehavior,
  onGenerateAudio,
  isGeneratingAudio
}: PropertiesPanelProps) {

  if (!storyData || storyData.beats.length === 0) {
    return (
      <div className="w-full h-full flex flex-col bg-white/60 dark:bg-[#070707]/80 backdrop-blur-md border-l border-neutral-200/50 dark:border-neutral-800/50 z-20 transition-colors duration-300">
        <div className="h-10 border-b border-neutral-200/60 dark:border-neutral-800/60 flex items-center px-4 bg-white dark:bg-[#0a0a0a] shrink-0 transition-colors">
          <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2"><SlidersHorizontal size={14} className="text-cyan-600 dark:text-cyan-500" /> Properties</span>
        </div>
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>
        </div>
      </div>
    );
  }

  const beat = storyData.beats[selectedSceneIndex];
  if (!beat) {
    return (
      <div className="w-full h-full flex flex-col bg-white/60 dark:bg-[#070707]/80 backdrop-blur-md border-l border-neutral-200/50 dark:border-neutral-800/50 z-20 transition-colors duration-300">
        <div className="h-10 border-b border-neutral-200/60 dark:border-neutral-800/60 flex items-center px-4 bg-white dark:bg-[#0a0a0a] shrink-0 transition-colors">
          <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2"><SlidersHorizontal size={14} className="text-cyan-600 dark:text-cyan-500" /> Properties</span>
        </div>
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>
        </div>
      </div>
    );
  }

  const selectedBindingRef = findCompiledBinding(beat.compiled_scene, selectedActionIndex);

  // ── Render ──

  const renderContent = () => {
    // ── Audio Properties ──────
    if (selectedAudioIndex !== null && beat.audio[selectedAudioIndex]) {
      const audio = beat.audio[selectedAudioIndex];
      const idx = selectedAudioIndex; // Get the index for onUpdateAudio
      const isSFX = audio.type !== "dialogue";
      return (
        <div className="flex flex-col gap-5 transition-opacity">
          <div>
            <div className="text-[10px] text-amber-600 dark:text-amber-500 font-bold mb-1 uppercase tracking-wider flex justify-between items-center">
              <span>{isSFX ? "Sound Effect Track" : "Dialogue Track"}</span>
              {audio.actor_id && <span className="text-cyan-600 dark:text-cyan-500">{audio.actor_id}</span>}
            </div>
            
            <div className="mt-4 flex flex-col gap-3">
              {/* Delivery Style / Prompt */}
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-neutral-400 font-mono tracking-widest uppercase">
                  {isSFX ? "Sound Prompt" : "Delivery Style"}
                </label>
                <input
                  type="text"
                  value={isSFX ? (audio.description || "") : (audio.delivery_style || "")}
                  onChange={(e) => onUpdateAudio(idx, isSFX ? { description: e.target.value } : { delivery_style: e.target.value })}
                  placeholder={isSFX ? "e.g. loud explosion" : "e.g. jaw, whisper, angry"}
                  className="w-full bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>

              {/* Spoken Text (Only for Dialogue) */}
              {!isSFX && (
                <div className="flex flex-col gap-1 mt-2">
                  <label className="text-[9px] text-neutral-400 font-mono tracking-widest uppercase">Dialogue Text</label>
                  <textarea
                    value={audio.text || ""}
                    onChange={(e) => onUpdateAudio(idx, { text: e.target.value })}
                    rows={3}
                    placeholder="Words to speak out loud..."
                    className="w-full bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 shadow-sm focus:outline-none focus:ring-1 focus:ring-cyan-500/50 resize-none leading-relaxed"
                  />
                </div>
              )}

              {/* Timing */}
              <div className="flex flex-col gap-1 mt-2">
                <label className="text-[9px] text-neutral-400 font-mono tracking-widest uppercase">Start Delay (s)</label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={audio.start_time || 0}
                  onChange={(e) => {
                    const val = Math.max(0, parseFloat(e.target.value) || 0);
                    onUpdateAudio(idx, { start_time: val });
                  }}
                  className="w-32 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                />
              </div>

              {/* Readonly Generated Status */}
              <div className="mt-4 p-2.5 rounded bg-neutral-50 dark:bg-neutral-900/30 border border-neutral-100 dark:border-neutral-800 flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                  <div className={`w-2 h-2 rounded-full ${audio.audio_data_url ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'}`} />
                  <span className="font-semibold uppercase tracking-wider">{audio.audio_data_url ? 'Generated API Track' : 'Awaiting Generation'}</span>
                </div>
                {audio.audio_data_url && (
                  <div className="text-[10px] text-neutral-400 font-mono mt-1">
                    Duration: {audio.duration_seconds?.toFixed(2)}s<br/>
                    {!isSFX && `Visemes: ${audio.visemes?.length || 0}`}
                  </div>
                )}
                {onGenerateAudio && (
                  <div className="mt-2">
                    <button 
                      onClick={() => onGenerateAudio(idx)}
                      disabled={isGeneratingAudio}
                      className={`w-full h-8 text-white rounded text-[10px] font-bold uppercase tracking-wider transition-colors shadow-sm ${
                        isGeneratingAudio 
                          ? 'bg-neutral-400 dark:bg-neutral-600 cursor-not-allowed opacity-70'
                          : 'bg-cyan-500 hover:bg-cyan-400 dark:bg-cyan-600 dark:hover:bg-cyan-500'
                      }`}
                    >
                      {isGeneratingAudio ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-3 w-3 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                          Generating...
                        </span>
                      ) : audio.audio_data_url ? 'Regenerate Track' : 'Generate Track'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ── Camera Properties ──────
    if (selectedCameraIndex !== null) {
      const cam = beat.cameras?.[selectedCameraIndex] || { zoom: 1, x: 960, y: 540, rotation: 0 };
      return (
        <div className="flex flex-col gap-5 transition-opacity">
          <div>
            <div className="text-[10px] text-amber-500 dark:text-amber-500 font-bold mb-1 uppercase tracking-wider flex justify-between items-center">
              <span>Camera Lens</span>
              <div className="flex items-center gap-1">
                <button onClick={() => {
                  onUpdateCamera('x', 960);
                  onUpdateCamera('y', 540);
                  onUpdateCamera('zoom', 1.0);
                  onUpdateCamera('rotation', 0);
                  onUpdateCamera('target_actor_id', undefined);
                  onUpdateCamera('target_x', undefined);
                  onUpdateCamera('target_y', undefined);
                  onUpdateCamera('target_zoom', undefined);
                }} className="px-2 py-0.5 border border-amber-200 dark:border-amber-600 bg-white dark:bg-neutral-800 text-amber-600 dark:text-amber-400 rounded text-[9px] hover:bg-amber-50 dark:hover:bg-amber-900/40 transition-colors font-medium" title="Reset camera to default center view">⟲ Reset</button>
                <button onClick={onDeleteAction} className="px-2 py-0.5 border border-red-200 dark:border-red-900/50 bg-white dark:bg-neutral-800 text-red-500 dark:text-red-400 rounded text-[9px] hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors font-medium" title="Delete Camera Cut">Delete</button>
              </div>
            </div>
            <div className="w-full h-8 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-700/50 flex items-center px-3 text-xs text-amber-700 dark:text-amber-300 font-mono shadow-sm dark:shadow-none transition-colors">
              {cam.target_x !== undefined || cam.target_actor_id ? "Cinematic Pan / Follow" : "Static Camera"}
            </div>
          </div>

          {/* Start Transforms */}
          <div 
            className={`p-2 rounded-lg transition-all cursor-pointer ${selectedKeyframe === 'start' ? 'bg-cyan-50 dark:bg-cyan-900/40 ring-2 ring-cyan-400 dark:ring-cyan-500 shadow-md' : 'bg-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/50 opacity-50 grayscale border border-dashed border-neutral-300 dark:border-neutral-700'}`}
            onClick={() => selectedKeyframe !== 'start' && onSelectKeyframe('start')}
          >
            <div className="text-[10px] text-cyan-600 dark:text-cyan-400 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
              <span>Start Keyframe</span>
              {selectedKeyframe === 'start' && (
                <button onClick={(e) => {
                   e.stopPropagation();
                   onUpdateCamera('x', 960);
                   onUpdateCamera('y', 540);
                   onUpdateCamera('zoom', 1.0);
                   onUpdateCamera('rotation', 0);
                   onUpdateCamera('target_actor_id', undefined);
                   onUpdateCamera('target_x', undefined);
                   onUpdateCamera('target_y', undefined);
                   onUpdateCamera('target_zoom', undefined);
                }} className="px-1.5 py-0.5 border border-cyan-200 bg-white text-cyan-600 rounded text-[9px] hover:bg-cyan-100 dark:bg-transparent dark:hover:bg-cyan-900 transition-colors">Reset</button>
              )}
            </div>
            <div className={`grid grid-cols-2 gap-2 mb-2 ${selectedKeyframe !== 'start' ? 'pointer-events-none' : ''}`}>
               {[
                  { label: 'X', prop: 'x', val: cam.x ?? 960, step: 10 },
                  { label: 'Y', prop: 'y', val: cam.y ?? 540, step: 10 },
                  { label: 'Zoom', prop: 'zoom', val: cam.zoom ?? 1, step: 0.05 },
                  { label: 'Rot', prop: 'rotation', val: cam.rotation ?? 0, step: 1 }
               ].map((field) => (
                 <div key={`cam-start-${field.prop}`} className="flex flex-col gap-1">
                   <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                   <input
                     type="number"
                     step={field.step || 1}
                     value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                     onChange={(e) => {
                        const p = parseFloat(e.target.value);
                        let val = isNaN(p) ? 0 : p;
                        if (field.prop === 'zoom') val = Math.max(0.01, val);
                        onUpdateCamera(field.prop, val);
                     }}
                     className="w-full h-7 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700 px-2 text-xs text-neutral-700 dark:text-neutral-300 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                   />
                 </div>
               ))}
            </div>
          </div>

          {/* End Transforms */}
          <div 
            className={`p-2 rounded-lg transition-all cursor-pointer ${selectedKeyframe === 'end' ? 'bg-blue-50 dark:bg-blue-900/40 ring-2 ring-blue-400 dark:ring-blue-500 shadow-md' : 'bg-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/50 opacity-50 grayscale border border-dashed border-neutral-300 dark:border-neutral-700'}`}
            onClick={() => selectedKeyframe !== 'end' && onSelectKeyframe('end')}
          >
            <div className="text-[10px] text-blue-600 dark:text-blue-400 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
              <span>End Keyframe</span>
              {selectedKeyframe === 'end' && (
                <button onClick={(e) => {
                  e.stopPropagation();
                }} className="px-1.5 py-0.5 border border-blue-200 bg-white text-blue-600 rounded text-[9px] hover:bg-blue-100 dark:bg-transparent dark:hover:bg-blue-900 transition-colors">Clear</button>
              )}
            </div>
            <div className={`grid grid-cols-2 gap-2 mb-2 ${selectedKeyframe !== 'end' ? 'pointer-events-none' : ''}`}>
               {[
                  { label: 'Target X', prop: 'target_x', val: cam.target_x ?? cam.x ?? 960, step: 10 },
                  { label: 'Target Y', prop: 'target_y', val: cam.target_y ?? cam.y ?? 540, step: 10 },
                  { label: 'Target Zoom', prop: 'target_zoom', val: cam.target_zoom ?? cam.zoom ?? 1.0, step: 0.05 }
               ].map((field) => (
                 <div key={`cam-end-${field.prop}`} className="flex flex-col gap-1">
                   <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                   <input
                     type="number"
                     step={field.step || 1}
                     value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                     onChange={(e) => {
                        const p = parseFloat(e.target.value);
                        let val = isNaN(p) ? 0 : p;
                        if (field.prop === 'target_zoom') val = Math.max(0.01, val);
                        onUpdateCamera(field.prop, val);
                     }}
                     className="w-full h-7 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700 px-2 text-xs text-neutral-700 dark:text-neutral-300 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                   />
                 </div>
               ))}
            </div>
          </div>
        </div>
      );
    }

    // ── Animation Overview (no action selected) ──────
    if (selectedActionIndex === null || !beat.actions[selectedActionIndex]) {
      return (
        <div className="space-y-5">
          <div>
            <h3 className="text-[9px] font-bold uppercase tracking-widest text-neutral-400 dark:text-neutral-600 mb-2">Compiled Scene Timeline</h3>
            <div className="space-y-1.5">
              <div className="rounded border border-indigo-100 dark:border-indigo-800/20 overflow-hidden">
                <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 dark:bg-indigo-900/10">
                  <span className="text-indigo-400 text-[9px] font-mono">↻</span>
                  <span className="text-[10px] text-neutral-600 dark:text-neutral-400 flex-1">Background ambient</span>
                  <span className="text-[9px] text-indigo-400 font-mono">
                    {beat.compiled_scene?.background_ambient?.length || 0} bind
                  </span>
                </div>
                {beat.compiled_scene?.background_ambient?.length ? (
                  beat.compiled_scene.background_ambient.map(binding => (
                    <div
                      key={binding.id}
                      className="flex items-center gap-2 px-2 py-1 border-t border-indigo-100/60 dark:border-indigo-800/20 bg-indigo-50/40 dark:bg-indigo-900/5"
                    >
                      <span className="text-indigo-400 text-[9px] font-mono">≈</span>
                      <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">
                        {binding.target_id}
                        <span className="ml-1 text-indigo-400 font-mono">({binding.label})</span>
                      </span>
                      <span className="text-[8px] text-indigo-400 font-mono">
                        {binding.start_time.toFixed(1)}s + {binding.duration_seconds.toFixed(1)}s
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="px-2 py-1.5 border-t border-indigo-100/60 dark:border-indigo-800/20 bg-indigo-50/20 dark:bg-indigo-900/5 text-[9px] text-neutral-500 dark:text-neutral-400">
                    No compiled background motion.
                  </div>
                )}
              </div>
              {beat.compiled_scene?.instance_tracks.length ? (
                beat.compiled_scene.instance_tracks.map(track => {
                  const actorData = storyData.actors_detected.find(a => a.id === track.actor_id);
                  return (
                    <div key={track.actor_id} className="rounded border border-neutral-100 dark:border-neutral-800/40 overflow-hidden">
                      <div className="px-2 py-1 bg-neutral-50 dark:bg-neutral-900/50 flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-sm bg-neutral-200 dark:bg-neutral-800 overflow-hidden shrink-0">
                          {actorReferences[track.actor_id] && <img src={actorReferences[track.actor_id]} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <span className="text-[10px] font-semibold text-neutral-600 dark:text-neutral-300 flex-1 truncate">{actorData?.name || track.actor_id}</span>
                      </div>
                      {track.clip_bindings.map(binding => (
                        <div
                          key={binding.id}
                          className="flex items-center gap-2 px-2 py-1 border-t border-neutral-100 dark:border-neutral-800/30 bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer hover:bg-blue-100/60 dark:hover:bg-blue-900/20 transition-colors"
                          onClick={() => { onSelectAction(binding.source_action_index); onSelectActor(track.actor_id); }}
                        >
                          <span className="text-blue-400 text-[9px] font-mono">▶</span>
                          <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">
                            {binding.motion} <span className="text-neutral-400">({binding.style})</span>
                            <span className="ml-1 text-cyan-500 font-mono">→ {binding.clip_id === "base_object" ? "object" : binding.clip_id}</span>
                          </span>
                          <span className="text-[8px] text-blue-400 font-mono">{binding.start_time.toFixed(1)}s + {binding.duration_seconds.toFixed(1)}s</span>
                        </div>
                      ))}
                    </div>
                  );
                })
              ) : (
                beat.actions.map((action, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 px-2 py-1 border border-neutral-100 dark:border-neutral-800/40 bg-blue-50/50 dark:bg-blue-900/10 cursor-pointer hover:bg-blue-100/60 dark:hover:bg-blue-900/20 transition-colors rounded"
                    onClick={() => { onSelectAction(idx); onSelectActor(action.actor_id); }}
                  >
                    <span className="text-blue-400 text-[9px] font-mono">▶</span>
                    <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">{action.motion} <span className="text-neutral-400">({action.style})</span></span>
                    <span className="text-[8px] text-blue-400 font-mono">{action.duration_seconds}s</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      );
    }

    // ── Action Properties ──────
    const action = beat.actions[selectedActionIndex];
    const binding = selectedBindingRef?.binding;

    return (
      <div className="flex flex-col gap-5 transition-opacity">
        <div>
          <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-1 uppercase tracking-wider flex justify-between">
            <span>{binding ? "Selected Binding" : "Selected Action"}</span>
            <span className="text-cyan-500">{action.actor_id}</span>
          </div>
          <div className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 flex items-center px-3 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm dark:shadow-none transition-colors">
            {action.motion}({action.style}){binding ? ` -> ${binding.clip_id === "base_object" ? "object" : binding.clip_id}` : ""}
          </div>
          {binding?.collision && (
            <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">
              Collision stop: {binding.collision.obstacle_id} at x={Math.round(binding.collision.stop_x)}
              {binding.collision.stop_time !== undefined ? ` @ ${binding.collision.stop_time.toFixed(2)}s` : ""}
            </div>
          )}
        </div>

        {/* Motion Editor */}
        <div>
          <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider flex items-center gap-2">
            <Play size={12} /> Motion
          </div>
          <select
            value={action.motion}
            onChange={e => onUpdateAction({ motion: e.target.value, target_spatial_transform: motionNeedsTarget(e.target.value) ? undefined : null })}
            className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 text-xs text-neutral-700 dark:text-neutral-300 shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500/50 cursor-pointer appearance-none"
          >
            {(() => {
              const rig = storyData?.actors_detected.find(a => a.id === action.actor_id)?.drafted_rig;
              const availableMotions = new Set<string>();
              availableMotions.add(action.motion);
              if (rig?.rig_data.motion_clips) {
                Object.keys(rig.rig_data.motion_clips).forEach(m => availableMotions.add(m));
              } else {
                availableMotions.add('idle');
              }
              return Array.from(availableMotions).map(m => (
                <option key={m} value={m}>{m}</option>
              ));
            })()}
          </select>
        </div>

        {/* Transforms Editor */}
        <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800/40 relative mt-4">
          {selectedKeyframe && (
            <div className="absolute -top-3 left-0 bg-cyan-100/90 text-cyan-800 dark:bg-cyan-900/80 dark:text-cyan-200 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest uppercase border border-cyan-200 dark:border-cyan-800 backdrop-blur shadow-sm">
              Editing {selectedKeyframe} Keyframe
            </div>
          )}
          {(!selectedKeyframe || selectedKeyframe === 'start') && (
            <div className={`p-2 rounded-lg transition-colors ${selectedKeyframe === 'start' ? 'bg-cyan-50 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : ''}`}>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
                <span className={selectedKeyframe === 'start' ? 'text-cyan-600 dark:text-cyan-400 font-bold' : ''}>Start Keyframe</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                {[
                  { label: 'X', prop: 'x' as const, val: action.spatial_transform?.x ?? 960 },
                  { label: 'Y', prop: 'y' as const, val: action.spatial_transform?.y ?? 950 },
                  { label: 'Scale', prop: 'scale' as const, val: action.spatial_transform?.scale ?? 0.5, step: 0.05 }
                ].map((field) => (
                  <div key={`start-${field.prop}`} className="flex flex-col gap-1">
                    <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                    <input
                      type="number"
                      step={field.step || 1}
                      value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (isNaN(val)) return;
                        onUpdateAction({ spatial_transform: { [field.prop]: val } });
                      }}
                      className={`w-full h-7 bg-white dark:bg-neutral-900 rounded border px-1.5 text-xs font-mono shadow-inner focus:outline-none focus:ring-1 transition-colors ${selectedKeyframe === 'start' ? 'border-cyan-300 dark:border-cyan-700/50 text-cyan-800 dark:text-cyan-300 focus:ring-cyan-500/50' : 'border-neutral-200 dark:border-neutral-700/50 text-neutral-700 dark:text-neutral-300 focus:ring-cyan-500/30'}`}
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={action.spatial_transform?.flip_x ?? false}
                    onChange={(e) => onUpdateAction({ spatial_transform: { flip_x: e.target.checked } })}
                    className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'start' ? 'ring-1 ring-cyan-400' : ''}`}
                  />
                  <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'start' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip X</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={action.spatial_transform?.flip_y ?? false}
                    onChange={(e) => onUpdateAction({ spatial_transform: { flip_y: e.target.checked } })}
                    className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'start' ? 'ring-1 ring-cyan-400' : ''}`}
                  />
                  <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'start' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip Y</span>
                </label>
              </div>
            </div>
          )}

          {motionNeedsTarget(action.motion) && (!selectedKeyframe || selectedKeyframe === 'end') && (
            <div className={`mt-2 p-2 rounded-lg transition-colors ${selectedKeyframe === 'end' ? 'bg-cyan-50 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : ''}`}>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex justify-between items-center">
                <span className={selectedKeyframe === 'end' ? 'text-cyan-600 dark:text-cyan-400 font-bold' : ''}>End Keyframe</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                {[
                  { label: 'X', prop: 'x' as const, val: action.target_spatial_transform?.x ?? (action.spatial_transform?.x ?? 960) },
                  { label: 'Y', prop: 'y' as const, val: action.target_spatial_transform?.y ?? (action.spatial_transform?.y ?? 950) },
                  { label: 'Scale', prop: 'scale' as const, val: action.target_spatial_transform?.scale ?? (action.spatial_transform?.scale ?? 0.5), step: 0.05 }
                ].map((field) => (
                  <div key={`end-${field.prop}`} className="flex flex-col gap-1">
                    <label className="text-[9px] text-neutral-400 font-mono tracking-widest">{field.label}</label>
                    <input
                      type="number"
                      step={field.step || 1}
                      value={typeof field.val === 'number' ? Number((field.val).toFixed(2)) : field.val}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (isNaN(val)) return;
                        onUpdateAction({ target_spatial_transform: { [field.prop]: val } });
                      }}
                      className={`w-full h-7 bg-white dark:bg-neutral-900 rounded border px-1.5 text-xs font-mono shadow-inner focus:outline-none focus:ring-1 transition-colors ${selectedKeyframe === 'end' ? 'border-cyan-300 dark:border-cyan-700/50 text-cyan-800 dark:text-cyan-300 focus:ring-cyan-500/50' : 'border-neutral-200 dark:border-neutral-700/50 text-cyan-700 dark:text-cyan-400 focus:ring-cyan-500/30'}`}
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={action.target_spatial_transform?.flip_x ?? action.spatial_transform?.flip_x ?? false}
                    onChange={(e) => onUpdateAction({ target_spatial_transform: { flip_x: e.target.checked } })}
                    className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'end' ? 'ring-1 ring-cyan-400' : ''}`}
                  />
                  <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'end' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip X</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={action.target_spatial_transform?.flip_y ?? action.spatial_transform?.flip_y ?? false}
                    onChange={(e) => onUpdateAction({ target_spatial_transform: { flip_y: e.target.checked } })}
                    className={`rounded border-neutral-300 text-cyan-500 focus:ring-cyan-500/50 dark:border-neutral-600 dark:bg-neutral-800 ${selectedKeyframe === 'end' ? 'ring-1 ring-cyan-400' : ''}`}
                  />
                  <span className={`text-[9px] font-mono tracking-widest uppercase ${selectedKeyframe === 'end' ? 'text-cyan-700 dark:text-cyan-400' : 'text-neutral-500 dark:text-neutral-400'}`}>Flip Y</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Timeline Editor */}
        <div className="pt-4 border-t border-neutral-100 dark:border-neutral-800/40 mt-4">
          <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider">
            Timeline Properties
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-neutral-400 font-mono tracking-widest whitespace-nowrap">Delay (s)</label>
              <input
                type="number"
                step={0.1}
                min={0}
                value={Number((action.animation_overrides?.delay ?? 0).toFixed(2))}
                onChange={(e) => {
                  const val = Math.max(0, parseFloat(e.target.value) || 0);
                  onUpdateAction({ animation_overrides: { delay: val } });
                }}
                className="w-full h-7 bg-white dark:bg-neutral-900 rounded border border-neutral-200 dark:border-neutral-700/50 px-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-inner focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-colors"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-neutral-400 font-mono tracking-widest whitespace-nowrap">Dur (s)</label>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={Number((action.duration_seconds).toFixed(2))}
                onChange={(e) => {
                  const val = Math.max(0.1, parseFloat(e.target.value) || 0.1);
                  onUpdateAction({ duration_seconds: val });
                }}
                className="w-full h-7 bg-white dark:bg-neutral-900 rounded border border-neutral-200 dark:border-neutral-700/50 px-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-inner focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-colors"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-amber-500 font-mono tracking-widest font-bold whitespace-nowrap">Speed (x)</label>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={Number((action.animation_overrides?.speed ?? 1.0).toFixed(2))}
                onChange={(e) => {
                  const val = Math.max(0.1, parseFloat(e.target.value) || 1.0);
                  onUpdateAction({ animation_overrides: { speed: val } });
                }}
                className="w-full h-7 bg-white dark:bg-neutral-900 rounded border border-neutral-200 dark:border-neutral-700/50 px-1.5 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-inner focus:outline-none focus:ring-1 focus:ring-amber-500/30 transition-colors"
              />
            </div>
          </div>
        </div>

        {binding && (
          <div>
            <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider flex items-center gap-2">
              <Bug size={12} /> Collision Response
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["halt", "slide", "bounce"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onUpdateCollisionBehavior(mode)}
                  className={`rounded border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${(binding.collision_behavior || "halt") === mode
                      ? "border-amber-400 bg-amber-500 text-black"
                      : "border-neutral-200 dark:border-neutral-700/50 bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pt-5 flex justify-end">
          <button 
            type="button"
            className="px-3 py-1.5 rounded bg-red-50 text-red-600 border border-red-200 text-xs font-semibold hover:bg-red-100 dark:bg-red-900/20 dark:border-red-800/50 dark:text-red-400 dark:hover:bg-red-900/40 transition-colors"
            onClick={onDeleteAction}
          >
            Delete Action
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full h-full flex flex-col bg-white/60 dark:bg-[#070707]/80 backdrop-blur-md border-l border-neutral-200/50 dark:border-neutral-800/50 z-20 transition-colors duration-300">
      <div className="h-10 border-b border-neutral-200/60 dark:border-neutral-800/60 flex items-center px-4 bg-white dark:bg-[#0a0a0a] shrink-0 transition-colors">
        <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2"><SlidersHorizontal size={14} className="text-cyan-600 dark:text-cyan-500" /> Properties</span>
      </div>
      <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
        {renderContent()}
      </div>
    </div>
  );
}
