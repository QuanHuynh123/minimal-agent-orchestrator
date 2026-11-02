# 🧭 Hướng Dẫn Khởi Tạo & Vận Hành Chuẩn (CLI-First Onboarding)
> **Nguyên tắc Cốt lõi:** **`IDE Chat = Read / Plan / Draft`** $\cdot$ **`CLI Runner = Execute / Validate / Commit`** $\cdot$ **`Applier = Safe Write`**

---

## 1. Kiến trúc Phân quyền Bắt buộc (Role & Permission Boundary)

Hệ thống này cưỡng chế sự tách biệt tuyệt đối giữa **Môi trường Chat (Tư vấn/Lập kế hoạch)** và **Môi trường Thực thi (Ghi file/Kiểm thử)**:

| Thành phần | Quyền hạn Được phép (Allowed) | Hành vi Bị cấm Tuyệt đối (Forbidden) |
| :--- | :--- | :--- |
| **1. IDE Chat Agent**<br>*(Cline, Antigravity, Cursor, Claude...)* | - **Read-only mặc định** đối với mã nguồn dự án.<br>- Khảo sát cấu trúc thư mục, đọc code, phân tích lỗi.<br>- **Soạn thảo (Draft)** nội dung cấu hình (`project.yaml`, `team.yaml`) và soạn file Task Contract (`tasks/active/*.yaml`) để Human duyệt. | ❌ **CẤM** trực tiếp sửa mã nguồn dự án trong phiên chat.<br>❌ **CẤM** tự ý ghi đè các file hệ thống trong `protected_files` (`agent-team/config/**`, `agent-team/scripts/**`, `.env*`). |
| **2. Human Operator**<br>*(Kỹ sư vận hành)* | - Giao yêu cầu bằng ngôn ngữ tự nhiên trong khung Chat.<br>- Duyệt cấu hình đề xuất, duyệt `scope_hash` cho các task `high-risk`.<br>- Kích hoạt lệnh chạy từ **CLI Terminal** (`npm start`, `npm test`). | Không cần tự gõ tay toàn bộ nội dung file task YAML từ đầu (do IDE Chat Agent đã hỗ trợ soạn bản nháp). |
| **3. CLI Runner & Applier**<br>*(`orchestrator.mjs`, `applier.mjs`, `validator.mjs`)* | - Cổng **duy nhất** được phép ghi mã nguồn xuống ổ cứng thông qua pipeline 8 bước của `applier.mjs`.<br>- Chạy kiểm thử tự động 0-token (`validator.mjs`).<br>- Tự động rollback khi test fail và commit theo đúng `scope`. | Không bao giờ ghi file nằm ngoài `task.scope` hoặc ngoài `project.allowed_dirs`. |

> **Châm ngôn vận hành:**  
> - *"IDE Chat is read-only by default."*  
> - *"If you want repo mutation, run the Orchestrator from CLI."*  
> - *"AI may assist in drafting config and tasks, but actual code writes must go through the controlled pipeline (`orchestrator.mjs` $\rightarrow$ `applier.mjs`)."*

---

## 2. Quy trình Onboarding 3 Bước (Khi mới Clone về máy)

### Bước 1: Cài đặt & Chạy Tự Kiểm từ CLI Terminal
Mở Terminal tại thư mục gốc dự án của bạn và chạy:
```bash
git clone https://github.com/QuanHuynh123/minimal-agent-orchestrator.git agent-team
cd agent-team
npm install
npm test
```

### Bước 2: Dùng IDE Chat Agent ở chế độ Read-Only để khảo sát & soạn Cấu hình
Bạn vẫn có thể giao việc bằng ngôn ngữ tự nhiên, nhưng **IDE Chat chỉ dùng để đọc, đề xuất cấu hình và tạo bản nháp Task**. Hãy gửi chỉ thị sau vào khung chat IDE:

```text
Hãy đọc file agent-team/ONBOARDING.md. Ở chế độ Read-Only (tuyệt đối không tự ý sửa code dự án hay ghi đè protected_files), hãy khảo sát cấu trúc dự án hiện tại của tôi và xuất bản nháp cấu hình cho agent-team/config/project.yaml cùng agent-team/config/team.yaml để tôi duyệt.
```

