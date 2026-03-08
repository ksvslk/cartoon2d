"use client";

import { useState, useEffect } from "react";
import Stage from "@/components/Stage";
import { Send, Play, Image as ImageIcon, ImageOff, Volume2, Sparkles, LayoutList, SlidersHorizontal, ChevronDown, ChevronUp, Loader2, Film, Trash2, Pencil, Plus, Copy, Check, Mountain } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { processScenePromptStream, processSceneImageEdit } from "@/app/actions/scene";
import { StoryGenerationData } from "@/lib/schema/story";
import { loadStoryFromStorage, saveStoryToStorage, clearStoryStorage, getProjectsList, createProject, deleteProject, updateProjectTitle, ProjectMetadata, loadActorIdentities, saveActorIdentity } from "@/lib/storage/db";
import { processDraftsmanPrompt } from "@/app/actions/draftsman";
import { processSetDesignerPrompt } from "@/app/actions/set_designer";
import { DraftsmanData } from "@/lib/schema/rig";
import { RigViewer } from "@/components/RigViewer";

import { ThemeToggle } from "@/components/ThemeToggle";

export default function Home() {
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
  const [isStoryApproved, setIsStoryApproved] = useState(false);

  // Draftsman / Rigging State
  const [draftingActorId, setDraftingActorId] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [draftedRig, setDraftedRig] = useState<DraftsmanData | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Set Designer State
  const [draftingBackgroundSceneIndex, setDraftingBackgroundSceneIndex] = useState<number | null>(null);
  const [isDraftingBackground, setIsDraftingBackground] = useState(false);
  const [draftBackgroundError, setDraftBackgroundError] = useState<string | null>(null);

  // Generation Mode: 'sequence' | 'single'
  const [generateMode, setGenerateMode] = useState<'sequence' | 'single'>('single');

  // Stage Selection State
  const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);

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
                      setIsStoryApproved(false);
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
                    <div
                      key={actor.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition-colors group"
                    >
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
                        <div className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">{actor.species}</div>
                      </div>

                      {/* Draft Vector Rig Button */}
                      {actorReferences[actor.id] && (
                        <button
                          onClick={() => {
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
                  ))}
                </div>
              )}
            </div>
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
                                  <span key={`act-${i}`} className="group/tag inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700 text-[9px] font-mono text-neutral-600 dark:text-neutral-400">
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
                                      }}
                                      title="Remove this action"
                                    >×</button>
                                  </span>
                                ))}
                              </div>
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

                    {/* Approve Storyboard Button */}
                    {storyData && storyData.beats.length > 0 && (
                      <div className="mt-4 mb-2">
                        {isStoryApproved ? (
                          <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/50">
                            <div className="flex items-center gap-2">
                              <Check size={16} className="text-emerald-600 dark:text-emerald-400" />
                              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Storyboard Approved</span>
                            </div>
                            <button
                              onClick={() => setIsStoryApproved(false)}
                              className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-200 underline transition-colors"
                            >
                              Edit Again
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setIsStoryApproved(true)}
                            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg hover:-translate-y-0.5 transform"
                          >
                            <Check size={14} /> Approve Storyboard
                          </button>
                        )}
                      </div>
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
                            <button className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 hover:text-black dark:hover:text-white bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded transition-colors group">
                              1080p FHD <span className="text-[9px] font-mono text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-400">(1920x1080)</span> <ChevronDown size={14} className="text-neutral-400 dark:text-neutral-500 group-hover/dropdown:text-neutral-600 dark:group-hover/dropdown:text-neutral-300" />
                            </button>
                            {/* Dropdown Menu (Hidden by default, shown on hover for this prototype) */}
                            <div className="absolute top-full mt-1 right-0 w-48 bg-white dark:bg-[#1a1a1a] border border-neutral-200 dark:border-neutral-700/50 rounded-lg shadow-xl opacity-0 invisible group-hover/dropdown:opacity-100 group-hover/dropdown:visible transition-all duration-200 z-50">
                              <div className="p-1 flex flex-col gap-0.5">
                                <button className="text-left px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors flex items-center justify-between">720p HD <span className="text-[9px] text-neutral-400 dark:text-neutral-500">1280x720</span></button>
                                <button className="text-left px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 rounded flex items-center justify-between">1080p FHD <span className="text-[9px] text-emerald-500/70">1920x1080</span></button>
                                <button className="text-left px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors flex items-center justify-between">4K UHD <span className="text-[9px] text-neutral-400 dark:text-neutral-500">3840x2160</span></button>
                                <button className="text-left px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors flex items-center justify-between">8K UHD <span className="text-[9px] text-neutral-400 dark:text-neutral-500">7680x4320</span></button>
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
                        <button className="px-4 py-1.5 bg-gradient-to-br from-cyan-500 dark:from-cyan-600 to-blue-500 dark:to-blue-600 hover:from-cyan-600 hover:dark:from-cyan-500 hover:to-blue-600 hover:dark:to-blue-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-[0_0_15px_rgba(34,211,238,0.3)] hover:shadow-[0_0_20px_rgba(34,211,238,0.5)] transition-all flex items-center gap-2 transform hover:-translate-y-0.5">
                          Export <Send size={12} className="-mt-0.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 relative rounded-2xl border border-neutral-200 dark:border-neutral-800/60 bg-white/80 dark:bg-[#0a0a0a]/80 shadow-lg dark:shadow-2xl overflow-hidden backdrop-blur-xl group/stage transition-colors duration-300">
                      {/* Stage Grid Pattern */}
                      <div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,#000_10%,transparent_100%)]" />

                      <div className="absolute inset-0 flex items-center justify-center">
                        <Stage
                          beat={storyData && storyData.beats.length > 0 ? storyData.beats[selectedSceneIndex] : null}
                          availableRigs={
                            storyData 
                            ? storyData.actors_detected.reduce((acc, actor) => {
                                if (actor.drafted_rig) acc[actor.id] = actor.drafted_rig;
                                return acc;
                              }, {} as Record<string, DraftsmanData>)
                            : {}
                          }
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
                        {/* Left Side: Scene info */}
                        <div className="w-48 flex items-center gap-3 shrink-0">
                          <div className="text-[10px] font-bold text-neutral-600 dark:text-neutral-300 uppercase tracking-widest bg-white dark:bg-neutral-900 px-2 py-1.5 rounded border border-neutral-200 dark:border-neutral-800 shadow-sm dark:shadow-none transition-colors">Scene 1</div>
                          <button className="text-neutral-400 dark:text-neutral-500 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors" title="Timeline Settings">
                            <SlidersHorizontal size={14} />
                          </button>
                        </div>

                        {/* Center: Transport Controls */}
                        <div className="flex-1 flex justify-center items-center gap-6">
                          <div className="flex items-center gap-2">
                            <button className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group" title="Step Back">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                            </button>
                            <button className="w-8 h-8 rounded-lg bg-emerald-500 hover:bg-emerald-400 dark:hover:bg-emerald-400 flex items-center justify-center text-white dark:text-[#0a0a0a] transition-all shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.3)] hover:shadow-[0_0_15px_rgba(16,185,129,0.4)] dark:hover:shadow-[0_0_15px_rgba(16,185,129,0.5)] group" title="Play">
                              <Play size={15} className="fill-current ml-0.5 group-hover:scale-110 transition-transform" />
                            </button>
                            <button className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors group" title="Step Forward">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M4 18l8.5-6L4 6v12zm13-12v12h2V6h-2z" /></svg>
                            </button>
                          </div>

                          <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-800/60" />

                          {/* Playback Modes */}
                          <div className="flex items-center gap-1 bg-white dark:bg-[#111] border border-neutral-200 dark:border-neutral-800/80 rounded p-1 shadow-sm dark:shadow-none transition-colors">
                            <button className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 shadow-sm transition-colors" title="Play this scene only">Scene</button>
                            <button className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors" title="Play all scenes sequentially">All</button>
                          </div>

                          <button className="text-neutral-400 dark:text-neutral-600 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900" title="Toggle Loop">
                            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8" /><path d="M21 3v5h-5" /><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" /><path d="M3 21v-5h5" /></svg>
                          </button>
                        </div>

                        {/* Right Side flex spacer */}
                        <div className="w-48 flex justify-end shrink-0">
                          <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-500 font-bold bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-500/20 shadow-sm dark:shadow-none transition-colors">00:00:00</span>
                        </div>
                      </div>

                      {/* 2. Timeline Ruler Header (Track Labels & Time Ticks) */}
                      <div className="h-8 border-b border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#111] flex items-center shrink-0 z-20 relative transition-colors duration-300">
                        <div className="w-48 border-r border-neutral-200 dark:border-neutral-800/60 h-full flex items-center px-4 bg-neutral-50 dark:bg-[#0a0a0a] shrink-0 transition-colors">
                          <span className="text-[10px] text-neutral-500 dark:text-neutral-600 font-bold uppercase tracking-wider">Tracks</span>
                        </div>
                        <div className="flex-1 h-full relative bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iMTAwJSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJyZ2JhKDE1MCwxNTAsMTUwLDAuMikiIHg9IjAiIHk9IjAiLz48L3N2Zz4=')] dark:bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iMTAwJSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDUpIiB5PSIwIi8+PC9zdmc+')] bg-repeat-x transition-colors">

                          {/* Playhead Time Ruler & Beautiful Knob */}
                          <div className="absolute left-[20%] top-0 bottom-[-500px] w-[1px] bg-emerald-500/80 z-50 pointer-events-none dark:mix-blend-screen shadow-[0_0_10px_rgba(16,185,129,0.2)] dark:shadow-[0_0_10px_rgba(16,185,129,0.8)] transition-shadow">
                            {/* The Knob */}
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3 h-4 bg-gradient-to-b from-emerald-400 to-emerald-600 rounded-b-[3px] cursor-grab active:cursor-grabbing border-b border-l border-r border-emerald-300 shadow-[0_2px_10px_rgba(16,185,129,0.2)] dark:shadow-[0_2px_10px_rgba(16,185,129,0.5)] pointer-events-auto flex items-center justify-center flex-col gap-[2px]">
                              <span className="w-1.5 h-px bg-emerald-200/80 dark:bg-emerald-200/50"></span>
                              <span className="w-1.5 h-px bg-emerald-200/80 dark:bg-emerald-200/50"></span>
                            </div>
                          </div>

                          <div className="flex items-end h-full px-2 gap-[28px] text-[9px] text-neutral-400 dark:text-neutral-600 font-mono pb-1 select-none pointer-events-none transition-colors">
                            <span>0:00</span><span>0:01</span><span>0:02</span><span>0:03</span><span>0:04</span><span>0:05</span>
                          </div>
                        </div>
                      </div>

                      {/* 3. Timeline Tracks */}
                      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">

                        {/* Audio Track */}
                        <div className="h-10 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                          <div className="w-48 h-full flex items-center px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors">
                            <span className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5"><Volume2 size={12} /> Audio</span>
                          </div>
                          <div className="flex-1 h-full py-1.5 px-2 relative">
                            {/* Audio Waveform Clip */}
                            <div className="absolute left-[10%] w-[15%] h-full top-0 py-1.5">
                              <div className="w-full h-full bg-cyan-100 dark:bg-cyan-900/40 border border-cyan-200 dark:border-cyan-800/50 rounded flex items-center justify-center overflow-hidden transition-colors">
                                <div className="w-full h-2/3 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgeD0iMCI yeD0iMiIgd2lkdGg9IjIiIGhlaWdodD0iNiIgZmlsbD0icmdiYSg4LCAxNDUsIDE3OCLCAwLjQpIi8+PHJlY3QgeD0iNCIgeT0iMCIgd2lkdGg9IjIiIGhlaWdodD0iMTAiIGZpbGw9InJnYmEoOCwgMTQ1LCAxNzgsIDAuNCkiLz48cmVjdCB4PSI4IiB5PSI0IiB3aWR0aD0iMiIgaGVpZ2h0PSI0IiBmaWxsPSJyZ2JhKDgsIDE0NSwgMTc4LCAwLjQpIi8+PC9zdmc+')] dark:bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgeD0iMCIgeT0iMiIgd2lkdGg9IjIiIGhlaWdodD0iNiIgZmlsbD0icmdiYSgzNCwgMjExLCAyMzgsIDAuNCkiLz48cmVjdCB4PSI0IiB5PSIwIiB3aWR0aD0iMiIgaGVpZ2h0PSIxMCIgZmlsbD0icmdiYSgzNCwgMjExLCAyMzgsIDAuNCkiLz48cmVjdCB4PSI4IiB5PSI0IiB3aWR0aD0iMiIgaGVpZ2h0PSI0IiBmaWxsPSJyZ2JhKDM0LCAyMTEsIDIzOCwgMC40KSIvPjwvc3ZnPg==')] bg-repeat-x opacity-60"></div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Actor Track: Robot Cat */}
                        <div className="h-10 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                          <div className="w-48 h-full flex items-center px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors">
                            <span className="text-xs text-neutral-700 dark:text-neutral-300 font-medium">Robot Cat</span>
                          </div>
                          <div className="flex-1 h-full py-1.5 px-2 relative">
                            {/* Motion Clip */}
                            <div className="absolute left-[15%] w-[40%] h-[70%] top-[15%] rounded bg-blue-100 dark:bg-blue-600/20 border border-blue-200 dark:border-blue-500/40 flex items-center px-2 cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-600/30 transition-colors">
                              <span className="text-[10px] font-mono text-blue-700 dark:text-blue-300 truncate">run(panic)</span>
                            </div>
                          </div>
                        </div>

                        {/* Actor Track: Vacuum Cleaner */}
                        <div className="h-10 border-b border-neutral-200 dark:border-neutral-800/40 flex shrink-0 group/track hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors">
                          <div className="w-48 h-full flex items-center px-4 border-r border-neutral-200 dark:border-neutral-800/60 bg-white dark:bg-[#0f0f0f] shrink-0 transition-colors">
                            <span className="text-xs text-neutral-700 dark:text-neutral-300 font-medium">Vacuum</span>
                          </div>
                          <div className="flex-1 h-full py-1.5 px-2 relative">
                            {/* Motion Clip */}
                            <div className="absolute left-[5%] w-[60%] h-[70%] top-[15%] rounded bg-amber-100 dark:bg-amber-600/20 border border-amber-200 dark:border-amber-500/40 flex items-center px-2 cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-600/30 transition-colors">
                              <span className="text-[10px] font-mono text-amber-700 dark:text-amber-300 truncate">idle(loud)</span>
                            </div>
                          </div>
                        </div>

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
                {/* Placeholder Property content */}
                <div className="flex flex-col gap-5 opacity-70 dark:opacity-50 transition-opacity">
                  <div>
                    <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-1 uppercase tracking-wider">Selected Clip</div>
                    <div className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 flex items-center px-3 text-xs text-neutral-700 dark:text-neutral-300 font-mono shadow-sm dark:shadow-none transition-colors">run(panic)</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-2 uppercase tracking-wider">Speed Multiplier</div>
                    <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden transition-colors">
                      <div className="w-[60%] h-full bg-cyan-500 rounded-full"></div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-500 dark:text-neutral-500 font-bold mb-1 uppercase tracking-wider">Blend Mode</div>
                    <div className="w-full h-8 bg-white dark:bg-neutral-800 rounded border border-neutral-200 dark:border-neutral-700/50 flex items-center px-3 text-xs text-neutral-600 dark:text-neutral-400 shadow-sm dark:shadow-none transition-colors">Smooth</div>
                  </div>
                </div>

                <div className="mt-8 text-center text-[10px] text-neutral-400 dark:text-neutral-600 font-mono transition-colors">Click a timeline block to edit properties.</div>
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
                                  drafted_background: result,
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
                              a.id === draftingActorId ? { ...a, drafted_rig: result } : a
                            )
                          };
                        });

                        setDraftedRig(result);
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

    </div>
  );
}
