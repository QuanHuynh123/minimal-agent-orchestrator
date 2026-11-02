# Bản Đặc Tả Kỹ Thuật & Giao Diện: Orchestrator Read-Only Live Monitor (v3.0)

- **Document ID:** `SPEC-ORCHESTRATOR-UI-V3.0`
- **Target Files:**
  - Frontend UI: [`agent-team/ui/index.html`](file:///d:/tool-download/agent-team/ui/index.html)
  - Read-Only Telemetry Server: [`agent-team/scripts/dashboard.mjs`](file:///d:/tool-download/agent-team/scripts/dashboard.mjs)
- **Triết lý Cốt lõi:**
  1. **Read-Only Telemetry & Zero Fake Data:** Chỉ hiển thị dữ liệu thật từ `/api/snapshot` (`live-status.json`, `team.yaml`, `project.yaml`, `policy.yaml`, `task-state.json`, `state/runs/*`). Không bịa dữ liệu giả khi trường nguồn trống.
  2. **Phân tách rạch ròi "Nhân sự AI (`AI Squad Models`)" và "Cơ khí Thác nước (`Waterfall Pipeline Stages`)":** Các script deterministic (`applier.mjs`, `validator.mjs`, `git-guard.mjs`) thuộc về **Sơ đồ Thác nước**, tuyệt đối không nhét vào danh sách Nhân sự AI ở cột trái.
  3. **Waterfall & Writer Sub-Flow làm Trung tâm Thị giác (Centerpiece):** Thay vì để khung chữ thô `Writer Raw Output` chiếm 60% màn hình, khu vực chính được chia thành **2 Tab**:
     - **Tab 1 (Mặc định): `🌊 Waterfall & Writer Sub-Flow`** — Mô phỏng trực quan cả **Tầng Vĩ mô (Macro Waterfall 7 trạm)** lẫn **Tầng Vi mô (Micro Writer & Verification Sub-Flow)** theo đúng luồng chạy thực tế của dự án.
     - **Tab 2 (Bật khi cần): `📄 Raw Output & Error Inspector`** — Xem chi tiết nội dung `attempt-N.txt` (`SEARCH/REPLACE` blocks) và full traceback khi cần soi code/lỗi.

---

## 1. Bốn Vấn Đề Cốt Lõi Của Bản Cũ Cần Giải Quyết Triệt Để Ở v3.0

| # | Vấn đề ở bản cũ (Từ thực tế chạy `127.0.0.1:4310`) | Nguyên nhân Gốc | Giải pháp Kiến trúc ở bản v3.0 |
| :--- | :--- | :--- | :--- |
| **1** | **Nhập nhằng giữa "AI Squad Roles" và "Waterfall Pipeline Scripts"** | Cột trái `SQUAD ROLES` đang liệt kê chung 4 Model AI (`Antigravity`, `Sonnet 4.5`, `DeepSeek V4.1`, `Opus 5.5`) với 3 script cơ khí (`Applier`, `Validator`, `Git Guard`). | **Cột trái (`AI SQUAD MODELS`)** chỉ hiển thị **4 vị trí Nhân sự AI** kèm chức danh rõ ràng trong quy trình (`IDE Coordinator`, `Planner / Router`, `Core Code Writer`, `Tech Lead Reviewer`). Còn `Applier`, `Validator`, `Git Guard` được trả về đúng vị trí của chúng là các **Trạm Cơ khí trên Sơ đồ Thác nước (Waterfall Canvas)**. |
| **2** | **Đảo ngược Tỷ lệ Ưu tiên Thị giác (Visual Hierarchy)** | Thanh Waterfall ở trên cùng chỉ cao `44px` với các nút chữ bé xíu, trong khi khung text thô `WRITER RAW OUTPUT` lại chiếm 60% diện tích màn hình chính dù người vận hành rất ít khi đọc từng dòng `<<<<<<< SEARCH`. | Xóa thanh strip `44px` chật hẹp trên đầu. Đưa **Sơ đồ Thác nước & Luồng Writer (Waterfall & Writer Flow)** vào **Trung tâm Khung phải trên (Tab 1 - Mặc định)** với các Node Card lớn, rõ ràng. Đẩy `Writer Raw Output & Diff Inspector` sang **Tab 2** (chỉ mở khi muốn đọc raw diff/log). |
| **3** | **Thiếu mô phỏng Luồng Nội bộ của Đội Writer (`Writer Sub-Workflow`)** | Trạm `2. Writer` hiện chỉ là 1 pill đơn điệu, không cho thấy quy trình thực tế bên trong `orchestrator.mjs` + `roles/writer.md` (Nạp scope $\rightarrow$ Tiêm luật `policy.yaml` / lỗi Retry $\rightarrow$ Gọi 9Router $\rightarrow$ Kiểm tra `Model Match` & `finish_reason` $\rightarrow$ Bóc tách `SEARCH/REPLACE` $\rightarrow$ Vòng lặp Retry `1..3`). | Thiết kế **Bản đồ 2 Tầng (2-Layer Flow Canvas)** ngay trong Tab 1: **Tầng 1 (Macro Waterfall)** hiển thị toàn cảnh 7 trạm thác nước + đường vòng **Retry Loop**; **Tầng 2 (Micro Writer & Gate Sub-Flow)** mô phỏng chi tiết 4 bước nội bộ của Writer + 2 chốt kiểm tra `Applier (8-Step Guard)` & `Validator (Fast + Suite)` bằng dữ liệu thật. |
| **4** | **2 Bug Telemetry: Đồng hồ đếm vô tận (`53553s`) & Báo lỗi giả sau khi Retry thành công** | 1) Khi `current_stage` là `idle`/`done`, UI vẫn lấy `Date.now() - task_started_at` khiến đồng hồ chạy suốt 15 tiếng (`53553s`).<br>2) Khi Attempt 1 lỗi nhưng Attempt 2 `done`, `last_error` của Attempt 1 vẫn lưu lại làm hiện khung đỏ báo lỗi giả. | 1) Khi task đã kết thúc (`idle`, `done`, `blocked`), đồng hồ chốt thời gian chạy thực tế (`task_completed_at - task_started_at`, VD: `⏱ 97s`).<br>2) Khi task `done`, xóa `last_error = null` (chỉ hiển thị badge nhỏ `"Recovered on Attempt 2/3"` để biết task đã tự sửa lỗi thành công). |

