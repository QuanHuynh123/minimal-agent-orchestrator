# Operational Specification (v2.1 Standard)

> **Mục tiêu:** Đặc tả vận hành chuẩn cho `agent-team/` (`minimal-agent-orchestrator`). Cưỡng chế an toàn ở tầng Runtime (Runtime Enforcement), phân làn thực thi theo mức độ rủi ro (Mode-Based Policy), nạp ngữ cảnh thông minh (Context-Aware File Loader) và báo cáo tự động tốn 0 token.

---

## 1. Chuẩn hóa Schema của Task (`state/task-state.schema.json` / YAML)

Mỗi task bao gồm các trường kiểm soát chế độ chạy, phạm vi, phê duyệt rủi ro và báo cáo kết quả:

```yaml
# Định danh & Chế độ vận hành
task_id: "T-2026-10-31-001"
mode: "quick"                # Enum: "direct" | "quick" | "standard"

# Quyền hạn & Giới hạn (CHỈ Operator / Config được ghi, cấm LLM tự hạ cấp)
forbidden_files: [".env*", "package.json", "package-lock.json", "requirements.txt"]
risk_level: "low"            # Enum: "low" | "medium" | "high" (computed deterministically)
allow_scope_expansion: false # Mặc định cấm sửa lan sang file ngoài task.scope
justification: ""            # Bắt buộc có lý do (>= 10 chars) nếu allow_scope_expansion = true
approval: null               # Object duyệt khi risk_level = "high": { by: "admin", at: "<ISO>", scope_hash: "<sha1>" }

# Bộ đếm mở rộng phạm vi (Internal Orchestrator quản lý cộng dồn per task)
scope_expansions: []

# Báo cáo cuối (0-Token, ghi atomic trong khối finally khi kết thúc task)
last_report: null
```

---

## 2. Chốt chặn 0-Token tại `orchestrator.mjs`, `applier.mjs` & `validator.mjs`

### 2.1. Tại `orchestrator.mjs` (Pre-Flight Healthcheck, Mode Resolution & Fail-Fast Gate)
1. **Pre-Flight Healthcheck (`HR-6`):**
   * Trước khi mở vòng lặp xử lý `tasks/active/`, kiểm tra kết nối tới cổng LLM (`check9RouterHealth`, timeout $\le 15\text{s}$).
   * Nếu cổng LLM chưa sẵn sàng: **Ngắt phiên chạy ngay (`Session Abort`) và giữ nguyên trạng thái các task trong `tasks/active/`** (không đánh dấu nhầm task thành `blocked`).
2. **Hỗ trợ Draft-to-Planned (`runRouterPlanner`):**
   * Nếu task ở trạng thái `draft` và chưa có `scope`, gọi `Router` để sinh `plan`, `scope`, `acceptance_criteria` trước khi vào cổng kiểm tra.
3. **Kiểm tra tính hợp lệ sớm (0-Token Fail-Fast):**
   * Nếu `scope` rỗng, vượt quá `max_files_per_task`, hoặc thiếu `acceptance_criteria` $\rightarrow$ Chuyển thẳng `blocked`, không gọi Writer.
   * Nếu `scope` chứa đường dẫn bất hợp pháp, khớp `protected_files`/`forbidden_files`, hoặc nằm ngoài `project.allowed_dirs` $\rightarrow$ Chuyển `blocked` (tốn 0 token).
4. **Chặn Self-Approval & Phân làn Mode (`resolveTaskMode`):**
   * `risk_level` hiệu lực = `max(declared, computed)`. Tự động tính `high` nếu chạm đường dẫn nhạy cảm (`auth`, `keyring`, `secret`, `migration`, `infra`, `agent-team/scripts`, `agent-team/config`, `.github/`).
   * Tự động chọn `quick` mode khi `scope.length <= small_task_threshold_files`, `risk_level === "low"` và `!allow_scope_expansion`; ngược lại chuyển sang `standard` mode.
5. **Cơ chế Phê duyệt (`approval` check):**
   * Nếu `risk_level === "high"` hoặc `cross_role_edit === true`: Chỉ cho qua khi trường `approval` tồn tại và `approval.scope_hash === computeScopeHash(task.scope)`. Nếu chưa có hoặc lệch hash $\rightarrow$ Chuyển `blocked` chờ Operator duyệt.
   * Nếu `allow_scope_expansion: true` nhưng thiếu `justification` ($\le 10$ ký tự) $\rightarrow$ Chuyển `blocked`.
6. **Context-Aware File Loader (`buildScopedFilesContext`):**
   * Tự động tính hạn mức ngữ cảnh từ `token_budget_per_task`. Nạp nguyên vẹn 100% các file vừa và nhỏ.
   * Với file lớn vượt hạn mức: Tự động trích xuất từ khóa/tên hàm từ `goal`, `acceptance_criteria`, `last_error` (`extractTaskKeywords`) và cắt cửa sổ ngữ cảnh $\pm 80$ dòng quanh các vị trí khớp (`sliceContentByKeywords`).

---

### 2.2. Tại `applier.mjs` (Pipeline 8 bước nghiêm ngặt trước khi ghi Patch xuống đĩa)

Mọi bản vá từ Writer phải vượt qua 8 chốt chặn tuần tự:

