import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet, stopMicrophone } from "./audio-recorder.js";

const userId = "demo-user";

const ui = {
  sessionSelect: document.getElementById("sessionSelect"),
  createSessionBtn: document.getElementById("createSessionBtn"),
  deleteSessionBtn: document.getElementById("deleteSessionBtn"),
  voiceReply: document.getElementById("voiceReply"),
  enableProactivity: document.getElementById("enableProactivity"),
  enableAffectiveDialog: document.getElementById("enableAffectiveDialog"),
  micButton: document.getElementById("micButton"),
  status: document.getElementById("status"),
  stage: document.getElementById("stage"),
  scrubber: document.getElementById("scrubber"),
  timeLabel: document.getElementById("timeLabel"),
  durationLabel: document.getElementById("durationLabel"),
  playButton: document.getElementById("playButton"),
  refreshButton: document.getElementById("refreshButton"),
  sceneList: document.getElementById("sceneList"),
  eventList: document.getElementById("eventList"),
  sceneState: document.getElementById("sceneState"),
  assetList: document.getElementById("assetList"),
  preview: document.getElementById("preview"),
  log: document.getElementById("log"),
  textForm: document.getElementById("textForm"),
  textInput: document.getElementById("textInput"),
  showAudio: document.getElementById("showAudio"),
  clearConsole: document.getElementById("clearConsole"),
  console: document.getElementById("console"),
};

const state = {
  sessionId: null,
  sessions: [],
  ws: null,
  wsUrlActive: null,
  wsGeneration: 0,
  socketConnecting: false,
  hydratingSessions: false,
  reconnectTimer: null,
  reconnectEnabled: true,
  reconnectAttempt: 0,
  timeline: null,
  assets: [],
  playback: null,
  timeMs: 0,
  durationMs: 10000,
  playTimer: null,
  micEnabled: false,
  audioPlayerNode: null,
  audioRecorderNode: null,
  audioRecorderContext: null,
  micStream: null,
  duplexHoldUntil: 0,
  outputBuffer: "",
  outputSource: null,
  inputLoggedThisTurn: false,
  lastAgentLine: "",
  awaitingAgentReply: false,
  activeInvocationId: null,
  lastCompletedInvocationId: null,
  lastTimelineSessionId: null,
  lastTimelineSequenceNotified: 0,
  refreshInFlight: false,
  liveRefreshTimer: null,
  assetWatchTimer: null,
  assetWatchUntil: 0,
  lastAudioChunkKey: "",
  lastAudioChunkAt: 0,
};

function ts() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function setStatus(connected) {
  ui.status.textContent = connected ? "Connected" : "Disconnected";
}

function addLog(kind, text) {
  const value = String(text || "").trim();
  if (!value) {
    return;
  }
  if (kind === "agent" && value === state.lastAgentLine) {
    return;
  }
  if (kind === "agent") {
    state.lastAgentLine = value;
  }
  const row = document.createElement("div");
  row.className = `log-item log-${kind}`;
  row.textContent = `${ts()} • ${value}`;
  ui.log.appendChild(row);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function addConsole(direction, summary, payload = null, isAudio = false) {
  if (isAudio && !ui.showAudio.checked) {
    return;
  }
  const row = document.createElement("div");
  row.className = "console-row";
  const head = document.createElement("div");
  head.className = "console-head";
  head.innerHTML = `<span>${direction}</span><span>${ts()}</span>`;
  const body = document.createElement("div");
  body.textContent = summary;
  row.appendChild(head);
  row.appendChild(body);
  if (payload) {
    const detail = document.createElement("div");
    detail.style.opacity = "0.75";
    detail.style.marginTop = "4px";
    detail.textContent = JSON.stringify(payload);
    row.appendChild(detail);
  }
  ui.console.appendChild(row);
  ui.console.scrollTop = ui.console.scrollHeight;
}

function compactPayload(payload) {
  try {
    return JSON.parse(
      JSON.stringify(payload, (key, value) => {
        if (key === "data" && typeof value === "string" && value.length > 160) {
          return `${value.slice(0, 64)}…(${value.length} chars)`;
        }
        return value;
      }),
    );
  } catch (err) {
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(typeof data?.detail === "string" ? data.detail : response.statusText);
  }
  return data;
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (ui.enableProactivity.checked) {
    params.set("proactivity", "true");
  }
  if (ui.enableAffectiveDialog.checked) {
    params.set("affective_dialog", "true");
  }
  if (ui.voiceReply.checked) {
    params.set("voice_reply", "true");
  }
  const query = params.toString();
  const base = `${protocol}//${window.location.host}/ws_v1/${encodeURIComponent(userId)}/${encodeURIComponent(state.sessionId)}`;
  return query ? `${base}?${query}` : base;
}

function closeSocket() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch (err) {
      console.error(err);
    }
    state.ws = null;
    state.wsUrlActive = null;
  }
}