### Bước 3: Duyệt Cấu hình & Kích hoạt Runner từ CLI
Sau khi xem và áp dụng cấu hình `config/project.yaml` phù hợp với dự án của bạn, hãy mở **CLI Terminal** và chạy kiểm định:
```bash
# Chạy từ CLI Terminal (trong thư mục agent-team/)
node scripts/test-applier-v2.1.mjs
node scripts/validator.mjs fast
```

---

## 3. Chỉ thị Hệ thống dành cho IDE Chat Agent (Planner & Coordinator Protocol)

> **CHỈ THỊ BẮT BUỘC CHO AI AGENT ĐỌC FILE NÀY:**  
> Bạn đang đóng vai **Read-Only Planner & Task Drafter**, KHÔNG PHẢI **Direct Code Editor**. Bạn phải tuân thủ nghiêm ngặt 3 quy tắc sau:

### Quy tắc 1: Không tự ý sửa mã nguồn dự án hay `protected_files`
- Danh sách `agent-team/config/**`, `agent-team/scripts/**`, `package.json`, `requirements.txt`, `.env*` nằm trong vùng bảo vệ (`protected_files`).
- Khi hỗ trợ người dùng Onboarding, bạn chỉ **đọc** cấu trúc thư mục dự án (`../`) để xác định ngôn ngữ, thư mục nguồn (`allowed_dirs`), lệnh chạy test (`validation`), sau đó **xuất nội dung cấu hình đề xuất** ra khung chat (hoặc file nháp được phép) để Human kiểm tra và áp dụng.

### Quy tắc 1.5: Cổng Thu thập Thông tin Bắt buộc (Mandatory Intake Gate — Thiếu là Hỏi hoặc Fail, Cấm Tự Đoán)
Khi khởi tạo dự án mới hoặc nhận một bài toán lớn từ người dùng, nếu bất kỳ thông tin cốt lõi nào dưới đây chưa rõ hoặc chưa có trong `config/team.yaml`, `config/project.yaml`, bạn **BẮT BUỘC phải dừng lại hỏi người dùng (hoặc báo thiếu để fail-fast)** — **TUYỆT ĐỐI KHÔNG tự bịa tên model hay đoán bừa**:
1. **Đội hình & Nhân sự AI (`config/team.yaml`):**
   - Team có bao nhiêu thành viên (roles)? Gồm những vị trí nào (`router` lập kế hoạch, `writer` viết code, `reviewer` duyệt diff, `validator` chạy script 0-token)?
   - Cổng kết nối LLM (`base_url`, biến môi trường chứa API key `api_key_env` — *lưu ý: chỉ lưu tên biến môi trường trong YAML, không dán key thật*)?
   - Tên model chính xác (`model` ID trên 9Router/provider) cho từng vị trí là gì? Role nào cần cấu hình `max_thinking_tokens`?
2. **Đầu ra Phần mềm & Ranh giới Dự án (`config/project.yaml`):**
   - Mô tả dự án, ngôn ngữ/stack, thư mục nào được phép sửa (`allowed_dirs`), file nào cấm đụng (`protected_files`)?
   - Lệnh kiểm thử nhanh (`fast_checks`) và kiểm thử toàn bộ (`suite_checks`) để xác nhận đầu ra phần mềm đạt chuẩn là gì?
3. **Mục tiêu & Nghiệm thu Task (`tasks/active/*.yaml`):**
   - Nếu người dùng chỉ nêu `goal` chung chung mà chưa rõ đầu ra mong đợi hoặc tiêu chí nghiệm thu (`acceptance_criteria`), bạn phải hỏi lại để chốt trước khi tạo file task `status: "ready"`.

