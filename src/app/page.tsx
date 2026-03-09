"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Stage from "@/components/Stage";
import { Send, Play, Image as ImageIcon, ImageOff, Volume2, Sparkles, LayoutList, SlidersHorizontal, ChevronDown, ChevronUp, Loader2, Film, Trash2, Pencil, Plus, Copy, Mountain } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { processScenePromptStream, processSceneImageEdit } from "@/app/actions/scene";
import { ClipBinding, CompiledSceneData, StoryGenerationData } from "@/lib/schema/story";
import { loadStoryFromStorage, saveStoryToStorage, clearStoryStorage, getProjectsList, createProject, deleteProject, updateProjectTitle, ProjectMetadata, loadActorIdentities, saveActorIdentity } from "@/lib/storage/db";
import { generateMotionClipForRig, processDraftsmanPrompt } from "@/app/actions/draftsman";
import { processSetDesignerPrompt } from "@/app/actions/set_designer";
import { DraftsmanData } from "@/lib/schema/rig";
import { RigViewer } from "@/components/RigViewer";
import { inferAutoTargetTransform, motionNeedsTarget, normalizeMotionKey } from "@/lib/motion/semantics";
import { compileBeatToScene } from "@/lib/motion/compiler";

import { ThemeToggle } from "@/components/ThemeToggle";

function findCompiledBinding(compiledScene: CompiledSceneData | null | undefined, actionIndex: number | null) {
  if (!compiledScene || actionIndex === null) return null;
  for (let trackIndex = 0; trackIndex < compiledScene.instance_tracks.length; trackIndex += 1) {
    const track = compiledScene.instance_tracks[trackIndex];
    const bindingIndex = track.clip_bindings.findIndex(binding => binding.source_action_index === actionIndex);
    if (bindingIndex >= 0) {
      return { trackIndex, bindingIndex, track, binding: track.clip_bindings[bindingIndex] };
    }
  }
  return null;
}