function connectSocket() {
  if (!state.sessionId) {
    return;
  }
  if (state.socketConnecting) {
    return;
  }
  const targetUrl = wsUrl();
  if (
    state.ws &&
    state.wsUrlActive === targetUrl &&
    (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.socketConnecting = true;
  closeSocket();
  state.wsGeneration += 1;
  const generation = state.wsGeneration;
  const ws = new WebSocket(targetUrl);
  state.ws = ws;
  state.wsUrlActive = targetUrl;

  ws.onopen = () => {
    if (state.wsGeneration !== generation || state.ws !== ws) {
      return;
    }
    state.socketConnecting = false;
    state.reconnectAttempt = 0;
    setStatus(true);
    addConsole("DOWNSTREAM", "WebSocket connected", { sessionId: state.sessionId });
    addLog("system", `Connected (${state.sessionId})`);
  };

  ws.onclose = (event) => {
    if (state.wsGeneration !== generation || state.ws !== ws) {
      return;
    }
    state.socketConnecting = false;
    setStatus(false);
    state.ws = null;
    state.wsUrlActive = null;
    const code = Number(event?.code || 0);
    const reason = String(event?.reason || "");
    addConsole("DOWNSTREAM", `WebSocket closed (${code})`, reason ? { code, reason } : { code });
    const shouldReconnect = [1006, 1011, 1012, 1013].includes(code);
    if (state.reconnectEnabled && shouldReconnect) {
      const attempt = Number(state.reconnectAttempt || 0) + 1;
      state.reconnectAttempt = attempt;
      const delayMs = Math.min(5000, 900 + attempt * 600);
      state.reconnectTimer = setTimeout(connectSocket, delayMs);
    }
  };

  ws.onerror = () => {
    if (state.wsGeneration !== generation || state.ws !== ws) {
      return;
    }
    state.socketConnecting = false;
    addConsole("ERROR", "WebSocket error");
  };

  ws.onmessage = (event) => {
    if (state.wsGeneration !== generation || state.ws !== ws) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      onStreamEvent(payload);
    } catch (err) {
      addConsole("ERROR", `Invalid payload: ${String(err)}`);
    }
  };
}

function sendText(text) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not connected");
  }
  state.ws.send(JSON.stringify({ type: "text", text }));
  addConsole("UPSTREAM", `text: ${text}`);
}

async function refreshSessions() {
  const result = await api(`/api/v1/cartoon/users/${encodeURIComponent(userId)}/sessions`);
  state.sessions = Array.isArray(result.sessions) ? result.sessions : [];
  state.hydratingSessions = true;
  try {
    ui.sessionSelect.innerHTML = "";
    for (const item of state.sessions) {
      const opt = document.createElement("option");
      opt.value = item.sessionId;
      opt.textContent = item.sessionId;
      if (item.sessionId === state.sessionId) {
        opt.selected = true;
      }
      ui.sessionSelect.appendChild(opt);
    }
  } finally {
    state.hydratingSessions = false;
  }
}