```text
[BƯỚC 1] Parse SEARCH/REPLACE blocks:
         ↳ Kiểm tra cú pháp khối và Anti-Lazy Regex Guard (chặn '// ... existing code ...')

[BƯỚC 2] Chuẩn hóa Path (Path Traversal Guard):
         ↳ Kiểm tra qua path.resolve và path.relative theo repo_root động
         ↳ Chặn path chứa '\0', absolute path, hoặc thoát khỏi root (..) -> mark 'blocked' (noRetry)

[BƯỚC 3] Chặn Symlink Escape trên toàn chuỗi thư mục:
         ↳ Kiểm tra lstatSync và đối chiếu realpathSync từ file đích ngược lên repoRoot
         ↳ Phát hiện symlink -> mark 'blocked' (SECURITY: Symlink disallowed, noRetry)

[BƯỚC 4] Kiểm tra Forbidden Files (Case-insensitive & Glob Match):
         ↳ effective_forbidden = project.protected_files ∪ task.forbidden_files
         ↳ Khớp file cấm -> mark 'blocked' (SECURITY: Forbidden file, noRetry)

[BƯỚC 5] Kiểm tra Allowed Dirs:
         ↳ File nằm ngoài project.allowed_dirs -> từ chối thực thi

[BƯỚC 6] Kiểm tra Scope, New-File Policy & Giới hạn Mở rộng:
         ↳ Nếu tạo file mới: kiểm tra allow_new_files và new_files_only_in_scope
         ↳ outOfScope = modifiedFiles − task.scope
         ↳ Nếu !task.allow_scope_expansion && outOfScope != ∅ -> từ chối
         ↳ Nếu task.allow_scope_expansion == true:
           → Chặn ngay nếu outOfScope chạm đường dẫn nhạy cảm (computeDeterministicRisk === 'high')
           → Cộng dồn: all_expansions = unique(task.scope_expansions ∪ outOfScope)
           → Nếu |all_expansions| > policy.max_scope_increase -> từ chối

[BƯỚC 7] All-or-Nothing In-Memory Simulation:
         ↳ Kiểm tra mọi khối SEARCH phải khớp ĐÚNG 1 LẦN DUY NHẤT trong bộ nhớ
         ↳ Chỉ khi 100% khối trong mọi file đều hợp lệ mới chuyển sang bước ghi đĩa

[BƯỚC 8] Atomic Disk Write:
         ↳ Ghi ra file tạm (.tmp.<timestamp>) và renameSync atomic, bảo toàn chuẩn EOL (LF/CRLF)
```

---

## 3. Cơ chế Báo cáo Đầu - Cuối (0-Token Pre/Post Hooks trong `orchestrator.mjs`)

Chính `orchestrator.mjs` tự động ghi log và cập nhật state mà không tốn token gọi LLM:

### 3.1. Pre-hook (Chạy 1 lần ngay trước khi vào vòng lặp thực thi):
```text
[START] T-2026-10-31-001 | Mode: quick | Goal: Bổ sung API kiểm tra sức khỏe | Scope: src/health.py | Allow-expansion: false
```

### 3.2. Post-hook (Chạy trong khối `finally` ngay khi Task kết thúc ở `done`, `blocked`, hoặc `failed`):
Ghi atomic vào trường `last_report` trong file task và in tóm tắt ra console:

```yaml
last_report:
  final_status: "done" # "done" | "blocked" | "failed"
  mode: "quick"        # "direct" | "quick" | "standard"
  modified_files:      # Lấy từ git diff có lọc theo phạm vi task
    - "src/health.py"
  validation_passed: true
  retries_used: 0
  blocker_reason: null
  next_action: "none"
  reported_at: "2026-10-31T00:50:00Z"
```

---

## 4. Danh sách File Hệ Thống Được Bảo Vệ Mặc Định (`project.protected_files`)

```yaml
protected_files:
  - "**/.env*"
  - "package.json"
  - "package-lock.json"
  - "requirements.txt"
  - "agent-team/scripts/**"
  - "agent-team/config/**"
  - ".github/workflows/**"
```

---

## 5. Anti-Hang & Execution Guardrails (`HR-1` $\rightarrow$ `HR-7`)

1. **HR-1 (Timeout bắt buộc):** Mọi lệnh network (`AbortSignal.timeout`) và CLI (`validator.mjs`) đều phải có timeout tường minh. Lệnh không có timeout bị từ chối ngay lập tức (`ban_unbounded_commands: true`).
2. **HR-2 (Cấm alias `curl` trần trên Windows):** Chặn việc gọi `curl` alias của PowerShell; bắt buộc dùng `curl.exe --connect-timeout 2 --max-time 5` hoặc native `fetch` có `AbortSignal`.
3. **HR-3 (Non-interactive):** Mọi lệnh kiểm thử phải chạy ở chế độ non-interactive (`stdio: ['ignore', 'pipe', 'pipe']`).
4. **HR-4 (Ưu tiên công cụ chuẩn hóa):** Ưu tiên gọi qua giao thức chuẩn (MCP / API có cấu trúc) và công cụ 0-token (`applier.mjs`, `validator.mjs`, `git-guard.mjs`).
5. **HR-5 (Diệt tận gốc Process Tree khi Timeout):** Khi quá hạn timeout, tự động hủy toàn bộ cây tiến trình con (`taskkill /PID <pid> /T /F` trên Windows hoặc `-pid` process group trên POSIX).
6. **HR-6 (Pre-flight Fail-fast $\le 15\text{s}$):** Kiểm tra sức khỏe cổng LLM tối đa 15s trước khi chạy; thất bại thì dừng phiên ngay.
7. **HR-7 (Chống lặp lỗi vô tận bằng Normalized SHA-1 Hash):** Chuẩn hóa log lỗi (lọc bỏ thời gian chạy động, địa chỉ bộ nhớ) trước khi băm SHA-1; nếu lặp lại cùng 1 mã băm lỗi $\ge 2$ lần liên tiếp thì ngắt ngay để bảo vệ ngân sách.
