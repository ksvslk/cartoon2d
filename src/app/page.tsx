"use client";

import { useState } from "react";
import Stage from "@/components/Stage";
import { Send, Play, Image as ImageIcon, Volume2, Sparkles, LayoutList, SlidersHorizontal, ChevronDown, Loader2, Film } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { processScenePromptStream } from "@/app/actions/scene";
import { StoryGenerationData } from "@/lib/schema/story";

import { ThemeToggle } from "@/components/ThemeToggle";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [storyData, setStoryData] = useState<StoryGenerationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setIsGenerating(true);
    setError(null);
    setStoryData(null);

    try {
      const stream = await processScenePromptStream(prompt);
      for await (const chunk of stream) {
        if (chunk.type === 'error') {
          setError(chunk.error);
          break;
        } else if (chunk.type === 'story') {
          setStoryData(chunk.data);
        } else if (chunk.type === 'image') {
          setStoryData(prev => {
            if (!prev) return prev;
            const newBeats = [...prev.beats];
            if (newBeats[chunk.index]) {
              newBeats[chunk.index] = { ...newBeats[chunk.index], image_data: chunk.data };
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
          <div className="px-5 mb-4 text-[10px] font-bold text-neutral-500 dark:text-neutral-500 uppercase tracking-widest">Project Assets</div>

          <div className="flex-1 overflow-y-auto px-3 space-y-1 custom-scrollbar">
            {/* Asset Categories */}
            <div className="px-2 py-2 flex items-center gap-3 text-sm text-cyan-700 dark:text-cyan-400 font-medium bg-cyan-100 dark:bg-cyan-900/10 rounded-lg cursor-pointer hover:bg-cyan-200 dark:hover:bg-cyan-900/20 transition-colors">
              <LayoutList size={14} /> Scenes <span className="ml-auto text-xs bg-cyan-200 dark:bg-cyan-900/40 px-1.5 rounded-md text-cyan-800 dark:text-cyan-300">{storyData?.beats.length || 0}</span>
            </div>
            <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
              <ImageIcon size={14} /> Actors <span className="ml-auto text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 rounded-md text-neutral-700 dark:text-neutral-300">{storyData?.actors_detected.length || 0}</span>
            </div>
            <div className="px-2 py-2 flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400 font-medium hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded-lg cursor-pointer transition-colors">
              <Volume2 size={14} /> Audio <span className="ml-auto text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 rounded-md text-neutral-700 dark:text-neutral-300">0</span>
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
                      className="w-full h-36 bg-transparent p-5 text-sm resize-none focus:outline-none placeholder-neutral-400 dark:placeholder-neutral-600 text-neutral-800 dark:text-neutral-200"
                      placeholder="Describe a sequence... e.g., 'A robot cat runs in panic from a loud vacuum cleaner. Then it hides under the couch.'"
                      disabled={isGenerating}
                    />
                    <div className="absolute bottom-3 right-3 flex items-center gap-2">
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !prompt.trim()}
                        className="bg-neutral-900 dark:bg-white disabled:bg-neutral-300 dark:disabled:bg-neutral-600 disabled:text-neutral-500 dark:disabled:text-neutral-400 hover:bg-neutral-700 dark:hover:bg-neutral-200 text-white dark:text-black px-4 py-2 rounded-lg transition-all duration-300 flex items-center gap-2 shadow-md dark:hover:shadow-[0_0_15px_rgba(255,255,255,0.4)] disabled:shadow-none transform hover:-translate-y-0.5 disabled:transform-none font-medium text-sm"
                      >
                        {isGenerating ? (
                          <><Loader2 size={14} className="animate-spin" /> <span>Directing...</span></>
                        ) : (
                          <><span>Generate Sequence</span><Send size={14} className="group-hover:translate-x-0.5 transition-transform" /></>
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
                  <div className="flex-1 overflow-y-auto space-y-4 pr-3 pb-8 custom-scrollbar relative">

                    {/* Timeline Connector Line */}
                    <div className="absolute left-8 top-4 bottom-0 w-px bg-gradient-to-b from-neutral-300 dark:from-neutral-800 via-neutral-300/50 dark:via-neutral-800/50 to-transparent -z-10" />

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
                        <div key={index} className="relative pl-1">
                          {/* Node Dot */}
                          <div className="absolute left-0 top-6 w-3 h-3 rounded-full bg-white dark:bg-[#111] border-2 border-cyan-500 dark:border-cyan-700 z-10 shadow-[0_0_10px_rgba(34,211,238,0.2)] dark:shadow-[0_0_10px_rgba(34,211,238,0.4)] transition-colors duration-300" />

                          <div className="ml-6 p-1 rounded-2xl bg-gradient-to-br from-neutral-100 dark:from-neutral-800/40 to-neutral-50 dark:to-neutral-900/40 border border-neutral-200 dark:border-neutral-800/60 backdrop-blur-md shadow-md dark:shadow-lg transition-all hover:border-neutral-300 dark:hover:border-neutral-700/80 hover:shadow-[0_8px_30px_rgba(0,0,0,0.05)] dark:hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] group/card">
                            <div className="bg-white dark:bg-[#0f0f0f] rounded-xl flex flex-col h-full relative overflow-hidden transition-colors duration-300">
                              {/* Subtle card glow */}
                              <div className="absolute right-0 top-0 w-32 h-32 bg-cyan-500/10 dark:bg-cyan-500/5 rounded-full blur-[40px] opacity-0 group-hover/card:opacity-100 transition-opacity pointer-events-none" />

                              <div className="w-full aspect-video bg-neutral-100 dark:bg-[#1a1a1a] flex-shrink-0 flex items-center justify-center border-b border-neutral-200 dark:border-neutral-800/80 shadow-inner group-hover/card:border-neutral-300 dark:group-hover/card:border-neutral-700 transition-colors flex-col gap-2 overflow-hidden relative">
                                {beat.image_data ? (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img src={beat.image_data} alt={`Scene ${beat.scene_number}`} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full flex flex-col items-center justify-center animate-pulse bg-neutral-200/50 dark:bg-neutral-900/40">
                                    <ImageIcon className="text-neutral-400 dark:text-neutral-700 mb-2" size={32} />
                                    <span className="text-xs text-neutral-500 uppercase font-mono tracking-widest text-center px-1">Drawing Scene {beat.scene_number}...</span>
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 flex flex-col p-4 pt-3">
                                <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mb-4">
                                  {beat.narrative}
                                </p>

                                <div className="mt-auto flex flex-wrap gap-2 pt-3 border-t border-neutral-100 dark:border-neutral-800/50">
                                  {beat.audio.map((audio, i) => (
                                    <span key={`audio-${i}`} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-medium ${audio.type === 'dialogue' ? 'bg-amber-100 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-400' : 'bg-cyan-100 dark:bg-cyan-500/10 border-cyan-200 dark:border-cyan-500/20 text-cyan-700 dark:text-cyan-400'}`}>
                                      <Volume2 size={10} /> {audio.type === 'dialogue' ? `"${audio.text}"` : audio.description}
                                    </span>
                                  ))}
                                  {beat.actions.map((act, i) => (
                                    <span key={`act-${i}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700 text-[10px] font-mono text-neutral-600 dark:text-neutral-400">
                                      {act.actor_id}:{act.motion}({act.style})
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
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
                          // A simple placeholder SVG box for now
                          actorSvgData="<svg viewBox='0 0 100 100' class='w-32 h-32 fill-cyan-500/10 dark:fill-cyan-500/20 stroke-cyan-500 dark:stroke-cyan-400 stroke-[1.5] drop-shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-transform duration-1000 group-hover/stage:scale-110'><rect x='25' y='25' width='50' height='50' rx='12' /></svg>"
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
                        <div className="flex-1 h-full relative bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iMTAwJSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJyZ2JhKDE1MCwxNTAsMTUwLDAuMikiIHg9IjAiIHk9IjAiLz48L3N2Zz4=')] dark:bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iMTAwJSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDUpIiB4PSIwIiB5PSIwIi8+PC9zdmc+')] bg-repeat-x transition-colors">

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
                                <div className="w-full h-2/3 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgeD0iMCIgeT0iMiIgd2lkdGg9IjIiIGhlaWdodD0iNiIgZmlsbD0icmdiYSg4LCAxNDUsIDE3OCLCAwLjQpIi8+PHJlY3QgeD0iNCIgeT0iMCIgd2lkdGg9IjIiIGhlaWdodD0iMTAiIGZpbGw9InJnYmEoOCwgMTQ1LCAxNzgsIDAuNCkiLz48cmVjdCB4PSI4IiB5PSI0IiB3aWR0aD0iMiIgaGVpZ2h0PSI0IiBmaWxsPSJyZ2JhKDgsIDE0NSwgMTc4LCAwLjQpIi8+PC9zdmc+')] dark:bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgeD0iMCIgeT0iMiIgd2lkdGg9IjIiIGhlaWdodD0iNiIgZmlsbD0icmdiYSgzNCwgMjExLCAyMzgsIDAuNCkiLz48cmVjdCB4PSI0IiB5PSIwIiB3aWR0aD0iMiIgaGVpZ2h0PSIxMCIgZmlsbD0icmdiYSgzNCwgMjExLCAyMzgsIDAuNCkiLz48cmVjdCB4PSI4IiB5PSI0IiB3aWR0aD0iMiIgaGVpZ2h0PSI0IiBmaWxsPSJyZ2JhKDM0LCAyMTEsIDIzOCwgMC40KSIvPjwvc3ZnPg==')] bg-repeat-x opacity-60"></div>
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
    </div>
  );
}
