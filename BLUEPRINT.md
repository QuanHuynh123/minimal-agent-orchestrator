# Minimal Agent Orchestration Standard (v2.1 Blueprint)
> **Mục đích tài liệu:** Đây là bản đặc tả kỹ thuật chuẩn (Single Source of Truth) dành cho đội ngũ Kỹ sư và AI Agent triển khai bộ khung điều phối đa tác tử (Multi-Agent Orchestration). Tài liệu này quy định kiến trúc phân làn theo rủi ro (Mode-Based Policy), cưỡng chế an toàn mã nguồn ở tầng Runtime và khả năng tái sử dụng đa dự án (Plugin-Ready).

---

## 1. Mục tiêu & Triết lý Thiết kế

Thiết kế một hệ thống AI team làm việc hiệu quả, không phụ thuộc vào trí nhớ hay kỹ năng prompt của từng cá nhân, và có thể bê nguyên sang dự án mới chỉ bằng cách đổi file cấu hình.

> **Châm ngôn cốt lõi:** *"Không xây team agent dựa trên memory của người, mà dựa trên State + Policy + Contract + Validation."*

* **Giảm sai sót:** Chặn đứng việc AI tự ý sửa code lan man ngoài phạm vi (scope creep) hoặc làm hỏng code cũ.
* **Không đốt Token hai lần (Zero LLM Pass-Through):** Tuyệt đối không dùng một LLM này chỉ để đọc code của LLM khác rồi chép lại vào ổ cứng.
* **Tách bạch Sinh code và Ghi file:** LLM chỉ sinh bản vá (Patch/Diff), còn công cụ hệ thống (System Applier) mới có quyền kiểm tra ranh giới an toàn và ghi xuống đĩa.
* **Dễ thay thế (Plug-and-Play):** Đổi model (DeepSeek, Claude, Gemini) hoặc đổi dự án (Python, Node.js, Go) chỉ qua cấu hình YAML.

---

## 2. Cấu trúc Thư mục Chuẩn (Cross-Platform)

Sử dụng **Node.js (`.mjs`)** hoặc **Python (`.py`)** thay cho Bash script (`.sh`) để đảm bảo chạy mượt trên cả Windows (PowerShell), macOS và Linux mà không bị lỗi đường dẫn hay thiếu thư viện xử lý JSON/YAML.

```text
agent-team/
├── config/
│   ├── team.yaml                 # Khai báo Roles, Model Binding & Hạn mức chung
│   ├── project.yaml              # Khai báo đặc thù Repo, Safe Paths & Lệnh Test
│   └── policy.yaml               # Luật kiểm soát Scope, Approval, Retry & Git Rollback
├── roles/
│   ├── router.md                 # System Prompt & Contract đầu ra cho Router
│   ├── writer.md                 # System Prompt & Contract sinh Patch cho Writer
│   └── reviewer.md               # System Prompt & Rubric chấm điểm cho Reviewer
├── tasks/
│   ├── task-template.yaml        # Khuôn mẫu khởi tạo task mới
│   ├── active/                   # Chứa các file YAML/JSON của task đang chạy
│   └── archive/                  # Lưu trữ các task đã DONE hoặc FAILED/BLOCKED
├── state/
│   ├── task-state.schema.json    # JSON Schema bắt buộc để validate trạng thái task
│   └── morning-report.md         # Báo cáo tổng hợp tự động sau mỗi ca chạy
└── scripts/
    ├── orchestrator.mjs          # State Machine trung tâm điều phối toàn bộ luồng
    ├── applier.mjs               # Deterministic Writer: Kiểm tra Safe Path & áp Patch
    ├── validator.mjs             # Chạy Unittest, Linter, Build (0 Token)
    └── git-guard.mjs             # Quản lý Snapshot, Diff, Stash & Rollback tự động
```

---

## 3. Phân tách Vai trò & Quyền hạn (Role Contracts)

Hệ thống gồm **3 Vai trò LLM** và **2 Công cụ Hệ thống (0 Token)**:

### 3.1. Các Vai trò LLM (AI Agents)
1. **Router (Planner & Triage)**
   * **Input:** Yêu cầu gốc từ người dùng + Cấu trúc thư mục dự án.
   * **Output:** Kế hoạch thực thi (`plan`), danh sách file được phép đụng vào (`scope`), tiêu chí nghiệm thu (`acceptance_criteria`).
   * **Cấm (Forbidden):** Không được sinh code thực thi, không được ghi vào repo.
