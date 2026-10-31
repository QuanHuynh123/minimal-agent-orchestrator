# 👋 Chào Mừng Đến Với Minimal Agent Orchestration (v2.1)
> **Tài liệu Khởi tạo & Vận hành Tự động dành cho AI Agent (Agent-First Onboarding Playbook)**

---

## Dành cho Người dùng (Human Operator) — Bạn chỉ cần đọc 3 dòng này!

Bạn **KHÔNG CẦN** tự mở các file `.yaml` ra gõ cấu hình hay tự viết file task bằng tay.  
Toàn bộ bộ khung này được thiết kế để **con AI trong IDE của bạn (Cline, Antigravity, Cursor, Claude Code, Windsurf...)** đọc hiểu và **tự động điền thay cho bạn**.

👉 **Cách bắt đầu duy nhất:** Hãy copy câu lệnh dưới đây và dán vào khung chat của AI Agent trên máy bạn:

```text
Hãy đọc file agent-team/ONBOARDING.md, khảo sát dự án hiện tại của tôi và tự động cấu hình agent-team phù hợp với máy của tôi.
```

Từ lúc đó trở đi, bạn chỉ cần ngồi ngay trong khung chat của Agent và giao việc bằng ngôn ngữ tự nhiên!

---

## 🤖 Dành cho AI Agent (IDE Agent Self-Setup & Operation Protocol)

> **CHỈ THỊ HỆ THỐNG DÀNH CHO AI AGENT ĐANG ĐỌC FILE NÀY:**  
> Khi người dùng yêu cầu bạn đọc `agent-team/ONBOARDING.md`, nhiệm vụ của bạn là đóng vai **Squad Coordinator & Onboarding Architect**. Tuyệt đối **không** bắt người dùng phải tự sửa file YAML bằng tay. Bạn phải tự thực hiện tuần tự **4 Bước Khởi Tạo (Self-Setup)** dưới đây.

### GIAI ĐOẠN 1: Tự động Khảo sát & Cấu hình Dự án (4 Bước)

#### Bước 1: Tự khảo sát Repository chủ (`../`)
Hãy dùng công cụ đọc file/thư mục của bạn kiểm tra thư mục gốc của dự án (nằm ở `../` so với `agent-team/`):
1. **Nhận diện ngôn ngữ & môi trường:**
   - Có `package.json` / `tsconfig.json` $\rightarrow$ Node.js / TypeScript.
   - Có `pyproject.toml` / `requirements.txt` / `.venv` $\rightarrow$ Python (kiểm tra xem đường dẫn Python trên máy là `.venv/Scripts/python.exe` trên Windows hay `.venv/bin/python` / `python3` trên macOS/Linux).
   - Có `go.mod` $\rightarrow$ Go; `Cargo.toml` $\rightarrow$ Rust.
2. **Nhận diện danh sách thư mục mã nguồn (`allowed_dirs`):**
   - Liệt kê các thư mục chứa code và test thực tế của dự án (ví dụ: `src/`, `app/`, `core/`, `ui/`, `tests/`...).
3. **Nhận diện lệnh kiểm thử (`validation`):**
   - Tìm lệnh chạy test/linter sẵn có của dự án (ví dụ: `npm test`, `pytest`, `python -m unittest discover -s tests`).

#### Bước 2: Tự động điền lại `agent-team/config/project.yaml`
Dựa trên kết quả khảo sát ở Bước 1, hãy cập nhật ngay file `agent-team/config/project.yaml` cho khớp 100% với dự án của người dùng:
- Đặt `project.id` theo tên thư mục dự án.
- Đặt `project.language` đúng ngôn ngữ vừa phát hiện.
- Đặt `project.repo_root: "../"`.
- Điền danh sách thư mục thật của dự án vào `project.allowed_dirs` (luôn giữ `agent-team/` ở cuối nếu cần tự kiểm).
- Giữ nguyên danh sách bảo vệ an toàn trong `project.protected_files` (`**/.env*`, `package.json`, `agent-team/scripts/**`, `agent-team/config/**`...).
- Cập nhật `validation.fast_checks` (luôn giữ bài tự kiểm `node agent-team/scripts/test-applier-v2.1.mjs`) và `validation.suite_checks` bằng lệnh test thực tế chạy được trên máy của người dùng.

#### Bước 3: Kiểm tra Cổng Model trong `agent-team/config/team.yaml`
1. Nếu người dùng đã nói rõ họ đang dùng cổng LLM nào (ví dụ: `9Router` tại `http://127.0.0.1:20128/v1`, `Ollama` tại `http://127.0.0.1:11434/v1`, `OpenRouter`, `LiteLLM`...), hãy điền giúp họ `base_url`, `api_key_env` và tên `model` tương ứng vào `agent-team/config/team.yaml`.
2. Nếu người dùng **chưa có** cổng LLM rời bên ngoài và chỉ đang trò chuyện trực tiếp với bạn trên IDE (Cline / Antigravity / Cursor):
   - Hãy thông báo ngắn gọn rằng họ có thể dùng ngay **Chế độ Tương tác Trực tiếp (Interactive Mode)** với chính bạn làm Agent thực thi, còn `agent-team` sẽ đóng vai trò **Trọng tài 0-Token (`validator.mjs` & `applier.mjs`)** để bảo vệ phạm vi code và chạy kiểm thử.

