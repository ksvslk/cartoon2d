"""SQLite event store for Cartoon Director V1 (additive path)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


NUMERIC_ENTITY_KEYS = ("x", "y", "scaleX", "scaleY", "rotationDeg", "opacity")
NUMERIC_CAMERA_KEYS = ("x", "y", "zoom", "rotationDeg")
MAX_SVG_BYTES = 400_000
DISALLOWED_SVG_TAGS = {"script", "foreignobject", "iframe", "object", "embed", "audio", "video", "canvas"}


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _slug(value: str, fallback: str) -> str:
    raw = (value or "").strip().lower()
    clean = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw)
    clean = "-".join(part for part in clean.split("-") if part)
    return clean or fallback


def _coerce_int(value: Any, default: int) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(0, parsed)


def _coerce_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed != parsed:
        return default
    return parsed


def _payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha1(_json_dumps(payload).encode("utf-8")).hexdigest()


def _xml_local_name(value: Any) -> str:
    text = str(value or "")
    return text.rsplit("}", 1)[-1].lower() if "}" in text else text.lower()


def _is_external_reference(value: Any) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return False
    if text.startswith("#"):
        return False
    return text.startswith(("javascript:", "data:", "http:", "https:", "ftp:", "file:", "//"))


@dataclass
class StoreConfig:
    db_path: str


class CartoonDirectorStore:
    """Event-sourced store for sessions, assets, and timeline events."""

    def __init__(self, config: StoreConfig) -> None:
        self._config = config
        Path(config.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(config.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            with self._conn:
                self._conn.execute("PRAGMA foreign_keys = ON")
                self._conn.execute("PRAGMA journal_mode = WAL")
                self._conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        app_name TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        session_id TEXT NOT NULL,
                        metadata_json TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (app_name, user_id, session_id)
                    );

                    CREATE TABLE IF NOT EXISTS assets (
                        asset_id TEXT PRIMARY KEY,
                        app_name TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        session_id TEXT NOT NULL,
                        asset_key TEXT NOT NULL,
                        asset_type TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        name TEXT,
                        svg TEXT NOT NULL,
                        metadata_json TEXT NOT NULL DEFAULT '{}',
                        deleted_at TEXT,
                        created_at TEXT NOT NULL,
                        UNIQUE (app_name, user_id, session_id, asset_key, version),
                        FOREIGN KEY (app_name, user_id, session_id)
                            REFERENCES sessions(app_name, user_id, session_id)
                            ON DELETE CASCADE
                    );

                    CREATE INDEX IF NOT EXISTS idx_assets_session_key
                    ON assets(app_name, user_id, session_id, asset_key, version);

                    CREATE TABLE IF NOT EXISTS timeline_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        app_name TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        session_id TEXT NOT NULL,
                        sequence INTEGER NOT NULL,
                        command_id TEXT,
                        window_id TEXT,
                        event_type TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        payload_hash TEXT NOT NULL,
                        is_correction INTEGER NOT NULL DEFAULT 0,
                        corrects_sequence INTEGER,
                        created_at TEXT NOT NULL,
                        UNIQUE (app_name, user_id, session_id, sequence),
                        UNIQUE (
                            app_name, user_id, session_id,
                            command_id, window_id, event_type, payload_hash
                        ),
                        FOREIGN KEY (app_name, user_id, session_id)
                            REFERENCES sessions(app_name, user_id, session_id)
                            ON DELETE CASCADE
                    );

                    CREATE INDEX IF NOT EXISTS idx_events_session
                    ON timeline_events(app_name, user_id, session_id, sequence);
                    """
                )

    @staticmethod
    def validate_svg(svg: str) -> tuple[bool, str | None]:
        if not isinstance(svg, str) or not svg.strip():
            return False, "SVG is empty."

        raw = svg.strip()
        if len(raw.encode("utf-8")) > MAX_SVG_BYTES:
            return False, f"SVG exceeds size limit ({MAX_SVG_BYTES} bytes)."

        lowered = raw.lower()
        if "<!doctype" in lowered or "<!entity" in lowered:
            return False, "DOCTYPE/ENTITY declarations are not allowed in SVG."

        try:
            root = ET.fromstring(raw)
        except ET.ParseError as exc:
            return False, f"SVG parse error: {exc}"

        if _xml_local_name(root.tag) != "svg":
            return False, "Root element must be <svg>."

        for element in root.iter():
            tag = _xml_local_name(element.tag)
            if tag in DISALLOWED_SVG_TAGS:
                return False, f"Disallowed SVG element: <{tag}>."

            for attr_name, attr_value in element.attrib.items():
                normalized = _xml_local_name(attr_name)
                if normalized.startswith("on"):
                    return False, f"Event handler attribute is not allowed: {normalized}."
                if normalized in {"href", "xlink:href"} and _is_external_reference(attr_value):
                    return False, f"External reference is not allowed in attribute: {normalized}."
                if normalized == "style" and "url(" in str(attr_value).lower():
                    return False, "Inline style url() references are not allowed."

        return True, None

    def ensure_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = _now_utc()
        with self._lock:
            with self._conn:
                existing = self._conn.execute(
                    """
                    SELECT * FROM sessions
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                    """,
                    (app_name, user_id, session_id),
                ).fetchone()
                if existing is None:
                    self._conn.execute(
                        """
                        INSERT INTO sessions(app_name, user_id, session_id, metadata_json, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (app_name, user_id, session_id, _json_dumps(metadata or {}), now, now),
                    )
                else:
                    next_metadata = _json_dumps(metadata) if metadata is not None else existing["metadata_json"]
                    self._conn.execute(
                        """
                        UPDATE sessions
                        SET metadata_json = ?, updated_at = ?
                        WHERE app_name = ? AND user_id = ? AND session_id = ?
                        """,
                        (next_metadata, now, app_name, user_id, session_id),
                    )
                row = self._conn.execute(
                    """
                    SELECT * FROM sessions
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                    """,
                    (app_name, user_id, session_id),
                ).fetchone()
        return self._session_dict(row)

    def get_session(self, *, app_name: str, user_id: str, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM sessions
                WHERE app_name = ? AND user_id = ? AND session_id = ?
                """,
                (app_name, user_id, session_id),
            ).fetchone()
        return self._session_dict(row) if row is not None else None

    def list_sessions(self, *, app_name: str, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM sessions
                WHERE app_name = ? AND user_id = ?
                ORDER BY updated_at DESC
                """,
                (app_name, user_id),
            ).fetchall()
        return [self._session_dict(row) for row in rows]

    def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> bool:
        with self._lock:
            with self._conn:
                cursor = self._conn.execute(
                    """
                    DELETE FROM sessions
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                    """,
                    (app_name, user_id, session_id),
                )
        return int(cursor.rowcount or 0) > 0

    def create_asset(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        asset_key: str,
        asset_type: str,
        svg: str,
        name: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.get_session(app_name=app_name, user_id=user_id, session_id=session_id) is None:
            raise ValueError(f"Session not found: {session_id}")
        valid_svg, svg_error = self.validate_svg(svg)
        if not valid_svg:
            raise ValueError(f"Invalid SVG: {svg_error}")
        key = _slug(asset_key, "asset")
        kind = _slug(asset_type, "asset")
        now = _now_utc()

        with self._lock:
            with self._conn:
                existing = self._conn.execute(
                    """
                    SELECT * FROM assets
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                      AND asset_key = ? AND asset_type = ?
                      AND svg = ? AND deleted_at IS NULL
                    ORDER BY version DESC
                    LIMIT 1
                    """,
                    (app_name, user_id, session_id, key, kind, svg),
                ).fetchone()
                if existing is not None:
                    return self._asset_dict(existing)

                version_row = self._conn.execute(
                    """
                    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                    FROM assets
                    WHERE app_name = ? AND user_id = ? AND session_id = ? AND asset_key = ?
                    """,
                    (app_name, user_id, session_id, key),
                ).fetchone()
                version = int(version_row["next_version"])
                asset_id = str(uuid.uuid4())

                self._conn.execute(
                    """
                    INSERT INTO assets(
                        asset_id, app_name, user_id, session_id,
                        asset_key, asset_type, version, name, svg, metadata_json,
                        deleted_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                    """,
                    (
                        asset_id,
                        app_name,
                        user_id,
                        session_id,
                        key,
                        kind,
                        version,
                        name,
                        svg,
                        _json_dumps(metadata or {}),
                        now,
                    ),
                )
                row = self._conn.execute("SELECT * FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
        return self._asset_dict(row)

    def list_assets(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]:
        where_deleted = "" if include_deleted else "AND deleted_at IS NULL"
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT * FROM assets
                WHERE app_name = ? AND user_id = ? AND session_id = ? {where_deleted}
                ORDER BY asset_key ASC, version DESC
                """,
                (app_name, user_id, session_id),
            ).fetchall()
        return [self._asset_dict(row) for row in rows]

    def delete_asset_by_id(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        asset_id: str,
    ) -> bool:
        now = _now_utc()
        with self._lock:
            with self._conn:
                cursor = self._conn.execute(
                    """
                    UPDATE assets
                    SET deleted_at = COALESCE(deleted_at, ?)
                    WHERE app_name = ? AND user_id = ? AND session_id = ? AND asset_id = ?
                    """,
                    (now, app_name, user_id, session_id, asset_id),
                )
        return int(cursor.rowcount or 0) > 0

    def delete_asset_by_key(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        asset_key: str,
    ) -> int:
        now = _now_utc()
        key = _slug(asset_key, "asset")
        with self._lock:
            with self._conn:
                cursor = self._conn.execute(
                    """
                    UPDATE assets
                    SET deleted_at = COALESCE(deleted_at, ?)
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                      AND asset_key = ? AND deleted_at IS NULL
                    """,
                    (now, app_name, user_id, session_id, key),
                )
        return int(cursor.rowcount or 0)

    def append_event(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        command_id: str | None = None,
        window_id: str | None = None,
        is_correction: bool = False,
        corrects_sequence: int | None = None,
    ) -> dict[str, Any]:
        if self.get_session(app_name=app_name, user_id=user_id, session_id=session_id) is None:
            raise ValueError(f"Session not found: {session_id}")
        body = payload or {}
        hash_value = _payload_hash(body)

        with self._lock:
            with self._conn:
                if command_id and window_id:
                    existing = self._conn.execute(
                        """
                        SELECT * FROM timeline_events
                        WHERE app_name = ? AND user_id = ? AND session_id = ?
                          AND command_id = ? AND window_id = ?
                          AND event_type = ? AND payload_hash = ?
                        """,
                        (
                            app_name,
                            user_id,
                            session_id,
                            command_id,
                            window_id,
                            event_type,
                            hash_value,
                        ),
                    ).fetchone()
                    if existing is not None:
                        return self._event_dict(existing)

                seq = self._conn.execute(
                    """
                    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
                    FROM timeline_events
                    WHERE app_name = ? AND user_id = ? AND session_id = ?
                    """,
                    (app_name, user_id, session_id),
                ).fetchone()["next_seq"]

                self._conn.execute(
                    """
                    INSERT INTO timeline_events(
                        app_name, user_id, session_id,
                        sequence, command_id, window_id,
                        event_type, payload_json, payload_hash,
                        is_correction, corrects_sequence, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        app_name,
                        user_id,
                        session_id,
                        int(seq),
                        command_id,
                        window_id,
                        event_type,
                        _json_dumps(body),
                        hash_value,
                        1 if is_correction else 0,
                        corrects_sequence,
                        _now_utc(),
                    ),
                )
                row = self._conn.execute(
                    """
                    SELECT * FROM timeline_events
                    WHERE app_name = ? AND user_id = ? AND session_id = ? AND sequence = ?
                    """,
                    (app_name, user_id, session_id, int(seq)),
                ).fetchone()
        return self._event_dict(row)

    def list_events(self, *, app_name: str, user_id: str, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM timeline_events
                WHERE app_name = ? AND user_id = ? AND session_id = ?
                ORDER BY sequence ASC
                """,
                (app_name, user_id, session_id),
            ).fetchall()
        events = [self._event_dict(row) for row in rows]
        return self._mark_effective(events)

    def timeline_view(self, *, app_name: str, user_id: str, session_id: str) -> dict[str, Any]:
        assets = self.list_assets(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            include_deleted=False,
        )
        events = self.list_events(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
        )
        state = self._reduce(events=events, assets=assets)
        return {
            "state": state,
            "events": events,
            "eventCount": len(events),
        }

    def playback(self, *, app_name: str, user_id: str, session_id: str, time_ms: int) -> dict[str, Any]:
        view = self.timeline_view(app_name=app_name, user_id=user_id, session_id=session_id)
        state = view["state"]
        t = max(0, int(time_ms))
        scenes = state.get("scenes", {})
        active_scene = None

        clips = []
        for scene_id in state.get("sceneOrder", []):
            scene = scenes.get(scene_id)
            if not isinstance(scene, dict):
                continue
            clip = scene.get("clip", {})
            clips.append((
                _coerce_int(clip.get("trackOrder"), 0),
                _coerce_int(clip.get("startMs"), 0),
                _coerce_int(clip.get("endMs"), 0),
                scene,
            ))

        clips.sort(key=lambda item: (item[1], item[0]))
        for _, start_ms, end_ms, scene in clips:
            if start_ms <= t <= end_ms:
                active_scene = scene
                break

        if active_scene is None:
            active_id = state.get("activeSceneId")
            if isinstance(active_id, str):
                active_scene = scenes.get(active_id)

        if not isinstance(active_scene, dict):
            return {"timeMs": t, "scene": None, "camera": None, "entities": []}

        camera = self._interpolate(active_scene.get("cameraTrack", []), t, NUMERIC_CAMERA_KEYS)
        entities = []
        for entity_id, entity in (active_scene.get("entities") or {}).items():
            if not isinstance(entity, dict):
                continue
            transform = self._interpolate(entity.get("keyframes", []), t, NUMERIC_ENTITY_KEYS)
            if transform is None:
                continue
            entities.append(
                {
                    "id": entity_id,
                    "name": entity.get("name") or entity_id,
                    "asset": entity.get("asset"),
                    "transform": transform,
                }
            )

        return {
            "timeMs": t,
            "scene": {
                "id": active_scene.get("id"),
                "name": active_scene.get("name"),
                "clip": active_scene.get("clip"),
                "background": active_scene.get("background"),
            },
            "camera": camera,
            "entities": entities,
        }

    def restore_bundle(self, *, app_name: str, user_id: str, session_id: str) -> dict[str, Any]:
        session = self.get_session(app_name=app_name, user_id=user_id, session_id=session_id)
        if session is None:
            return {}
        return {
            "session": session,
            "assets": self.list_assets(
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
                include_deleted=True,
            ),
            "events": self.list_events(
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
            ),
            "timeline": self.timeline_view(
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
            ),
        }

    @staticmethod
    def _session_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "appName": row["app_name"],
            "userId": row["user_id"],
            "sessionId": row["session_id"],
            "metadata": _json_loads(row["metadata_json"], {}),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _asset_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["asset_id"],
            "assetKey": row["asset_key"],
            "assetType": row["asset_type"],
            "version": int(row["version"]),
            "name": row["name"],
            "svg": row["svg"],
            "metadata": _json_loads(row["metadata_json"], {}),
            "deletedAt": row["deleted_at"],
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _event_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "sequence": int(row["sequence"]),
            "commandId": row["command_id"],
            "windowId": row["window_id"],
            "eventType": row["event_type"],
            "payload": _json_loads(row["payload_json"], {}),
            "payloadHash": row["payload_hash"],
            "isCorrection": bool(row["is_correction"]),
            "correctsSequence": row["corrects_sequence"],
            "createdAt": row["created_at"],
        }

    def _mark_effective(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        corrected: dict[int, int] = {}
        for item in events:
            if item.get("eventType") != "timeline.correct":
                continue
            payload = item.get("payload", {})
            if not isinstance(payload, dict):
                continue
            if payload.get("action") != "undo_sequence":
                continue
            target = payload.get("targetSequence")
            if isinstance(target, int):
                corrected[target] = item["sequence"]

        with_flags: list[dict[str, Any]] = []
        for item in events:
            copy = dict(item)
            copy["correctedBySequence"] = corrected.get(item["sequence"])
            copy["isEffective"] = (
                not copy["isCorrection"] and copy["correctedBySequence"] is None
            )
            with_flags.append(copy)
        return with_flags

    def _reduce(self, *, events: list[dict[str, Any]], assets: list[dict[str, Any]]) -> dict[str, Any]:
        assets_by_id = {asset["id"]: asset for asset in assets}
        latest_by_key: dict[str, dict[str, Any]] = {}
        for asset in assets:
            key = asset["assetKey"]
            prior = latest_by_key.get(key)
            if prior is None or int(asset["version"]) > int(prior["version"]):
                latest_by_key[key] = asset

        state: dict[str, Any] = {
            "timeline": {"durationMs": 10000},
            "activeSceneId": None,
            "sceneOrder": [],
            "scenes": {},
        }

        for event in events:
            if not event.get("isEffective"):
                continue

            event_type = event.get("eventType")
            payload = event.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}

            if event_type == "scene.create":
                scene_id = _slug(str(payload.get("sceneId") or "scene"), "scene")
                if scene_id not in state["scenes"]:
                    state["sceneOrder"].append(scene_id)
                    state["scenes"][scene_id] = {
                        "id": scene_id,
                        "name": str(payload.get("name") or scene_id),
                        "clip": {
                            "startMs": _coerce_int(payload.get("startMs"), 0),
                            "endMs": _coerce_int(payload.get("endMs"), 5000),
                            "trackOrder": _coerce_int(payload.get("trackOrder"), len(state["sceneOrder"]) - 1),
                        },
                        "background": None,
                        "cameraTrack": [],
                        "entities": {},
                    }
                state["activeSceneId"] = scene_id
                continue

            if event_type == "scene.delete":
                scene_id = payload.get("sceneId")
                if isinstance(scene_id, str) and scene_id in state["scenes"]:
                    state["scenes"].pop(scene_id, None)
                    if scene_id in state["sceneOrder"]:
                        state["sceneOrder"].remove(scene_id)
                    if state["activeSceneId"] == scene_id:
                        state["activeSceneId"] = state["sceneOrder"][-1] if state["sceneOrder"] else None
                continue

            if event_type == "scene.select":
                scene_id = payload.get("sceneId")
                if isinstance(scene_id, str) and scene_id in state["scenes"]:
                    state["activeSceneId"] = scene_id
                continue

            scene_id = payload.get("sceneId")
            if not isinstance(scene_id, str) or scene_id not in state["scenes"]:
                continue
            scene = state["scenes"][scene_id]

            if event_type == "scene.set_background":
                scene["background"] = self._resolve_asset(payload.get("assetRef"), assets_by_id, latest_by_key)
                continue

            if event_type == "scene.clip.set":
                clip = scene["clip"]
                if "startMs" in payload:
                    clip["startMs"] = _coerce_int(payload.get("startMs"), clip["startMs"])
                if "endMs" in payload:
                    clip["endMs"] = _coerce_int(payload.get("endMs"), clip["endMs"])
                if "trackOrder" in payload:
                    clip["trackOrder"] = _coerce_int(payload.get("trackOrder"), clip["trackOrder"])
                if clip["endMs"] < clip["startMs"]:
                    clip["endMs"] = clip["startMs"]
                continue

            if event_type == "scene.camera.keyframe_set":
                keyframe = {
                    "timeMs": _coerce_int(payload.get("timeMs"), 0),
                    "x": _coerce_float(payload.get("x"), 0.0),
                    "y": _coerce_float(payload.get("y"), 0.0),
                    "zoom": _coerce_float(payload.get("zoom"), 1.0),
                    "rotationDeg": _coerce_float(payload.get("rotationDeg"), 0.0),
                }
                self._upsert_keyframe(scene["cameraTrack"], keyframe)
                continue

            if event_type == "scene.entity.add":
                entity_id = _slug(str(payload.get("entityId") or "entity"), "entity")
                existing = scene["entities"].get(entity_id)
                if isinstance(existing, dict):
                    existing["name"] = str(payload.get("name") or existing.get("name") or entity_id)
                    resolved = self._resolve_asset(payload.get("assetRef"), assets_by_id, latest_by_key)
                    if resolved is not None:
                        existing["asset"] = resolved
                else:
                    scene["entities"][entity_id] = {
                        "id": entity_id,
                        "name": str(payload.get("name") or entity_id),
                        "asset": self._resolve_asset(payload.get("assetRef"), assets_by_id, latest_by_key),
                        "keyframes": [],
                    }
                continue

            if event_type == "scene.entity.remove":
                entity_id = payload.get("entityId")
                if isinstance(entity_id, str):
                    scene["entities"].pop(entity_id, None)
                continue

            if event_type == "scene.entity.keyframe_set":
                entity_id = payload.get("entityId")
                if not isinstance(entity_id, str):
                    continue
                entity = scene["entities"].get(entity_id)
                if not isinstance(entity, dict):
                    continue
                keyframe = {
                    "timeMs": _coerce_int(payload.get("timeMs"), 0),
                    "x": _coerce_float(payload.get("x"), 0.0),
                    "y": _coerce_float(payload.get("y"), 0.0),
                    "scaleX": _coerce_float(payload.get("scaleX"), 1.0),
                    "scaleY": _coerce_float(payload.get("scaleY"), 1.0),
                    "rotationDeg": _coerce_float(payload.get("rotationDeg"), 0.0),
                    "opacity": _coerce_float(payload.get("opacity"), 1.0),
                }
                self._upsert_keyframe(entity["keyframes"], keyframe)

        max_end = 1000
        for scene in state["scenes"].values():
            max_end = max(max_end, _coerce_int(scene.get("clip", {}).get("endMs"), 0))
        state["timeline"]["durationMs"] = max_end
        return state

    @staticmethod
    def _resolve_asset(
        ref: Any,
        by_id: dict[str, dict[str, Any]],
        by_key: dict[str, dict[str, Any]],
    ) -> dict[str, Any] | None:
        if not isinstance(ref, dict):
            return None
        asset_id = ref.get("assetId")
        if isinstance(asset_id, str):
            match = by_id.get(asset_id)
            if match is not None:
                return match
            return {"assetId": asset_id, "missing": True}
        asset_key = ref.get("assetKey")
        if isinstance(asset_key, str):
            match = by_key.get(asset_key)
            if match is not None:
                return match
            return {"assetKey": asset_key, "missing": True}
        return None

    @staticmethod
    def _upsert_keyframe(track: list[dict[str, Any]], keyframe: dict[str, Any]) -> None:
        t = _coerce_int(keyframe.get("timeMs"), 0)
        for idx, existing in enumerate(track):
            if _coerce_int(existing.get("timeMs"), -1) == t:
                track[idx] = keyframe
                break
        else:
            track.append(keyframe)
        track.sort(key=lambda item: _coerce_int(item.get("timeMs"), 0))

    @staticmethod
    def _interpolate(
        track: list[dict[str, Any]],
        time_ms: int,
        keys: tuple[str, ...],
    ) -> dict[str, Any] | None:
        if not track:
            return None
        ordered = sorted(track, key=lambda item: _coerce_int(item.get("timeMs"), 0))
        if time_ms <= _coerce_int(ordered[0].get("timeMs"), 0):
            return dict(ordered[0])
        if time_ms >= _coerce_int(ordered[-1].get("timeMs"), 0):
            return dict(ordered[-1])

        left = ordered[0]
        right = ordered[-1]
        for index in range(len(ordered) - 1):
            current = ordered[index]
            nxt = ordered[index + 1]
            current_t = _coerce_int(current.get("timeMs"), 0)
            next_t = _coerce_int(nxt.get("timeMs"), current_t)
            if current_t <= time_ms <= next_t:
                left = current
                right = nxt
                break

        lt = _coerce_int(left.get("timeMs"), 0)
        rt = _coerce_int(right.get("timeMs"), lt)
        if rt <= lt:
            return dict(left)

        ratio = (time_ms - lt) / float(rt - lt)
        result: dict[str, Any] = {"timeMs": time_ms}
        for key in keys:
            lv = _coerce_float(left.get(key), 0.0)
            rv = _coerce_float(right.get(key), lv)
            result[key] = lv + (rv - lv) * ratio
        return result