---

## 2. Kiến Trúc Bố Cục & Phân Vùng Thị Giác (Bento Obsidian v3.0)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. TOP BAR (52px cố định)                                                                                  │
│ [⚡ 9Router Orchestrator v3.0] [Project: tool-download-stable] │ [Stage: IDLE] [9Router :20128 ● 12ms]     │
│                                                                │ [PID: IDLE] [Tokens: 789.7k↑ | 422.9k↓]   │
├───────────────────────────────────────────────┬────────────────────────────────────────────────────────────┤
│ 2. CỘT TRÁI (380px cố định, cuộn độc lập)     │ 3. CỘT PHẢI TRÊN (64% chiều cao phải — Vùng Tab Trung Tâm) │
│                                               │                                                            │
│ ┌─ A. ACTIVE / LAST TASK & LOCKED SCOPE ────┐ │ ┌─ TAB HEADER BAR ───────────────────────────────────────┐ │
│ │ T-2026-11-01-012          [ATTEMPT 2 / 3] │ │ │ [🌊 1. Waterfall & Writer Flow (Active)]               │ │
│ │ [STATUS: DONE ✓] [MODE: QUICK] [RISK: LOW]│ │ │ [📄 2. Raw Output & Error Inspector (6 KB | stop)]     │ │
│ │ Duration: ⏱ 1m 37s (Recovered on Retry 1) │ │ └────────────────────────────────────────────────────────┘ │
│ │ Goal: Nâng cấp inpaint_ai trong core/...  │ │ ┌─ TAB 1: 2-LAYER WATERFALL & WRITER SUB-FLOW CANVAS ────┐ │
│ │ Locked Scope (2 files):                   │ │ │                                                        │ │
│ │  • core/eraser.py             [VALIDATED] │ │ │ PHẦN A: MACRO WATERFALL PIPELINE (7 Trạm + Retry Loop) │ │
│ │  • tests/test_eraser.py       [VALIDATED] │ │ │                                                        │ │
│ └───────────────────────────────────────────┘ │ │  ┌────────────┐   ┌────────────┐   ╔══════════════╗    │ │
│                                               │ │  │0.Pre-Flight│──►│ 1. Router  │──►║  2. WRITER   ║    │ │
│ ┌─ B. AI SQUAD (CHỈ NHÂN SỰ MODEL AI) ──────┐ │ │  │ Baseline ✓ │   │Scope Lock ✓│   ║DeepSeek V4 ✓ ║    │ │
│ │ (Tuyệt đối không trộn script cơ khí)      │ │ │  └────────────┘   └────────────┘   ╚══════╤═══════╝    │ │
│ │                                           │ │ │         ▲─ ─ ─ ─ (Retry Loop: Used 1/2) ─ ┼ ─ ─ ┐      │ │
│ │ ⚡ Antigravity (IDE Coordinator)  [ONLINE] │ │ │                                           ▼     │      │ │
│ │   Vai trò: Architect & Task Planner       │ │ │  ┌────────────┐   ┌────────────┐   ┌────────────┴───┐  │ │
│ │                                           │ │ │  │4b.Reviewer │◄──│4.Validator │◄──│  3. Applier    │  │ │
│ │ 🧭 Planner / UI Router             [IDLE] │ │ │  │  SKIPPED   │   │  PASSED ✓  │   │8-Step Guard ✓  │  │ │
│ │   Model: kr/claude-sonnet-4.5-thinking    │ │ │  └─────┬──────┘   └────────────┘   └────────────────┘  │ │
│ │   Trigger: Auto khi > 2 files / UI design │ │ │        ▼                                               │ │
│ │                                           │ │ │  ┌────────────┐   ┌───────────────────────────────┐    │ │
│ │ ✍️ Core Code Writer                [DONE] │ │ │  │5.Git Guard │──►│ 6. Final State: DONE ✓        │    │ │
│ │   Model: Deepseek V4.1 Flash/...          │ │ │  │Committed ✓ │   │ Commit: 28a30b1 (Attempt 2/3) │    │ │
│ │   Last Run: 41.5k in / 2.2k out | stop    │ │ │  └────────────┘   └───────────────────────────────┘    │ │
│ │                                           │ │ │ ────────────────────────────────────────────────────── │ │
│ │ 🔍 Tech Lead Reviewer           [SKIPPED] │ │ │ PHẦN B: MICRO SUB-FLOW (Mổ xẻ Luồng Writer & Gates)    │ │
│ │   Model: ag/claude-opus-5-5-high          │ │ │                                                        │ │
│ │   Gate: risk_level >= high (Current: low) │ │ │  [2.1 Context & Rules] ➔ [2.2 Retry Feedback]          │ │
│ └───────────────────────────────────────────┘ │ │   • 2 locked files        • Attempt 2 / 3              │ │
│                                               │ │   • Policy: TAB (\t)      • Injected Attempt 1 FAIL    │ │
│ ┌─ C. TASK QUEUE & ARCHIVE ─────────────────┐ │ │          │                                             │ │
│ │ [ Active: 0 ] [ Done: 16 ] [ Blocked: 0 ] │ │ │          ▼                                             │ │
│ │  ✓ T-2026-11-01-012  [28a30b1]   Retry: 1 │ │ │  [2.3 LLM Generation]  ➔ [2.4 Output & Gate Guards]    │ │
│ │  ✓ T-2026-11-01-011  [e56987c]   Retry: 0 │ │ │   • Req == Resp Match ✓   • Finish: stop (No trunc) ✓  │ │
│ │  ✓ T-2026-11-01-010  [9a12f4b]   Retry: 0 │ │ │   • 41,547 ➔ 2,261 tok    • 2 SEARCH/REPLACE blocks ✓  │ │
│ └───────────────────────────────────────────┘ │ └────────────────────────────────────────────────────────┘ │
│                                               ├────────────────────────────────────────────────────────────┤
│                                               │ 4. CỘT PHẢI DƯỚI: LIVE CONSOLE LOGS (36% chiều cao phải)   │
│                                               │ ┌────────────────────────────────────────────────────────┐ │
│                                               │ │ [Filter logs...]                    [⏸ Pause] [Clear] │ │
│                                               │ │ 23:40:25 [INFO] [START] T-2026-11-01-012 | Mode: quick │ │
│                                               │ │ 23:41:23 [WARN] [Validator] Suite check failed (Att 1) │ │
│                                               │ │ 23:42:03 [INFO] [REPORT] T-2026-11-01-012 | Status:done│ │
│                                               │ └────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────┴────────────────────────────────────────────────────────────┘
```

---

## 3. Đặc Tả Chi Tiết Từng Khu Vực (Dành cho Designer & FE Dev)

### 3.1. Cột Trái — Khu A: `ACTIVE / LAST TASK` & Đồng hồ Chuẩn Xác
- **Hiển thị:**
  - `current_task_id`, Badge `ATTEMPT X / Y` (`live.attempt / live.max_retries`).
  - Hàng pills:
    - `STATUS`: Nếu `live.active === true` $\rightarrow$ `RUNNING` (xanh dương); nếu `current_stage === 'done'` hoặc `task_final_status === 'done'` $\rightarrow$ `DONE ✓` (xanh lá); nếu `current_stage === 'blocked'` $\rightarrow$ `BLOCKED ✕` (đỏ).
    - `MODE`: `QUICK` hoặc `STANDARD`.
    - `RISK`: `LOW` / `MEDIUM` / `HIGH`.
    - `DURATION / TIMER`:
      - **Quy tắc chống đếm vô tận (BẮT BUỘC):**
        - Chỉ đếm giây realtime (`Date.now() - Date.parse(task_started_at)`) khi **Orchestrator đang chạy (`orchestrator.running === true`) VÀ `current_stage` không nằm trong `['idle', 'done', 'blocked', 'failed']`**.
        - Khi task đã xong hoặc hệ thống `idle`: Nếu có `live_status.task_completed_at` và `live_status.task_started_at`, hiển thị tổng thời gian tĩnh (VD: `⏱ 97s` hoặc `⏱ 1m 37s`). Nếu không tính được, hiển thị `⏱ --`. Tuyệt đối không cộng dồn lên `53553s`!
  - **Locked Scope Files:** Hiển thị danh sách các file trong `live_status.scope_files` kèm badge `LOCKED` / `MODIFIED` / `VALIDATED` / `ROLLED_BACK`.

### 3.2. Cột Trái — Khu B: `AI SQUAD MODELS` (Thuần Khiết 100% Nhân Sự AI)
- **Nguyên tắc:** Tuyệt đối **KHÔNG** render `Applier`, `Validator`, `Git Guard` ở đây. Chỉ render đúng **4 vị trí Nhân sự AI** trong kiến trúc:
  1. **`⚡ Antigravity (IDE Coordinator)`**
     - **Chức danh (Role Subtitle):** `Architect, UI & Task Coordinator`
     - **Model:** `Google Antigravity (Gemini)`
     - **Badge:** `ONLINE`
  2. **`🧭 Planner & Scope Router` (`roles.router`)**
     - **Chức danh:** `Scope Planner & UI/UX Specialist`
     - **Model:** Lấy từ `data.roles.router.model` (VD: `kr/claude-sonnet-4.5-thinking`).
     - **Điều kiện kích hoạt (Rule Line):** `Trigger: standard mode / >2 files`
     - **Badge:** Dựa trên `current_stage === 'router'` (`WORKING`) hoặc `roles_status.router?.status` (`IDLE` / `DONE` / `SKIPPED` / `DISABLED`).
  3. **`✍️ Core Code Writer` (`roles.writer`)**
     - **Chức danh:** `Autonomous SEARCH/REPLACE Engine`
     - **Model:** Lấy từ `data.roles.writer.model` (VD: `Deepseek V4.1 Flash/...`).
     - **Telemetry Line:** Hiển thị thông số thật từ `latest_output`: `Tokens: <prompt_tokens> in → <completion_tokens> out | Finish: <finish_reason>`.
     - **Badge:** `WORKING` (khi `current_stage === 'writer'`), `DONE` (khi đã sinh xong), hoặc `IDLE`.
  4. **`🔍 Tech Lead Reviewer` (`roles.reviewer`)**
     - **Chức danh:** `High-Risk Diff & Security Auditor`
     - **Model:** Lấy từ `data.roles.reviewer.model` (VD: `ag/claude-opus-5-5-high`).
     - **Điều kiện kích hoạt (Rule Line):** Lấy từ `data.policy.approval_gates.review_min_risk_level` (VD: `Gate: risk_level >= high`).
     - **Badge:** `WORKING`, `APPROVED`, `REJECTED`, `SKIPPED` (nếu task `risk_level: low`), hoặc `DISABLED` (nếu `enabled: false`).

---

### 3.3. Cột Phải Trên — Thiết Kế Hệ Thống 2 Tab (`Waterfall Flow` vs. `Raw Output`)

Trên đỉnh khung Phải Trên là thanh **Tab Switcher** gồm 2 tab:
1. **`[ 🌊 Waterfall & Writer Flow ]` *(Mặc định Active)*:** Hiển thị toàn bộ kiến trúc thác nước và luồng nội bộ của đội Writer.
2. **`[ 📄 Raw Output & Inspector ]` *(Hiển thị kèm badge dung lượng file `attempt-N.txt` & chấm đỏ nếu có `last_error`)*:** Bấm vào mới mở khung xem raw text `<<<<<<< SEARCH` và chi tiết lỗi.

---

#### Chi Tiết Tab 1: `🌊 Waterfall & Writer Flow` (Bản Đồ 2 Tầng)

##### TẦNG 1: `MACRO WATERFALL PIPELINE` (Sơ đồ 7 Trạm Thác Nước Cơ Khí & AI)
Thay thế thanh strip `44px` cũ bằng một lưới **7 Node Cards lớn**, mỗi Card hiển thị:
- **Tên Trạm & Số thứ tự**
- **Tác nhân thực thi** (Script cơ khí hay Model AI)
- **Trạng thái + Bộ đếm giây `⏱ Ns`** (nếu đang ở trạm đó)
- **Thông số đầu ra thực tế**

Danh sách 7 Trạm trên Tầng 1:
1. **`0. Pre-Flight & Baseline`** (`orchestrator.mjs` + `:20128/v1/models`)
2. **`1. Router & Scope Lock`** (`roles.router` hoặc `Direct Lock (0-Token)`)
3. **`2. WRITER ENGINE`** (`roles.writer` — `Attempt <attempt>/<max_retries>` | `<search_block_count> blocks`)
4. **`3. Applier (8-Step Guard)`** (`scripts/applier.mjs` — Path Traversal, Locked Scope, Atomic `.tmp`)
5. **`4. Validator Gate`** (`scripts/validator.mjs` — `Fast Check` + `Scoped Test Suite`, kèm **đường vòng `Bounded Retry Loop`** nối ngược về `2. Writer` khi `attempt > 1`)
6. **`4b. Tech Lead Review`** (`roles.reviewer` — hiển thị rõ `SKIPPED (0-Token Gate)` khi `risk_level < review_min_risk_level`)
7. **`5. Git Guard & Final State`** (`scripts/git-guard.mjs` — hiển thị mã commit `<7 ký tự commit_hash>` và trạng thái `DONE ✓` hoặc `Scoped Rollback Executed`)

##### TẦNG 2: `MICRO WRITER & VERIFICATION SUB-FLOW` (Mô phỏng chi tiết Luồng Nội Bộ của Writer)
Ngay bên dưới Tầng 1 là khung phóng đại chi tiết bên trong Trạm **Writer & Cổng Kiểm Tra**, gồm **4 Node bước tuần tự**:
- **Bước 2.1: `Context & Rules Assembly`** (`live_status.scope_files.length` file + luật `TAB (\t) Only`, `Zero New Deps`, `Bounded Timeout`, `Strict Scope`)
- **Bước 2.2: `Retry & Traceback Injection`** (`First Pass` nếu `attempt <= 1`; `Retry Pass #<attempt> — Injected Failure Tail` nếu `attempt > 1`)
- **Bước 2.3: `9Router LLM Generation`** (`model_requested` vs `model_responded` + `prompt_tokens` $\rightarrow$ `completion_tokens`)
- **Bước 2.4: `Contract & Truncation Guard`** (`finish_reason` + `<search_block_count> SEARCH/REPLACE blocks` trên `target_files`)