### Quy tắc 2: Chuyển hóa Yêu cầu của Người dùng thành Task Contract (`.yaml`)
Khi người dùng mô tả một tính năng hoặc lỗi cần sửa trong khung chat:
1. Bạn đọc các file liên quan trong dự án để hiểu ngữ cảnh (**Read-Only**).
2. Bạn soạn thảo **Task Contract** theo đúng khuôn mẫu [`agent-team/tasks/task-template.yaml`](file:///d:/tool-download/agent-team/tasks/task-template.yaml) (cho mục tiêu `agent-team/tasks/active/T-YYYY-MM-DD-XXX.yaml`), chỉ cần điền **6 trường bắt buộc** (các trường nội bộ như `retries`, `error_history`, `last_report` do Orchestrator tự quản lý):
   ```yaml
   # 1. CÁC TRƯỜNG BẮT BUỘC (REQUIRED)
   task_id: "T-2026-11-02-001"
   title: "Tiêu đề ngắn gọn của tác vụ (< 80 ký tự)"
   status: "ready" # "ready" khi đã có scope rõ ràng
   goal: "Mô tả chính xác hàm/lớp cần thêm hoặc sửa (< 150 dòng thay đổi mỗi task)"
   scope:
     - "core/module_a.py"
     - "tests/test_module_a.py"
   acceptance_criteria:
     - "Tiêu chí nghiệm thu cụ thể 1"
     - "Toàn bộ unit tests trong scope và tests/test_indentation.py PASS 100%"

   # 2. CÁC TRƯỜNG TÙY CHỌN (OPTIONAL — CÓ MẶC ĐỊNH AN TOÀN)
   mode: "quick" # "quick" (<=3 files, low/medium risk) | "standard" (bật Reviewer gate khi risk >= high)
   risk_level: "low" # "low" | "medium" | "high" | "critical"
   constraints:
     - "100% TAB indentation cho mọi file Python"
     - "Không sửa ngoài danh sách scope"
   ```
3. Nếu tác vụ chạm vào vùng nhạy cảm (`auth`, `keyring`, `secret`, `migration`, `infra`), bạn phải đặt `risk_level: "high"` và thông báo mã `scope_hash` để Human cấp quyền `approval` trước khi chạy.

### Quy tắc 2.5: Chia nhỏ Task theo Độ phức tạp & Giới hạn của `SEARCH/REPLACE`
- **Giới hạn độ phức tạp mỗi Task (< 150 dòng code sinh mới/sửa đổi):** Dù một task chỉ chạm 1–2 file, nếu tổng lượng code + unit test vượt quá ~150 dòng (hoặc vừa viết thuật toán lõi vừa viết wiring + bộ test lớn), hãy **tách thành chuỗi tuần tự** (`T-...-001A`, `T-...-001B`) để tránh bị cắt cụt (`finish_reason: "length"`).
- **Tránh đổi tên symbol xuyên nhiều file (Cross-file Rename):** Cơ chế `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` rất mạnh khi thêm/sửa hàm cục bộ, nhưng dễ sót điểm gọi khi đổi tên một hàm/biến xuất hiện ở hàng chục vị trí. Chỉ đổi tên symbol trong phạm vi `task.scope` đã nạp đầy đủ.
- **Chẩn đoán & Chạy lại khi Task bị `blocked`:**
  - Mọi đầu ra thô của Writer cho từng lần thử đều được lưu tại `agent-team/state/runs/<TASK-ID>/attempt-<N>.txt`.
  - Các task có `status: "blocked"` trong `agent-team/tasks/active/` sẽ tự động được bỏ qua ở các lượt chạy sau để không đốt token lặp lại. Sau khi điều chỉnh `goal` hoặc chia nhỏ task, đổi lại `status: "ready"` để chạy tiếp.

### Quy tắc 3: Chuyển giao Thực thi cho CLI Runner (`orchestrator.mjs`)
Sau khi Task Contract đã được xác nhận và đặt trong `agent-team/tasks/active/`, bạn hướng dẫn Human chạy lệnh thực thi từ **CLI Terminal**:
```bash
cd agent-team
npm start
```
Toàn bộ quá trình:
1. Kiểm tra sức khỏe cổng LLM (`Pre-flight Healthcheck HR-6`)
2. Nạp ngữ cảnh thông minh (`Context-Aware File Loader`)
3. Gọi `Writer` sinh khối `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`
4. Kiểm tra 8 bước an toàn và ghi đĩa Atomic qua `applier.mjs`
5. Chạy kiểm thử 0-token qua `validator.mjs` (và `Reviewer` nếu ở chế độ `standard`)
6. Tự động Rollback nếu lỗi hoặc Scoped Commit nếu thành công

...sẽ do **CLI Runner (`scripts/orchestrator.mjs`)** đảm nhiệm độc lập và xuất báo cáo vào `agent-team/state/morning-report.md`.