export default function Home() {
  const EXPORT_RESOLUTIONS = {
    "720p": { label: "720p HD", width: 1280, height: 720 },
    "1080p": { label: "1080p FHD", width: 1920, height: 1080 },
    "4k": { label: "4K UHD", width: 3840, height: 2160 },
    "8k": { label: "8K UHD", width: 7680, height: 4320 },
  } as const;

  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [storyData, setStoryData] = useState<StoryGenerationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Actor Identity State (projectId -> actorId -> base64Image)
  const [actorReferences, setActorReferences] = useState<Record<string, string>>({});

  // Project Management State
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjectTitle, setEditProjectTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteBeatIndex, setConfirmDeleteBeatIndex] = useState<number | null>(null);
  const [confirmClearStory, setConfirmClearStory] = useState(false);

  // Draftsman / Rigging State
  const [draftingActorId, setDraftingActorId] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [draftedRig, setDraftedRig] = useState<DraftsmanData | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Set Designer State
  const [draftingBackgroundSceneIndex, setDraftingBackgroundSceneIndex] = useState<number | null>(null);
  const [isDraftingBackground, setIsDraftingBackground] = useState(false);
  const [draftBackgroundError, setDraftBackgroundError] = useState<string | null>(null);

  // Auto-Animate Macro State
  const [animatingSceneIndex, setAnimatingSceneIndex] = useState<number | null>(null);
  const [animatingLogs, setAnimatingLogs] = useState<string[]>([]);
  // Persistent per-scene logs that survive after animation completes
  const [completedAnimLogs, setCompletedAnimLogs] = useState<Record<number, string[]>>({});
  const [dismissedCompileReports, setDismissedCompileReports] = useState<Record<number, boolean>>({});
  // Per-beat image generation cost (from Gemini usage metadata)
  const [beatGenerationCosts, setBeatGenerationCosts] = useState<Record<number, { tokens: number; cost: number }>>({});
  const [playbackScope, setPlaybackScope] = useState<"scene" | "all">("scene");
  const [exportResolution, setExportResolution] = useState<keyof typeof EXPORT_RESOLUTIONS>("1080p");
  const [isExportDropdownOpen, setIsExportDropdownOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [exportPlayheadTime, setExportPlayheadTime] = useState(0);
  const [exportBeatState, setExportBeatState] = useState<{
    beat: StoryGenerationData["beats"][number];
    compiledScene: CompiledSceneData;
    key: string;
  } | null>(null);
  const exportStageHostRef = useRef<HTMLDivElement>(null);
  const exportTimelineDurationRef = useRef(0);
  const exportTimelineReadyResolverRef = useRef<((duration: number) => void) | null>(null);

  // Stage Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [sceneTimelineDurations, setSceneTimelineDurations] = useState<Record<number, number>>({});

  // Generation Mode: 'sequence' | 'single'
  const [generateMode, setGenerateMode] = useState<'sequence' | 'single'>('single');

  // Stage Selection State
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState<number | null>(null);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);

  // Timeline Playhead & Frame State
  const [playheadPos, setPlayheadPos] = useState<number>(0);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [fps, setFps] = useState<12 | 24 | 30 | 60>(60);
  const timelineRef = useRef<HTMLDivElement>(null);

  const selectedBeat = useMemo(
    () => (storyData && storyData.beats.length > 0 ? storyData.beats[selectedSceneIndex] : null),
    [storyData, selectedSceneIndex]
  );
  const selectedCompiledScene = selectedBeat?.compiled_scene ?? null;

  const availableRigs = useMemo(
    () =>
      storyData
        ? storyData.actors_detected.reduce((acc, actor) => {
            if (actor.drafted_rig) acc[actor.id] = actor.drafted_rig;
            return acc;
          }, {} as Record<string, DraftsmanData>)
        : {},
    [storyData]
  );

  // Total duration of the selected scene (seconds), used for frame math
  const totalDuration = useMemo(() => {
    const compiledDuration = sceneTimelineDurations[selectedSceneIndex];
    if (compiledDuration && compiledDuration > 0) return compiledDuration;
    if (selectedCompiledScene?.duration_seconds && selectedCompiledScene.duration_seconds > 0) {
      return selectedCompiledScene.duration_seconds;
    }

    if (!selectedBeat || selectedBeat.actions.length === 0) return 10;
    return Math.max(
      2,
      ...selectedBeat.actions.map(a => {
        const delay = a.animation_overrides?.delay || 0;
        return delay + (a.duration_seconds || 2);
      }),
    );
  }, [sceneTimelineDurations, selectedSceneIndex, selectedBeat, selectedCompiledScene]);

  const currentTimeSeconds = (playheadPos / 100) * totalDuration;
  const currentFrame = Math.round(currentTimeSeconds * fps);
  const totalFrames  = Math.round(totalDuration * fps);

  useEffect(() => {
    if (!isDraggingPlayhead) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      let newX = e.clientX - rect.left;
      newX = Math.max(0, Math.min(newX, rect.width));
      const newPercent = (newX / rect.width) * 100;
      setPlayheadPos(newPercent);
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead]);

  // Playhead callbacks — called by Stage when GSAP timeline ticks or completes
  const handlePlayheadUpdate = (timeSeconds: number) => {
    const pct = totalDuration > 0 ? (timeSeconds / totalDuration) * 100 : 0;
    setPlayheadPos(Math.min(100, pct));
  };

  const handlePlayComplete = () => {
    setIsPlaying(false);
    setPlayheadPos(0);
  };

  const handleTimelineReady = (durationSeconds: number) => {
    setSceneTimelineDurations(prev => {
      const current = prev[selectedSceneIndex];
      if (current === durationSeconds) return prev;
      return { ...prev, [selectedSceneIndex]: durationSeconds };
    });
  };

  const waitForAnimationFrames = (count: number = 2) =>
    new Promise<void>((resolve) => {
      const tick = (remaining: number) => {
        if (remaining <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(() => tick(remaining - 1));
      };
      tick(count);
    });

  const waitForExportTimelineReady = () =>
    new Promise<number>((resolve) => {
      exportTimelineReadyResolverRef.current = resolve;
    });

  const sanitizeSvgMarkup = (svgMarkup: string) => {
    if (svgMarkup.includes('xmlns="http://www.w3.org/2000/svg"')) {
      return svgMarkup;
    }
    return svgMarkup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  };

  const captureExportStageSvg = async (timeSeconds: number) => {
    setExportPlayheadTime(timeSeconds);
    await waitForAnimationFrames(2);
    const svg = exportStageHostRef.current?.querySelector("svg");
    if (!svg) {
      throw new Error("Export stage did not render an SVG frame.");
    }
    return sanitizeSvgMarkup(svg.outerHTML);
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const loadSvgIntoImage = (svgMarkup: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const blob = new Blob([sanitizeSvgMarkup(svgMarkup)], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      };
      img.src = url;
    });

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const canvasToPngBlob = (canvas: HTMLCanvasElement) =>
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to encode a frame as PNG."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });

  // Panel Editing State
  const [editingBeatIndex, setEditingBeatIndex] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [isEditingImage, setIsEditingImage] = useState(false);

  // Panel Insertion State
  const [insertAtIndex, setInsertAtIndex] = useState<number | null>(null);
  const [insertPrompt, setInsertPrompt] = useState("");

  // Load from local IndexedDB on mount
  useEffect(() => {
    const initializeApp = async () => {
      let activeProjectId = null;
      try {
        const loadedProjects = await getProjectsList();

        if (loadedProjects.length === 0) {
          // First time user: create default project
          const newProj = await createProject("My First Cartoon");
          setProjects([newProj]);
          activeProjectId = newProj.id;
        } else {
          setProjects(loadedProjects);
          // Load most recently updated project
          const recent = [...loadedProjects].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          activeProjectId = recent.id;
        }

        setCurrentProjectId(activeProjectId);

        // Load the actual story data for the active project
        const data = await loadStoryFromStorage(activeProjectId);
        setStoryData(data || { title: "", actors_detected: [], beats: [] });

        // Load project's actor ID registry
        const actors = await loadActorIdentities(activeProjectId);
        setActorReferences(actors);
      } catch (err) {
        console.error("Failed to initialize projects:", err);
      } finally {
        setIsLoaded(true);
      }
    };
    initializeApp();
  }, []);

  // Save to local IndexedDB whenever storyData changes
  useEffect(() => {
    if (isLoaded && storyData && currentProjectId) {
      saveStoryToStorage(currentProjectId, storyData).then(() => {
        // Silently refresh project list to get updated timestamps
        getProjectsList().then(setProjects);
      });
    }
  }, [storyData, isLoaded, currentProjectId]);

  // Utility to compress context images before sending to API to save tokens/payload
  const downscaleBase64Image = (base64Str: string, maxWidth: number = 512): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64Str;
      img.onload = () => {
        if (img.width <= maxWidth) {
          return resolve(base64Str);
        }
        const scaleSize = maxWidth / img.width;
        const canvas = document.createElement('canvas');
        canvas.width = maxWidth;
        canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve(base64Str); // fallback if it fails
    });
  };

  // --- Project Management Handlers ---

  const handleCreateProject = async () => {
    try {
      const newProj = await createProject(`New Cartoon ${projects.length + 1}`);
      setProjects(prev => [...prev, newProj]);
      setCurrentProjectId(newProj.id);
      setStoryData({ title: "", actors_detected: [], beats: [] });
      setActorReferences({});
      setIsProjectDropdownOpen(false);
    } catch (err) {
      console.error("Failed to create project", err);
    }
  };

  const handleSwitchProject = async (id: string) => {
    if (id === currentProjectId) return;
    try {
      setCurrentProjectId(id);
      const data = await loadStoryFromStorage(id);
      setStoryData(data || { title: "", actors_detected: [], beats: [] });

      const actors = await loadActorIdentities(id);
      setActorReferences(actors);

      setIsProjectDropdownOpen(false);
    } catch (err) {
      console.error("Failed to switch project", err);
    }
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // Inline Confirmation Flow
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);

      // Auto-cancel confirmation after 3 seconds
      setTimeout(() => {
        setConfirmDeleteId(current => current === id ? null : current);
      }, 3000);
      return;
    }

    try {
      await deleteProject(id);
      const remaining = projects.filter(p => p.id !== id);
      setProjects(remaining);

      if (currentProjectId === id) {
        if (remaining.length > 0) {
          handleSwitchProject(remaining[0].id);
        } else {
          // Explicitly wipe the screen before creating a new dummy project
          setStoryData({ title: "", actors_detected: [], beats: [] });
          setActorReferences({});
          handleCreateProject();
        }
      }
      setConfirmDeleteId(null);
    } catch (err) {
      console.error("Failed to delete project", err);
      setConfirmDeleteId(null);
    }
  };

  const handleUpdateProjectTitle = async (id: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    try {
      await updateProjectTitle(id, newTitle);
      setProjects(prev => prev.map(p => p.id === id ? { ...p, title: newTitle } : p));
      setEditingProjectId(null);
    } catch (err) {
      console.error("Failed to update project title", err);
    }
  };

  // --- Generation Handlers ---

  const handleGenerate = async () => {
    // ... existing function remains unchanged
    if (!prompt.trim()) return;

    setIsGenerating(true);
    setError(null);

    // We do NOT clear storyData here anymore, because we are appending!
    const initialBeatsLength = storyData ? storyData.beats.length : 0;

    let contextBeats;
    if (storyData && storyData.beats.length > 0) {
      // Deep copy the last two beats to avoid mutating React state
      contextBeats = JSON.parse(JSON.stringify(storyData.beats.slice(-2)));
      // Downscale images for API payload to save tokens/MB limits
      for (const beat of contextBeats) {
        if (beat.image_data) {
          beat.image_data = await downscaleBase64Image(beat.image_data, 512);
        }
      }
    }

    try {
      const stream = await processScenePromptStream(prompt, contextBeats, { singleBeat: generateMode === 'single' }, actorReferences);
      for await (const chunk of stream) {
        if (chunk.type === 'error') {
          setError(chunk.error);
          break;
        } else if (chunk.type === 'story') {
          setStoryData(prev => {
            if (!prev) return chunk.data;

            // Merge actors seamlessly
            const newActors = chunk.data.actors_detected.filter(
              newActor => !prev.actors_detected.some(old => old.id === newActor.id)
            );

            return {
              title: prev.title || chunk.data.title, // Keep original title
              actors_detected: [...prev.actors_detected, ...newActors],
              beats: [...prev.beats, ...chunk.data.beats]
            };
          });
        } else if (chunk.type === 'image') {
          const compressedIncomingImage = await downscaleBase64Image(chunk.data, 512);

          // ACTOR IDENTITY LOCK: Intercept First Appearances
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            const targetIndex = initialBeatsLength + chunk.index;
            const currentBeat = newBeats[targetIndex];

            if (currentBeat) {
              currentBeat.image_data = compressedIncomingImage;

              // Save reference for ALL detected actors that don't have one yet
              if (currentProjectId) {
                // Collect actor IDs from this beat's actions
                const beatActorIds = new Set(
                  (currentBeat.actions || []).map(a => a.actor_id)
                );

                // Also check all globally detected actors
                prev.actors_detected.forEach(actor => {
                  beatActorIds.add(actor.id);
                });

                beatActorIds.forEach(actorId => {
                  setActorReferences(prevRefs => {
                    if (!prevRefs[actorId]) {
                      saveActorIdentity(currentProjectId, actorId, compressedIncomingImage);
                      return { ...prevRefs, [actorId]: compressedIncomingImage };
                    }
                    return prevRefs;
                  });
                });
              }
            }
            return { ...prev, beats: newBeats };
          });
        } else if (chunk.type === 'usage') {
          // Store generation cost split evenly across the newly generated beats
          const totalTokens = chunk.promptTokens + chunk.candidateTokens;
          const totalCost = (chunk.promptTokens * 0.00000125) + (chunk.candidateTokens * 0.000005);
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeatCount = prev.beats.length - initialBeatsLength;
            if (newBeatCount <= 0) return prev;
            const costPerBeat = totalCost / newBeatCount;
            const tokensPerBeat = Math.round(totalTokens / newBeatCount);
            setBeatGenerationCosts(prevCosts => {
              const updated = { ...prevCosts };
              for (let i = initialBeatsLength; i < prev.beats.length; i++) {
                updated[i] = { tokens: tokensPerBeat, cost: costPerBeat };
              }
              return updated;
            });
            return prev;
          });
        }
      }
    } catch (err: unknown) {
      console.error("Generation failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to connect to generation service: ${errorMessage}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEditImageSubmit = async (index: number) => {
    if (!storyData || !storyData.beats[index] || !storyData.beats[index].image_data || !editPrompt.trim() || isEditingImage) return;

    setIsEditingImage(true);
    setError(null);

    try {
      const originalImage = storyData.beats[index].image_data as string;

      // CRITICAL: Next.js Server Actions choke on massive base64 strings (array nesting error)
      // We MUST compress the image on the client before sending it over the network to the server function.
      const compressedImage = await downscaleBase64Image(originalImage, 512);

      const result = await processSceneImageEdit(compressedImage, editPrompt);

      if (result.error) {
        setError(result.error);
      } else if (result.data) {
        // Automatically append the edited image data to the story state
        setStoryData(prev => {
          if (!prev) return prev;
          const newBeats = [...prev.beats];
          newBeats[index] = { ...newBeats[index], image_data: result.data };
          return { ...prev, beats: newBeats };
        });

        // Close the edit prompt overlay
        setEditingBeatIndex(null);
        setEditPrompt("");
      }
    } catch (error: unknown) {
      console.error("Image editing failed:", error);
      setError(error instanceof Error ? error.message : "Failed to edit image");
    } finally {
      setIsEditingImage(false);
    }
  };

  const handleInsertScene = async (insertIndex: number) => {
    if (!insertPrompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setError(null);

    // Build context from surrounding beats (the one before and one after the insertion point)
    let contextBeats;
    if (storyData && storyData.beats.length > 0) {
      const surroundingBeats = [];
      if (insertIndex > 0) surroundingBeats.push(storyData.beats[insertIndex - 1]);
      if (insertIndex < storyData.beats.length) surroundingBeats.push(storyData.beats[insertIndex]);
      contextBeats = JSON.parse(JSON.stringify(surroundingBeats));
      for (const beat of contextBeats) {
        if (beat.image_data) {
          beat.image_data = await downscaleBase64Image(beat.image_data, 512);
        }
      }
    }

    try {
      const stream = await processScenePromptStream(insertPrompt, contextBeats, { singleBeat: true }, actorReferences);
      for await (const chunk of stream) {
        if (chunk.type === 'error') {
          setError(chunk.error);
          break;
        } else if (chunk.type === 'story') {
          setStoryData(prev => {
            if (!prev) return chunk.data;
            const newActors = chunk.data.actors_detected.filter(
              newActor => !prev.actors_detected.some(old => old.id === newActor.id)
            );
            const newBeats = [...prev.beats];
            // Splice the new beat(s) at the insertion point
            newBeats.splice(insertIndex, 0, ...chunk.data.beats);
            return {
              title: prev.title || chunk.data.title,
              actors_detected: [...prev.actors_detected, ...newActors],
              beats: newBeats
            };
          });
        } else if (chunk.type === 'image') {
          const compressedIncomingImage = await downscaleBase64Image(chunk.data, 512);

          // ACTOR IDENTITY LOCK for Scene Insertions
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            const targetIdx = insertIndex + chunk.index;
            const currentBeat = newBeats[targetIdx];

            if (currentBeat) {
              currentBeat.image_data = compressedIncomingImage;

              // Save reference for ALL detected actors that don't have one yet
              if (currentProjectId) {
                const beatActorIds = new Set(
                  (currentBeat.actions || []).map(a => a.actor_id)
                );
                prev.actors_detected.forEach(actor => {
                  beatActorIds.add(actor.id);
                });
                beatActorIds.forEach(actorId => {
                  setActorReferences(prevRefs => {
                    if (!prevRefs[actorId]) {
                      saveActorIdentity(currentProjectId, actorId, compressedIncomingImage);
                      return { ...prevRefs, [actorId]: compressedIncomingImage };
                    }
                    return prevRefs;
                  });
                });
              }
            }
            return { ...prev, beats: newBeats };
          });
        }
      }
      // Close the insert prompt
      setInsertAtIndex(null);
      setInsertPrompt("");
    } catch (err: unknown) {
      console.error("Insert scene failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to insert scene: ${errorMessage}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAnimateScene = async (index: number) => {
    if (!storyData || !storyData.beats[index]) return;

    // Clear any previous completed logs for this scene
    setCompletedAnimLogs(prev => { const n = { ...prev }; delete n[index]; return n; });
    setDismissedCompileReports(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });

    setAnimatingSceneIndex(index);
    setAnimatingLogs(["Initializing automation macro..."]);
    setSelectedSceneIndex(index);
    const beat = storyData.beats[index];
    let didAugmentTargets = false;
    let workingBeat = {
      ...beat,
      actions: beat.actions.map(action => {
        if (action.target_spatial_transform || !motionNeedsTarget(action.motion)) return action;

        const start = action.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 };
        const inferred = inferAutoTargetTransform(
          action.motion,
          { x: start.x, y: start.y, scale: start.scale },
          action.duration_seconds || 2,
        );

        return inferred
          ? (() => {
              didAugmentTargets = true;
              return { ...action, target_spatial_transform: inferred };
            })()
          : action;
      }),
    };

    if (didAugmentTargets) {
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        newBeats[index] = workingBeat;
        return { ...prev, beats: newBeats };
      });
    }

    // Local accumulator so we can capture the full log on completion
    const localLogs: string[] = ["Initializing automation macro..."];
    const addLog = (msg: string) => {
      localLogs.push(msg);
      setAnimatingLogs([...localLogs]);
    };

    let totalTokens = 0;
    let apiCalls = 0;
    let totalCostEst = 0;
    let compileStatus: "success" | "error" = "error";

    const logUsage = (usage: any, label?: string) => {
      const promptTokens = usage?.promptTokenCount || 0;
      const candidateTokens = usage?.candidatesTokenCount || 0;
      const total = promptTokens + candidateTokens;
      totalTokens += total;

      // Gemini 1.5 Pro approx cost (USD)
      const cost = (promptTokens * 0.00000125) + (candidateTokens * 0.000005);
      totalCostEst += cost;

      addLog(`   [${label || 'Usage'}: ${total} tokens | ~$${cost.toFixed(4)}]`);
    };

    try {
      // 1. Generate Background if missing
      if (!workingBeat.drafted_background && workingBeat.image_data) {
        addLog("> Starting Set Designer AI...");
        addLog("> Extracting 3-layer parallax environment...");

        apiCalls++;
        const result = await processSetDesignerPrompt(workingBeat.image_data, workingBeat.narrative);

        setStoryData(prev => {
          if (!prev) return prev;
          const newBeats = [...prev.beats];
          newBeats[index] = { ...newBeats[index], drafted_background: result.data };
          return { ...prev, beats: newBeats };
        });

        addLog("✓ Environment vector rig compiled.");
        logUsage(result.usage, "Set Designer");
        workingBeat = { ...workingBeat, drafted_background: result.data };
      } else {
        addLog("✓ Environment rig found in cache.");
      }

      // 2. Generate Actors if missing
      const actorIdsInScene = new Set(workingBeat.actions.map(a => a.actor_id));
      const sceneRigs: Record<string, DraftsmanData> = {};
      for (const actorId of Array.from(actorIdsInScene)) {
        const actor = storyData.actors_detected.find(a => a.id === actorId);
        if (actor) {
          let actorRig = actor.drafted_rig;

          if (!actorRig && actorReferences[actorId]) {
            const sceneText = `${workingBeat.narrative} ${workingBeat.comic_panel_prompt}`.toLowerCase();
            const actorActions = workingBeat.actions.filter(a => a.actor_id === actorId);
            const viewSet = new Set<string>();

            for (const action of actorActions) {
              const motionKey = normalizeMotionKey(action.motion);
              if (motionNeedsTarget(motionKey)) {
                viewSet.add('view_side_right');
              } else if (/wave|greet|salute|talk|speak|say|tip_hat|sing|shout|smile|dialogue/.test(motionKey)) {
                viewSet.add('view_front');
              } else {
                viewSet.add('view_3q_right');
              }
            }

            if (/top[- ]?down|overhead|bird'?s[- ]eye|from above/.test(sceneText)) {
              viewSet.add('view_top');
            }
            if (/from behind|back view|walk away|turns away|retreats|seen from behind/.test(sceneText)) {
              viewSet.add('view_back');
            }

            if (viewSet.size === 0) {
              viewSet.add('view_3q_right');
            }

            const viewsArray = Array.from(viewSet);

            addLog(`> Starting Draftsman AI for '${actor.name}'...`);
            addLog(`> Rigging A-Pose skeleton & visemes (${viewsArray.join(', ')})...`);

            apiCalls++;
            const description = `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(', ')}. ${actor.visual_description}`;
            const result = await processDraftsmanPrompt(actorReferences[actorId], description, viewsArray);

            setStoryData(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                actors_detected: prev.actors_detected.map(a =>
                  a.id === actorId ? { ...a, drafted_rig: result.data } : a
                )
              };
            });

            actorRig = result.data;
            addLog(`✓ '${actor.name}' SVG rig assembled.`);
            logUsage(result.usage, `Draftsman (${actor.name})`);
          } else if (actorRig) {
            addLog(`✓ '${actor.name}' rig found in cache.`);
          }

          if (actorRig) {
            const actorActions = workingBeat.actions.filter(a => a.actor_id === actorId);
            let nextRig = actorRig;

            for (const actorAction of actorActions) {
              const motionKey = normalizeMotionKey(actorAction.motion);
              if (nextRig.rig_data.animation_clips?.[motionKey]) continue;

              addLog(`> Compiling motion '${motionKey}' for '${actor.name}'...`);
              apiCalls++;

              const clipResult = await generateMotionClipForRig({
                rig: nextRig,
                motion: motionKey,
                style: actorAction.style,
                durationSeconds: actorAction.duration_seconds,
                actorName: actor.name,
                actorDescription: actor.visual_description,
                sceneNarrative: workingBeat.narrative,
              });

              nextRig = {
                ...nextRig,
                rig_data: {
                  ...nextRig.rig_data,
                  animation_clips: {
                    ...(nextRig.rig_data.animation_clips || {}),
                    [motionKey]: clipResult.clip,
                  },
                },
              };

              addLog(`✓ Motion '${motionKey}' compiled for '${actor.name}'.`);
              logUsage(clipResult.usage, `Motion (${actor.name}:${motionKey})`);
            }

            if (nextRig !== actorRig) {
              setStoryData(prev => {
                if (!prev) return prev;
                return {
                  ...prev,
                  actors_detected: prev.actors_detected.map(a =>
                    a.id === actorId ? { ...a, drafted_rig: nextRig } : a
                  )
                };
              });
            }

            sceneRigs[actorId] = nextRig;
          }
        }
      }

      const compiledScene = compileBeatToScene(workingBeat, sceneRigs);
      setStoryData(prev => {
        if (!prev) return prev;
        const newBeats = [...prev.beats];
        newBeats[index] = { ...newBeats[index], compiled_scene: compiledScene };
        return { ...prev, beats: newBeats };
      });
      addLog(`✓ Compiled scene timeline (${compiledScene.instance_tracks.length} track${compiledScene.instance_tracks.length === 1 ? "" : "s"}, ${compiledScene.duration_seconds.toFixed(2)}s).`);

      addLog("✓ Stage ready. Dispatching GSAP context...");
      addLog("─────────────────────────────");
      const imageGen = beatGenerationCosts[index];
      if (imageGen) {
        addLog(`Image gen: ~$${imageGen.cost.toFixed(5)} | ${imageGen.tokens.toLocaleString()} tokens`);
      }
      addLog(`API Calls: ${apiCalls} | Total tokens: ${totalTokens}`);
      addLog(`Scene cost: ~$${totalCostEst.toFixed(5)}`);
      addLog("─────────────────────────────");
      compileStatus = "success";

    } catch (err: any) {
      console.error("Animation prep failed", err);
      addLog(`❌ Error: ${err.message || 'Pipeline failed'}`);
    } finally {
      // Persist logs so they remain visible below the scene image
      setCompletedAnimLogs(prev => ({ ...prev, [index]: [...localLogs] }));
      setStoryData(prev => {
        if (!prev || !prev.beats[index]) return prev;
        const newBeats = [...prev.beats];
        const imageGen = beatGenerationCosts[index];
        newBeats[index] = {
          ...newBeats[index],
          compile_report: {
            status: compileStatus,
            compiled_at: Date.now(),
            logs: [...localLogs],
            api_calls: apiCalls,
            total_tokens: totalTokens,
            scene_cost_estimate: Number(totalCostEst.toFixed(5)),
            image_generation_cost: imageGen
              ? { cost: imageGen.cost, tokens: imageGen.tokens }
              : undefined,
          },
        };
        return { ...prev, beats: newBeats };
      });
      setAnimatingSceneIndex(null);
      setAnimatingLogs([]);
    }
  };

  // --- Actor Selection Handlers ---

  const handleActorSelect = (actorId: string | null) => {
    setSelectedActorId(actorId);
    if (!actorId || !storyData) {
      setSelectedActionIndex(null);
      return;
    }
    const beat = storyData.beats[selectedSceneIndex];
    if (!beat) { setSelectedActionIndex(null); return; }
    const compiledTrack = beat.compiled_scene?.instance_tracks.find(track => track.actor_id === actorId);
    const idx = compiledTrack?.clip_bindings[0]?.source_action_index ?? beat.actions.findIndex(a => a.actor_id === actorId);
    setSelectedActionIndex(idx >= 0 ? idx : null);
  };

  const handleActorPositionChange = (actorId: string, x: number, y: number) => {
    setStoryData(prev => {
      if (!prev) return prev;
      const newBeats = [...prev.beats];
      const beat = newBeats[selectedSceneIndex];
      if (!beat) return prev;
      const newActions = beat.actions.map(a => {
        if (a.actor_id !== actorId) return a;
        return {
          ...a,
          spatial_transform: {
            ...(a.spatial_transform || { x: 960, y: 950, scale: 0.5, z_index: 10 }),
            x: Math.round(x),
            y: Math.round(y),
          },
        };
      });
      let nextCompiledScene = beat.compiled_scene;
      if (nextCompiledScene) {
        nextCompiledScene = {
          ...nextCompiledScene,
          instance_tracks: nextCompiledScene.instance_tracks.map(track => {
            if (track.actor_id !== actorId) return track;
            const first = track.transform_track[0];
            const dx = Math.round(x - (first?.x ?? x));
            const dy = Math.round(y - (first?.y ?? y));
            return {
              ...track,
              transform_track: track.transform_track.map(keyframe => ({
                ...keyframe,
                x: Math.round(keyframe.x + dx),
                y: Math.round(keyframe.y + dy),
              })),
              clip_bindings: track.clip_bindings.map(binding => ({
                ...binding,
                start_transform: {
                  ...binding.start_transform,
                  x: Math.round(binding.start_transform.x + dx),
                  y: Math.round(binding.start_transform.y + dy),
                },
                end_transform: binding.end_transform
                  ? {
                      ...binding.end_transform,
                      x: Math.round(binding.end_transform.x + dx),
                      y: Math.round(binding.end_transform.y + dy),
                    }
                  : binding.end_transform,
              })),
            };
          }),
        };
      }
      newBeats[selectedSceneIndex] = { ...beat, actions: newActions, compiled_scene: nextCompiledScene };
      return { ...prev, beats: newBeats };
    });
  };

  const handleExportTimelineReady = (durationSeconds: number) => {
    exportTimelineDurationRef.current = durationSeconds;
    exportTimelineReadyResolverRef.current?.(durationSeconds);
    exportTimelineReadyResolverRef.current = null;
  };

  const handleExport = async () => {
    if (!storyData) return;

    const beatsToExport = (playbackScope === "all"
      ? storyData.beats
      : storyData.beats[selectedSceneIndex]
        ? [storyData.beats[selectedSceneIndex]]
        : []
    ).filter(beat => beat.compiled_scene);

    if (beatsToExport.length === 0) {
      setError("No compiled scene is available to export. Run Animate Scene first.");
      return;
    }

    const missingCompiled = (playbackScope === "all"
      ? storyData.beats
      : storyData.beats[selectedSceneIndex]
        ? [storyData.beats[selectedSceneIndex]]
        : []
    ).filter(beat => !beat.compiled_scene);

    if (missingCompiled.length > 0) {
      const missingScenes = missingCompiled.map(beat => beat.scene_number).join(", ");
      setError(`Scene ${missingScenes} is not compiled yet. Run Animate Scene before exporting.`);
      return;
    }

    try {
      setIsExporting(true);
      setError(null);
      setExportProgress("Preparing export stage...");
      const resolution = EXPORT_RESOLUTIONS[exportResolution];
      const canvas = document.createElement("canvas");
      canvas.width = resolution.width;
      canvas.height = resolution.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas export context could not be created.");
      }

      const formData = new FormData();
      formData.append("fileName", `${storyData.title || "cartoon"}-${playbackScope}-${resolution.label}.mp4`);
      formData.append("fps", String(fps));
      formData.append("width", String(resolution.width));
      formData.append("height", String(resolution.height));

      let frameSerial = 1;

      for (let sceneOffset = 0; sceneOffset < beatsToExport.length; sceneOffset += 1) {
        const beat = beatsToExport[sceneOffset];
        const compiledScene = beat.compiled_scene!;

        setExportProgress(`Rendering Scene ${beat.scene_number}...`);
        const durationPromise = waitForExportTimelineReady();
        setExportBeatState({
          beat,
          compiledScene,
          key: `${beat.scene_number}-${Date.now()}-${sceneOffset}`,
        });
        setExportPlayheadTime(0);

        await waitForAnimationFrames(2);
        const timelineDuration = await durationPromise;
        const sceneDuration = timelineDuration > 0 ? timelineDuration : compiledScene.duration_seconds;
        const frameCount = Math.max(1, Math.ceil(sceneDuration * fps) + 1);

        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          const timeSeconds = Math.min(sceneDuration, frameIndex / fps);
          setExportProgress(`Rendering Scene ${beat.scene_number} frame ${frameIndex + 1}/${frameCount}...`);
          const svgMarkup = await captureExportStageSvg(timeSeconds);
          const image = await loadSvgIntoImage(svgMarkup);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const pngBlob = await canvasToPngBlob(canvas);
          const frameName = `frame-${String(frameSerial).padStart(6, "0")}.png`;
          formData.append("frames", pngBlob, frameName);
          frameSerial += 1;
        }
      }

      setExportProgress(`Encoding MP4 (${resolution.label})...`);

      const response = await fetch("/api/export", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => null) }));
        throw new Error(payload?.error || `Export failed (${response.status}).`);
      }

      const blob = await response.blob();
      const suggestedName = response.headers.get("x-export-filename") || `${storyData.title || "cartoon"}-${playbackScope}.mp4`;
      downloadBlob(blob, suggestedName);
      setExportProgress(`Export complete: ${suggestedName}`);
    } catch (err) {
      console.error("Export failed", err);
      setError(err instanceof Error ? err.message : "Export failed.");
      setExportProgress(null);
    } finally {
      setIsExporting(false);
      setExportBeatState(null);
      exportTimelineDurationRef.current = 0;
      exportTimelineReadyResolverRef.current = null;
    }
  };

  return (

    <div className="h-screen h-[100dvh] w-screen bg-neutral-50 dark:bg-[#050505] text-neutral-900 dark:text-neutral-200 flex flex-col font-sans selection:bg-cyan-500/30 relative overflow-hidden transition-colors duration-300">

      {/* Background Ambience Layers */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />

      {/* Premium Glass Header */}
      <header className="h-16 border-b border-neutral-200/60 dark:border-neutral-800/60 bg-white/70 dark:bg-[#0a0a0a]/70 backdrop-blur-xl flex items-center px-6 shrink-0 z-10 sticky top-0 shadow-[0_4px_30px_rgba(0,0,0,0.05)] dark:shadow-[0_4px_30px_rgba(0,0,0,0.1)] transition-colors duration-300">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-[0_0_15px_rgba(34,211,238,0.3)]">
            <Play size={16} className="text-white fill-white ml-0.5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-gradient-to-br from-neutral-800 dark:from-white via-neutral-600 dark:via-neutral-200 to-neutral-500 dark:to-neutral-400 bg-clip-text text-transparent">
            Cartoon 2Director
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <div className="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-xs font-medium text-cyan-600 dark:text-cyan-400 flex items-center gap-1.5 shadow-[0_0_10px_rgba(34,211,238,0.1)]">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 dark:bg-cyan-400 animate-pulse" /> Prototype v0.2
          </div>
        </div>
      </header>

      {/* Main Workspace (Now Resizable) */}
      <main className="flex-1 flex overflow-hidden z-10 w-full">

        {/* Far Left Column: Project Assets Sidebar */}
        <aside className="w-16 md:w-48 lg:w-64 border-r border-neutral-200/50 dark:border-neutral-800/50 bg-white/60 dark:bg-[#070707]/60 backdrop-blur-md flex flex-col pt-4 hidden sm:flex shrink-0 transition-colors duration-300">
          {/* Project Switcher Dropdown */}
          <div className="px-3 mb-4 relative z-50">
            <button
              onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
              className="w-full bg-white dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700/50 rounded-lg px-3 py-2 flex items-center justify-between shadow-sm hover:border-cyan-500/50 transition-colors group"
            >
              <div className="flex flex-col items-start truncate">
                <span className="text-[9px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">Current Draft</span>
                <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200 truncate pr-2">
                  {projects.find(p => p.id === currentProjectId)?.title || "Loading..."}
                </span>
              </div>
              <ChevronDown size={14} className="text-neutral-400 group-hover:text-cyan-500 transition-colors" />
            </button>

            {isProjectDropdownOpen && (
              <div className="absolute top-full left-3 right-3 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 z-50">
                <div className="max-h-60 overflow-y-auto custom-scrollbar">
                  {projects.map(proj => (
                    <div
                      key={proj.id}
                      className={`group flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors border-l-2 ${proj.id === currentProjectId ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/10' : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                      onClick={() => handleSwitchProject(proj.id)}
                    >
                      {editingProjectId === proj.id ? (
                        <input
                          autoFocus
                          value={editProjectTitle}
                          onChange={(e) => setEditProjectTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleUpdateProjectTitle(proj.id, editProjectTitle);
                            if (e.key === 'Escape') setEditingProjectId(null);
                          }}
                          onBlur={() => handleUpdateProjectTitle(proj.id, editProjectTitle)}
                          className="flex-1 bg-white dark:bg-neutral-800 border-b border-cyan-500 focus:outline-none text-xs px-1 py-0.5"
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-300 pr-2">
                          {proj.title}
                        </span>
                      )}

                      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingProjectId(proj.id);
                            setEditProjectTitle(proj.title);
                            setConfirmDeleteId(null);
                          }}
                          className="p-1 hover:text-cyan-600 dark:hover:text-cyan-400 text-neutral-400"
                          title="Rename Cartoon"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={(e) => handleDeleteProject(proj.id, e)}
                          className={`p-1 transition-all ${confirmDeleteId === proj.id
                            ? 'text-red-500 scale-110 animate-pulse'
                            : 'text-neutral-400 hover:text-red-400'
                            }`}
                          title={confirmDeleteId === proj.id ? "Click again to delete" : "Delete Cartoon"}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="p-2 border-t border-neutral-100 dark:border-neutral-800">
                  <button
                    onClick={handleCreateProject}
                    className="w-full py-1.5 flex items-center justify-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/20 rounded transition-colors"
                  >
                    <Plus size={12} /> New Cartoon
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-3 space-y-1 custom-scrollbar">
            {/* Asset Categories */}
            <div className="px-2 py-2 flex items-center gap-3 text-sm text-cyan-700 dark:text-cyan-400 font-medium bg-cyan-100/60 dark:bg-cyan-900/10 rounded-lg cursor-pointer hover:bg-cyan-200/60 dark:hover:bg-cyan-900/20 transition-colors group">
              <LayoutList size={14} /> <span className="flex-1">Scenes</span>
              {storyData && (
                <button
                  title={confirmClearStory ? "Click again to confirm" : "Clear Story Database"}
                  className={`focus:outline-none transition-all ${confirmClearStory ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirmClearStory) {
                      if (currentProjectId) clearStoryStorage(currentProjectId);
                      setStoryData(null);
                      setConfirmClearStory(false);
                    } else {
                      setConfirmClearStory(true);
                      setTimeout(() => setConfirmClearStory(false), 3000);
                    }
                  }}
                >
                  <Trash2
                    size={12}
                    className={`transition-colors ${confirmClearStory ? 'text-red-500 animate-pulse' : 'text-cyan-700/50 hover:text-red-500'}`}
                  />
                </button>
              )}
              <span className="min-w-[1.5rem] text-center text-xs bg-cyan-200/60 dark:bg-cyan-900/40 px-1.5 py-0.5 rounded-md text-cyan-800 dark:text-cyan-300">{storyData?.beats.length || 0}</span>
            </div>
            {/* Actors Section */}
            <div>
              <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
                <ImageIcon size={14} /> <span className="flex-1">Actors</span> <span className="min-w-[1.5rem] text-center text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md text-neutral-700 dark:text-neutral-300">{storyData?.actors_detected.length || 0}</span>
              </div>
              {storyData && storyData.actors_detected.length > 0 && (
                <div className="mt-1 space-y-1 pl-2 pr-1">
                  {storyData.actors_detected.map(actor => (
                    (() => {
                      const clipNames = Object.keys(actor.drafted_rig?.rig_data.animation_clips || {}).sort();
                      return (
                    <div
                      key={actor.id}
                      onClick={() => handleActorSelect(selectedActorId === actor.id ? null : actor.id)}
                      className={`px-2 py-1.5 rounded-md cursor-pointer transition-colors group ${selectedActorId === actor.id ? 'bg-cyan-100 dark:bg-cyan-900/20 ring-1 ring-cyan-400 dark:ring-cyan-500/50' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
                    >
                      <div className="flex items-center gap-2">
                        {/* Actor Thumbnail */}
                        <div className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600">
                          {actorReferences[actor.id] ? (
                            <img
                              src={actorReferences[actor.id]}
                              alt={actor.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-neutral-400 dark:text-neutral-500">
                              <ImageIcon size={12} />
                            </div>
                          )}
                        </div>
                        {/* Actor Info & Draft Button */}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 truncate">{actor.name}</div>
                          <div className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                            {actor.species}
                            {actor.drafted_rig && (
                              <span className="ml-1 text-cyan-600 dark:text-cyan-400">
                                • {clipNames.length} action{clipNames.length === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Draft Vector Rig Button */}
                        {actorReferences[actor.id] && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDraftingActorId(actor.id);
                              // Load cached rig if it exists, otherwise prepare for new generation
                              setDraftedRig(actor.drafted_rig || null);
                              setDraftError(null);
                            }}
                            className={`p-1.5 rounded transition-colors group-hover:opacity-100 ${actor.drafted_rig
                              ? "text-emerald-500 hover:text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 opacity-100 border border-emerald-200 dark:border-emerald-700/50"
                              : "text-neutral-400 hover:text-cyan-500 opacity-0 bg-transparent"
                              }`}
                            title={actor.drafted_rig ? "View Vector Rig" : "Generate SVG Vector Rig"}
                          >
                            {actor.drafted_rig ? (
                              <div className="relative">
                                <Sparkles size={14} />
                                <div className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full border border-white dark:border-neutral-900"></div>
                              </div>
                            ) : (
                              <Sparkles size={14} />
                            )}
                          </button>
                        )}
                      </div>

                      {selectedActorId === actor.id && clipNames.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1 pl-10">
                          {clipNames.map(clipName => (
                            <span
                              key={`${actor.id}-${clipName}`}
                              className="inline-flex items-center rounded-full border border-cyan-200 dark:border-cyan-800/50 bg-cyan-50 dark:bg-cyan-900/20 px-2 py-0.5 text-[9px] font-mono text-cyan-700 dark:text-cyan-300"
                              title={`Reusable motion clip on ${actor.name}`}
                            >
                              {clipName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                      );
                    })()
                  ))}
                </div>
              )}
            </div>
            {/* Background Props subsection */}
            {(() => {
              const beatProps = storyData?.beats[selectedSceneIndex]?.drafted_background?.rig_data?.interactionNulls;
              if (!beatProps || beatProps.length === 0) return null;
              return (
              <div>
                <div className="px-2 py-1.5 text-[10px] font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
                  <Mountain size={12} /> Props
                </div>
                <div className="mt-0.5 space-y-0.5 pl-2 pr-1">
                  {beatProps.map(propId => (
                    <div
                      key={propId}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <div className="w-2 h-2 rounded-sm bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                      <span className="text-[10px] text-neutral-600 dark:text-neutral-400 truncate">{propId}</span>
                    </div>
                  ))}
                </div>
              </div>
              );
            })()}
            <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
              <Volume2 size={14} /> <span className="flex-1">Audio</span> <span className="min-w-[1.5rem] text-center text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded-md text-neutral-700 dark:text-neutral-300">0</span>
            </div>
          </div>

          <div className="p-4 border-t border-neutral-200/50 dark:border-neutral-800/50">
            <button className="w-full py-2 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-xs font-semibold text-neutral-700 dark:text-neutral-300 rounded-lg transition-colors flex items-center justify-center gap-2">
              + Import Asset
            </button>
          </div>
        </aside>

        <PanelGroup direction="horizontal" className="flex-1 w-full h-full">

          {/* Left Panel: Director's Prompt & Comic Timeline */}
          <Panel defaultSize={30} minSize={20}>
            <div className="w-full h-full flex flex-col bg-white/40 dark:bg-[#0a0a0a]/40 backdrop-blur-sm transition-colors duration-300">
              <section className="flex-1 flex flex-col px-6 py-8 pb-0 overflow-hidden">
                <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest mb-4 flex items-center gap-2.5">
                  <Sparkles size={16} className="text-cyan-500 dark:text-cyan-400" /> Director&apos;s Prompt
                </h2>

                <div className="relative group shrink-0">
                  <div className={`absolute -inset-0.5 bg-gradient-to-r from-cyan-400/30 dark:from-cyan-500/20 to-blue-400/30 dark:to-blue-500/20 rounded-2xl blur transition duration-500 ${isGenerating ? 'opacity-100 animate-pulse' : 'opacity-0 group-hover:opacity-100'}`} />
                  <div className="relative bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded-xl overflow-hidden shadow-sm dark:shadow-inner transition-colors duration-300">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      className="w-full h-28 bg-transparent p-5 pb-2 text-sm resize-none focus:outline-none placeholder-neutral-400 dark:placeholder-neutral-600 text-neutral-800 dark:text-neutral-200"
                      placeholder={generateMode === 'single' ? "Describe a single scene... e.g., 'A robot cat stares at a vacuum cleaner suspiciously.'" : "Describe a sequence... e.g., 'A robot cat runs in panic from a loud vacuum cleaner. Then it hides under the couch.'"}
                      disabled={isGenerating}
                    />
                    <div className="flex items-center justify-between px-3 pb-3 pt-1">
                      {/* Mode Toggle */}
                      <div className="flex items-center bg-neutral-100 dark:bg-neutral-800/80 rounded-lg p-0.5 border border-neutral-200/80 dark:border-neutral-700/50">
                        <button
                          onClick={() => setGenerateMode('single')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-200 ${generateMode === 'single' ? 'bg-white dark:bg-neutral-700 text-cyan-700 dark:text-cyan-300 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
                        >
                          Single Scene
                        </button>
                        <button
                          onClick={() => setGenerateMode('sequence')}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-200 ${generateMode === 'sequence' ? 'bg-white dark:bg-neutral-700 text-cyan-700 dark:text-cyan-300 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
                        >
                          Sequence
                        </button>
                      </div>
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !prompt.trim()}
                        className="bg-neutral-900 dark:bg-white disabled:bg-neutral-300 dark:disabled:bg-neutral-600 disabled:text-neutral-500 dark:disabled:text-neutral-400 hover:bg-neutral-700 dark:hover:bg-neutral-200 text-white dark:text-black px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 shadow-md dark:hover:shadow-[0_0_15px_rgba(255,255,255,0.4)] disabled:shadow-none transform hover:-translate-y-0.5 disabled:transform-none font-medium text-sm"
                      >
                        {isGenerating ? (
                          <><Loader2 size={14} className="animate-spin" /> <span>Directing...</span></>
                        ) : (
                          <><span>{generateMode === 'single' ? 'Generate Scene' : 'Generate Sequence'}</span><Send size={14} /></>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mt-4 p-3 rounded bg-red-100 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30 text-xs text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="mt-10 flex-1 flex flex-col min-h-0 overflow-hidden">
                  <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest mb-4 flex items-center gap-2.5 shrink-0">
                    <LayoutList size={16} className="text-blue-500 dark:text-blue-400" /> Storyboard Timeline
                  </h2>

                  {/* Timeline Scroll Area */}
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 pb-8 custom-scrollbar">

                    {!storyData ? (
                      <div className="flex flex-col items-center justify-center h-full max-w-xs mx-auto text-center px-4">
                        <div className="w-16 h-16 mb-4 rounded-full bg-white dark:bg-[#111] flex items-center justify-center border border-neutral-200 dark:border-neutral-800/80 shadow-sm dark:shadow-[0_0_15px_rgba(0,0,0,0.5)] transition-colors duration-300">
                          <Film strokeWidth={1.5} className="w-8 h-8 text-neutral-400 dark:text-neutral-500" />
                        </div>
                        <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Awaiting Direction</h3>
                        <p className="text-xs text-neutral-500 dark:text-neutral-500 leading-relaxed">
                          Describe your sequence in the prompt above to generate the storyboard beats and comic panels.
                        </p>
                      </div>
                    ) : (
                      storyData.beats.map((beat, index) => (
                        <div key={index} onClick={() => setSelectedSceneIndex(index)} className="cursor-pointer relative pl-1">
                          {/* Node Dot */}
                          <div className={`absolute left-0 top-6 w-3 h-3 rounded-full border-2 z-10 transition-all ${selectedSceneIndex === index ? 'bg-cyan-500 border-white shadow-[0_0_15px_rgba(34,211,238,0.8)] scale-125' : 'bg-white dark:bg-[#111] border-neutral-300 dark:border-neutral-700'}`} />

                          <div className={`ml-6 p-1 rounded-2xl border backdrop-blur-md shadow-lg transition-all duration-300 group/card ${selectedSceneIndex === index ? 'bg-cyan-50/50 dark:bg-cyan-900/20 border-cyan-400 dark:border-cyan-500/50 shadow-[0_8px_30px_rgba(34,211,238,0.15)]' : 'bg-white dark:bg-[#0f0f0f] border-neutral-200 dark:border-neutral-800/60 hover:border-cyan-300 dark:hover:border-neutral-700/80'}`}>
                            {/* Always-visible header with scene number + controls */}
                            <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-50 dark:bg-[#0a0a0a] border-b border-neutral-200/80 dark:border-neutral-800/50">
                              <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Scene {index + 1}</span>
                              <div className="flex items-center gap-0.5">
                                {/* Move Up */}
                                <button
                                  className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move Up"
                                  disabled={index === 0}
                                  onClick={() => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      [newBeats[index - 1], newBeats[index]] = [newBeats[index], newBeats[index - 1]];
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                >
                                  <ChevronUp size={12} />
                                </button>
                                {/* Move Down */}
                                <button
                                  className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move Down"
                                  disabled={index === storyData.beats.length - 1}
                                  onClick={() => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      [newBeats[index], newBeats[index + 1]] = [newBeats[index + 1], newBeats[index]];
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                >
                                  <ChevronDown size={12} />
                                </button>
                                {/* Duplicate */}
                                <button
                                  className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                                  title="Duplicate Scene"
                                  onClick={() => {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      const clone = JSON.parse(JSON.stringify(prev.beats[index]));
                                      newBeats.splice(index + 1, 0, clone);
                                      return { ...prev, beats: newBeats };
                                    });
                                  }}
                                >
                                  <Copy size={12} />
                                </button>
                                {/* Draft Background */}
                                <button
                                  className={`p-1 rounded transition-colors ${beat.drafted_background ? "text-emerald-500 hover:text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700/50" : "text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
                                  title={beat.drafted_background ? "View Vector Background" : "Generate SVG Background"}
                                  onClick={() => {
                                    setDraftingBackgroundSceneIndex(index);
                                    setDraftBackgroundError(null);
                                  }}
                                >
                                  {beat.drafted_background ? (
                                    <div className="relative">
                                      <Mountain size={12} />
                                      <div className="absolute -top-0.5 -right-0.5 w-[5px] h-[5px] bg-emerald-500 rounded-full"></div>
                                    </div>
                                  ) : (
                                    <Mountain size={12} />
                                  )}
                                </button>
                                {/* Edit */}
                                {editingBeatIndex !== index && (
                                  <button
                                    className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                                    title="Edit Panel"
                                    onClick={() => {
                                      setEditingBeatIndex(index);
                                      setEditPrompt("");
                                    }}
                                  >
                                    <Pencil size={12} />
                                  </button>
                                )}
                                {/* Delete (inline confirm) */}
                                <button
                                  className={`p-1 rounded transition-all ${confirmDeleteBeatIndex === index ? 'bg-red-100 dark:bg-red-950/30 text-red-500 animate-pulse' : 'hover:bg-red-100 dark:hover:bg-red-950/30 text-neutral-400 hover:text-red-500'}`}
                                  title={confirmDeleteBeatIndex === index ? "Click again to delete" : "Delete Scene"}
                                  onClick={() => {
                                    if (confirmDeleteBeatIndex === index) {
                                      setStoryData(prev => {
                                        if (!prev) return prev;
                                        const newBeats = [...prev.beats];
                                        newBeats.splice(index, 1);
                                        return { ...prev, beats: newBeats };
                                      });
                                      setConfirmDeleteBeatIndex(null);
                                    } else {
                                      setConfirmDeleteBeatIndex(index);
                                      setTimeout(() => setConfirmDeleteBeatIndex(curr => curr === index ? null : curr), 3000);
                                    }
                                  }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>

                            {/* Image area */}
                            <div className="w-full aspect-video bg-neutral-100 dark:bg-[#1a1a1a] flex items-center justify-center overflow-hidden relative">
                              {beat.image_data ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={beat.image_data} alt={`Scene ${beat.scene_number}`} className="w-full h-full object-cover" />
                              ) : isGenerating ? (
                                <div className="w-full h-full flex flex-col items-center justify-center animate-pulse bg-neutral-200/50 dark:bg-neutral-900/40">
                                  <ImageIcon className="text-neutral-400 dark:text-neutral-700 mb-2" size={32} />
                                  <span className="text-xs text-neutral-500 uppercase font-mono tracking-widest text-center px-1">Drawing Scene {beat.scene_number}...</span>
                                </div>
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center bg-red-50/50 dark:bg-red-950/20 text-red-500 border border-red-100 dark:border-red-900/50">
                                  <ImageOff className="text-red-400 dark:text-red-600 mb-2" size={32} />
                                  <span className="text-xs font-semibold text-center px-1">Image Generation Failed</span>
                                  <span className="text-[10px] text-red-400 mt-1 px-4 text-center">No image was returned. You can try editing the prompt or deleting this scene.</span>
                                </div>
                              )}

                              {/* Image Inpainting Edit Overlay */}
                              {editingBeatIndex === index && (
                                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-30 flex flex-col p-3 transition-all">
                                  <div className="flex-1 flex flex-col">
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-white/70 mb-1 flex items-center gap-1.5"><Pencil size={10} /> Redraw Instructions</label>
                                    <textarea
                                      autoFocus
                                      value={editPrompt}
                                      onChange={(e) => setEditPrompt(e.target.value)}
                                      placeholder="e.g. Make it raining, give them a blue hat, add a car in the background..."
                                      className="w-full flex-1 bg-black/40 border border-white/20 rounded p-2 text-xs text-white placeholder-white/40 resize-none focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all custom-scrollbar"
                                      disabled={isEditingImage}
                                    />
                                  </div>
                                  <div className="flex items-center justify-end gap-2 mt-2">
                                    <button
                                      className="px-3 py-1.5 text-[10px] font-semibold text-white/70 hover:text-white hover:bg-white/10 rounded transition-colors"
                                      onClick={() => {
                                        setEditingBeatIndex(null);
                                        setEditPrompt("");
                                      }}
                                      disabled={isEditingImage}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="px-3 py-1.5 text-[10px] font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors flex items-center gap-1.5 disabled:bg-cyan-800 disabled:text-white/50"
                                      onClick={() => handleEditImageSubmit(index)}
                                      disabled={isEditingImage || !editPrompt.trim()}
                                    >
                                      {isEditingImage ? <><Loader2 size={10} className="animate-spin" /> Rendering...</> : "Apply Edit"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Image generation cost badge */}
                            {beatGenerationCosts[index] && (
                              <div className="px-3 py-1 bg-neutral-50 dark:bg-[#0a0a0a] border-t border-neutral-100 dark:border-neutral-800/50 flex items-center gap-2 text-[9px] font-mono text-neutral-400 dark:text-neutral-600">
                                <span className="text-neutral-500 dark:text-neutral-500">Image gen:</span>
                                <span className="text-amber-600 dark:text-amber-500 font-semibold">~${beatGenerationCosts[index].cost.toFixed(5)}</span>
                                <span className="text-neutral-400 dark:text-neutral-600">{beatGenerationCosts[index].tokens.toLocaleString()} tokens</span>
                              </div>
                            )}

                            {/* Narrative + metadata */}
                            <div className="p-3 pt-2">
                              <p
                                className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed mb-2 cursor-text hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 rounded px-1 -mx-1 transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const newText = e.currentTarget.textContent || '';
                                  if (newText !== beat.narrative) {
                                    setStoryData(prev => {
                                      if (!prev) return prev;
                                      const newBeats = [...prev.beats];
                                      newBeats[index] = { ...newBeats[index], narrative: newText };
                                      return { ...prev, beats: newBeats };
                                    });
                                  }
                                }}
                              >
                                {beat.narrative}
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {beat.audio.map((audio, i) => (
                                  <span key={`audio-${i}`} className={`group/tag inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[9px] font-medium ${audio.type === 'dialogue' ? 'bg-amber-100 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-400' : 'bg-cyan-100 dark:bg-cyan-500/10 border-cyan-200 dark:border-cyan-500/20 text-cyan-700 dark:text-cyan-400'}`}>
                                    <Volume2 size={8} /> {audio.type === 'dialogue' ? `"${audio.text}"` : audio.description}
                                    <button
                                      className="opacity-0 group-hover/tag:opacity-100 ml-0.5 hover:text-red-500 transition-all"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setStoryData(prev => {
                                          if (!prev) return prev;
                                          const newBeats = [...prev.beats];
                                          newBeats[index] = { ...newBeats[index], audio: newBeats[index].audio.filter((_, ai) => ai !== i) };
                                          return { ...prev, beats: newBeats };
                                        });
                                      }}
                                      title="Remove this audio cue"
                                    >×</button>
                                  </span>
                                ))}
                                {beat.actions.map((act, i) => (
                                  <span
                                    key={`act-${i}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedSceneIndex(index);
                                      setSelectedActionIndex(i);
                                      setSelectedActorId(act.actor_id);
                                    }}
                                    className={`group/tag inline-flex items-center gap-1 px-2 py-0.5 rounded-full border cursor-pointer text-[9px] font-mono transition-colors ${selectedSceneIndex === index && selectedActionIndex === i ? 'bg-cyan-500 text-white border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]' : 'bg-neutral-100 dark:bg-neutral-800/80 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:border-cyan-400 dark:hover:border-cyan-500/50'}`}
                                  >
                                    {act.actor_id}:{act.motion}({act.style})
                                    <button
                                      className="opacity-0 group-hover/tag:opacity-100 ml-0.5 hover:text-red-500 transition-all"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setStoryData(prev => {
                                          if (!prev) return prev;
                                          const newBeats = [...prev.beats];
                                          newBeats[index] = { ...newBeats[index], actions: newBeats[index].actions.filter((_, ai) => ai !== i) };
                                          return { ...prev, beats: newBeats };
                                        });
                                        if (selectedSceneIndex === index && selectedActionIndex === i) {
                                          setSelectedActionIndex(null);
                                        }
                                      }}
                                      title="Remove this action"
                                    >×</button>
                                  </span>
                                ))}
                              </div>
                            </div>
                            
                            {/* Auto-Animate Macro Button + Persistent Log Console */}
                            <div className="border-t border-neutral-200/80 dark:border-neutral-800/50 bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
                              {(() => {
                                const persistedLogs = dismissedCompileReports[index]
                                  ? null
                                  : (completedAnimLogs[index] || beat.compile_report?.logs || null);

                                if (animatingSceneIndex === index) {
                                  return (
                                // Live: show spinning log while running
                                <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                  <div className="absolute top-2 right-2">
                                    <Loader2 size={12} className="animate-spin text-emerald-500 opacity-50" />
                                  </div>
                                  {animatingLogs.map((log, i) => (
                                    <div key={i} className="animate-in fade-in slide-in-from-bottom-1 leading-relaxed">{log}</div>
                                  ))}
                                </div>
                                  );
                                }

                                if (persistedLogs) {
                                  return (
                                // Completed: persistent log with dismiss + re-run button
                                <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 max-h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                  <div className="absolute top-2 right-2 flex items-center gap-1">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleAnimateScene(index);
                                      }}
                                      title="Re-run animation pipeline"
                                      className="text-neutral-500 hover:text-emerald-400 transition-colors"
                                    >
                                      <Play size={10} className="fill-current" />
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDismissedCompileReports(prev => ({ ...prev, [index]: true }));
                                        setCompletedAnimLogs(prev => { const n = { ...prev }; delete n[index]; return n; });
                                      }}
                                      title="Dismiss log"
                                      className="text-neutral-500 hover:text-red-400 transition-colors text-[11px] leading-none"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                  {persistedLogs.map((log, i) => (
                                    <div key={i} className="leading-relaxed">{log}</div>
                                  ))}
                                </div>
                                  );
                                }

                                if (beat.compiled_scene && !dismissedCompileReports[index]) {
                                  return (
                                    <div className="p-3 bg-neutral-950 font-mono text-[10px] text-emerald-400 max-h-28 overflow-y-auto flex flex-col gap-0.5 rounded-b-xl shadow-inner relative custom-scrollbar">
                                      <div className="absolute top-2 right-2 flex items-center gap-1">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleAnimateScene(index);
                                          }}
                                          title="Re-run animation pipeline"
                                          className="text-neutral-500 hover:text-emerald-400 transition-colors"
                                        >
                                          <Play size={10} className="fill-current" />
                                        </button>
                                      </div>
                                      <div>✓ Compiled scene timeline ({beat.compiled_scene.instance_tracks.length} track{beat.compiled_scene.instance_tracks.length === 1 ? "" : "s"}, {beat.compiled_scene.duration_seconds.toFixed(2)}s).</div>
                                      <div>✓ Persisted compiled scene found after refresh.</div>
                                      {beat.compile_report?.compiled_at && (
                                        <div>Last compile: {new Date(beat.compile_report.compiled_at).toLocaleString()}</div>
                                      )}
                                    </div>
                                  );
                                }

                                return (
                                // Idle: show Animate button
                                <div className="p-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleAnimateScene(index);
                                    }}
                                    disabled={isGenerating || !beat.image_data}
                                    className="w-full py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg shadow-sm flex items-center justify-center gap-2 transition-all group/animate"
                                  >
                                    <Play size={14} className="fill-white group-hover/animate:scale-110 transition-transform" /> Animate Scene
                                  </button>
                                </div>
                                );
                              })()}
                            </div>
                          </div>

                          {/* Insert After Button (between this panel and the next, or at end) */}
                          <div className="my-1">
                            {insertAtIndex === index + 1 ? (
                              <div className="p-3 rounded-xl bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-800/60 border-dashed">
                                <label className="text-[10px] uppercase tracking-wider font-semibold text-cyan-600 dark:text-cyan-400 mb-1.5 flex items-center gap-1.5">
                                  <Plus size={10} /> {index + 1 < storyData.beats.length ? `Insert Scene Between ${index + 1} & ${index + 2}` : `Add New Scene at End`}
                                </label>
                                <textarea
                                  autoFocus
                                  value={insertPrompt}
                                  onChange={(e) => setInsertPrompt(e.target.value)}
                                  placeholder="Describe what happens in this new scene..."
                                  className="w-full bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-700 rounded-lg p-2.5 text-xs text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 dark:placeholder-neutral-500 resize-none focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 h-20"
                                  disabled={isGenerating}
                                />
                                <div className="flex items-center justify-end gap-2 mt-2">
                                  <button className="px-3 py-1.5 text-[10px] font-semibold text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition-colors" onClick={() => { setInsertAtIndex(null); setInsertPrompt(""); }} disabled={isGenerating}>Cancel</button>
                                  <button className="px-3 py-1.5 text-[10px] font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50" onClick={() => handleInsertScene(index + 1)} disabled={isGenerating || !insertPrompt.trim()}>
                                    {isGenerating ? <><Loader2 size={10} className="animate-spin" /> Generating...</> : <><Plus size={10} /> Generate Scene</>}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setInsertAtIndex(index + 1); setInsertPrompt(""); }}
                                className="w-full py-1 border border-dashed border-neutral-300/60 dark:border-neutral-700/40 hover:border-cyan-400 dark:hover:border-cyan-600 rounded-lg text-[10px] font-medium text-neutral-400 dark:text-neutral-600 hover:text-cyan-600 dark:hover:text-cyan-400 transition-all flex items-center justify-center gap-1.5 hover:bg-cyan-50/50 dark:hover:bg-cyan-950/20"
                                disabled={isGenerating}
                              >
                                <Plus size={10} /> Insert Scene
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}

                  </div>
                </div>
              </section>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-emerald-500/50 transition-colors cursor-col-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center">
            <div className="w-0.5 h-8 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </PanelResizeHandle>

          {/* Center Panel: Animation Stage & Horizontal Timeline */}
          <Panel defaultSize={50} minSize={30}>
            <div className="w-full h-full flex flex-col bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-neutral-100 dark:from-neutral-900/40 via-white dark:via-[#050505] to-white dark:to-[#050505] relative transition-colors duration-300">
              <PanelGroup direction="vertical" className="flex-1 w-full h-full">

                {/* Top Viewport: Stage */}
                <Panel defaultSize={60} minSize={30}>
                  <div className="w-full h-full flex flex-col p-6 min-h-0">
                    <div className="flex items-center justify-between mb-6 shrink-0 z-20">
                      <h2 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2.5">
                        <Play size={16} className="text-emerald-500 dark:text-emerald-400" /> Performance Stage
                      </h2>

                      {/* Stage Output Controls */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded-lg p-1 shadow-sm dark:shadow-inner transition-colors duration-300">
                          {/* Resolution Dropdown */}
                          <div className="relative group/dropdown">
                            <button
                              onClick={() => setIsExportDropdownOpen(prev => !prev)}
                              className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 hover:text-black dark:hover:text-white bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded transition-colors group"
                            >
                              {EXPORT_RESOLUTIONS[exportResolution].label} <span className="text-[9px] font-mono text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-400">({EXPORT_RESOLUTIONS[exportResolution].width}x{EXPORT_RESOLUTIONS[exportResolution].height})</span> <ChevronDown size={14} className="text-neutral-400 dark:text-neutral-500 group-hover/dropdown:text-neutral-600 dark:group-hover/dropdown:text-neutral-300" />
                            </button>
                            {/* Dropdown Menu (Hidden by default, shown on hover for this prototype) */}
                            <div className={`absolute top-full mt-1 right-0 w-48 bg-white dark:bg-[#1a1a1a] border border-neutral-200 dark:border-neutral-700/50 rounded-lg shadow-xl transition-all duration-200 z-50 ${isExportDropdownOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
                              <div className="p-1 flex flex-col gap-0.5">
                                {Object.entries(EXPORT_RESOLUTIONS).map(([key, value]) => (
                                  <button
                                    key={key}
                                    onClick={() => {
                                      setExportResolution(key as keyof typeof EXPORT_RESOLUTIONS);
                                      setIsExportDropdownOpen(false);
                                    }}
                                    className={`text-left px-3 py-2 text-xs rounded flex items-center justify-between transition-colors ${exportResolution === key ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10' : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                                  >
                                    {value.label} <span className={`text-[9px] ${exportResolution === key ? 'text-emerald-500/70' : 'text-neutral-400 dark:text-neutral-500'}`}>{value.width}x{value.height}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-800" />

                          {/* Orientation Toggles */}
                          <div className="flex items-center gap-0.5">
                            <button className="p-1.5 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 rounded" title="Landscape (16:9)">
                              <div className="w-4 h-3 border-2 border-current rounded-[2px]" />
                            </button>
                            <button className="p-1.5 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded transition-colors" title="Portrait (9:16)">
                              <div className="w-3 h-4 border-2 border-current rounded-[2px]" />
                            </button>
                          </div>
                        </div>

                        {/* Export Button */}
                        <button
                          onClick={handleExport}
                          disabled={isExporting}
                          className="px-4 py-1.5 bg-gradient-to-br from-cyan-500 dark:from-cyan-600 to-blue-500 dark:to-blue-600 hover:from-cyan-600 hover:dark:from-cyan-500 hover:to-blue-600 hover:dark:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-[0_0_15px_rgba(34,211,238,0.3)] hover:shadow-[0_0_20px_rgba(34,211,238,0.5)] transition-all flex items-center gap-2 transform hover:-translate-y-0.5 disabled:transform-none"
                          title={`Export ${playbackScope === 'all' ? 'all compiled scenes' : 'selected scene'} to MP4`}
                        >
                          {isExporting ? <Loader2 size={12} className="animate-spin" /> : null}
                          Export <Send size={12} className="-mt-0.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 relative rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/80 dark:bg-[#0a0a0a]/80 shadow-lg dark:shadow-2xl overflow-hidden backdrop-blur-xl group/stage transition-colors duration-300">
                      {/* Stage Grid Pattern */}
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_10%,transparent_100%)]" />

                      <div className="absolute inset-0 flex items-center justify-center">
                        <Stage
                          beat={selectedBeat}
                          compiledScene={selectedCompiledScene}
                          frameRate={fps}
                          isPlaying={isPlaying}
                          playheadTime={currentTimeSeconds}
                          onTimelineReady={handleTimelineReady}
                          onPlayheadUpdate={handlePlayheadUpdate}
                          onPlayComplete={handlePlayComplete}
                          availableRigs={availableRigs}
                          selectedActorId={selectedActorId}
                          onActorSelect={handleActorSelect}
                          onActorPositionChange={handleActorPositionChange}
                        />
                      </div>

                      {/* Corner accoutrements */}
                      <div className="absolute bottom-4 left-4 text-[10px] text-neutral-400 dark:text-neutral-600 font-mono tracking-widest uppercase transition-colors">
                        SVG Render Engine
                      </div>
                    </div>
                  </div>
                </Panel>

                {/* Resize Handle for Vertical Splitting */}
                <PanelResizeHandle className="h-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-emerald-500/50 transition-colors cursor-row-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center relative">
                  <div className="w-8 h-0.5 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
                </PanelResizeHandle>

                {/* Bottom Viewport: Timeline Panel */}
                <Panel defaultSize={40} minSize={15}>
                  <div className="w-full h-full flex flex-col">
                    <div className="flex-1 rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/90 dark:bg-[#0a0a0a]/90 backdrop-blur-xl shadow-lg dark:shadow-2xl mx-6 mb-6 flex flex-col overflow-hidden transition-colors duration-300">

                      {/* 1. Timeline Toolbar (Global Transport Controls) */}
                      <div className="h-12 border-b border-neutral-200 dark:border-neutral-800/60 bg-neutral-50 dark:bg-[#0a0a0a] flex items-center px-4 shrink-0 shadow-sm z-30 relative transition-colors duration-300">
                        {/* Left Side: Scene info + FPS */}
                        <div className="w-48 flex items-center gap-2 shrink-0">
                          <div className="text-[10px] font-bold text-neutral-600 dark:text-neutral-300 uppercase tracking-widest bg-white dark:bg-neutral-900 px-2 py-1.5 rounded border border-neutral-200 dark:border-neutral-800 shadow-sm dark:shadow-none transition-colors">
                            Scene {selectedSceneIndex + 1}
                          </div>
                          {/* FPS selector */}
                          <div className="flex items-center bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden shadow-sm">
                            {([12, 24, 30, 60] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => setFps(f)}
                                className={`px-1.5 py-1 text-[9px] font-bold transition-colors ${fps === f ? 'bg-cyan-500 text-white' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'}`}
                              >{f}</button>
                            ))}
                          </div>
                        </div>

                        {/* Center: Transport Controls */}
                        <div className="flex-1 flex justify-center items-center gap-6">
                          <div className="flex items-center gap-2">
                            <button className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group" title="Step Back">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                            </button>
                            <button onClick={() => setIsPlaying(!isPlaying)} className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all group ${isPlaying ? 'bg-amber-500 hover:bg-amber-400 text-[#0a0a0a] shadow-[0_0_10px_rgba(245,158,11,0.3)]' : 'bg-emerald-500 hover:bg-emerald-400 text-white dark:text-[#0a0a0a] shadow-[0_0_10px_rgba(16,185,129,0.3)] hover:shadow-[0_0_15px_rgba(16,185,129,0.4)]'}`} title={isPlaying ? "Pause" : "Play"}>
                              {isPlaying ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> : <Play size={15} className="fill-current ml-0.5 group-hover:scale-110 transition-transform" />}
                            </button>
                            <button className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group" title="Step Forward">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M4 18l8.5-6L4 6v12zm13-12v12h2V6h-2z" /></svg>
                            </button>
                          </div>

                          <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-800/60" />

                          {/* Playback Modes */}
                          <div className="flex items-center gap-1 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded p-1 shadow-sm dark:shadow-none transition-colors">
                            <button
                              onClick={() => setPlaybackScope("scene")}
                              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'scene' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                              title="Export or operate on this scene only"
                            >
                              Scene
                            </button>
                            <button
                              onClick={() => setPlaybackScope("all")}
                              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${playbackScope === 'all' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'}`}
                              title="Export all compiled scenes sequentially"
                            >
                              All
                            </button>
                          </div>

                          <button className="text-neutral-400 dark:text-neutral-600 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900" title="Toggle Loop">
                            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8" /><path d="M21 3v5h-5" /><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" /><path d="M3 21v-5h5" /></svg>
                          </button>
                        </div>

                        {/* Right Side: frame counter */}
                        <div className="w-48 flex justify-end items-center gap-2 shrink-0">
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
                      <div className="h-8 border-b border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#111] flex items-center shrink-0 z-20 relative transition-colors duration-300">
                        <div className="w-48 border-r border-neutral-200 dark:border-neutral-800/60 h-full flex items-center px-4 bg-neutral-50 dark:bg-[#0a0a0a] shrink-0 transition-colors">
                          <span className="text-[10px] text-neutral-500 dark:text-neutral-600 font-bold uppercase tracking-wider">Layers</span>
                        </div>
                        <div className="flex-1 h-full relative overflow-hidden transition-colors" ref={timelineRef}>

                          {/* Playhead line + knob */}
                          <div className="absolute top-0 bottom-[-500px] w-[1px] bg-emerald-500/80 z-50 pointer-events-none dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)]" style={{ left: `${playheadPos}%` }}>
                            <div
                              className={`absolute top-0 left-1/2 -translate-x-1/2 w-3 h-4 bg-gradient-to-b from-emerald-400 to-emerald-600 rounded-b-[3px] cursor-grab active:cursor-grabbing border-b border-l border-r border-emerald-300 shadow-[0_2px_10px_rgba(16,185,129,0.5)] pointer-events-auto flex items-center justify-center flex-col gap-[2px] ${isDraggingPlayhead ? 'scale-110' : ''}`}
                              onMouseDown={() => setIsDraggingPlayhead(true)}
                            >
                              <span className="w-1.5 h-px bg-emerald-200/80"></span>
                              <span className="w-1.5 h-px bg-emerald-200/80"></span>
                            </div>
                          </div>

                          {/* Frame grid + second labels */}
                          <div className="absolute inset-0 flex items-end pb-1 pointer-events-none select-none">
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

                      {/* 3. Timeline Tracks */}
                      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">
                        {!storyData || storyData.beats.length === 0 ? (
                           <div className="h-full flex items-center justify-center text-xs text-neutral-500 font-mono">No scene selected.</div>
                        ) : (() => {
                          const beat = storyData.beats[selectedSceneIndex];
                          return (
                            <>
                              {/* Background / Environment Layer */}
                              <div className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                                <div className="w-48 h-full flex items-center gap-2 px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors">
                                  <Mountain size={10} className="text-neutral-400 dark:text-neutral-600 shrink-0" />
                                  <span className="text-[10px] text-neutral-500 dark:text-neutral-500 font-medium truncate">Background</span>
                                  {beat.drafted_background && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-auto shrink-0" title="Background generated" />}
                                </div>
                                <div className="flex-1 h-full relative overflow-hidden">
                                  {/* Ambient loop strip — full width, always on */}
                                  <div className="absolute inset-y-1.5 left-0 right-0 rounded bg-repeating-gradient opacity-50 dark:opacity-30"
                                    style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(99,102,241,0.15) 8px, rgba(99,102,241,0.15) 9px)' }}>
                                    <div className="absolute inset-0 border border-indigo-200 dark:border-indigo-700/30 rounded" />
                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-indigo-400 dark:text-indigo-500 select-none">ambient ↻</span>
                                  </div>
                                </div>
                              </div>

                              {/* Actor Layers */}
                              {(beat.compiled_scene?.instance_tracks.length
                                ? beat.compiled_scene.instance_tracks.map(track => ({
                                    actorId: track.actor_id,
                                    bindings: track.clip_bindings,
                                  }))
                                : Array.from(new Set(beat.actions.map(a => a.actor_id))).map(actorId => ({
                                    actorId,
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
                                  }))
                              ).map(({ actorId, bindings }) => {
                                const actorData = storyData.actors_detected.find(a => a.id === actorId);
                                const hasRig = !!actorData?.drafted_rig;
                                const hasIdleClip = !!actorData?.drafted_rig?.rig_data.animation_clips?.idle;

                                return (
                                  <div key={`track-${actorId}`} className="h-9 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                                    <div className="w-48 h-full flex items-center gap-2 px-3 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors">
                                      <div className="w-5 h-5 rounded shrink-0 bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                                        {actorReferences[actorId]
                                          ? <img src={actorReferences[actorId]} alt="" className="w-full h-full object-cover" />
                                          : <div className="w-full h-full flex items-center justify-center text-[8px] text-neutral-400">?</div>}
                                      </div>
                                      <span className="text-[10px] text-neutral-700 dark:text-neutral-300 font-medium truncate flex-1">{actorData?.name || actorId}</span>
                                      {hasRig && <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" title="Rig ready" />}
                                    </div>
                                    <div className="flex-1 h-full relative overflow-hidden">
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
                                        if (isIdleMotion) return null;
                                        return (
                                          <div
                                            key={binding.id}
                                            className={`absolute inset-y-1.5 rounded flex items-center px-2 cursor-pointer transition-colors z-10 ${
                                              isSelected
                                                ? 'bg-cyan-500/40 border border-cyan-400 text-cyan-700 dark:text-cyan-300'
                                                : 'bg-blue-100 dark:bg-blue-600/25 border border-blue-300 dark:border-blue-500/50 hover:bg-blue-200 dark:hover:bg-blue-600/35 text-blue-700 dark:text-blue-300'
                                            }`}
                                            style={{ left: `${clipStartPct}%`, width: `${clipWidthPct}%` }}
                                            onClick={() => {
                                              setSelectedActionIndex(binding.source_action_index);
                                              setSelectedActorId(actorId);
                                            }}
                                          >
                                            <span className="absolute -left-1 top-1/2 -translate-y-1/2 text-[10px] text-blue-400 dark:text-blue-400 leading-none select-none">◆</span>
                                            <span className="text-[9px] font-mono truncate pl-1">{binding.motion}</span>
                                            {binding.style && <span className="text-[8px] font-mono text-blue-400 dark:text-blue-500 ml-1 truncate">({binding.style})</span>}
                                            <span className="absolute -right-1 top-1/2 -translate-y-1/2 text-[10px] text-blue-400 dark:text-blue-400 leading-none select-none">◆</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </Panel>
              </PanelGroup>
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-neutral-200 dark:bg-neutral-800/60 hover:bg-cyan-500/50 transition-colors cursor-col-resize shadow-[inset_0_0_5px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_5px_rgba(0,0,0,0.5)] z-20 flex items-center justify-center">
            <div className="w-0.5 h-8 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </PanelResizeHandle>

          {/* Right Panel: Properties Panel (for Timeline Editing) */}
          <Panel defaultSize={20} minSize={15} maxSize={30}>
            <div className="w-full h-full flex flex-col bg-white/60 dark:bg-[#070707]/80 backdrop-blur-md border-l border-neutral-200/50 dark:border-neutral-800/50 z-20 transition-colors duration-300">
              <div className="h-10 border-b border-neutral-200/60 dark:border-neutral-800/60 flex items-center px-4 bg-white dark:bg-[#0a0a0a] shrink-0 transition-colors">
                <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest flex items-center gap-2"><SlidersHorizontal size={14} className="text-cyan-600 dark:text-cyan-500" /> Properties</span>
              </div>

              <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
                {(() => {
                  if (!storyData || storyData.beats.length === 0) {
                    return <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>;
                  }
                  
                  const beat = storyData.beats[selectedSceneIndex];
                  if (!beat) {
                    return <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Awaiting story data...</div>;
                  }
                  const selectedBindingRef = findCompiledBinding(beat.compiled_scene, selectedActionIndex);

                  // ── Animation Overview (shown when nothing selected) ──────
                  if (selectedActionIndex === null || !beat.actions[selectedActionIndex]) {
                    return (
                      <div className="space-y-5">
                        <div>
                          <h3 className="text-[9px] font-bold uppercase tracking-widest text-neutral-400 dark:text-neutral-600 mb-2">Compiled Scene Timeline</h3>
                          <div className="space-y-1.5">
                            {/* Background ambient */}
                            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-800/20">
                              <span className="text-indigo-400 text-[9px] font-mono">↻</span>
                              <span className="text-[10px] text-neutral-600 dark:text-neutral-400 flex-1">Background ambient</span>
                              <span className="text-[9px] text-indigo-400 font-mono">∞</span>
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
                                        onClick={() => { setSelectedActionIndex(binding.source_action_index); setSelectedActorId(track.actor_id); }}
                                      >
                                        <span className="text-blue-400 text-[9px] font-mono">▶</span>
                                        <span className="text-[9px] text-neutral-600 dark:text-neutral-400 flex-1">
                                          {binding.motion} <span className="text-neutral-400">({binding.style})</span>
                                          <span className="ml-1 text-cyan-500 font-mono">→ {binding.clip_id}</span>
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
                                  onClick={() => { setSelectedActionIndex(idx); setSelectedActorId(action.actor_id); }}
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

                  const action = beat.actions[selectedActionIndex];
                  const binding = selectedBindingRef?.binding;
                  const transform = binding?.start_transform || action.spatial_transform || { x: 500, y: 800, scale: 1.0, z_index: 10 };

                  const updateTransform = (key: keyof typeof transform, value: number) => {
                    setStoryData(prev => {
                      if (!prev) return prev;
                      const newBeats = [...prev.beats];
                      const currentBeat = newBeats[selectedSceneIndex];
                      const newActions = [...newBeats[selectedSceneIndex].actions];
                      newActions[selectedActionIndex] = {
                        ...newActions[selectedActionIndex],
                        spatial_transform: { ...transform, [key]: value }
                      };
                      let nextCompiledScene = currentBeat.compiled_scene;
                      const nextBindingRef = findCompiledBinding(nextCompiledScene, selectedActionIndex);
                      if (nextCompiledScene && nextBindingRef) {
                        nextCompiledScene = {
                          ...nextCompiledScene,
                          instance_tracks: nextCompiledScene.instance_tracks.map((track, trackIndex) => {
                            if (trackIndex !== nextBindingRef.trackIndex) return track;
                            return {
                              ...track,
                              transform_track: track.transform_track.map((keyframe, keyframeIndex) =>
                                keyframeIndex === 0 ? { ...keyframe, [key]: value } : keyframe
                              ),
                              clip_bindings: track.clip_bindings.map((clipBinding, bindingIndex) =>
                                bindingIndex === nextBindingRef.bindingIndex
                                  ? { ...clipBinding, start_transform: { ...clipBinding.start_transform, [key]: value } }
                                  : clipBinding
                              ),
                            };
                          }),
                        };
                      }
                      newBeats[selectedSceneIndex] = { ...newBeats[selectedSceneIndex], actions: newActions, compiled_scene: nextCompiledScene };
                      return { ...prev, beats: newBeats };
                    });
                  };

                  const targetTransform = binding?.end_transform || action.target_spatial_transform || { x: transform.x + 200, y: transform.y, scale: transform.scale, z_index: transform.z_index };
                  
                  const updateTargetTransform = (key: keyof typeof targetTransform, value: number) => {
                    setStoryData(prev => {
                      if (!prev) return prev;
                      const newBeats = [...prev.beats];
                      const currentBeat = newBeats[selectedSceneIndex];
                      const newActions = [...newBeats[selectedSceneIndex].actions];
                      newActions[selectedActionIndex] = {
                        ...newActions[selectedActionIndex],
                        target_spatial_transform: { ...targetTransform, [key]: value }
                      };
                      let nextCompiledScene = currentBeat.compiled_scene;
                      const nextBindingRef = findCompiledBinding(nextCompiledScene, selectedActionIndex);
                      if (nextCompiledScene && nextBindingRef) {
                        nextCompiledScene = {
                          ...nextCompiledScene,
                          instance_tracks: nextCompiledScene.instance_tracks.map((track, trackIndex) => {
                            if (trackIndex !== nextBindingRef.trackIndex) return track;
                            return {
                              ...track,
                              transform_track: track.transform_track.map((keyframe, keyframeIndex) =>
                                keyframeIndex === track.transform_track.length - 1 ? { ...keyframe, [key]: value } : keyframe
                              ),
                              clip_bindings: track.clip_bindings.map((clipBinding, bindingIndex) =>
                                bindingIndex === nextBindingRef.bindingIndex
                                  ? {
                                      ...clipBinding,
                                      end_transform: { ...(clipBinding.end_transform || clipBinding.start_transform), [key]: value },
                                    }
                                  : clipBinding
                              ),
                            };
                          }),
                        };
                      }
                      newBeats[selectedSceneIndex] = { ...newBeats[selectedSceneIndex], actions: newActions, compiled_scene: nextCompiledScene };
                      return { ...prev, beats: newBeats };
                    });
                  };

                  const updateDuration = (value: number) => {
                     setStoryData(prev => {
                      if (!prev) return prev;
                      const newBeats = [...prev.beats];
                      const currentBeat = newBeats[selectedSceneIndex];
                      const newActions = [...newBeats[selectedSceneIndex].actions];
                      newActions[selectedActionIndex] = {
                        ...newActions[selectedActionIndex],
                        duration_seconds: value
                      };
                      let nextCompiledScene = currentBeat.compiled_scene;
                      const nextBindingRef = findCompiledBinding(nextCompiledScene, selectedActionIndex);
                      if (nextCompiledScene && nextBindingRef) {
                        nextCompiledScene = {
                          ...nextCompiledScene,
                          duration_seconds: Math.max(
                            nextCompiledScene.duration_seconds,
                            (nextBindingRef.binding.start_time || 0) + value,
                          ),
                          instance_tracks: nextCompiledScene.instance_tracks.map((track, trackIndex) => {
                            if (trackIndex !== nextBindingRef.trackIndex) return track;
                            return {
                              ...track,
                              clip_bindings: track.clip_bindings.map((clipBinding, bindingIndex) =>
                                bindingIndex === nextBindingRef.bindingIndex
                                  ? { ...clipBinding, duration_seconds: value }
                                  : clipBinding
                              ),
                            };
                          }),
                        };
                      }
                      newBeats[selectedSceneIndex] = { ...newBeats[selectedSceneIndex], actions: newActions, compiled_scene: nextCompiledScene };
                      return { ...prev, beats: newBeats };
                    });
                  };

                  return (
                    <div className="flex flex-col gap-5 transition-opacity">
                      <div>
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-1 uppercase tracking-wider flex justify-between">
                          <span>{binding ? "Selected Binding" : "Selected Action"}</span>
                          <span className="text-cyan-500">{action.actor_id}</span>
                        </div>
                        <div className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 flex items-center px-3 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm dark:shadow-none transition-colors">
                          {action.motion}({action.style}){binding ? ` -> ${binding.clip_id}` : ""}
                        </div>
                      </div>

                      {/* Motion Editor */}
                      <div>
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider flex items-center gap-2">
                          <Play size={12} /> Motion
                        </div>
                        <input
                          list="motion-suggestions"
                          value={action.motion}
                          onChange={e => {
                            const newMotion = e.target.value;
                            setStoryData(prev => {
                              if (!prev) return prev;
                              const newBeats = [...prev.beats];
                              const newActions = [...newBeats[selectedSceneIndex].actions];
                              newActions[selectedActionIndex] = {
                                ...newActions[selectedActionIndex],
                                motion: newMotion,
                                // Clear target transform for non-movement motions
                                target_spatial_transform: motionNeedsTarget(newMotion)
                                  ? newActions[selectedActionIndex].target_spatial_transform
                                  : undefined,
                              };
                              newBeats[selectedSceneIndex] = { ...newBeats[selectedSceneIndex], actions: newActions };
                              return { ...prev, beats: newBeats };
                            });
                          }}
                          className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 px-2 text-xs text-neutral-700 dark:text-neutral-300 shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                        />
                        <datalist id="motion-suggestions">
                          {Array.from(new Set([
                            action.motion,
                            ...(storyData?.actors_detected.find(a => a.id === action.actor_id)?.drafted_rig
                              ? Object.keys(storyData.actors_detected.find(a => a.id === action.actor_id)?.drafted_rig?.rig_data.animation_clips || {})
                              : []),
                            'idle', 'walk', 'run', 'jump', 'swim', 'crawl', 'fly', 'slither', 'glide', 'drive', 'wave', 'sit', 'hide', 'panic', 'celebrate'
                          ])).map(m => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </div>

                      <div className="pt-3 border-t border-neutral-200 dark:border-neutral-800">
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex items-center gap-2">
                          <Mountain size={12} /> Spatial Transform
                        </div>
                        
                        <div className="space-y-4">
                          {/* X Position */}
                          <div>
                            <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                              <span>X Position</span>
                              <span>{transform.x}px</span>
                            </div>
                            <input 
                              type="range" min="-200" max="1200" step="10" 
                              value={transform.x} 
                              onChange={e => updateTransform('x', parseInt(e.target.value))}
                              className="w-full accent-cyan-500" 
                            />
                          </div>

                          {/* Y Position */}
                          <div>
                            <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                              <span>Y Position (Floor)</span>
                              <span>{transform.y}px</span>
                            </div>
                            <input 
                              type="range" min="-200" max="1200" step="10" 
                              value={transform.y} 
                              onChange={e => updateTransform('y', parseInt(e.target.value))}
                              className="w-full accent-cyan-500" 
                            />
                          </div>

                          {/* Scale */}
                          <div>
                            <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                              <span>Scale (Depth)</span>
                              <span>{transform.scale.toFixed(2)}x</span>
                            </div>
                            <input 
                              type="range" min="0.1" max="3" step="0.05" 
                              value={transform.scale} 
                              onChange={e => updateTransform('scale', parseFloat(e.target.value))}
                              className="w-full accent-cyan-500" 
                            />
                          </div>
                          
                          {/* Z-Index */}
                          <div>
                            <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                              <span>Z-Index (Layer)</span>
                              <span>{transform.z_index}</span>
                            </div>
                            <input 
                              type="range" min="0" max="100" step="1" 
                              value={transform.z_index} 
                              onChange={e => updateTransform('z_index', parseInt(e.target.value))}
                              className="w-full accent-cyan-500" 
                            />
                          </div>
                        </div>
                      </div>

                      {/* Target Transform (For Movement) */}
                      {motionNeedsTarget(action.motion) && (
                        <div className="pt-3 border-t border-neutral-200 dark:border-neutral-800">
                          <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex items-center gap-2">
                            <Mountain size={12} className="opacity-50" /> Target Destination
                          </div>
                          
                          <div className="space-y-4">
                            {/* X Target */}
                            <div>
                              <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                                <span>End X Position</span>
                                <span>{targetTransform.x}px</span>
                              </div>
                              <input 
                                type="range" min="-200" max="1200" step="10" 
                                value={targetTransform.x} 
                                onChange={e => updateTargetTransform('x', parseInt(e.target.value))}
                                className="w-full accent-blue-500" 
                              />
                            </div>

                            {/* Y Target */}
                            <div>
                              <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                                <span>End Y Position</span>
                                <span>{targetTransform.y}px</span>
                              </div>
                              <input 
                                type="range" min="-200" max="1200" step="10" 
                                value={targetTransform.y} 
                                onChange={e => updateTargetTransform('y', parseInt(e.target.value))}
                                className="w-full accent-blue-500" 
                              />
                            </div>
                            
                            {/* Scale Target */}
                            <div>
                              <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                                <span>End Scale</span>
                                <span>{targetTransform.scale.toFixed(2)}x</span>
                              </div>
                              <input 
                                type="range" min="0.1" max="3" step="0.05" 
                                value={targetTransform.scale} 
                                onChange={e => updateTargetTransform('scale', parseFloat(e.target.value))}
                                className="w-full accent-blue-500" 
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="pt-3 border-t border-neutral-200 dark:border-neutral-800">
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-3 uppercase tracking-wider flex items-center gap-2">
                          <Play size={12} /> Animation Timing
                        </div>
                        <div>
                            <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                              <span>Duration</span>
                              <span>{action.duration_seconds}s</span>
                            </div>
                            <input 
                              type="range" min="0.5" max="10" step="0.5" 
                              value={action.duration_seconds} 
                              onChange={e => updateDuration(parseFloat(e.target.value))}
                              className="w-full accent-emerald-500" 
                            />
                        </div>
                      </div>

                    </div>
                  );
                })()}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </main>

      {/* Set Designer Modal */}
      {draftingBackgroundSceneIndex !== null && storyData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[90vh]">

            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <h3 className="font-semibold text-neutral-800 dark:text-neutral-200 flex items-center gap-2">
                <Mountain size={16} className="text-cyan-500" />
                Scene {draftingBackgroundSceneIndex + 1} - Vector Environment
              </h3>
              <button
                onClick={() => {
                  setDraftingBackgroundSceneIndex(null);
                  setDraftBackgroundError(null);
                }}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                disabled={isDraftingBackground}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto flex flex-col items-center justify-center min-h-[400px]">
              {(() => {
                const beat = storyData.beats[draftingBackgroundSceneIndex];
                if (!beat) return null;

                return (
                  <>
                    {!beat.drafted_background && !isDraftingBackground && (
                      <div className="flex flex-col items-center max-w-sm text-center">
                        <div className="w-48 aspect-video mb-6 rounded-xl overflow-hidden shadow-lg border-2 border-cyan-500/30">
                          {beat.image_data ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={beat.image_data} alt="Reference" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-neutral-200 dark:bg-neutral-800" />
                          )}
                        </div>
                        <h4 className="text-lg font-bold text-neutral-800 dark:text-neutral-200 mb-2">Build Environment Set</h4>
                        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
                          The Set Designer AI will extract the scenery from this panel and recreate it as a 3-layer parallax SVG (sky, midground, foreground).
                        </p>
                        <button
                          onClick={async () => {
                            if (!beat.image_data) {
                              setDraftBackgroundError("No image data available for this scene.");
                              return;
                            }
                            setIsDraftingBackground(true);
                            setDraftBackgroundError(null);
                            try {
                              const result = await processSetDesignerPrompt(beat.image_data, beat.narrative);

                              setStoryData(prev => {
                                if (!prev) return prev;
                                const newBeats = [...prev.beats];
                                newBeats[draftingBackgroundSceneIndex] = {
                                  ...newBeats[draftingBackgroundSceneIndex],
                                  drafted_background: result.data,
                                };
                                return { ...prev, beats: newBeats };
                              });
                            } catch (err: any) {
                              setDraftBackgroundError(err.message || "Failed to generate background.");
                            } finally {
                              setIsDraftingBackground(false);
                            }
                          }}
                          className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-all shadow-md shadow-cyan-900/20 flex items-center justify-center gap-2"
                        >
                          <Mountain size={16} /> Begin Set Design
                        </button>
                      </div>
                    )}

                    {isDraftingBackground && (
                      <div className="flex flex-col items-center">
                        <div className="relative mb-6">
                          <div className="w-48 aspect-video rounded-xl overflow-hidden opacity-50 blur-sm">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {beat.image_data && <img src={beat.image_data} alt="Reference" className="w-full h-full object-cover" />}
                          </div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 size={32} className="text-cyan-500 animate-spin" />
                          </div>
                        </div>
                        <h4 className="text-neutral-800 dark:text-neutral-200 font-medium">Painting Parallax Layers...</h4>
                        <p className="text-xs text-neutral-500 mt-2">This may take 15-20 seconds.</p>
                      </div>
                    )}

                    {draftBackgroundError && (
                      <div className="p-4 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg max-w-md text-center text-sm">
                        {draftBackgroundError}
                      </div>
                    )}

                    {beat.drafted_background && (
                      <div className="w-full h-full flex flex-col">
                        <div className="bg-emerald-100/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs px-4 py-2 rounded-lg mb-4 text-center border border-emerald-200 dark:border-emerald-800/50">
                          Set Designer Success: Found {beat.drafted_background.rig_data.interactionNulls.length} interaction props. Hover points to inspect anchor nulls.
                        </div>
                        <div className="flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-900 rounded-xl overflow-hidden relative shadow-inner">
                          <RigViewer data={beat.drafted_background} />
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Draftsman Modal */}
      {draftingActorId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[90vh]">

            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800/60 flex items-center justify-between bg-neutral-50/50 dark:bg-[#0a0a0a]/50">
              <h3 className="font-semibold text-neutral-800 dark:text-neutral-200 flex items-center gap-2">
                <Sparkles size={16} className="text-cyan-500" />
                {storyData?.actors_detected.find(a => a.id === draftingActorId)?.name} - Vector Drafting
              </h3>
              <button
                onClick={() => {
                  setDraftingActorId(null);
                  setDraftedRig(null);
                  setDraftError(null);
                }}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                disabled={isDrafting}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 flex-1 overflow-y-auto flex flex-col items-center justify-center min-h-[400px]">

              {!draftedRig && !isDrafting && (
                <div className="flex flex-col items-center max-w-sm text-center">
                  <div className="w-24 h-24 mb-6 rounded-xl overflow-hidden shadow-lg border-2 border-cyan-500/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={actorReferences[draftingActorId]} alt="Reference" className="w-full h-full object-cover" />
                  </div>
                  <h4 className="text-lg font-bold text-neutral-800 dark:text-neutral-200 mb-2">Generate Animatable Rig</h4>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
                    The Draftsman AI will analyze this character and redraw them as a structured SVG vector puppet, complete with interaction pivot points.
                  </p>
                  <button
                    onClick={async () => {
                      setIsDrafting(true);
                      setDraftError(null);
                      try {
                        const actor = storyData?.actors_detected.find(a => a.id === draftingActorId);
                        if (!actor || !actorReferences[draftingActorId]) throw new Error("Missing actor data");
                        const description = `Name: ${actor.name}. Species: ${actor.species}. Personality: ${actor.personality}. Visuals: ${actor.attributes.join(', ')}. ${actor.visual_description}`;

                        const result = await processDraftsmanPrompt(actorReferences[draftingActorId], description);

                        // Cache the generated rig into the global story data
                        setStoryData(prev => {
                          if (!prev) return prev;
                          return {
                            ...prev,
                            actors_detected: prev.actors_detected.map(a =>
                              a.id === draftingActorId ? { ...a, drafted_rig: result.data } : a
                            )
                          };
                        });

                        setDraftedRig(result.data);
                      } catch (err: any) {
                        setDraftError(err.message || "Failed to generate rig.");
                      } finally {
                        setIsDrafting(false);
                      }
                    }}
                    className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-all shadow-md shadow-cyan-900/20 flex items-center justify-center gap-2"
                  >
                    <Sparkles size={16} /> Begin Drafting Phase
                  </button>
                </div>
              )}

              {isDrafting && (
                <div className="flex flex-col items-center">
                  <div className="relative mb-6">
                    <div className="w-20 h-20 rounded-xl overflow-hidden opacity-50 blur-sm">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={actorReferences[draftingActorId]} alt="Reference" className="w-full h-full object-cover" />
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 size={32} className="text-cyan-500 animate-spin" />
                    </div>
                  </div>
                  <h4 className="text-neutral-800 dark:text-neutral-200 font-medium">Drawing Vector Arrays...</h4>
                  <p className="text-xs text-neutral-500 mt-2">This may take 15-20 seconds.</p>
                </div>
              )}

              {draftError && (
                <div className="p-4 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg max-w-md text-center text-sm">
                  {draftError}
                </div>
              )}

              {draftedRig && (
                <div className="w-full h-full flex flex-col">
                  <div className="bg-emerald-100/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs px-4 py-2 rounded-lg mb-4 text-center border border-emerald-200 dark:border-emerald-800/50">
                    Draftsman Success: Found {draftedRig.rig_data.bones.length} bones, {draftedRig.rig_data.visemes?.length || 0} visemes, and {draftedRig.rig_data.emotions?.length || 0} emotions. Hover points to inspect rig.
                  </div>
                  <div className="flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-900 rounded-xl overflow-hidden relative shadow-inner">
                    <RigViewer data={draftedRig} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {exportBeatState && (
        <div
          ref={exportStageHostRef}
          className="pointer-events-none fixed -left-[10000px] top-0 h-[1080px] w-[1920px] opacity-0"
          aria-hidden="true"
        >
          <Stage
            stageDomId="cartoon2d-export-stage"
            beat={exportBeatState.beat}
            compiledScene={exportBeatState.compiledScene}
            availableRigs={availableRigs}
            frameRate={fps}
            disableAmbient={true}
            isPlaying={false}
            playheadTime={exportPlayheadTime}
            onTimelineReady={handleExportTimelineReady}
            selectedActorId={null}
          />
        </div>
      )}

    </div>
  );
}
