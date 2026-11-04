# 🧭 Sổ Tay Khởi Tạo & Vận Hành Chuẩn (Onboarding Standard v3.0)

> **Câu chốt Kiến trúc Cốt lõi (Golden Rule):**  
> *"Agent Runtime có thể sửa file qua Applier trong scope được cấp; Orchestrator là một workflow tự động dùng runtime để chạy task theo quy trình."*

Tài liệu này được tách bạch thành **2 Phần độc lập**:
- **[Phần 1: Hướng Dẫn Nhanh Dành Cho Kỹ Sư / Con Người (Human Quickstart)](#phần-1-hướng-dẫn-nhanh-dành-cho-kỹ-sư--con-người)**
- **[Phần 2: Phụ Lục Chỉ Thị Dành Cho AI IDE Agent (AI Planner & Intake Protocol)](#phần-2-phụ-lục-chỉ-thị-dành-cho-ai-ide-agent)**

---

# Phần 1: Hướng Dẫn Nhanh Dành Cho Kỹ Sư / Con Người

Dành cho nhà phát triển mới clone thư mục `agent-team` vào dự án của mình và muốn bắt đầu làm việc ngay trong vòng 2 phút.

## 1. Cài đặt & Kiểm thử 0-Token (30 giây)

Mở Terminal tại thư mục `agent-team` và chạy:
```bash
git clone https://github.com/QuanHuynh123/minimal-agent-orchestrator.git agent-team
cd agent-team
npm install
npm test
```
*(Nếu cả 3 bài test Applier, Runtime v3 và Cockpit đều báo PASS 100% $\rightarrow$ Hệ thống sẵn sàng mà không tiêu tốn bất kỳ token LLM nào!)*

---

## 2. Cấu hình Tối thiểu 1 Model (1-Model Minimal Setup)

Bạn chỉ cần chỉnh sửa đúng 2 file cấu hình đơn giản:

### A. Cổng kết nối LLM (`config/team.yaml`)
Hỗ trợ mọi nhà cung cấp chuẩn OpenAI-compatible (9Router, OpenRouter, DeepSeek, Ollama, vLLM):
```yaml
providers:
  local_gateway:
    base_url: "http://127.0.0.1:20128/v1"
    api_key_env: "LLM_API_KEY"  # Hoặc đặt biến môi trường LLM_API_KEY
roles:
  writer:
    model: "deepseek-ai/deepseek-v4.1-flash-1017" # Model chính của bạn
```
> **💡 Cơ chế Kế thừa 1-Model:** Bạn **chỉ cần cấu hình duy nhất model cho `writer`**. Các role khác (`router`, `reviewer`) sẽ tự động kế thừa model này nếu bạn chưa cần chia tách nhiều model khác nhau.

### B. Ranh giới Dự án (`config/project.yaml`)
Chỉ định thư mục nào AI được phép sửa và lệnh kiểm thử tự động của dự án bạn:
```yaml
project:
  id: "my-project"
  language: "typescript"
  allowed_dirs:
    - "src"
    - "tests"
  protected_files:
    - "package.json"
  validation:
    fast_checks:
      - name: "fast-unit-test"
        run: "npm test" # Hoặc: pytest tests/, go test ./...
```

---

## 3. Chọn Lối Vào Phù Hợp Với Nhu Cầu

Hệ thống cung cấp **2 Lối Vào Kiến Trúc** dùng chung 100% cấu hình:

| Tiêu chí | Lối vào 1: Standalone Agent Runtime | Lối vào 2: Autonomous Squad Orchestrator |
| :--- | :--- | :--- |
| **Bản chất** | **Agent đơn lẻ tương tác (Interactive Single Agent)** | **Quy trình thác nước tự động theo lô (Batch Workflow)** |
| **Lệnh chạy** | `npm run agent -- --role writer --prompt "..."` | `npm run dashboard` (Web) hoặc `npm start` (CLI) |
| **Giao diện** | CLI Terminal | Bàn điều khiển Web Cockpit (`http://127.0.0.1:4310`) |
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
#### Cách A: Dùng Web Cockpit (Khuyến nghị cho người mới)
```bash
npm run dashboard
```
1. Mở trình duyệt tại `http://127.0.0.1:4310`.
2. Chuyển sang Tab **`0. 🚀 Goal Studio & Cockpit`**.
3. Nhập mục tiêu tính năng bằng ngôn ngữ tự nhiên $\rightarrow$ Bấm **`[Decompose Goal to Tasks]`**.
4. AI Planner sẽ đọc codebase và tạo các task nháp ở trạng thái `draft_review`.
5. Bạn kiểm tra lại các file trong `scope` $\rightarrow$ Bấm **`[Approve & Run Queue]`**. Tiến trình sẽ tự động chạy ngầm, kiểm thử và thông báo kết quả.

#### Cách B: Dùng CLI
```bash
# Bước 1: Bóc tách Goal thành Task YAML
npm run plan -- "Tích hợp tính năng xuất báo cáo PDF cho module billing"

# Bước 2: Kiểm tra file trong tasks/active/ rồi chạy
npm start
```

---

# Phần 2: Phụ Lục Chỉ Thị Dành Cho AI IDE Agent

*(Dành riêng cho các trợ lý AI Chat trong IDE như Antigravity, Cursor, Cline, Claude Desktop... khi tham gia hỗ trợ lập kế hoạch).*

> **CHỈ THỊ HỆ THỐNG:**  
> Bạn đang đóng vai trò **Planner & Task Drafter** trong môi trường Chat. Khi người dùng yêu cầu bạn phân tích dự án hoặc soạn task, bạn phải tuân thủ nghiêm ngặt 3 quy tắc sau:

### Quy tắc 1: Cổng Thu Thập Thông Tin Bắt Buộc (Intake Gate)
Khi người dùng giao một bài toán lớn hoặc khởi tạo dự án mới, nếu thiếu bất kỳ thông tin cốt lõi nào dưới đây, bạn **BẮT BUỘC phải dừng lại hỏi người dùng** — **TUYỆT ĐỐI KHÔNG tự bịa tên model hay đoán bừa**:
1. **Đội ngũ AI (`config/team.yaml`):** Cổng kết nối (`base_url`), model chính xác cho `writer`.
2. **Ranh giới Dự án (`config/project.yaml`):** Thư mục nguồn (`allowed_dirs`), file cấm đụng (`protected_files`), lệnh chạy test tự động (`validation`).
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
mode: "quick" # "quick" (<=3 files, low/medium risk) | "standard" (bật Reviewer gate khi risk >= high)
risk_level: "low" # "low" | "medium" | "high"
constraints:
  - "Tuân thủ quy tắc thụt lề (indentation) của file gốc trong dự án"
  - "Không chỉnh sửa ngoài danh sách scope"
```

### Quy tắc 3: Nguyên Tắc Tách Nhỏ Task (< 150 Dòng) & Safe Refactoring
- **Quy tắc < 150 dòng:** Dù một task chỉ chạm 1–2 file, nếu tổng lượng code sinh mới hoặc sửa đổi vượt quá ~150 dòng, hãy chia thành chuỗi task tuần tự (`T-...-001A`, `T-...-001B`) để tránh bị cắt cụt token (`finish_reason: length`).
- **Tránh Cross-file Rename:** Hạn chế đổi tên hàm/biến xuất hiện ở nhiều file ngoài `scope`. Chỉ refactor trong phạm vi các file đã được khai báo tường minh trong `scope`.
- **Cơ chế Block & Retry:** Nếu một task thất bại quá số lần quy định, Orchestrator sẽ đổi sang `status: "blocked"`. Hãy đọc file `state/runs/<TASK-ID>/attempt-<N>.txt` để chẩn đoán nguyên nhân, tinh chỉnh lại `goal`/`scope` rồi chuyển lại `status: "ready"`.
