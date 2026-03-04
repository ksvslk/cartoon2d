"""Runtime config and singletons for Cartoon Director V1."""

from __future__ import annotations

import os
from pathlib import Path

from .store import CartoonDirectorStore, StoreConfig

APP_NAME = "cartoon2d_director_v1"
DB_PATH = os.getenv(
    "CARTOON_V1_DB_PATH",
    str(Path(__file__).resolve().parent.parent / "cartoon_director_v1.db"),
)
SESSION_BACKEND = os.getenv("CARTOON_V1_ADK_SESSION_BACKEND", "sqlite").strip().lower()
SESSION_DB_PATH = os.getenv(
    "CARTOON_V1_ADK_SESSION_DB_PATH",
    str(Path(DB_PATH).with_name("cartoon_director_v1_sessions.db")),
)


def _env_true(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, min_value: int, max_value: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(min_value, min(max_value, value))


def _worker_live_model(env_name: str, fallback: str) -> str:
    configured = os.getenv(env_name, "").strip()
    if not configured:
        return fallback
    lowered = configured.lower()
    if "live" in lowered or "native-audio" in lowered:
        return configured
    return fallback


ALLOW_PROACTIVITY = _env_true("CARTOON_V1_ALLOW_PROACTIVITY")
USE_SUB_AGENTS = _env_true("CARTOON_V1_USE_SUBAGENTS")

# Live streaming model used by websocket bidi sessions.
LIVE_MODEL = os.getenv("DEMO_AGENT_MODEL", "gemini-live-2.5-flash-native-audio").strip()

# Worker agents in run_live() must still be Live-capable models.
ASSET_MODEL = _worker_live_model("CARTOON_V1_ASSET_MODEL", LIVE_MODEL)
TIMELINE_MODEL = _worker_live_model("CARTOON_V1_TIMELINE_MODEL", LIVE_MODEL)
VALIDATOR_MODEL = _worker_live_model("CARTOON_V1_VALIDATOR_MODEL", LIVE_MODEL)

# Separate model for SVG generation tool (non-live generate_content path).
SVG_MODEL = os.getenv("CARTOON_V1_SVG_MODEL", "gemini-3.1-flash-lite-preview").strip()
SVG_MODELS = [
    item.strip()
    for item in os.getenv("CARTOON_V1_SVG_MODELS", SVG_MODEL).split(",")
    if item.strip()
]
if SVG_MODEL not in SVG_MODELS:
    SVG_MODELS.insert(0, SVG_MODEL)
SVG_FALLBACK_MODELS = [
    item.strip()
    for item in os.getenv("CARTOON_V1_SVG_FALLBACK_MODELS", "gemini-2.5-flash").split(",")
    if item.strip()
]
for fallback_model in SVG_FALLBACK_MODELS:
    if fallback_model not in SVG_MODELS:
        SVG_MODELS.append(fallback_model)
SVG_GENERATION_ATTEMPTS = _env_int(
    "CARTOON_V1_SVG_GENERATION_ATTEMPTS",
    2,
    min_value=1,
    max_value=5,
)

store = CartoonDirectorStore(StoreConfig(db_path=DB_PATH))
