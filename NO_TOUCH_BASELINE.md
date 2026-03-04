# No-Touch Baseline Policy

This repository currently has a working ADK bidi-streaming baseline.

## Hard Rules

1. Do not modify baseline streaming backbone files without explicit user approval.
2. Treat these files as frozen by default:
   - `app/main.py`
   - `app/static/js/app.js`
   - `app/static/index.html`
   - `app/static/css/style.css`
   - `app/google_search_agent/agent.py`
3. All new work must be additive in new modules/folders.
4. Integration into baseline files is opt-in and must be approved per change.
5. For any bidi streaming or agent architecture work, use the `google-adk-python-expert` skill and cite ADK references before implementation.

## Default Workflow

1. Design first with ADK references.
2. Implement in additive files only.
3. Show exact diff proving baseline files are unchanged.
4. Request approval before any integration edits.
