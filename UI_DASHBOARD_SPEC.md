# Bản Đặc Tả Kỹ Thuật & Giao Diện: Orchestrator Read-Only Live Monitor (v3.0 — 9Router Neural Node Graph Edition)

- **Document ID:** `SPEC-ORCHESTRATOR-UI-V3.0`
- **Target Files:**
  - Frontend UI: [`agent-team/ui/index.html`](file:///d:/tool-download/agent-team/ui/index.html)
  - Read-Only Telemetry Server: [`agent-team/scripts/dashboard.mjs`](file:///d:/tool-download/agent-team/scripts/dashboard.mjs)
  - Visual Reference Image: `agent-team/ui/reference-9router-graph.png`
- **Triết lý Cốt lõi:**
  1. **Read-Only Telemetry & Zero Fake Data:** Chỉ hiển thị dữ liệu thật từ `/api/snapshot`. Không bịa dữ liệu giả.
  2. **Tách biệt "Cơ khí Thác nước (`Waterfall Pipeline`)" và "Mạng lưới Trí tuệ AI (`9Router Neural Node Graph`)":**
     - Quy trình cơ khí (`0. Pre-Flight` $\rightarrow$ `1. Router` $\rightarrow$ `2. Writer` $\rightarrow$ `3. Applier` $\rightarrow$ `4. Validator` $\rightarrow$ `4b. Review` $\rightarrow$ `5. Git` $\rightarrow$ `6. Done`) là **Thanh Trạng Thái Thác Nước (Waterfall Stage Bar)** nằm phía trên.
     - Còn **Trái tim của màn hình chính (Tab 1 - Mặc định)** là **Bản Đồ Node Mạng Lưới AI (`9Router Live AI Topology Canvas`)** lấy cảm hứng trực tiếp từ giao diện Node Graph của **9Router**: đặt **`[9] 9Router`** ở tâm lưới, nối bằng đường cong SVG Bezier tới các Node AI xung quanh để người dùng nhìn một phát biết ngay **Model AI nào đang thức, đang nhận bao nhiêu token qua 9Router, và đang làm nhiệm vụ gì!**

---

## 1. Bốn Nâng Cấp Đột Phá Của Bản v3.0 (So Với v2.0/v2.1)

| # | Vấn đề ở bản cũ | Giải pháp Thiết kế ở Bản v3.0 (9Router Node Graph Edition) |
| :--- | :--- | :--- |
| **1** | **Khung chữ thô `Writer Raw Output` chiếm hết trung tâm màn hình**, trong khi người dùng muốn nhìn thấy trực quan **Model AI nào đang chạy và làm gì**. | Đưa **`🕸️ 9Router AI Topology & Waterfall Canvas`** lên làm **Tab 1 (Mặc định, chiếm trọn khung chính phải trên)**. Đẩy `📄 Raw Output & Diff Inspector` sang **Tab 2** (chỉ mở khi cần soi code `<<<<<<< SEARCH`). |
| **2** | **Mô tả luồng AI bằng chữ khô khan**, khó cảm nhận sự kết nối giữa Orchestrator, 9Router và các nhà cung cấp / model AI. | Dựng **Canvas Lưới Đen (`32px x 32px` Grid Background)** chuẩn phong cách **9Router**: Node **`[9] 9Router (:20128)`** nằm ở trung tâm (viền cam phát sáng `#f97316`), nối bằng **đường cong SVG Bezier (`<svg><path>`)** tới các Node AI vệ tinh xung quanh (`Dev Cá Voi / DeepSeek V4.1`, `Kiro AI / Sonnet 4.5`, `Antigravity / Opus 5.5`, `Orchestrator Caller`). Khi model nào chạy, **đường dây SVG nối từ `9Router` sang Node đó phát sáng màu Cam/Vàng và có hạt xung (pulse) chạy dọc dây!** |
| **3** | **Nhập nhằng giữa Nhân sự AI (`Squad Models`) và Script cơ khí (`Applier`, `Validator`, `Git Guard`)**. | Cột trái (`AI SQUAD ROSTER`) chỉ liệt kê thuần khiết **4 vị trí Nhân sự AI** kèm chức danh, tên model và điều kiện kích hoạt (`Trigger` / `Gate`). Các bước cơ khí (`Applier`, `Validator`, `Git Guard`) nằm trên **Thanh Thác Nước (Waterfall Bar)** và gắn với Node `Orchestrator`. |
| **4** | **Đồng hồ chạy vô tận (`53553s`) khi `idle` & Báo lỗi đỏ giả của Attempt 1 sau khi Attempt 2 đã `done`**. | Khi `orchestrator.running === false` hoặc `current_stage` là `'idle'` / `'done'`, đồng hồ chốt thời gian hoàn thành thực tế (`task_completed_at - task_started_at`, VD: `⏱ 1m 37s`). Khi task đã `done`, ẩn banner đỏ cũ và hiện huy hiệu xanh `Recovered on Attempt 2/3`. |

---

## 2. Kiến Trúc Bố Cục & Bản Đồ Node 9Router (Bento Obsidian v3.0)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. TOP BAR (52px cố định)                                                                                  │
│ [⚡ 9Router Orchestrator v3.0] [Project: tool-download-stable] │ [Stage: IDLE] [9Router :20128 ● 18ms]     │
│                                                                │ [PID: IDLE] [Tokens: 789.7k↑ | 422.9k↓]   │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. WATERFALL PIPELINE BAR (54px — Các trạm cơ khí thác nước + Vòng lặp Retry + Đồng hồ tại trạm active)    │
│ [0.Pre-Flight ✓] ➔ [1.Router —] ➔ [2.Writer ✓ (Att 2/3)] ➔ [3.Applier ✓] ➔ [4.Validator ✓]                 │
│                                      ▲────── ↻ Auto-Retry Loop (1 used) ──────┘                            │
│                                                           ➔ [4b.Review (Skip)] ➔ [5.Git ✓] ➔ [6.DONE ✓]    │
├───────────────────────────────────────────────┬────────────────────────────────────────────────────────────┤
│ 3. CỘT TRÁI (370px cố định, cuộn độc lập)     │ 4. CỘT PHẢI TRÊN (62% chiều cao phải — Vùng Tab Trung Tâm) │
│                                               │                                                            │
│ ┌─ A. ACTIVE / LAST TASK & LOCKED SCOPE ────┐ │ ┌─ TAB HEADER BAR ───────────────────────────────────────┐ │
│ │ T-2026-11-01-012          [ATTEMPT 2 / 3] │ │ │ [🕸️ 1. 9Router AI Live Topology (Active)]              │ │
│ │ [STATUS: DONE ✓] [MODE: QUICK] [RISK: LOW]│ │ │ [📄 2. Raw Output & Diff Inspector (6 KB | stop)]      │ │
│ │ Duration: ⏱ 1m 37s (Recovered on Retry 1) │ │ └────────────────────────────────────────────────────────┘ │
│ │ Goal: Nâng cấp inpaint_ai trong core/...  │ │ ┌─ TAB 1: 9ROUTER AI NODE GRAPH CANVAS (Grid 32x32px) ───┐ │
│ │ Locked Scope (2 files):                   │ │ │  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  │ │
│ │  • core/eraser.py             [VALIDATED] │ │ │                   ┌──────────────────────────┐         │ │
│ │  • tests/test_eraser.py       [VALIDATED] │ │ │                   │ [OP] Dev Cá Voi (Writer) │         │ │
│ └───────────────────────────────────────────┘ │ │                   │ DeepSeek V4.1 Flash      │         │ │
│                                               │ │                   │ ● DONE (41.5k ➔ 2.2k tok)│         │ │
│ ┌─ B. AI SQUAD MODELS (CHỈ NHÂN SỰ AI) ─────┐ │ │                   └────────────┬─────────────┘         │ │
│ │ ⚡ Antigravity (IDE Coordinator)  [ONLINE] │ │ │                                ║ (Đường cong SVG sáng) │ │
│ │   Architect, UI & Task Coordinator        │ │ │  ┌───────────────────┐    ╔════╩══════════╗    ┌───────┴──────────────┐ │
│ │                                           │ │ │  │ [⚙️] Orchestrator │═══►║ [9] 9Router   ║───►│ [👻] Kiro AI (Router)│ │
│ │ 🧭 Kiro AI / Sonnet 4.5            [IDLE] │ │ │  │ Task: T-012 (Att2)│    ║ :20128 • 18ms ║    │ Claude Sonnet 4.5 Th │ │
│ │   Model: kr/claude-sonnet-4.5-thinking    │ │ │  │ Gate: Applier/Val │    ╚════╤══════════╝    │ ○ IDLE (Quick Mode)  │ │
│ │   Role: Scope Router & UI Designer        │ │ │  └───────────────────┘         │               └──────────────────────┘ │
│ │                                           │ │ │                                │ (Đường cong SVG mờ)   │ │
│ │ ✍️ Dev Cá Voi / DeepSeek V4.1      [DONE] │ │ │                   ┌────────────┴─────────────┐         │ │
│ │   Model: Deepseek V4.1 Flash/...          │ │ │                   │ [A] Antigravity (Opus)   │         │ │
│ │   Role: Autonomous Code Writer            │ │ │                   │ Claude Opus 5.5 High     │         │ │
│ │   Last: 41.5k in → 2.2k out | stop ✓      │ │ │                   │ — SKIPPED (Risk: LOW)    │         │ │
│ │                                           │ │ │                   └──────────────────────────┘         │ │
│ │ 🔍 Antigravity / Opus 5.5       [SKIPPED] │ │ │  + Thanh trạng thái dưới đáy Canvas:                   │ │
│ │   Model: ag/claude-opus-5-5-high          │ │ │  [Model Match: ✓] [Finish: stop] [Blocks: 2] [Commit]  │ │
│ │   Role: High-Risk Tech Lead Reviewer      │ │ └────────────────────────────────────────────────────────┘ │
│ └───────────────────────────────────────────┘ ├────────────────────────────────────────────────────────────┤
│ ┌─ C. TASK QUEUE & ARCHIVE ─────────────────┐ │ 5. CỘT PHẢI DƯỚI: LIVE CONSOLE LOGS (38% chiều cao phải)   │
│ │ [ Active: 0 ] [ Done: 16 ] [ Blocked: 0 ] │ │ ┌────────────────────────────────────────────────────────┐ │
│ │  ✓ T-2026-11-01-012  [28a30b1]   Retry: 1 │ │ │ [Filter logs...]                    [⏸ Pause] [Clear] │ │
│ │  ✓ T-2026-11-01-011  [e56987c]   Retry: 0 │ │ │ 23:40:25 [INFO] [START] T-2026-11-01-012 | Mode: quick │ │
│ └───────────────────────────────────────────┘ │ └────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────┴────────────────────────────────────────────────────────────┘
```

---

## 3. Đặc Tả Thị Giác & Kỹ Thuật Cho "9Router AI Node Graph Canvas" (Dành cho Designer & FE Dev)

Để Designer (`designer_claude`) và FE Dev dựng chuẩn xác 100% giao diện giống bức ảnh mẫu `agent-team/ui/reference-9router-graph.png` của 9Router mà không cần đoán mò, dưới đây là thông số CSS & SVG chính xác:

### 3.1. Nền Lưới Không Gian (`Canvas Grid Background`)
- Nền tối `#121215` với lưới ô vuông mảnh `32px × 32px`:
  ```css
  .topology-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 320px;
    background-color: #121215;
    background-image:
      linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 32px 32px;
    overflow: hidden;
  }
  ```

### 3.2. Cấu Trúc Thành Viên Standard Workflow (Không Bịa, Đúng Tên Model)
Canvas Tab 1 phản ánh chân thực chu trình làm việc **Standard Workflow (Interconnected Multi-Model Mesh)**. Tuyệt đối không bịa tên, chỉ sử dụng đúng tên model và thành phần kỹ thuật thực tế trong squad:

1. **`Claude Sonnet 4.5 Thinking` `(x: 15%, y: 50%)` — Plan, Scope & UI/UX Spec:**
   - **Form dáng:** Capsule tối `#18181b`, icon `S` tím `#4c1d95`.
   - **Vai trò:** Lập kế hoạch, phân tích yêu cầu, bóc tách scope và định hình spec giao diện.
2. **`Gemini 3.8 Flash` `(x: 44%, y: 22%)` — Frontend Writer & IDE Pair:**
   - **Form dáng:** Capsule tối `#18181b`, icon `G` xanh lam `#172554`.
   - **Vai trò:** Lập trình viên Frontend, sinh code UI/CSS/HTML, tương tác trực tiếp với user tại IDE Antigravity.
3. **`DeepSeek V4.1 Flash` `(x: 44%, y: 78%)` — Backend Writer & Search-Replace Engine:**
   - **Form dáng:** Capsule tối `#18181b`, icon `D` xanh cyan `#082f49`.
   - **Vai trò:** Lập trình viên Backend, xử lý thuật toán `core/**`, sinh các khối `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`.
4. **`Validator Guard` `(x: 70%, y: 50%)` — Feedback Loop & Test Gate:**
   - **Form dáng:** Capsule tối `#18181b`, icon `🛡️` xanh lục `#064e3b`.
   - **Vai trò:** Kiểm định nội bộ của Writer (`validator.mjs`): chạy `test_indentation.py` (100% TAB), `pytest`. Nếu tạch, bắn lỗi Traceback ngược lại cho Writer sửa lại ở Attempt 2/3.
5. **`Claude Opus 5.5 High` `(x: 89%, y: 50%)` — Tech Lead Reviewer:**
   - **Form dáng:** Capsule tối `#18181b`, icon `O` xanh tím `#1e1b4b`.
   - **Vai trò:** Giám định viên cấp cao, thẩm tra `git diff` các task rủi ro cao trước khi cho phép Git Guard commit.

### 3.3. Dây Nối Trực Tiếp Theo Chu Trình Standard Workflow (`Interconnected SVG Paths`)
Tầng `<svg viewBox="0 0 800 360">` vẽ các tuyến kết nối trực tiếp giữa các thành viên:
- **Sonnet 4.5 $\rightarrow$ Gemini 3.8 Flash:** `d="M 180 180 C 260 180, 270 80, 350 80"` (Giao việc Frontend/UI)
- **Sonnet 4.5 $\rightarrow$ DeepSeek V4.1 Flash:** `d="M 180 180 C 260 180, 270 280, 350 280"` (Giao việc Backend/Core)
- **Gemini 3.8 Flash $\rightarrow$ Validator Guard:** `d="M 450 80 C 530 80, 540 180, 620 180"` (Kiểm tra mã nguồn Frontend)
- **DeepSeek V4.1 Flash $\rightarrow$ Validator Guard:** `d="M 450 280 C 530 280, 540 180, 620 180"` (Nộp Search/Replace blocks)
- **Validator Guard $\rightarrow$ DeepSeek V4.1 Flash (Feedback Loop):** `d="M 620 190 C 550 230, 520 310, 440 290"` (Báo lỗi Traceback để DeepSeek sửa lại ở Attempt 2/3)
- **Validator Guard $\rightarrow$ Claude Opus 5.5 High:** `d="M 640 180 C 670 180, 680 180, 710 180"` (Khi test xanh $\rightarrow$ chuyển Tech Lead thẩm định)

---

## 4. Thanh Trạng Thái Dưới Đáy Canvas & Tab 2 (`Raw Output Inspector`)

1. **Thanh Telemetry Footer ngay dưới chân Canvas (trong Tab 1):**
   Hiển thị 4 chip dữ liệu thật bóc từ `latest_output` và `live_status`:
   - `Model Verification`: `Req == Resp ✓` (hoặc tên model thật trong `attempt-N.txt`)
   - `Finish Reason`: `stop ✓ (No Truncation)`
   - `Patch Payload`: `<search_block_count> SEARCH/REPLACE blocks → <target_files.join(', ')>`
   - `Retry Status`: `Attempt <attempt>/<max_retries>` (nếu `recovered_on_retry === true` thì hiện `✓ Auto-Recovered on Retry #<attempt - 1>`)
2. **Tab 2 (`📄 Raw Output & Error Inspector`):**
   - Giữ nguyên trình xem nội dung file `state/runs/<task_id>/attempt-N.txt` và full traceback khi người dùng bấm sang Tab 2.

---

## 5. Checklist Nghiệm Thu cho Designer & FE Dev (`Acceptance Criteria v3.0`)

- [ ] **AC-1 (9Router Live Node Graph ở Tab 1):** Dựng chuẩn Canvas lưới tối `32×32px` với `[9] 9Router` ở tâm và 4 Node xung quanh (`[OP] Dev Cá Voi - Writer`, `[👻] Kiro AI - Router`, `[A] Antigravity - Reviewer`, `[▢] Orchestrator`), nối bằng đường cong SVG Bezier phát sáng động theo stage/model.
- [ ] **AC-2 (Tách biệt Nhân sự AI & Cơ khí Thác nước):** Cột trái `AI SQUAD MODELS` chỉ chứa 4 Agent AI. Các trạm cơ khí (`Applier`, `Validator`, `Git Guard`) hiển thị trên thanh `Waterfall Pipeline Bar` (kèm chỉ báo `↻ Auto-Retry Loop`).
- [ ] **AC-3 (Tab 2 cho Raw Output):** Đẩy khung `Writer Raw Output` sang Tab 2 để nhường không gian chính cho Sơ đồ Node AI ở Tab 1.
- [ ] **AC-4 (Sửa Đồng hồ chạy vô tận & Xóa lỗi cũ sau khi Retry thành công):** Khi `idle`/`done`, đồng hồ hiển thị thời gian tĩnh `task_completed_at - task_started_at` (không đếm lên `53553s`), và không hiện banner lỗi đỏ cũ khi `task_final_status === 'done'`.
- [ ] **AC-5 (100% Anti-XSS & Read-Only):** Toàn bộ dữ liệu động gán qua `.textContent` / DOM APIs, tuyệt đối không dùng `.innerHTML`.
