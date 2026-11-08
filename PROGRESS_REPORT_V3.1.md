# Báo Cáo Tiến Độ & Thành Tựu: Agent-Team Runtime v3.1 (Antigravity-Parity & Universal Squad Engine)

> **Cập nhật lần cuối:** `2026-11-08`  
> **Trạng thái:** ✅ **HOÀN THÀNH 100% (Batch A, B, C, D — Toàn bộ Test Suites PASS 100%)**  
> **File đặc tả gốc:** [`agent-team/RUNTIME_PAYLOAD_SPEC.md`](file:///d:/tool-download/agent-team/RUNTIME_PAYLOAD_SPEC.md)

---

## 1. Tổng Quan Mục Tiêu Đạt Được

Từ kết quả giải phẫu HTTP POST thực tế của Antigravity (`STRUCTURE.md`) và các phản biện kiến trúc từ TechLead độc lập, hệ thống **`agent-team/`** đã được nâng cấp toàn diện lên **v3.1** với 2 trụ cột lớn:

1. **Antigravity-Parity Payload & Token Optimization (G1 $\rightarrow$ G5):**
   - Kẹp cứng đầu ra công cụ đọc file (`MAX_READ_LINES = 300`, `MAX_READ_BYTES = 32KB`) không gây lỗi giả.
   - Bảo toàn `thought_signature` & `provider_specific_fields` qua 9Router SSE/JSON; tự động bóc bỏ `reasoning_content` thô ở chiều gửi đi (Outbound Request) để tránh lỗi `HTTP 400` trên các gateway nghiêm ngặt.
   - Nén lịch sử hội thoại theo mốc `32,000 tokens` (`Epoch Watermark Compaction`) để giữ nguyên prefix bất biến, kết hợp gắn 3 mốc `cache_control: { type: 'ephemeral' }` (`tools`, `system`, `messages[1]`).
   - Chuẩn hóa đo lường `cached_tokens` và `cache_hit_ratio` đa nhà cung cấp (Anthropic, OpenAI/DeepSeek, Gemini) lên thẳng thanh Top Bar của Dashboard `:4310`.

2. **100% Project-Agnostic `Task-Demand × Squad-Roster` Engine (G6):**
   - **Tách bạch hoàn toàn khỏi `tool-download`:** Không còn bất kỳ đường dẫn cứng (`core/`, `ui_bridge/`, `ui_web/`) nào trong `agent-team/runtime/`, `agent-team/roles/router.md`, hay `agent-team/scripts/`. Mọi dự án (Node.js, Python, Go, Rust, React...) đều tự động nhận diện qua `policy.yaml` hoặc phần mở rộng file.
   - **Định tuyến 0-Token bằng toán học (`Task-Demand × Squad-Roster`):** Tự động đối chiếu **Task cần gì** (`hasBackend`, `hasFrontend`, `isCrossDomain`, `needsDesignSpec`, `needsTechSpec`, `needsIndependentReview`) với **Đội hình đang bật có ai** (`resolveSquadRoster`) để sinh luồng thực thi tối ưu.

---

## 2. Chi Tiết 4 Batch Đã Triển Khai & Nghiệm Thu

### ✅ Batch A — Tool Clamping, Signature Passthrough & Usage Telemetry
| Hạng mục | File đã nâng cấp | Kết quả kỹ thuật |
| :--- | :--- | :--- |
| **G1. Clamping `read_file`** | [`agent-team/runtime/tool-runtime.mjs`](file:///d:/tool-download/agent-team/runtime/tool-runtime.mjs) | Kẹp `MAX_READ_LINES = 300`, `MAX_READ_BYTES = 32768`, `MAX_SINGLE_LINE_CHARS = 4096`. Tự động nối `[Showing lines X-Y of Z. Call read_file with start_line=Y+1...]` thay vì văng lỗi. |
| **G2. Signature & Reasoning Safety** | [`agent-team/runtime/provider-gateway.mjs`](file:///d:/tool-download/agent-team/runtime/provider-gateway.mjs) | Lưu `thought_signature` và `provider_specific_fields` từ response/SSE; tự động lọc bỏ `reasoning_content` khỏi mảng `messages` gửi đi để tương thích 100% với mọi provider trên 9Router. |
| **G5. Multi-Turn Usage & Cache Ratio** | [`agent-team/runtime/provider-gateway.mjs`](file:///d:/tool-download/agent-team/runtime/provider-gateway.mjs), [`agent-team/runtime/index.mjs`](file:///d:/tool-download/agent-team/runtime/index.mjs) | Hàm `normalizeUsage()` bóc tách `cached_tokens` từ `prompt_tokens_details.cached_tokens`, `cache_read_input_tokens`, `cachedContentTokenCount` và cộng dồn xuyên suốt mọi lượt tool-calling trong `runAgent()`. |

### ✅ Batch B — Epoch Compaction (`32k` Watermark) & 3-Breakpoint Prompt Caching
| Hạng mục | File đã nâng cấp | Kết quả kỹ thuật |
| :--- | :--- | :--- |
| **G3. Epoch Compaction** | [`agent-team/runtime/session-store.mjs`](file:///d:/tool-download/agent-team/runtime/session-store.mjs) | Chỉ nén khi `estTokens > 32000` (`useEpochWatermark: true`), bảo toàn prefix tĩnh ở các turn ngắn để không phá vỡ Prompt Cache của LLM. Tự động dọn thẻ `<thinking>` cũ bằng `stripOldInlineThinking()`. |
| **G4. 3-Breakpoint Cache Control** | [`agent-team/runtime/provider-gateway.mjs`](file:///d:/tool-download/agent-team/runtime/provider-gateway.mjs) | Hàm `applyCacheBreakpoints()` tự động gắn `cache_control: { type: "ephemeral" }` tại 3 điểm neo tĩnh: định nghĩa `tools` cuối cùng, `system` prompt, và `messages[1]` (task goal + repo-map). |

### ✅ Batch C — Universal `Task-Demand × Squad-Roster` Engine & Multi-Bucket Orchestrator
| Hạng mục | File đã nâng cấp | Kết quả kỹ thuật |
| :--- | :--- | :--- |
| **4 Quy tắc bất biến (Invariants)** | [`agent-team/scripts/lib/risk-policy.mjs`](file:///d:/tool-download/agent-team/scripts/lib/risk-policy.mjs) | **1. No Ghost Role:** Không gọi role bị tắt. **2. No Irrelevant Domain:** Task thuần Backend không bao giờ gọi `Designer`. **3. Anti-Self-Spec / Anti-Self-Review:** Không tự viết spec hoặc tự review chính mình (`reviewerModel === writerModel` $\rightarrow$ skip). **4. Auto-Collapse:** Cùng 1 model kiêm nhiệm 2 bước liên tiếp $\rightarrow$ tự gộp thành 1 bước. |
| **Sửa các điểm nghẽn từ phản biện TechLead** | [`agent-team/scripts/lib/risk-policy.mjs`](file:///d:/tool-download/agent-team/scripts/lib/risk-policy.mjs), [`agent-team/scripts/goal-planner.mjs`](file:///d:/tool-download/agent-team/scripts/goal-planner.mjs), [`agent-team/scripts/applier.mjs`](file:///d:/tool-download/agent-team/scripts/applier.mjs) | • Dùng `resolveEffectiveRisk(task)` (`max(declared, computed)`) chống LLM khai báo hạ cấp rủi ro.<br>• Tự động nâng `risk_level` lên `high` cho các file manifest thư viện phổ quát (`package.json`, `requirements.txt`, `pyproject.toml`, `cargo.toml`, `go.mod`, `dockerfile`).<br>• Chặn khối `SEARCH/REPLACE` bị cụt giữa chừng (`blocks.dangling`) ngay trong `applier.mjs` kể cả khi provider không trả `finish_reason="length"`.<br>• Regex ý định giao diện tiếng Việt chuẩn hóa NFC + Unicode lookaround `(?<![\p{L}\p{N}_])...(?![\p{L}\p{N}_])`.<br>• Bước `Designer` nhận `inputs: [techArtifact]` từ `TechLead` để đồng bộ hợp đồng dữ liệu.<br>• Hàm `verifyPlannedScope()` kiểm tra file tồn tại & cảnh báo thiếu file UI bằng 0-token trước khi chạy. |
| **Multi-Bucket Execution & Live AST Bridge** | [`agent-team/scripts/orchestrator.mjs`](file:///d:/tool-download/agent-team/scripts/orchestrator.mjs), [`agent-team/runtime/repo-map.mjs`](file:///d:/tool-download/agent-team/runtime/repo-map.mjs) | Hỗ trợ chạy tuần tự nhiều bucket `apply_patch`: **Step 2A (Backend Writer)** sửa và ghi đĩa $\rightarrow$ trích xuất chữ ký hàm thực tế vừa viết bằng `generateRepoMap(inject_updated_repo_map_from)` $\rightarrow$ bơm vào **Step 2B (Frontend Writer)** để khớp 100% API contract. |
| **Selective Host Project Rules Loader (`<project_conventions>`)** | [`agent-team/scripts/lib/context-builders.mjs`](file:///d:/tool-download/agent-team/scripts/lib/context-builders.mjs), [`agent-team/runtime/index.mjs`](file:///d:/tool-download/agent-team/runtime/index.mjs) | Hàm `loadProjectConventions()` + `sanitizeProjectRules()` tự động dò tìm (`policy.project_rules` $\rightarrow$ `AGENTS.md`, `CLAUDE.md`, `RULES.md`, `RULE.md`, `.cursorrules` $\rightarrow$ `.agents/rules/*.md`), lọc bỏ các mục quy trình IDE/Git gây xung đột, bọc trong khóa `[ORCHESTRATOR PRECEDENCE OVERRIDE]` và gắn vào `system` prompt (Cache Breakpoint #2). Nếu dự án không có file rule thì bỏ qua êm ái (`''`). |

### ✅ Batch D — Interactive Cockpit Preset Selector & Cache Hit Telemetry (`:4310`)
| Hạng mục | File đã nâng cấp | Kết quả kỹ thuật |
| :--- | :--- | :--- |
| **Dropdown Chọn Chế Độ Luồng (`#sel-workflow-preset`)** | [`agent-team/ui/layouts/layout-central-stage.html`](file:///d:/tool-download/agent-team/ui/layouts/layout-central-stage.html), [`agent-team/ui/js/app.js`](file:///d:/tool-download/agent-team/ui/js/app.js), [`agent-team/scripts/server/routes-tasks.mjs`](file:///d:/tool-download/agent-team/scripts/server/routes-tasks.mjs) | Cho phép chọn trực tiếp trên giao diện Cockpit: `🤖 Auto Policy (Task-Demand × Squad)`, `⚡ Fast 1-Step Coder`, `🏛️ Architect / Designer Spec + Coder`, hoặc `🔍 Consult Only`. |
| **Hiển thị Luồng Writer Hub & Cảnh báo Scope trên Thẻ Task** | [`agent-team/ui/js/app.js`](file:///d:/tool-download/agent-team/ui/js/app.js), [`agent-team/scripts/server/state-reader.mjs`](file:///d:/tool-download/agent-team/scripts/server/state-reader.mjs) | Mỗi thẻ Draft Task hiển thị rõ chuỗi bước thực thi (VD: `🧭 Luồng Writer Hub: Spec[designer] ➔ Patch(frontend)[writer]`) và cảnh báo `scope_warnings` (nếu có) qua `.textContent` (Zero-Trust Anti-XSS). |
| **Đo lường `Cache: X%` trên Top Bar (`#tok-cache`)** | [`agent-team/ui/layouts/layout-header.html`](file:///d:/tool-download/agent-team/ui/layouts/layout-header.html), [`agent-team/scripts/orchestrator.mjs`](file:///d:/tool-download/agent-team/scripts/orchestrator.mjs) | Tính toán `session_cached` và `cache_hit_pct` thời gian thực từ `live-status.json` và hiển thị trực tiếp tại pill `#pill-tokens` trên thanh Header. |

---

## 3. Kết Quả Kiểm Thử Tự Động (Verification Matrix)

Toàn bộ các bộ kiểm thử của `agent-team/` đã được chạy và vượt qua 100%:

- `node agent-team/scripts/test-runtime-v3.mjs` $\rightarrow$ **PASS 100% (7/7 bộ test lớn, bao gồm Ma trận 5 đội hình × 4 loại task & 4 quy tắc bất biến)**
- `node agent-team/scripts/test-applier-v2.1.mjs` $\rightarrow$ **PASS 100% (12/12 bài test bảo mật Applier, Risk Policy & Anti-Self-Review)**
- `node agent-team/scripts/test-cockpit.mjs` $\rightarrow$ **PASS 100% (8/8 bài test Dashboard API, CSRF Guard, Preset Selector & Cache Hit Telemetry)**
- `node agent-team/scripts/validator.mjs fast` $\rightarrow$ **`{"ok": true}` (PASS 100%)**
