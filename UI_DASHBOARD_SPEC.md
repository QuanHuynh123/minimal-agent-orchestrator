# Technical Specification: Orchestrator Live Monitor UI (MVP Bento Dark — Windows-Safe)

- **Document ID:** `SPEC-ORCHESTRATOR-UI-V1.1`
- **Target Files:** `agent-team/scripts/dashboard.mjs`, `agent-team/ui/index.html`, `agent-team/scripts/orchestrator.mjs`
- **Execution Note:** Because `agent-team/scripts/**` and `agent-team/package.json` are in `protected_files`, this UI must be implemented directly by the IDE Agent (not via `orchestrator.mjs` self-modification) and only **after** active `orchestrator.mjs` runs finish.

---

## 1. Core Design Principles (Refined from Systems Review)

1. **1-Second HTTP Polling Instead of `fs.watch` + SSE:**
   - On Windows NTFS, atomic `fs.renameSync` invalidates file-level `fs.watch` handles and causes duplicate events or `EPERM` lock contention.
   - Browser polls `GET /api/snapshot` every `1000ms` (`1s`). Zero SSE state, zero broken watchers on Windows.
2. **Non-Throwing Telemetry (`try / catch` Swallow in `orchestrator.mjs`):**
   - `updateLiveStatus()` writes directly to `state/live-status.json` inside a `try { ... } catch {}` block. A telemetry write lock (`EPERM` / `EBUSY`) MUST NEVER crash or interrupt `orchestrator.mjs`.
3. **Console Ring Buffer (Last 100 Lines):**
   - Wrap `console.log`, `console.warn`, and `console.error` in `orchestrator.mjs` to append `{ ts, level, msg }` into an in-memory ring buffer (`max = 100`) flushed by `updateLiveStatus()`.
4. **Honest Non-Streaming Progress:**
   - Since `call9Router()` awaits the full HTTP response (`await res.text()`), the UI shows a live **Elapsed Timer (`⏱ 00:14s`)** while `active_stage === "writer"`, and updates token counts (`In ↑ / Out ↓`) once the response completes.
5. **Secret Scrubbing on `/api/snapshot`:**
   - Strip `teamConfig.providers` (which contains `default_key` / `api_key_env`) before returning JSON to the browser; only return `teamConfig.roles`.
6. **Offline-Safe System Font Stack:**
   - UI CSS uses system fallbacks (`'Inter', 'Segoe UI', system-ui, sans-serif` and `'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace`) with zero external CDN dependencies.

---

## 2. MVP Layout (`~250–350 Lines`, 5 Focused Panels)

```
+--------------------------------------------------------------------------------------------------+
| 1. TOP BAR: [● 9Router :20128]  [Orchestrator: RUNNING (PID 14820)]  [Tokens: 42.1k / 3.0M]      |
+--------------------------------------------------------------------------------------------------+
| 2. PIPELINE STAGE STRIP (7 Flexbox Step Pills — Lit by current_stage)                            |
|  [0. Pre-Flight] ➔ [1. Router] ➔ [2. Writer ⏱ 12s] ➔ [3. Applier] ➔ [4. Validator] ➔ [4b. Review] ➔ [5. Git] |
+------------------------------------------------+-------------------------------------------------+
| 3. ACTIVE TASK, SQUAD & SCOPE (Left Column)    | 4. WRITER RAW OUTPUT & LAST ERROR (Right Top)   |
|  Task: T-2026-11-01-002                        |  Source: state/runs/T-2026-11-01-002/attempt-1  |
|  Mode: [QUICK]  Risk: [LOW]  Attempt: 1 / 3    |  Finish Reason: [stop / length]  Model: [...]   |
|  Roles:                                        |  ┌─────────────────────────────────────────────┐|
|   • Writer: deepseek-v4.1-flash    [● WORKING] |  │ ### FILE: core/eraser.py                    │|
|   • Validator: validator.mjs       [IDLE]      |  │ <<<<<<< SEARCH                              │|
|   • Reviewer: claude-sonnet-4.5    [SKIP: LOW] |  │ ... (Raw Writer Output & Last Error Box)    │|
|  Locked Scope Files:                           |  └─────────────────────────────────────────────┘|
|   ✓ core/eraser.py                 [MODIFIED]  +-------------------------------------------------+
|   • tests/test_eraser.py           [PENDING]   | 5. LIVE CONSOLE LOGS (Right Bottom, Auto-scroll)|
|  Queue (Deduplicated by task_id):              |  15:20:01 [START] T-2026-11-01-002 | Mode: quick|
|   • Active: 1  • Done: 1  • Blocked: 1         |  15:20:14 [Applier] OK — Modified 1 file        |
+------------------------------------------------+-------------------------------------------------+
```

---

## 3. Backend Endpoints (`agent-team/scripts/dashboard.mjs`)

1. **`GET /`:** Serves `agent-team/ui/index.html`.
2. **`GET /api/snapshot`:**
   - Reads and merges:
     - `roles` from `config/team.yaml` (**excluding** `providers`).
     - `policy.approval_gates` & `policy.task_modes` from `config/policy.yaml`.
     - `state/live-status.json` (wrapped in `try/catch` if currently being written).
     - `.orchestrator.lock` (checks `isProcessAlive(pid)`).
     - Deduplicated counts and lists of `active`, `completed`, and `blocked` tasks by `task_id`.
     - Latest raw writer output file from `state/runs/<current_or_last_task_id>/attempt-<N>.txt` (capped at last `16 KB` for fast polling).
     - Cached 9Router health status (`http://127.0.0.1:20128/v1/models`, refreshed at most once every 10s).
3. **Security & Rendering Contract:**
   - Server binds strictly to `127.0.0.1` (default port `4310`).
   - All dynamic strings in `agent-team/ui/index.html` are rendered via `.textContent` (never `.innerHTML`).