---

## 4. Checklist Nghiệm Thu cho Designer & FE Dev (`Acceptance Criteria v3.0`)

- [ ] **AC-1 (Tách biệt Nhân sự AI & Cơ khí Thác nước):** Khung `AI SQUAD MODELS` ở cột trái chỉ chứa 4 Agent AI (`IDE Coordinator`, `Planner/Router`, `Core Writer`, `Tech Lead Reviewer`). `Applier`, `Validator`, `Git Guard` nằm hoàn toàn trên sơ đồ `Macro Waterfall Pipeline`.
- [ ] **AC-2 (Giao diện 2 Tab ở Khung Chính Phải Trên):** Tab 1 (`🌊 Waterfall & Writer Flow`) mở mặc định với **Tầng 1 (7 trạm Macro Waterfall + Retry Loop)** và **Tầng 2 (4 bước Micro Sub-Flow của đội Writer)**; Tab 2 (`📄 Raw Output & Error Inspector`) chứa nội dung `attempt-N.txt` và full traceback.
- [ ] **AC-3 (Sửa dứt điểm Đồng hồ chạy vô tận `53553s`):** Khi `orchestrator.running === false` hoặc `current_stage` là `'idle'` / `'done'` / `'blocked'`, đồng hồ hiển thị thời gian tĩnh `task_completed_at - task_started_at`.
- [ ] **AC-4 (Không báo lỗi giả khi Task đã Retry thành công):** Khi `task_final_status === 'done'` (`last_error === null`), ẩn khung đỏ `LAST ERROR` và hiện trạng thái `Recovered on Attempt 2/3`.
- [ ] **AC-5 (100% Anti-XSS & Read-Only):** Toàn bộ dữ liệu động render qua `.textContent` / DOM APIs, tuyệt đối không dùng `.innerHTML`.
