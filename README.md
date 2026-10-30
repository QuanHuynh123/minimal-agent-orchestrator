# Minimal Agent Orchestration Standard (v2.0 Blueprint)
## Bộ Khung Đội Ngũ Đa Agent Tự Vận Hành Cho Mọi Dự Án

Bộ khung này hiện thực hóa toàn bộ tiêu chuẩn **v2.0 Blueprint** đã được **Tech Lead Claude Opus** duyệt và tối ưu hóa cho môi trường Windows/Linux, sẵn sàng copy vào bất kỳ dự án mới nào để chạy xuyên suốt và qua đêm mà không tốn chi phí vô lý.

---

### 1. Cấu Trúc Thư Mục `agent-team/`

```text
agent-team/
├── .gitattributes             # Chuẩn hóa EOL (LF) tránh diff ảo trên Windows
├── package.json               # Quản lý script khởi chạy và phụ thuộc (yaml)
├── config/
│   ├── team.yaml              # Định nghĩa Router, Writer (Cá Voi), Tech Lead (Opus), Designer (Sonnet)
│   ├── project.yaml           # Lệnh test/lint 0-token của dự án cụ thể
│   └── policy.yaml            # Trần token/chi phí, số lần retry, scope guard
├── roles/
│   ├── router.md              # Phân tích đề bài, chia nhỏ task, lập scope
│   ├── writer.md              # Chuẩn block SEARCH/REPLACE, cấm code lười biếng
│   └── reviewer.md            # Tiêu chí review diff của Tech Lead
├── state/
│   ├── task-state.schema.json # Schema JSON cho state
│   ├── task-state.json        # State machine ghi atomic (.tmp + rename)
│   └── morning-report.md      # Báo cáo tổng kết buổi sáng cho Sếp
├── tasks/
│   ├── task-template.yaml     # Mẫu tạo task mới
│   ├── active/                # Chứa các task đang chờ chạy
│   └── archive/               # Chứa các task đã hoàn thành
└── scripts/
    ├── applier.mjs            # 0-token tool: parser block SEARCH/REPLACE, ghi atomic
    ├── git-guard.mjs          # 0-token tool: snapshot, rollback an toàn, commit tự động
    ├── validator.mjs          # 0-token tool: hash lỗi sha1 chống lặp vô tận, test shell
    └── orchestrator.mjs       # Tiến trình điều phối chính, lock file chống xung đột
```

---

### 2. Nguyên Tắc Cốt Lõi (Đã được Tech Lead Opus Approved)

1. **Zero LLM Pass-Through (0-token disk write):**
   - Writer (DeepSeek Cá Voi) chỉ trả về block thay đổi theo format chuẩn:
     ```text
     FILE: path/to/file.ext
     <<<<<<< SEARCH
     dòng code cũ chính xác
     =======
     dòng code mới thay thế
     >>>>>>> REPLACE
     ```
   - Script `applier.mjs` trực tiếp tìm chuỗi và ghi đè xuống đĩa, tuyệt đối không dùng LLM để copy lại file code.

2. **Khớp duy nhất 1 lần (Single Match Invariant):**
   - Khối `SEARCH` phải khớp **đúng 1 lần** trong file. Nếu không tìm thấy hoặc trùng nhiều vị trí, applier từ chối ngay lập tức và yêu cầu Writer cấp thêm ngữ cảnh xung quanh.

3. **Chống Code Lười Biếng (Anti-Lazy Guard):**
   - Tự động chặn và báo lỗi nếu Writer viết tắt các câu như `// ... existing code ...` hoặc `<!-- ... -->`.

4. **Công Cụ 0-Token Cho Kiểm Thử & Git (0-Token Deterministic Tools):**
   - Chạy test, lint, TAB check qua lệnh shell thuần túy (`python -m unittest`, `pytest`, `npm test`) mất <50ms và tốn **0 token**.
   - Rollback tức thời bằng git khi test fail mà không xóa nhầm file chưa track của người dùng.

5. **Trần Chi Phí & Chống Lặp Vô Tận (Cost Cap & Loop Breaker):**
   - Mỗi task bị chặn bởi `token_budget_per_task`.
   - Nếu xảy ra lỗi giống hệt nhau (`sha1(stderr)` trùng) 2 lần liên tiếp, hệ thống lập tức ngắt, đánh dấu task `blocked` và chuyển tiếp task khác, không bao giờ bị kẹt vòng lặp qua đêm.

6. **Độ Bền Vững Độc Lập (Overnight Autonomous):**
   - Chạy bằng tiến trình Node.js độc lập (`node scripts/orchestrator.mjs`), có lock file `.orchestrator.lock` tránh xung đột, tự ghi log và xuất báo cáo `morning-report.md` khi Sếp thức dậy.

---

### 3. Hướng Dẫn Sử Dụng Cho Dự Án Mới

#### Bước 1: Copy thư mục `agent-team/` vào root của dự án mới

```bash
cp -r agent-team /path/to/new-project/
cd /path/to/new-project/agent-team
npm install
```

#### Bước 2: Cập nhật `config/project.yaml`
Khai báo lệnh kiểm tra nhanh và test suite của dự án mới:
```yaml
project:
  name: "du-an-moi"
  allowed_dirs:
    - "src"
    - "tests"
  validation:
    fast_checks:
      - name: "Lint Check"
        run: "python -m py_compile src/**/*.py"
    suite_checks:
      - name: "Unit Tests"
        run: "pytest tests/"
```

#### Bước 3: Tạo Task trong `tasks/active/`
Tạo file `tasks/active/T-001.yaml`:
```yaml
task:
  id: "T-001"
  title: "Tạo hàm xử lý authentication"
  goal: "Thêm API xác thực token JWT trong src/auth.py"
  scope:
    - "src/auth.py"
    - "tests/test_auth.py"
```

#### Bước 4: Khởi động đội ngũ tự chạy qua đêm
```bash
npm start
```
Hoặc chạy nền bằng tiến trình daemon/pm2:
```bash
npx pm2 start scripts/orchestrator.mjs --name "agent-team"
```

Sáng hôm sau, mở file `state/morning-report.md` để xem báo cáo tổng kết chi tiết!