2. **Writer (Core Code Generator)**
   * **Input:** Task đã ở trạng thái `ready` + Nội dung các file nằm trong `scope` + Log lỗi lần chạy trước (nếu đang retry).
   * **Output:** Chuỗi **Unified Diff** hoặc khối **Search/Replace chuẩn** kèm tóm tắt thay đổi.
   * **Cấm (Forbidden):** Không được đụng vào các file ngoài danh sách `scope` đã duyệt; không được tự ý thêm thư viện ngoài nếu không được phép.
3. **Reviewer (Quality & Architecture Gate)**
   * **Input:** Bản `git diff` thực tế + Kết quả chạy `Validator` + `acceptance_criteria`.
   * **Output:** Quyết định `PASS` hoặc `REJECT` kèm danh sách lỗi cụ thể từng dòng.
   * **Cấm (Forbidden):** Không được tự tay sửa code hộ Writer.

### 3.2. Các Công cụ Hệ thống (Deterministic System Tools - 0 Token)
4. **Applier (Safe File Mutator)**
   * Đọc bản Patch từ `Writer`, đối chiếu từng đường dẫn file với `task.scope` và `project.allowed_dirs`. Nếu hợp lệ 100% mới ghi xuống ổ cứng.
5. **Validator (Test & Lint Runner)**
   * Thực thi các lệnh kiểm thử tự động (`pytest`, `npm test`, `TAB linter`, `smoke check`). Trả về mã thoát (`exit_code`) và `stdout/stderr`.

---

## 4. Vòng đời Tác vụ & Phân làn Thực thi (Mode-Based State Machine)

Hệ thống phân tầng thực thi dựa trên `task.mode` (`direct`, `quick`, `standard`) và `risk_level` (`low`, `medium`, `high`), được quản lý bởi `orchestrator.mjs`:

```text
[Pre-Flight Healthcheck (HR-6 ≤15s)] ──(Unreachable)──> [Session Abort (Giữ nguyên Active Tasks)]
         │
    (Healthy)
         ▼
      [draft] ──(Router lập kế hoạch khi chưa có scope)──> [planned]
                                                              │
         ┌──(Fail-Fast Gate: Allowed Dirs, Protected Files & Approval Hash)──┘
         ▼
      [ready] ◀───────────────────────────────────────────────┐
         │                                                    │
  (Context-Aware File Loader nạp ngữ cảnh &                   │ (Nếu Fail <= max_retries:
   Writer sinh Patch -> 8-Step Applier ghi Atomic)            │  Scoped Git Rollback +
         ▼                                                    │  Ghi nhận Normalized SHA-1 Error Hash)
     [writing]                                                │
         │                                                    │
  (Validator chạy Fast & Suite Checks có Bounded Timeout)     │
         ▼                                                    │
   [validating] ──(Test/Lint FAIL)────────────────────────────┤
         │                                                    │
   (Test/Lint PASS)                                           │
         ├──(Nếu mode == "quick": Bỏ qua Reviewer)──┐         │
         ▼                                          │         │
    [reviewing] ──(Reviewer REJECT ở mode standard)─┼─────────┘
         │                                          │
  (Reviewer PASS)                                   │
         ▼                                          ▼
      [done] (Scoped Git Commit & chuyển vào tasks/archive/)

* Nhánh ngắt mạch: Nếu (retries > max_retries) HOẶC (lặp lại cùng 1 mã SHA-1 lỗi >= 2 lần liên tiếp):
  ──> Chuyển sang [blocked] ──> Dừng task ngay để bảo vệ ngân sách token.
```

---

## 5. Nội dung Chi tiết các File Cấu hình Chuẩn

### 5.1. `config/team.yaml` (Cấu hình Đội hình & Ánh xạ Model)

```yaml
team:
  name: "hybrid-agent-squad"
  version: "2.0"
  single_writer_lock: true

# Định nghĩa các cổng kết nối (Providers)
providers:
  local_9router:
    base_url: "http://127.0.0.1:20128/v1"
    api_key_env: "NINE_ROUTER_API_KEY"
  ide_bridge:
    type: "mcp_loopback"
    timeout_sec: 120

# Cấu hình chi tiết từng Role và Model phụ trách
roles:
  router:
    enabled: true
    provider: "local_9router"
    model: "kr/claude-sonnet-4.5"
    temperature: 0.2
    allowed_actions: ["analyze", "plan", "triage"]
    forbidden_actions: ["direct_write", "modify_config"]

  writer:
    enabled: true
    provider: "local_9router"
    model: "deepseek-ai/deepseek-v4.1-flash-1017"
    temperature: 0.1
    output_format: "search_replace_blocks"
    allowed_actions: ["read_scoped_files", "propose_patch"]
    forbidden_actions: ["out_of_scope_edit", "unapproved_dependency"]

  reviewer:
    enabled: true
    provider: "local_9router"
    model: "ag/claude-opus-5-5-high"
    temperature: 0.1
    allowed_actions: ["review_diff", "approve", "reject"]
    forbidden_actions: ["direct_write"]

  validator:
    enabled: true
    type: "deterministic_script" # Chạy bằng code thuần, tốn 0 token
    script: "scripts/validator.mjs"
```