async function ensureSession() {
  await refreshSessions();
  if (!state.sessions.length) {
    state.sessionId = null;
    return false;
  }
  if (!state.sessionId || !state.sessions.some((item) => item.sessionId === state.sessionId)) {
    state.sessionId = state.sessions[0].sessionId;
  }
  await refreshSessions();
  return true;
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function renderStage() {
  const svg = ui.stage;
  clearNode(svg);

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", "1280");
  bg.setAttribute("height", "720");
  bg.setAttribute("fill", "#b8e0ef");
  svg.appendChild(bg);

  const frame = state.playback;
  if (!frame || !frame.scene) {
    return;
  }

  if (frame.scene.background && typeof frame.scene.background.svg === "string") {
    const parsed = new DOMParser().parseFromString(frame.scene.background.svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (root && root.nodeName.toLowerCase() !== "parsererror") {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      if (root.nodeName.toLowerCase() === "svg") {
        Array.from(root.childNodes).forEach((node) => group.appendChild(document.importNode(node, true)));
      } else {
        group.appendChild(document.importNode(root, true));
      }
      svg.appendChild(group);
    }
  }

  const entities = Array.isArray(frame.entities) ? [...frame.entities] : [];
  entities.sort((a, b) => Number(a?.transform?.y || 0) - Number(b?.transform?.y || 0));

  for (const entity of entities) {
    const transform = entity.transform || {};
    const x = Number(transform.x || 0);
    const y = Number(transform.y || 0);
    const scaleX = Number(transform.scaleX || 1);
    const scaleY = Number(transform.scaleY || 1);
    const rotation = Number(transform.rotationDeg || 0);
    const opacity = Number(transform.opacity ?? 1);

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("transform", `translate(${x} ${y}) rotate(${rotation}) scale(${scaleX} ${scaleY})`);
    group.setAttribute("opacity", String(opacity));

    if (entity.asset && typeof entity.asset.svg === "string") {
      const parsed = new DOMParser().parseFromString(entity.asset.svg, "image/svg+xml");
      const root = parsed.documentElement;
      const local = document.createElementNS("http://www.w3.org/2000/svg", "g");
      if (root && root.nodeName.toLowerCase() !== "parsererror") {
        if (root.nodeName.toLowerCase() === "svg") {
          Array.from(root.childNodes).forEach((node) => local.appendChild(document.importNode(node, true)));
        } else {
          local.appendChild(document.importNode(root, true));
        }
      }
      group.appendChild(local);
      svg.appendChild(group);
      continue;
    }

    if (entity.asset && entity.asset.missing) {
      const assetKey = String(entity.asset.assetKey || "");
      const genStatus = assetKey ? assetGenerationStatus(assetKey) : { status: "pending" };
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "text");
      marker.setAttribute("x", String(x));
      marker.setAttribute("y", String(y));
      marker.setAttribute("font-size", "16");
      marker.setAttribute("fill", "#21495a");
      if (genStatus.status === "failed") {
        marker.textContent = `Failed to generate ${entity.name || "asset"}`;
        marker.setAttribute("fill", "#8a2a2a");
      } else {
        marker.textContent = `Generating ${entity.name || "asset"}...`;
      }
      svg.appendChild(marker);
      continue;
    }
  }
}

function card(title, meta) {
  const node = document.createElement("div");
  node.className = "card";
  node.innerHTML = `<div class="title">${title}</div><div class="meta">${meta}</div>`;
  return node;
}

function assetCard(asset) {
  const node = document.createElement("div");
  node.className = "card asset-card";

  const previewWrap = document.createElement("div");
  previewWrap.className = "asset-preview";

  const thumb = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  thumb.classList.add("asset-thumb");
  thumb.setAttribute("viewBox", "0 0 128 128");
  thumb.setAttribute("preserveAspectRatio", "xMidYMid meet");

  if (typeof asset?.svg === "string" && asset.svg.trim()) {
    const parsed = new DOMParser().parseFromString(asset.svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (root && root.nodeName.toLowerCase() !== "parsererror") {
      if (typeof root.querySelectorAll === "function") {
        root.querySelectorAll("script, foreignObject").forEach((item) => item.remove());
      }
      if (root.nodeName.toLowerCase() === "svg") {
        const viewBox = root.getAttribute("viewBox");
        if (viewBox) {
          thumb.setAttribute("viewBox", viewBox);
        } else {
          const width = Number(root.getAttribute("width") || 0);
          const height = Number(root.getAttribute("height") || 0);
          if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            thumb.setAttribute("viewBox", `0 0 ${width} ${height}`);
          }
        }
        Array.from(root.childNodes).forEach((child) => {
          thumb.appendChild(document.importNode(child, true));
        });
      } else {
        thumb.appendChild(document.importNode(root, true));
      }
    }
  }

  if (!thumb.childNodes.length) {
    const fallback = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    fallback.setAttribute("x", "6");
    fallback.setAttribute("y", "6");
    fallback.setAttribute("width", "116");
    fallback.setAttribute("height", "116");
    fallback.setAttribute("rx", "14");
    fallback.setAttribute("fill", "#e7f2f6");
    thumb.appendChild(fallback);
  }

  previewWrap.appendChild(thumb);
  node.appendChild(previewWrap);
  node.insertAdjacentHTML(
    "beforeend",
    `<div class="title">${asset.name || asset.assetKey}</div><div class="meta">${asset.assetType} v${asset.version} • ${asset.assetKey}</div>`,
  );
  return node;
}

function renderTimeline() {
  ui.sceneList.innerHTML = "";
  ui.eventList.innerHTML = "";
  ui.sceneState.textContent = "{}";

  const timeline = state.timeline;
  if (!timeline || !timeline.state) {
    return;
  }

  const scenes = timeline.state.scenes || {};
  const order = timeline.state.sceneOrder || [];
  for (const sceneId of order) {
    const scene = scenes[sceneId];
    if (!scene) {
      continue;
    }
    ui.sceneList.appendChild(card(scene.name || sceneId, `${sceneId} • ${scene.clip?.startMs || 0}..${scene.clip?.endMs || 0}`));
  }

  for (const event of (timeline.events || []).slice(-80).reverse()) {
    ui.eventList.appendChild(card(`#${event.sequence} ${event.eventType}`, JSON.stringify(event.payload || {})));
  }

  const activeId = timeline.state.activeSceneId;
  const activeScene = activeId ? scenes[activeId] : null;
  ui.sceneState.textContent = JSON.stringify(activeScene || {}, null, 2);

  state.durationMs = Number(timeline.state.timeline?.durationMs || 10000);
  ui.scrubber.max = String(state.durationMs);
  ui.durationLabel.textContent = `${Math.round(state.durationMs)}ms`;
  ui.timeLabel.textContent = `${Math.round(state.timeMs)}ms`;
}

function renderAssets() {
  ui.assetList.innerHTML = "";
  for (const asset of state.assets) {
    ui.assetList.appendChild(assetCard(asset));
  }
}

function notifyTimelineEvents() {
  const events = Array.isArray(state.timeline?.events) ? state.timeline.events : [];
  if (state.lastTimelineSessionId !== state.sessionId) {
    state.lastTimelineSessionId = state.sessionId;
    const maxSeq = events.reduce((acc, event) => Math.max(acc, Number(event?.sequence || 0)), 0);
    state.lastTimelineSequenceNotified = maxSeq;
    return;
  }
  let maxSeen = Number(state.lastTimelineSequenceNotified || 0);
  for (const event of events) {
    const sequence = Number(event?.sequence || 0);
    if (sequence <= maxSeen) {
      continue;
    }
    const type = String(event?.eventType || "");
    const payload = event?.payload || {};
    if (type === "asset.refinement.queued") {
      addLog("system", `Generating asset ${String(payload.assetKey || "")}...`);
    } else if (type === "asset.refinement.generating") {
      addLog(
        "system",
        `Generating ${String(payload.assetKey || "")} with ${String(payload.model || "model")}...`,
      );
    } else if (type === "asset.refinement.inflight") {
      addLog("system", `Asset generation in progress: ${String(payload.assetKey || "")}`);
    } else if (type === "asset.refinement.completed") {
      addLog("system", `Asset ready: ${String(payload.assetKey || "")}`);
    } else if (type === "asset.refinement.failed") {
      addLog("system", `Asset generation failed: ${String(payload.assetKey || "")}`);
      const msg = String(payload.userMessage || "").trim();
      if (msg) {
        addLog("system", msg);
      } else {
        addLog("system", `I could not create ${String(payload.assetKey || "this asset")}.`);
      }
    }
    if (sequence > maxSeen) {
      maxSeen = sequence;
    }
  }
  state.lastTimelineSequenceNotified = maxSeen;
}

function assetGenerationStatus(assetKey) {
  const key = String(assetKey || "").trim();
  if (!key) {
    return { status: "unknown", event: null };
  }
  const events = Array.isArray(state.timeline?.events) ? state.timeline.events : [];
  let latest = null;
  for (const event of events) {
    const payload = event?.payload || {};
    if (String(payload.assetKey || "") !== key) {
      continue;
    }
    if (
      event?.eventType === "asset.refinement.queued" ||
      event?.eventType === "asset.refinement.inflight" ||
      event?.eventType === "asset.refinement.generating" ||
      event?.eventType === "asset.refinement.completed" ||
      event?.eventType === "asset.refinement.failed"
    ) {
      latest = event;
    }
  }
  if (!latest) {
    return { status: "unknown", event: null };
  }
  const t = String(latest.eventType || "");
  if (t === "asset.refinement.completed") {
    return { status: "completed", event: latest };
  }
  if (t === "asset.refinement.failed") {
    return { status: "failed", event: latest };
  }
  return { status: "pending", event: latest };
}

async function loadTimeline() {
  if (!state.sessionId) {
    state.timeline = null;
    renderTimeline();
    return;
  }
  const result = await api(`/api/v1/cartoon/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(state.sessionId)}/timeline`);
  state.timeline = result;
  notifyTimelineEvents();
  renderTimeline();
}

async function loadAssets() {
  if (!state.sessionId) {
    state.assets = [];
    renderAssets();
    return;
  }
  const result = await api(`/api/v1/cartoon/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(state.sessionId)}/assets`);
  state.assets = Array.isArray(result.assets) ? result.assets : [];
  renderAssets();
}

async function loadPlayback(timeMs) {
  if (!state.sessionId) {
    state.playback = null;
    renderStage();
    return;
  }
  const result = await api(`/api/v1/cartoon/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(state.sessionId)}/playback?time_ms=${encodeURIComponent(String(timeMs))}`);
  state.playback = result;
  renderStage();
}

async function refreshAll() {
  if (state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  try {
    if (!state.sessionId) {
      state.timeline = null;
      state.assets = [];
      state.playback = null;
      renderTimeline();
      renderAssets();
      renderStage();
      return;
    }
    await Promise.all([loadTimeline(), loadAssets()]);
    await loadPlayback(state.timeMs);
  } finally {
    state.refreshInFlight = false;
  }
}

function startAssetWatch(durationMs = 10000) {
  const now = Date.now();
  state.assetWatchUntil = Math.max(Number(state.assetWatchUntil || 0), now + Math.max(2000, durationMs));
  if (state.assetWatchTimer) {
    return;
  }
  state.assetWatchTimer = setInterval(() => {
    const stillNeeded = Date.now() < Number(state.assetWatchUntil || 0);
    if (!stillNeeded) {
      clearInterval(state.assetWatchTimer);
      state.assetWatchTimer = null;
      return;
    }
    if (!state.sessionId || document.hidden) {
      return;
    }
    refreshAll().catch(() => {});
  }, 600);
}

function stopPlay() {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
  ui.playButton.textContent = "Play";
}

function startPlay() {
  stopPlay();
  ui.playButton.textContent = "Pause";
  state.playTimer = setInterval(async () => {
    state.timeMs += 120;
    if (state.timeMs > state.durationMs) {
      state.timeMs = 0;
    }
    ui.scrubber.value = String(state.timeMs);
    ui.timeLabel.textContent = `${Math.round(state.timeMs)}ms`;
    try {
      await loadPlayback(state.timeMs);
    } catch (err) {
      stopPlay();
      addLog("system", `Playback error: ${String(err)}`);
    }
  }, 120);
}

async function ensureAudioPlayer() {
  if (state.audioPlayerNode) {
    return;
  }
  const [node] = await startAudioPlayerWorklet();
  state.audioPlayerNode = node;
}

function base64ToArray(base64) {
  let normalized = String(base64 || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) {
    normalized += "=";
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function audioRecorderHandler(pcmData) {
  if (!state.micEnabled) {
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  if (Date.now() < state.duplexHoldUntil) {
    return;
  }
  state.ws.send(pcmData);
}

async function startMic() {
  if (state.micEnabled) {
    return;
  }
  const [recorderNode, recorderContext, micStream] = await startAudioRecorderWorklet(audioRecorderHandler);
  state.audioRecorderNode = recorderNode;
  state.audioRecorderContext = recorderContext;
  state.micStream = micStream;
  state.micEnabled = true;
  ui.micButton.textContent = "Stop Mic";
  addLog("system", "Mic enabled");
  if (ui.voiceReply.checked) {
    await ensureAudioPlayer();
  }
}

function stopMic() {
  if (!state.micEnabled) {
    return;
  }
  try {
    if (state.audioRecorderNode) {
      state.audioRecorderNode.disconnect();
    }
  } catch (err) {
    console.error(err);
  }
  if (state.audioRecorderContext) {
    state.audioRecorderContext.close().catch(() => {});
  }
  if (state.micStream) {
    stopMicrophone(state.micStream);
  }
  state.audioRecorderNode = null;
  state.audioRecorderContext = null;
  state.micStream = null;
  state.micEnabled = false;
  ui.micButton.textContent = "Start Mic";
  addLog("system", "Mic disabled");
}

function onStreamEvent(event) {
  const invocationId = String(event.invocationId || "").trim();
  const staleCompletedInvocation =
    invocationId &&
    state.lastCompletedInvocationId &&
    invocationId === state.lastCompletedInvocationId &&
    !state.awaitingAgentReply;

  const hasAudio = Boolean(event?.content?.parts?.some((part) => part.inlineData));
  const summary = summarize(event);
  const payload = summary === "Event" || summary.startsWith("Tool") ? compactPayload(event) : null;
  addConsole("DOWNSTREAM", summary, payload, hasAudio);

  if (event.inputTranscription) {
    const text = String(event.inputTranscription.text || "").trim();
    const finished = Boolean(event.inputTranscription.finished);
    if (!finished) {
      ui.preview.textContent = text ? `Preview: ${text}` : "Listening...";
      ui.preview.classList.toggle("active", Boolean(text));
    } else {
      if (text && !state.inputLoggedThisTurn) {
        addLog("user", text);
        state.inputLoggedThisTurn = true;
        state.awaitingAgentReply = true;
        state.activeInvocationId = null;
        state.lastCompletedInvocationId = null;
        ui.preview.textContent = "Agent is thinking...";
        ui.preview.classList.add("active");
      } else {
        ui.preview.textContent = "Listening...";
        ui.preview.classList.remove("active");
      }
    }
  }

  if (event.outputTranscription) {
    if (!state.awaitingAgentReply) {
      return;
    }
    if (staleCompletedInvocation) {
      return;
    }
    if (state.awaitingAgentReply && invocationId && !state.activeInvocationId) {
      state.activeInvocationId = invocationId;
    }
    const text = String(event.outputTranscription.text || "");
    if (text) {
      state.outputSource = "outputTranscription";
      if (event.outputTranscription.finished) {
        state.outputBuffer = text;
      } else {
        state.outputBuffer += text;
      }
      ui.preview.textContent = "Agent is responding...";
      ui.preview.classList.add("active");
    }
  }

  if (event.content?.parts) {
    if (!state.awaitingAgentReply) {
      return;
    }
    if (staleCompletedInvocation) {
      return;
    }
    if (state.awaitingAgentReply && invocationId && !state.activeInvocationId) {
      state.activeInvocationId = invocationId;
    }
    const chunks = event.content.parts
      .filter((part) => typeof part.text === "string" && part.text && !part.thought)
      .map((part) => part.text);
    if (chunks.length && state.outputSource !== "outputTranscription") {
      state.outputSource = "content";
      state.outputBuffer += chunks.join("");
      ui.preview.textContent = "Agent is responding...";
      ui.preview.classList.add("active");
    }

    if (ui.voiceReply.checked && state.audioPlayerNode) {
      for (const part of event.content.parts) {
        if (!part.inlineData || typeof part.inlineData.data !== "string") {
          continue;
        }
        const mimeType = String(part.inlineData.mimeType || "");
        if (!mimeType.startsWith("audio/pcm")) {
          continue;
        }
        const audioData = String(part.inlineData.data || "");
        if (!audioData) {
          continue;
        }
        const chunkKey = `${audioData.length}:${audioData.slice(0, 48)}`;
        const now = Date.now();
        if (chunkKey === state.lastAudioChunkKey && now - Number(state.lastAudioChunkAt || 0) < 700) {
          continue;
        }
        state.lastAudioChunkKey = chunkKey;
        state.lastAudioChunkAt = now;
        state.duplexHoldUntil = Date.now() + 900;
        state.audioPlayerNode.port.postMessage(base64ToArray(audioData));
      }
    }

    for (const part of event.content.parts) {
      const functionResponse = part?.functionResponse;
      if (!functionResponse || functionResponse.name !== "generate_svg_asset") {
        continue;
      }
      const response = functionResponse.response || {};
      if (response?.pending === true || response?.refinementQueued === true) {
        startAssetWatch(12000);
      }
    }
  }

  if (state.awaitingAgentReply && !state.outputBuffer && !event.turnComplete && !event.interrupted) {
    ui.preview.textContent = "Agent is thinking...";
    ui.preview.classList.add("active");
  }

  if (event.turnComplete === true || event.interrupted === true) {
    const message = state.outputBuffer.trim();
    const isDuplicateInvocation =
      invocationId && state.lastCompletedInvocationId && invocationId === state.lastCompletedInvocationId;
    const isUnexpectedInvocation =
      state.awaitingAgentReply &&
      invocationId &&
      state.activeInvocationId &&
      invocationId !== state.activeInvocationId;
    if (isUnexpectedInvocation) {
      state.outputBuffer = "";
      state.outputSource = null;
      return;
    }
    if (isDuplicateInvocation && !state.awaitingAgentReply) {
      state.outputBuffer = "";
      state.outputSource = null;
      return;
    }
    if (message && state.awaitingAgentReply && !isDuplicateInvocation) {
      addLog("agent", message);
      state.awaitingAgentReply = false;
      if (invocationId) {
        state.lastCompletedInvocationId = invocationId;
      }
    }
    state.outputBuffer = "";
    state.outputSource = null;
    state.inputLoggedThisTurn = false;
    state.activeInvocationId = null;
    ui.preview.textContent = "Listening...";
    ui.preview.classList.remove("active");
    refreshAll().catch((err) => addLog("system", `Refresh error: ${String(err)}`));
  }
}

function startLiveRefresh() {
  if (state.liveRefreshTimer) {
    clearInterval(state.liveRefreshTimer);
    state.liveRefreshTimer = null;
  }
  state.liveRefreshTimer = setInterval(() => {
    if (!state.sessionId || document.hidden) {
      return;
    }
    refreshAll().catch(() => {});
  }, 1800);
}

function summarize(event) {
  if (event.turnComplete) {
    return "Turn complete";
  }
  if (event.interrupted) {
    return "Interrupted";
  }
  if (event.inputTranscription) {
    return `Input: ${String(event.inputTranscription.text || "")}`;
  }
  if (event.outputTranscription) {
    return `Output: ${String(event.outputTranscription.text || "")}`;
  }
  if (event.usageMetadata) {
    return `Token usage: ${event.usageMetadata.totalTokenCount || 0}`;
  }
  const toolCall = event?.content?.parts?.find((part) => part?.functionCall?.name)?.functionCall;
  if (toolCall?.name) {
    return `Tool call: ${String(toolCall.name)}`;
  }
  const toolResult = event?.content?.parts?.find((part) => part?.functionResponse?.name)?.functionResponse;
  if (toolResult?.name) {
    return `Tool result: ${String(toolResult.name)}`;
  }
  if (event.error) {
    return `Error: ${String(event.error.message || event.error)}`;
  }
  if (event.actions && Object.keys(event.actions).length > 0) {
    return "Actions update";
  }
  if (Array.isArray(event.longRunningToolIds) && event.longRunningToolIds.length) {
    return `Long-running tool: ${event.longRunningToolIds.join(", ")}`;
  }
  if (event.content?.parts?.some((part) => part.text)) {
    return "Text chunk";
  }
  if (event.content?.parts?.some((part) => part.inlineData)) {
    return "Audio chunk";
  }
  return "Event";
}

function bind() {
  ui.createSessionBtn.addEventListener("click", async () => {
    try {
      const created = await api(`/api/v1/cartoon/users/${encodeURIComponent(userId)}/sessions`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      state.sessionId = created.session.sessionId;
      await refreshSessions();
      connectSocket();
      await refreshAll();
      addLog("system", `Created session ${state.sessionId}`);
    } catch (err) {
      addLog("system", `Create session failed: ${String(err)}`);
    }
  });

  ui.deleteSessionBtn.addEventListener("click", async () => {
    if (!state.sessionId) {
      return;
    }
    const deletingSession = state.sessionId;
    const priorReconnect = state.reconnectEnabled;
    try {
      state.reconnectEnabled = false;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      stopMic();
      closeSocket();
      await api(`/api/v1/cartoon/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(deletingSession)}`, { method: "DELETE" });
      addLog("system", `Deleted session ${deletingSession}`);
      state.reconnectEnabled = priorReconnect;
      const hasSession = await ensureSession();
      if (hasSession) {
        connectSocket();
      } else {
        setStatus(false);
      }
      await refreshAll();
    } catch (err) {
      state.reconnectEnabled = priorReconnect;
      addLog("system", `Delete session failed: ${String(err)}`);
    }
  });

  ui.sessionSelect.addEventListener("change", async () => {
    if (state.hydratingSessions) {
      return;
    }
    const next = ui.sessionSelect.value;
    if (!next) {
      return;
    }
    state.sessionId = next;
    connectSocket();
    await refreshAll();
  });

  const reconnect = () => connectSocket();
  ui.voiceReply.addEventListener("change", reconnect);
  ui.enableProactivity.addEventListener("change", reconnect);
  ui.enableAffectiveDialog.addEventListener("change", reconnect);

  ui.refreshButton.addEventListener("click", () => {
    refreshAll().catch((err) => addLog("system", `Refresh failed: ${String(err)}`));
  });

  ui.playButton.addEventListener("click", () => {
    if (state.playTimer) {
      stopPlay();
    } else {
      startPlay();
    }
  });

  ui.scrubber.addEventListener("input", async () => {
    stopPlay();
    state.timeMs = Number(ui.scrubber.value || 0);
    ui.timeLabel.textContent = `${Math.round(state.timeMs)}ms`;
    await loadPlayback(state.timeMs);
  });

  ui.textForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = String(ui.textInput.value || "").trim();
    if (!text) {
      return;
    }
    try {
      sendText(text);
      addLog("user", text);
      state.awaitingAgentReply = true;
      state.activeInvocationId = null;
      state.lastCompletedInvocationId = null;
      ui.textInput.value = "";
    } catch (err) {
      addLog("system", `Send failed: ${String(err)}`);
    }
  });

  ui.clearConsole.addEventListener("click", () => {
    ui.console.innerHTML = "";
  });

  ui.micButton.addEventListener("click", async () => {
    try {
      if (state.micEnabled) {
        stopMic();
      } else {
        await startMic();
      }
    } catch (err) {
      addLog("system", `Mic error: ${String(err)}`);
    }
  });
}

async function boot() {
  setStatus(false);
  bind();
  startLiveRefresh();
  const hasSession = await ensureSession();
  if (hasSession) {
    connectSocket();
  } else {
    addLog("system", "No sessions found. Create one to begin.");
  }
  await refreshAll();
}

boot().catch((err) => {
  addLog("system", `Boot error: ${String(err)}`);
});