#### Bước 4: Chạy Kiểm định (Self-Verification) & Báo cáo Sẵn sàng
Chạy 2 lệnh sau để chứng minh cấu hình bạn vừa điền hoạt động hoàn hảo 100%:
```bash
node agent-team/scripts/test-applier-v2.1.mjs
node agent-team/scripts/validator.mjs fast
```
Nếu cả hai trả về PASS (`"ok": true`), hãy dọn sạch các task mẫu không thuộc dự án trong `agent-team/tasks/active/` (nếu người dùng muốn) và báo cáo ngắn gọn cho người dùng:
> *"✅ Đã tự động cấu hình xong `agent-team` cho dự án `<tên_dự_án>`! Toàn bộ bài kiểm tra bảo mật và Validator đều đã PASS. Hãy cho tôi biết yêu cầu tiếp theo của bạn."*

---

### GIAI ĐOẠN 2: Quy trình Vận hành Hàng ngày (Khi Người dùng Giao việc trong Chat)

Khi người dùng mô tả một yêu cầu bằng ngôn ngữ tự nhiên trong khung chat, **bạn (AI Agent) tự động phân làn và xử lý thay người dùng** theo 1 trong 3 chế độ sau:

#### 🟢 Làn 1: `direct` / `quick` Mode (Khi sửa nhanh $\le 3$ files ngay trong phiên Chat)
Người dùng không cần rời khỏi khung chat. Bạn trực tiếp thực hiện theo đúng 4 bước kỷ luật:
1. **Pre-Hook:** In ra dòng đầu tiên khai báo mục tiêu và phạm vi file sẽ chạm tới:
   `[START] T-QUICK | Mode: quick | Goal: <mô_tả_ngắn> | Scope: <file1, file2> | Allow-expansion: false`
2. **Thực thi trong Scope:** Chỉ sửa đúng các file đã khai báo trong `Scope`. Tuyệt đối không sửa lan sang file khác và không viết tắt `// ... existing code ...`.
3. **Chạy Trọng tài 0-Token (Bắt buộc trước khi báo cáo xong):**
   ```bash
   node agent-team/scripts/validator.mjs fast --scope <file1>,<file2>
   ```
   *(Lệnh này sẽ tự động kiểm tra: bạn có chạm vào file cấm không, có sửa lố ra ngoài `--scope` không, và code mới có vượt qua linter/test nhanh không).*
4. **Post-Hook:** In dòng kết thúc:
   `[REPORT] T-QUICK | Mode: quick | Status: done | Files: <file1, file2> | Validation: true | Retries: 0`

#### 🔵 Làn 2: `standard` / Batch Mode (Khi việc lớn, nhiều bước hoặc chạy tự động qua `orchestrator.mjs`)
Khi người dùng nói: *"Hãy lên kế hoạch / tạo task cho tính năng X rồi cho chạy tự động"*:
1. **Bạn tự viết file Task YAML thay cho người dùng:**
   Dựa vào khuôn mẫu `agent-team/tasks/task-template.yaml`, bạn tự động tạo một hoặc nhiều file `.yaml` vào thư mục `agent-team/tasks/active/T-YYYY-MM-DD-XXX.yaml` với đầy đủ:
   - `task_id`, `title`, `mode` (`quick` hoặc `standard`), `status: "ready"`
   - `goal`: Mô tả kỹ thuật rõ ràng.
   - `scope`: Danh sách đường dẫn tương đối của các file cần sửa/tạo mới.
   - `acceptance_criteria`: Danh sách các tiêu chí nghiệm thu cụ thể.
2. **Kích hoạt Cỗ máy Điều phối:**
   Chạy lệnh (hoặc hướng dẫn người dùng mở Terminal chạy):
   ```bash
   node agent-team/scripts/orchestrator.mjs
   ```
3. **Đọc Báo cáo:**
   Sau khi chạy xong, kiểm tra kết quả tại `agent-team/state/morning-report.md` và trường `last_report` bên trong `agent-team/tasks/archive/`.

#### 🔴 Làn 3: `high-risk` Mode (Khi cần chạm vào `auth`, `secret`, `migration`, `infra` hoặc mở rộng Scope)
- Nếu tác vụ buộc phải chạm vào các đường dẫn nhạy cảm, hệ thống sẽ tự động tính `risk_level: "high"` và yêu cầu chữ ký phê duyệt `approval.scope_hash`.
- Lúc này, bạn hãy dừng lại, giải thích rõ lý do cho người dùng, tính sẵn mã `scope_hash` và hỏi ý kiến xác nhận của người dùng trước khi ghi vào trường `approval` của file task.