### 5.2. `config/project.yaml` (Cấu hình Đặc thù Dự án)

```yaml
project:
  id: "my-application"
  language: "python"
  repo_root: "../"
  
  # Chỉ cho phép Applier ghi vào các thư mục này
  allowed_dirs:
    - "src/"
    - "core/"
    - "tests/"
    - "scripts/"
  
  # Các file nhạy cảm tuyệt đối cấm AI tự sửa
  protected_files:
    - "**/.env*"
    - "package.json"
    - "package-lock.json"
    - "requirements.txt"
    - "agent-team/scripts/**"
    - "agent-team/config/**"
    - ".github/workflows/**"

  # Chuỗi lệnh kiểm tra bắt buộc ở bước [validating] (Chạy tuần tự, 0 Token)
  validation:
    fast_checks:
      - name: "syntax_and_lint_check"
        run: "python -m unittest discover -s tests -p test_smoke.py"
        timeout_sec: 15
      - name: "agent_team_self_test"
        run: "node agent-team/scripts/test-applier-v2.1.mjs"
        timeout_sec: 10
    suite_checks:
      - name: "unit_test_suite"
        run: "python -m unittest discover -s tests -v"
        timeout_sec: 60
```

### 5.3. `config/policy.yaml` (Chính sách Phân làn & Bảo vệ Ngân sách)

```yaml
policy:
  scope_control:
    max_files_per_task: 5
    max_scope_increase: 1
    allow_new_files: true
    new_files_only_in_scope: true
    strict_scope_enforcement: true # Applier sẽ từ chối nếu Writer sửa file ngoài task.scope

  task_modes:
    quick:
      max_files: 1
      max_runtime_sec: 30
      skip_router_and_reviewer: true
    standard:
      max_runtime_sec: 300
      skip_router_and_reviewer: false

  approval_gates:
    plan_approval_mode: "auto_if_small"
    small_task_threshold_files: 3
    require_code_review: true
    require_human_approval_for_cross_role_edit: true

  retry_and_escalation:
    max_retries_per_task: 3
    abort_on_identical_error_count: 2 # Ngắt ngay nếu kẹt đúng 1 lỗi 2 lần liên tiếp
    on_exhausted: "mark_blocked_and_continue"
    token_budget_per_task: 150000
    night_token_budget_total: 3000000

  execution_guardrails:
    enforce_command_timeouts: true
    kill_process_tree_on_timeout: true
    default_cli_timeout_sec: 60
    healthcheck_timeout_sec: 15
    ban_unbounded_commands: true
    block_powershell_curl_alias: true

  git_hygiene:
    require_clean_worktree_before_start: true
    rollback_on_validation_fail: true
    auto_commit_on_done: true
    commit_message_prefix: "[AI-Task]"
```

---

## 6. Chuẩn hóa Dữ liệu Trạng thái (`state/task-state.schema.json`)

