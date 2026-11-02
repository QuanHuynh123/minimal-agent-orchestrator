# Bản Thiết Kế Kỹ Thuật & Giao Diện: Orchestrator Read-Only Live Monitor (v2.0)

- **Document ID:** `SPEC-ORCHESTRATOR-UI-V2.0`
- **Target Files:** `agent-team/scripts/dashboard.mjs`, `agent-team/ui/index.html`
- **Triết lý Cốt lõi:** **Read-Only Telemetry & Zero Fake Data** — Dashboard chỉ là lớp kính quan sát trực tiếp từ dữ liệu thật (`live-status.json`, `team.yaml`, `project.yaml`, `task-state.json`, `state/runs/*`), tuyệt đối không điều khiển, không sửa state, và không tự bịa dữ liệu khi trường nguồn trống.

---

## 1. Đánh Giá Bản Review & 6 Điểm Cần Nâng Cấp Từ UI v1.1 Lên v2.0

Đối chiếu bản *UI Read-Only Dashboard Specification* với code thực tế hiện tại trong [`agent-team/scripts/dashboard.mjs`](file:///d:/tool-download/agent-team/scripts/dashboard.mjs) và [`agent-team/ui/index.html`](file:///d:/tool-download/agent-team/ui/index.html), chúng ta xác nhận **6 điểm hạn chế của bản v1.1 cần được giải quyết trong v2.0**:

| # | Yêu cầu trong Bản Review | Hiện trạng ở Code UI v1.1 (`dashboard.mjs` / `index.html`) | Phương án Nâng cấp trong Bản Thiết kế v2.0 |
| :--- | :--- | :--- | :--- |
| **1** | **Team / Roles phải render động từ cấu hình `team.yaml` + `live-status.json`** (không tự định nghĩa hay hardcode). | `ui/index.html` đang viết cứng 3 dòng HTML (`Writer`, `Validator`, `Reviewer`), bỏ sót `router` và tự gán cứng chữ `'deepseek-v4.1'`, `'claude-opus'` làm fallback. | Render động danh sách role từ `data.roles` (trong `team.yaml`) + các chốt deterministic (`applier`, `validator`, `git`) dựa trên `current_stage` và `live_status.roles_status`. Hiển thị đúng `display_name` + `model` thật. |
| **2** | **Không tự bịa dữ liệu (Zero Fake Fallback)** khi trường nguồn không có. | `dashboard.mjs` (dòng 161–168) dùng regex cũ `Model Used:` (trong khi `orchestrator.mjs` đã đổi thành `Model Requested:` / `Model Responded:`), và khi không khớp thì tự điền `'deepseek-v4.1'` và `'stop'`! | Sửa parser trong `dashboard.mjs` đọc đúng `Model Requested`, `Model Responded`, `Finish Reason`. Nếu không có thì trả `'unknown'` / `'N/A'`, tuyệt đối không điền giá trị giả. |
| **3** | **Workflow Lifecycle & Elapsed Timer cho mọi Stage đang chạy** (bao gồm trạng thái cuối `Done / Blocked`). | Thanh Pipeline hiện chỉ có 7 bước và đồng hồ `⏱ 0s` chỉ hiện riêng ở bước `Writer`. Khi `Validator` chạy 231 unit tests (~30s), giao diện đứng im không có bộ đếm giây. | Thêm bước kết thúc `6. Done / Blocked` trên thanh Pipeline. Đồng hồ đếm giây (`⏱ Elapsed`) tự động gắn vào **bất kỳ stage nào đang active** dựa trên `stage_started_at`, kèm hiển thị tổng thời gian chạy task (`task_started_at`). |
| **4** | **Hiển thị tách biệt rõ `Last Error` cạnh `Writer Raw Output`**. | `live_status.last_error` đã có trong JSON nhưng `ui/index.html` hoàn toàn **chưa render `last_error`**! Khi test fail hoặc bị chặn, người dùng không thấy khung báo lỗi màu đỏ. | Thêm **Banner / Callout `Last Error`** nổi bật ngay phía trên (hoặc tab cạnh) `Writer Raw Output` bất cứ khi nào `live_status.last_error` khác `null`. |
| **5** | **Task Queue phải hiển thị cả danh sách `Pending / Active`, `Blocked` (kèm lý do), và `Recent Completed` (kèm commit hash)** đã gộp theo `task_id`. | API `/api/snapshot` đã trả về `queue.active`, `queue.blocked`, `queue.recent_completed`, nhưng `ui/index.html` mới chỉ vẽ 3 ô số đếm (`0 / 16 / 0`) và bỏ trống phần danh sách! | Nâng cấp thẻ **Task Queue** ở cột trái: bên dưới 3 ô số đếm là danh sách cuộn gọn gàng hiển thị các task `Active/Pending`, `Blocked` (kèm `block_reason`), và 5 task `Completed` gần nhất (kèm mã `commit_hash`). |
| **6** | **Hiển thị rõ `Project / Repo`, `Current Task Label` & `Current Stage` trên Top Bar & Active Task Card**. | Chưa đọc `project_id` / `allowed_dirs` từ `project.yaml`; Top Bar chưa hiện nhãn stage hiện tại. | Bổ sung `project` metadata (`id`, `allowed_dirs`) từ `config/project.yaml` vào `/api/snapshot` và hiển thị rõ trên Top Bar + Active Task Card. |

---

## 2. Kiến Trúc Layout & Phân Vùng Thị Giác (Bento Dark v2.0)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. TOP BAR (52px cố định)                                                                            │
│ [⚡ Orchestrator Monitor] [Project: tool-download-stable] │ [9Router: ● 12ms] [PID: 14820]           │
│                                                           │ [Stage: VALIDATOR] [Tokens: 789k↑ 422k↓] │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. WORKFLOW LIFECYCLE STRIP (44px cố định — Chỉ 1 Stage sáng đèn + Đồng hồ đếm giây tại Stage đó)    │
│ [0. Pre-Flight ✓] ➔ [1. Router ✓] ➔ [2. Writer ✓] ➔ [3. Applier ✓] ➔ [4. Validator ● ⏱ 14s]         │
│                   ➔ [4b. Review ○] ➔ [5. Git ○] ➔ [6. Done / Blocked ○]                              │
├───────────────────────────────────────────────┬──────────────────────────────────────────────────────┤
│ 3. CỘT TRÁI (390px cố định, cuộn độc lập)     │ 4. CỘT PHẢI TRÊN (60% chiều cao phải)                │
│                                               │                                                      │
│ ┌─ A. ACTIVE TASK & SCOPE ──────────────────┐ │ ┌─ A. LAST ERROR ALERT (Chỉ hiện khi có lỗi) ──────┐ │
│ │ ID: T-2026-11-01-012      [Attempt 1 / 3] │ │ │ ⚠️ LAST ERROR / BLOCKER:                         │ │
│ │ [STATUS: RUNNING] [MODE: QUICK] [RISK:LOW]│ │ │ FAIL: test_inpaint (AssertionError: ...)         │ │
│ │ Stage: validator (⏱ 14s) | Task: ⏱ 38s    │ │ └──────────────────────────────────────────────────┘ │
│ │ Goal: Nâng cấp inpaint_ai trong core/...  │ │ ┌─ B. WRITER RAW OUTPUT INSPECTOR ─────────────────┐ │
│ │ Locked Scope (2 files):                   │ │ │ File: state/runs/T-.../attempt-1.txt (12 KB)     │ │
│ │  • core/eraser.py              [MODIFIED] │ │ │ Req: Deepseek V4.1  │ Resp: deepseek-v4.1-flash  │ │
│ │  • tests/test_eraser.py        [MODIFIED] │ │ │ Finish Reason: [stop]                            │ │
│ └───────────────────────────────────────────┘ │ │ ──────────────────────────────────────────────── │ │
│ ┌─ B. SQUAD ROLES (Render động từ config) ──┐ │ │ ### FILE: core/eraser.py                         │ │
│ │ • router    claude-sonnet-4.5-th  [IDLE]  │ │ │ <<<<<<< SEARCH                                   │ │
│ │ • writer    deepseek-v4.1-flash   [DONE]  │ │ │ ...                                              │ │
│ │ • validator scripts/validator.mjs [WORK]  │ │ └──────────────────────────────────────────────────┘ │
│ │ • reviewer  claude-sonnet-4.5     [SKIP]  │ ├──────────────────────────────────────────────────────┤
│ └───────────────────────────────────────────┘ │ 5. CỘT PHẢI DƯỚI: LIVE CONSOLE LOGS (40% chiều cao)  │
│ ┌─ C. TASK QUEUE (Deduplicated by task_id) ─┐ │ ┌──────────────────────────────────────────────────┐ │
│ │ [ Active: 0 ] [ Done: 16 ] [ Blocked: 0 ] │ │ │ [Filter logs...]              [⏸ Pause] [Clear] │ │
│ │ Recent / Queue List:                      │ │ │ 11:30:01 [INFO]  [START] T-2026-11-01-012 ...    │ │
│ │  ✓ T-2026-11-01-012  [28a30b1]  (Done)    │ │ │ 11:30:19 [INFO]  [Applier] Applied 2 blocks      │ │
│ │  ✓ T-2026-11-01-011  [e56987c]  (Done)    │ │ │ 11:30:20 [WARN]  [Reviewer] Skipped AI review... │ │
│ └───────────────────────────────────────────┘ │ └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

---

## 3. Data Contract Chuẩn Hóa (`GET /api/snapshot`)

Backend `agent-team/scripts/dashboard.mjs` trả về đúng cấu trúc JSON chỉ-đọc sau (đã loại bỏ hoàn toàn `providers`, `api_key_env`, `default_key`):

```json
{
  "timestamp": "2026-11-02T05:00:00.000Z",
  "project": {
    "id": "tool-download-stable",
    "allowed_dirs": ["core/", "ui/", "ui_bridge/", "tests/"]
  },
  "orchestrator": {
    "running": true,
    "pid": 14820,
    "started_at": "2026-11-02T04:58:00.000Z"
  },
  "router_health": {
    "ok": true,
    "latency_ms": 14,
    "model_count": 12,
    "error": null
  },
  "roles": {
    "router": { "enabled": true, "display_name": "Claude Sonnet 4.5 Thinking", "model": "kr/claude-sonnet-4.5-thinking" },
    "writer": { "enabled": true, "display_name": "DeepSeek V4.1 Flash", "model": "Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017" },
    "reviewer": { "enabled": true, "display_name": "Claude Sonnet 4.5", "model": "kr/claude-sonnet-4.5" },
    "validator": { "enabled": true, "type": "deterministic_script", "script": "scripts/validator.mjs" }
  },
  "live_status": {
    "active": true,
    "pid": 14820,
    "current_task_id": "T-2026-11-01-012",
    "current_task_title": "Nâng cấp inpaint_ai trong core/eraser.py...",
    "current_stage": "validator",
    "stage_started_at": "2026-11-02T04:59:45.000Z",
    "task_started_at": "2026-11-02T04:59:10.000Z",
    "mode": "quick",
    "risk_level": "low",
    "attempt": 1,
    "max_retries": 3,
    "scope_files": [
      { "path": "core/eraser.py", "status": "modified" },
      { "path": "tests/test_eraser.py", "status": "modified" }
    ],
    "roles_status": {
      "writer": { "model": "Deepseek V4.1 Flash/...", "status": "done" },
      "validator": { "status": "working" },
      "reviewer": { "status": "idle" }
    },
    "last_error": null,
    "tokens": {
      "task_input": 18420,
      "task_output": 2150,
      "session_input": 789739,
      "session_output": 422870
    },
    "recent_logs": [
      { "ts": "11:59:10", "level": "info", "msg": "[START] T-2026-11-01-012 | Mode: quick..." }
    ]
  },
  "queue": {
    "active_count": 0,
    "completed_count": 16,
    "blocked_count": 0,
    "active": [],
    "blocked": [],
    "recent_completed": [
      {
        "task_id": "T-2026-11-01-012",
        "title": "Nâng cấp inpaint_ai trong core/eraser.py...",
        "mode": "quick",
        "status": "done",
        "commit_hash": "28a30b1a0221ed8ca4f72377e888bf3701fb2925",
        "retries": 1,
        "completed_at": "2026-11-01T16:42:03.550Z"
      }
    ]
  },
  "latest_output": {
    "file_path": "state/runs/T-2026-11-01-012/attempt-2.txt",
    "content": "=== WRITER ATTEMPT 2 ===\n...",
    "model_requested": "Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017",
    "model_responded": "deepseek-ai/deepseek-v4.1-flash-1017",
    "finish_reason": "stop",
    "file_size_bytes": 4120,
    "truncated": false
  }
}
```

---

## 4. Quy Tắc Màu Sắc, Typography & Bảo Mật Hiển Thị (Dành cho Designer & FE Dev)

1. **Bảng màu Trạng thái Ngữ nghĩa (Semantic Status Palette — Không dùng màu ẩn logic):**
   - **Success / Done / Validated (`#10b981` — Emerald):** Luôn đi kèm nhãn chữ tường minh `DONE`, `PASSED`, `APPROVED`, `VALIDATED` hoặc dấu `✓`.
   - **Active / Working (`#3b82f6` — Blue & `#f59e0b` — Amber):** Luôn đi kèm nhãn `WORKING`, `RUNNING`, `MODIFIED` và đồng hồ `⏱ Ns`.
   - **Blocked / Error / Rejected (`#ef4444` — Red):** Luôn đi kèm nhãn `BLOCKED`, `FAILED`, `ERROR`, `TRUNCATED` hoặc dấu `✕`.
   - **Idle / Skipped (`#64748b` — Slate Gray):** Đi kèm nhãn `IDLE`, `PENDING`, `SKIPPED`.
2. **Typography & Độ dễ đọc:**
   - Heading & Card Title: `11px–14px`, `font-weight: 700`, uppercase cho nhãn phân mục.
   - Code, File Path, Task ID, Commit Hash, Timers, Logs: Bắt buộc dùng `monospace` (`JetBrains Mono`, `Cascadia Code`, `Consolas`).
3. **Bảo mật Chống XSS & Lộ Secret:**
   - **Backend (`dashboard.mjs`):** Chỉ lấy `teamYaml.roles` và `projectYaml.project.id` / `allowed_dirs`. Tuyệt đối không trả `teamYaml.providers` qua API.
   - **Frontend (`ui/index.html`):** 100% dữ liệu động (log, tiêu đề task, đường dẫn file, raw output, last error) phải gán qua `.textContent` hoặc `document.createElement()`. Cấm dùng `.innerHTML` với dữ liệu từ API.

---

## 5. Checklist Nghiệm Thu cho FE Dev (`Acceptance Criteria`)

- [x] **AC-1 (Dynamic Roles):** Thay thế 3 dòng role cố định trong `ui/index.html` bằng hàm `renderSquadRoles(data.roles, live.roles_status, live.current_stage)` tự động liệt kê đầy đủ các role trong `team.yaml` (`router`, `writer`, `validator`, `reviewer`, `applier`, `git`).
- [x] **AC-2 (Zero Fake Data):** Trong `dashboard.mjs`, đọc đúng `Model Requested:` / `Model Responded:` / `Finish Reason:` từ file `attempt-N.txt`; nếu không có thì trả `'unknown'` / `'N/A'`.
- [x] **AC-3 (Universal Stage Timer & Final Stage):** Hiển thị bộ đếm giây `⏱ Ns` ngay trên pill của bất kỳ stage nào đang active trên thanh Pipeline + bước cuối `6. Done / Blocked`.
- [x] **AC-4 (Last Error Callout):** Khi `live_status.last_error` có nội dung, hiển thị khung cảnh báo đỏ `Last Error / Blocker` ngay phía trên khung `Writer Raw Output`.
- [x] **AC-5 (Interactive Queue List):** Hiển thị danh sách các task `Active/Pending`, `Blocked` (kèm lý do lỗi), và `Recent Completed` (kèm 7 ký tự đầu của `commit_hash` và số lần `retries`) ngay bên dưới 3 ô thống kê Queue.
