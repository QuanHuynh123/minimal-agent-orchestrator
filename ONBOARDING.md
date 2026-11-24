# 🧭 Sổ Tay Khởi Tạo & Vận Hành Chuẩn (Onboarding Standard v3.1)

> **Câu chốt Triết lý & Kiến trúc Cốt lõi (Golden Rule):**  
> *"Mini-Orchestrator là chiếc Khuôn Gá (Jig / Lồng 0-Token) giúp tận dụng các model giá rẻ/free qua `9router` chạy tự động nhiều task (kể cả qua đêm) mà không làm nát dự án: `Router` cắt việc thật nhỏ (`<= 2–3 file`) ➔ ghép `1 Model Giỏi` (ra bản vẽ/hợp đồng) kèm `1 Model Thợ` (chỉ làm đúng 1 việc sửa code trong `scope` hẹp) ➔ khóa ngoài bằng `Applier + Validator + Git Guard`. Tối ưu `Task Success / Token`, cấm Over-Engineering kiểu Enterprise."*

Tài liệu này được tách bạch thành **2 Phần độc lập**:
- **[Phần 1: Hướng Dẫn Nhanh Dành Cho Kỹ Sư / Con Người (Human Quickstart)](#phần-1-hướng-dẫn-nhanh-dành-cho-kỹ-sư--con-người)**
- **[Phần 2: Phụ Lục Chỉ Thị Dành Cho AI IDE Agent (AI Planner & Intake Protocol)](#phần-2-phụ-lục-chỉ-thị-dành-cho-ai-ide-agent)**

---

# Phần 1: Hướng Dẫn Nhanh Dành Cho Kỹ Sư / Con Người

Dành cho nhà phát triển mới clone thư mục `agent-team` vào dự án của mình và muốn bắt đầu làm việc ngay trong vòng 2 phút.

## 1. Cài đặt & Kiểm thử (30 giây)

Mở Terminal tại thư mục `agent-team` và chạy:
```bash
git clone https://github.com/QuanHuynh123/minimal-agent-orchestrator.git agent-team
cd agent-team
npm install
npm test
```
*   **Kiểm thử hoàn toàn Offline 0-Token:** Nếu chưa bật Router/LLM, chạy `npm run test:offline` để kiểm tra trọn vẹn 2 bộ lõi `Applier` và `Runtime v3` mà không tiêu tốn token nào.
*   **Kiểm thử Đầy đủ:** `npm test` sẽ chạy thêm bộ kiểm tra Web Cockpit server & CSRF security (kèm 1 ping nhỏ kiểm tra kết nối Router nếu đang mở).

---

## 2. Cấu hình Tối thiểu 1 Model (1-Model Minimal Setup)

Bạn chỉ cần kiểm tra/chỉnh sửa đúng 2 file cấu hình đơn giản:

### A. Cổng kết nối LLM (`config/team.yaml`)
Hỗ trợ mọi nhà cung cấp chuẩn OpenAI-compatible (9Router, OpenRouter, DeepSeek, Ollama, vLLM):
```yaml
providers:
  local_9router:
    base_url: "http://127.0.0.1:20128/v1"
    api_key_env: "NINE_ROUTER_API_KEY"  # Hoặc "LLM_API_KEY"
roles:
  writer:
    model: "deepseek-ai/deepseek-v4.1-flash-1017" # Model chính của bạn
```
> **💡 Mô hình Phối hợp Thực Chiến (`1 Model Giỏi + 1 Model Thợ`):**
> - **Khi chỉ cấu hình 1 Model:** Các role khác (`router`, `architect`, `reviewer`) tự động kế thừa model của `writer` và tự thu gọn bước phụ (*Anti-Self-Play* & *Anti-Self-Review*) để không bắt 1 model tự viết spec cho chính nó đọc.
> - **Khi cấu hình chuẩn Khuyến nghị (`1 Giỏi + 1 Thợ`):** Bạn gán model mạnh (`Gemini` / `Claude Sonnet`) cho `router` / `architect` / `designer` để cắt việc nhỏ và viết đặc tả thật nét ở lượt đầu, còn `writer` dùng model giá rẻ/free có KV-cache tốt (`DeepSeek` / `Gemini Flash`) kèm `fallback_model` để gõ bản vá trong `scope` hẹp.

### B. Ranh giới, Quy Ước Dự Án & Bộ Kiểm Thử (`config/policy.yaml`)
Hệ thống chuẩn hóa **chỉ có đúng 2 file cấu hình** trong `config/` (`team.yaml` và `policy.yaml`). Toàn bộ ranh giới thư mục, file được bảo vệ, domain patterns và lệnh kiểm thử tự động được quản lý tập trung trong `config/policy.yaml`:
```yaml
policy:
  project_id: "my-project"
  language: "typescript"

  scope_control:
    allowed_dirs:
      - "src/"         # Thư mục chứa mã nguồn được phép sửa
      - "tests/"       # Thư mục chứa bài test
    protected_files:
      - "package.json" # File nhạy cảm cấm AI tự ý sửa

  validation:
    fast_checks:
      - name: "unit_tests"
        run: "npm test" # Lệnh chạy test của dự án bạn (pytest, go test, npm test, etc.)
        timeout_sec: 30
```
> **📎 Tự động nạp Quy ước Dự án (`<project_conventions>`):** Nếu thư mục gốc dự án của bạn có sẵn các file quy chuẩn như `AGENTS.md`, `CLAUDE.md`, `RULES.md` hoặc `.agents/rules/*.md`, Orchestrator v3.1 sẽ tự động lọc lấy các quy tắc kỹ thuật/kiến trúc để nạp cho AI mà không cần cấu hình thêm.

---

## 3. Chọn Lối Vào Phù Hợp Với Nhu Cầu

Hệ thống cung cấp **2 Lối Vào Kiến Trúc** dùng chung 100% cấu hình:

| Tiêu chí | Lối vào 1: Standalone Agent Runtime | Lối vào 2: Autonomous Squad Orchestrator |
| :--- | :--- | :--- |
| **Bản chất** | **Agent đơn lẻ tương tác (Interactive Single Agent)** | **Quy trình thác nước tự động theo lô (Batch Workflow)** |
| **Lệnh chạy** | `npm run agent -- --role writer --prompt "..."` | `npm run dashboard` (Web) hoặc `npm start` (CLI) |
| **Giao diện** | CLI Terminal | Bàn điều khiển Web Cockpit (cổng đọc từ `policy.cockpit.port`, mặc định `4310`) |
| **Quyền ghi mã nguồn** | Ghi file qua `applier` **chỉ trong `scope` được bạn cấp**. | Ghi file qua `applier` kèm **tự động kiểm thử, sửa lỗi retry và commit Git**. |
| **Phù hợp nhất khi** | Cần hỏi đáp về repo, chẩn đoán bug, hoặc sửa 1 file cục bộ. | Cần giao một tính năng hoàn chỉnh từ ý tưởng đến kiểm thử tự động. |

### Cách dùng Lối vào 1: Standalone Agent Runtime
Gọi trực tiếp 1 Agent có công cụ tìm kiếm, đọc file, chạy lệnh shell và sửa file an toàn:
```bash
# Hỏi đáp / khảo sát code
npm run agent -- --role router --prompt "Giải thích luồng đăng nhập trong src/auth.py"

# Nhờ Agent sửa một file trong scope chỉ định
npm run agent -- --role writer --scope "src/auth.py" --prompt "Bổ sung kiểm tra độ dài mật khẩu tối thiểu 8 ký tự"
```

### Cách dùng Lối vào 2: Autonomous Cockpit & Orchestrator
#### Cách A: Dùng Web Cockpit (Khuyến nghị số 1 cho người mới)
```bash
npm run dashboard
```
1. Mở trình duyệt tại `http://127.0.0.1:<port>` theo cổng cấu hình trong `config/policy.yaml` -> `policy.cockpit.port` (mặc định `4310`, Phòng Điều Khiển Hình Sao - Star Topology Control Room).
2. Nhập mục tiêu tính năng hoặc câu hỏi tư vấn bằng ngôn ngữ tự nhiên, chọn chế độ định tuyến (`Auto: Task-Demand × Squad`, `Fast 1-Step`, `Spec + Coder`, hoặc `Consult Only`) $\rightarrow$ Bấm **`[Lập Kế Hoạch]`**.
3. AI Planner sẽ đọc codebase và tạo các task nháp ở trạng thái `draft_review`.
4. Bạn kiểm tra lại các file trong `scope` $\rightarrow$ Bấm **`[Duyệt & Chạy Ngay]`**. Hệ thống sẽ tự động đổi `draft_review` sang `ready`, điều phối các chuyên gia theo mô hình Hình Sao, chạy kiểm thử và báo cáo kết quả.

#### Cách B: Dùng CLI
```bash
# Bước 1: Bóc tách Goal thành Task YAML
npm run plan -- "Tích hợp tính năng xuất báo cáo PDF cho module billing"
# -> Lệnh này sẽ tạo file task trong thư mục tasks/active/ ở trạng thái an toàn 'draft_review'

# Bước 2 & 3: Phê duyệt và khởi động Orchestrator
# 🚀 Lựa chọn 1 (Nhanh nhất): Duyệt tự động và chạy ngay bằng cờ --approve (hoặc -y)
npm start -- --approve

# 🔍 Lựa chọn 2 (Kiểm tra thủ công): Mở file tasks/active/<task-id>.yaml, xem lại trường 'scope',
# đổi status: "draft_review" -> status: "ready", sau đó chạy:
npm start
```
> **💡 Nguyên tắc an toàn `draft_review`:** Mọi task sau khi sinh ra từ AI Planner đều ở trạng thái `draft_review` (chưa can thiệp code). Nếu bạn chạy `npm start` mà chưa duyệt, Orchestrator sẽ an toàn bỏ qua (skip) các task này và in lời nhắc hướng dẫn duyệt qua Dashboard hoặc chạy kèm cờ `--approve`.

---

# Phần 2: Phụ Lục Chỉ Thị Dành Cho AI IDE Agent

*(Dành riêng cho các trợ lý AI Chat trong IDE như Antigravity, Cursor, Cline, Claude Desktop... khi tham gia hỗ trợ lập kế hoạch).*

> **CHỈ THỊ HỆ THỐNG:**  
> Bạn đang đóng vai trò **Planner & Task Drafter** trong môi trường Chat. Khi người dùng yêu cầu bạn phân tích dự án, cải tiến bộ điều phối hoặc soạn task, bạn phải tuân thủ nghiêm ngặt **5 quy tắc** sau:

### Quy tắc 0: Hiểu Đúng Triết Lý Mini-Orchestrator (Cấm Over-Engineering)
- Hệ thống này sinh ra để **kẹp các AI model giá rẻ/free dễ trượt ngữ cảnh vào khuôn kỷ luật (`1 Model Giỏi chỉ đường + 1 Model Thợ gõ code + Lồng kiểm tra 0-Token`)**, không phải hệ thống SaaS/Production quy mô tập đoàn và cũng không giả lập công ty IT nhiều ban bệ (`BA ➔ DA ➔ BE ➔ FE`).
- Thước đo duy nhất đáng giá là **`Task Success / Token`** (chạy tự động qua đêm sáng dậy task hoàn thành thật, test xanh thật, không phá hỏng tính năng bên cạnh).
- **KHÔNG** đề xuất kiến trúc cồng kềnh, không bóp nghẹt độ dài bản vẽ của Model Giỏi chỉ để tiết kiệm vài xu quy đổi ảo, và luôn đối chiếu [`README.md`](README.md) cùng [`RUNTIME_PAYLOAD_SPEC.md`](RUNTIME_PAYLOAD_SPEC.md) trước khi đề xuất sửa đổi pipeline.

### Quy tắc 1: Cổng Thu Thập Thông Tin Bắt Buộc (Intake Gate)
Khi người dùng giao một bài toán lớn hoặc khởi tạo dự án mới, nếu thiếu bất kỳ thông tin cốt lõi nào dưới đây, bạn **BẮT BUỘC phải dừng lại hỏi người dùng** — **TUYỆT ĐỐI KHÔNG tự bịa tên model hay đoán bừa**:
1. **Đội ngũ AI (`config/team.yaml`):** Cổng kết nối (`base_url`), model chính xác cho `writer`.
2. **Ranh giới & Rào chắn Dự án (`config/policy.yaml`):** Thư mục nguồn (`allowed_dirs`), file cấm đụng (`protected_files`), lệnh chạy test tự động (`validation`).
3. **Mục tiêu & Nghiệm thu Task:** Nếu người dùng chỉ nói mục tiêu chung chung, bạn phải làm rõ đầu ra cụ thể và tiêu chí nghiệm thu (`acceptance_criteria`) trước khi tạo file task `status: "ready"`.

### Quy tắc 2: Khuôn Mẫu Task Contract YAML 6 Trường
Khi soạn thảo task vào thư mục `agent-team/tasks/active/<TASK-ID>.yaml`, chỉ cần điền **6 trường bắt buộc**:
```yaml
# 1. CÁC TRƯỜNG BẮT BUỘC (REQUIRED)
task_id: "T-YYYY-MM-DD-001"
title: "Tiêu đề ngắn gọn của tác vụ (< 80 ký tự)"
status: "ready" # Dùng "ready" khi đã có scope rõ ràng, hoặc "draft_review" để chờ duyệt
goal: "Mô tả chính xác hàm/lớp cần thêm hoặc sửa (< 150 dòng code mỗi task)"
scope:
  - "src/module_a.py"
  - "tests/test_module_a.py"
acceptance_criteria:
  - "Mô tả tiêu chí đạt yêu cầu chức năng"
  - "Toàn bộ unit test liên quan và validator fast PASS 100%"

# 2. CÁC TRƯỜNG TÙY CHỌN (OPTIONAL)
mode: "quick" # "quick" (<=3 files) | "standard" (Spec/Reviewer gate) | "consult" (Read-Only khảo sát/tư vấn)
risk_level: "low" # "low" | "medium" | "high"
constraints:
  - "Tuân thủ quy tắc thụt lề (indentation) của file gốc trong dự án"
  - "Không chỉnh sửa ngoài danh sách scope"
```

### Quy tắc 3: Nguyên Tắc Tách Nhỏ Task (< 150 Dòng) & Safe Refactoring
- **Quy tắc < 150 dòng:** Dù một task chỉ chạm 1–2 file, nếu tổng lượng code sinh mới hoặc sửa đổi vượt quá ~150 dòng, hãy chia thành chuỗi task tuần tự (`T-...-001A`, `T-...-001B`) để tránh bị cắt cụt token (`finish_reason: length`).
- **Tránh Cross-file Rename:** Hạn chế đổi tên hàm/biến xuất hiện ở nhiều file ngoài `scope`. Chỉ refactor trong phạm vi các file đã được khai báo tường minh trong `scope`.
- **Cơ chế Block & Retry:** Nếu một task thất bại quá số lần quy định, Orchestrator sẽ đổi sang `status: "blocked"`. Hãy đọc file `state/runs/<TASK-ID>/attempt-<N>.txt` để chẩn đoán nguyên nhân, tinh chỉnh lại `goal`/`scope` rồi chuyển lại `status: "ready"`.

### Quy tắc 4: Cấm Tự Ý Mở Orchestrator / Cockpit & Bắt Buộc Kiểm Tra Khóa/Cổng Trước
- **Tuyệt đối không tự mở `orchestrator.mjs` hay `dashboard.mjs` (Cockpit):** IDE Agent chỉ soạn/cập nhật task YAML; không tự ý chạy `npm start` hoặc `npm run dashboard` khi chưa có yêu cầu hoặc phê duyệt rõ ràng từ người dùng.
- **Kiểm tra khóa (Lock) & cổng (Port) trước khi thao tác:** Trước khi khởi chạy hoặc gọi API Cockpit/Orchestrator, **bắt buộc kiểm tra**:
  1. File khóa `agent-team/.orchestrator.lock` và `agent-team/.cockpit.lock` (xem `pid` còn sống không, `port`, `started_at`; không mở thêm tiến trình thứ hai nếu lock đang thuộc PID sống).
  2. Cổng Cockpit cấu hình trong `agent-team/config/policy.yaml` / `policy.local.yaml` (`policy.cockpit.port`, mặc định `4310`, hoặc biến môi trường `DASHBOARD_PORT`) và kiểm tra cổng đó có tiến trình nào đang lắng nghe chưa.