File JSON Schema này dùng để `orchestrator.mjs` kiểm tra tính hợp lệ của mọi file task trước và sau mỗi bước chuyển trạng thái:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentTaskState",
  "type": "object",
  "required": [
    "task_id",
    "project_id",
    "title",
    "status",
    "owner",
    "goal",
    "scope",
    "acceptance_criteria",
    "retries",
    "created_at",
    "updated_at"
  ],
  "properties": {
    "task_id": {
      "type": "string",
      "pattern": "^T-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}$"
    },
    "project_id": { "type": "string" },
    "title": { "type": "string", "minLength": 5 },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "planned",
        "ready",
        "writing",
        "validating",
        "reviewing",
        "done",
        "blocked",
        "failed"
      ]
    },
    "owner": {
      "type": "string",
      "enum": ["router", "writer", "validator", "reviewer", "human"]
    },
    "goal": { "type": "string" },
    "scope": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "maxItems": 5
    },
    "constraints": {
      "type": "array",
      "items": { "type": "string" }
    },
    "acceptance_criteria": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "retries": {
      "type": "integer",
      "minimum": 0,
      "maximum": 5
    },
    "error_history": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["attempt", "stage", "error_hash", "summary"],
        "properties": {
          "attempt": { "type": "integer" },
          "stage": { "type": "string", "enum": ["apply", "validate", "review"] },
          "error_hash": { "type": "string" },
          "summary": { "type": "string" }
        }
      }
    },
    "validation_result": {
      "type": "object",
      "properties": {
        "passed": { "type": "boolean" },
        "command_results": { "type": "array" }
      }
    },
    "review_result": {
      "type": "object",
      "properties": {
        "passed": { "type": "boolean" },
        "rubric_scores": {
          "type": "object",
          "properties": {
            "correctness": { "type": "boolean" },
            "safety": { "type": "boolean" },
            "scope_adherence": { "type": "boolean" },
            "testability": { "type": "boolean" }
          }
        },
        "issues": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```

---

## 7. Chuẩn Giao tiếp của Writer & Rubric của Reviewer

### 7.1. Định dạng xuất Patch bắt buộc cho `Writer` (`roles/writer.md`)
Để `applier.mjs` có thể tự động ghi code chính xác mà không làm mất code cũ, `Writer` bắt buộc trả về các khối sửa đổi theo cú pháp chuẩn sau:

```text
FILE: src/core/worker.py
<<<<<<< SEARCH
	def cancel_download(self, task_id: str):
		pass
=======
	def cancel_download(self, task_id: str) -> bool:
		if task_id not in self._active_procs:
			return False
		self._active_procs[task_id].terminate()
		return True
>>>>>>> REPLACE
```

**Quy tắc xử lý của `applier.mjs`:**
1. Kiểm tra `FILE` có nằm trong `task.scope` và thuộc `project.allowed_dirs` hay không. Nếu không -> Báo lỗi `OutOfScopeError` ngay lập tức.
2. Tìm chính xác đoạn văn bản trong khối `SEARCH`. Nếu không khớp 100% -> Báo lỗi `SearchBlockNotFoundError` để `Writer` đọc lại file và sinh lại khối đúng.

### 7.2. Tiêu chí chấm điểm bắt buộc cho `Reviewer` (`roles/reviewer.md`)
`Reviewer` chỉ nhận `git diff` sau khi `Validator` đã chạy PASS toàn bộ test/linter và phải chấm điểm theo 4 tiêu chí nhị phân (`true/false`):
1. **Correctness:** Logic đã giải quyết triệt để toàn bộ `acceptance_criteria` trong task chưa?
2. **Safety:** Có nguy cơ gây race condition, rò rỉ bộ nhớ, zombie process hoặc làm hỏng luồng khác không?
3. **Scope Adherence:** Có lén sửa đổi hoặc xóa code không liên quan đến `goal` của task không?
4. **Testability:** Các thay đổi mới đã có test case kiểm chứng hoặc dễ dàng kiểm thử tự động chưa?

*(Chỉ cần 1 trong 4 tiêu chí là `false`, trạng thái sẽ bị trả về để retry kèm danh sách `issues` cụ thể).*

---

## 8. Ý Kiến Thẩm Định Của Tech Lead Claude Opus (Review Verdict)

Bản đặc tả đã được gửi qua cổng 9Router tới **Tech Lead Claude Opus** và nhận được phê duyệt chính thức:

* **Tính khả thi:** 85% (Rất cao).
* **3 Điểm chốt cốt lõi:**
  1. *State Management:* Ghi atomic (`.tmp` + rename) và có lock file `.orchestrator.lock` tránh xung đột.
  2. *Patch Single Match:* Khối SEARCH phải khớp **đúng 1 lần**. Khớp 0 hoặc nhiều lần phải reject.
  3. *Cost Budget:* Đặt trần `token_budget_per_task` trong `policy.yaml`.
* **Lưu ý nền tảng Windows:**
  1. *EOL:* Chuẩn hóa CRLF→LF khi so khớp SEARCH, ghi lại theo EOL gốc. Bổ sung `.gitattributes`.
  2. *Path Check:* Scope check bằng `path.resolve` + `path.relative`, so sánh không phân biệt hoa thường. Dùng `fileURLToPath(import.meta.url)` thay `__dirname`.
  3. *ChildProcess:* Node 20.12+ gọi qua `shell: true`. Rollback an toàn tránh xóa file untracked.
* **VERDICT: APPROVED.**
