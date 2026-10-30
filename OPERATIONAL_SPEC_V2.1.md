# Operational Spec Addendum (v2.1 Patch) — CHÍNH THỨC ĐÃ CHỐT

> **Mục tiêu:** Bản nâng cấp đắp trực tiếp vào `agent-team/` (minimal-agent-orchestrator). Không thay đổi State Machine đã code, không sinh thêm file rác, tốn 0 token cho việc báo cáo và bảo vệ an toàn toàn diện theo phê duyệt của Tech Lead Opus & Sếp.

---

## 1. Bổ sung Schema của Task (`task-state.schema.json` / YAML)

Giữ nguyên toàn bộ trạng thái hiện có, bổ sung 5 trường kiểm soát phạm vi, phê duyệt và báo cáo vào mỗi task:

```yaml
# Quyền hạn & Giới hạn (CHỈ Human / Config được ghi, cấm LLM tự sửa)
forbidden_files: [".env*", "package.json", "package-lock.json", "requirements.txt"]
risk_level: "low"            # Enum: "low" | "medium" | "high" (computed deterministically)
allow_scope_expansion: false # Mặc định cấm sửa lan sang file ngoài task.scope
justification: ""            # Bắt buộc có lý do (>= 10 chars) nếu allow_scope_expansion = true
approval: null               # Object duyệt khi risk_level = "high": { by: "admin", at: "<ISO>", scope_hash: "<sha256>" }

# Bộ đếm mở rộng phạm vi (Internal Orchestrator quản lý cộng dồn per task)
scope_expansions: []

# Báo cáo cuối (0-Token, chỉ ghi 1 lần khi task chuyển trạng thái kết thúc)
last_report: null
```

---

## 2. Siết luật kiểm tra 0-Token tại `router.mjs` & `applier.mjs`

### 2.1. Tại `router.mjs` (Bước lập Plan & Thẩm định)
1. **Kiểm tra đầu vào:** Nếu `scope` rỗng hoặc thiếu `acceptance_criteria` $\rightarrow$ Chuyển thẳng `blocked`, không gọi Writer.
2. **Kiểm tra tính hợp lệ sớm (Fail Fast):**
   * Nếu `scope` chứa file trong `effective_forbidden` hoặc nằm ngoài `project.allowed_dirs` $\rightarrow$ Chuyển `blocked`.
3. **Chặn Self-Approval của LLM:**
   * LLM không được tự ý sinh hay hạ các trường: `risk_level`, `allow_scope_expansion`, `forbidden_files`.
   * `risk_level` hiệu lực = `max(declared, computed)`. Tự động tính `high` nếu đụng file nhạy cảm (`auth/`, `migrations/`, `orchestrator`, CI...).
4. **Cơ chế thoát Deadlock (`approval` check):**
   * Nếu `risk_level === "high"`: Chỉ cho qua khi trường `approval` tồn tại và `approval.scope_hash === sha256(task.scope.sort())`. Nếu chưa có hoặc lệch scope $\rightarrow$ Chuyển `blocked` chờ Human duyệt.
   * Nếu `allow_scope_expansion: true` nhưng thiếu `justification` $\rightarrow$ Chuyển `blocked`.

---

### 2.2. Tại `applier.mjs` (Pipeline 8 bước nghiêm ngặt trước khi ghi Patch xuống đĩa)

Mọi patch từ Writer phải vượt qua 8 chốt chặn tuần tự:

```text
[BƯỚC 1] Parse patch → [{op, oldPath, newPath, mode}]
         ↳ Parse lỗi syntax diff → mark 'failed'

[BƯỚC 2] Chuẩn hóa Path (Path Traversal Guard):
         ↳ Kiểm tra cả oldPath lẫn newPath qua path.resolve và path.relative
         ↳ Chặn path chứa '\0', absolute path, hoặc thoát khỏi root (..)
         ↳ Lỗi path → mark 'blocked' (SECURITY: Illegal path)

[BƯỚC 3] Chặn Symlink / Submodule Escape:
         ↳ Mode 120000 hoặc symlink pointer → mark 'blocked' (SECURITY: Symlink disallowed)

[BƯỚC 4] Kiểm tra Forbidden Files (Nocase & Glob Match):
         ↳ effective_forbidden = project.protected_files ∪ task.forbidden_files
         ↳ Khớp file cấm (VD: .env*, package.json, lockfiles, orchestrator scripts)
         ↳ HÀNH ĐỘNG: Chuyển 'blocked' (SECURITY: Forbidden file), KHÔNG RETRY để tránh đốt token.

[BƯỚC 5] Kiểm tra Allowed Dirs:
         ↳ File không nằm trong project.allowed_dirs → mark 'blocked'

[BƯỚC 6] Kiểm tra Scope & Giới hạn nới rộng (Strict Scope Enforcement):
         ↳ outOfScope = modifiedFiles − task.scope
         ↳ Nếu !task.allow_scope_expansion && outOfScope != ∅:
           → mark 'blocked' với lý do: "Out-of-scope edit attempted on <file>"
         ↳ Nếu task.allow_scope_expansion == true:
           → Cộng dồn: all_expansions = unique(task.scope_expansions ∪ outOfScope)
           → Nếu |all_expansions| > policy.max_scope_increase (1 file):
             → mark 'blocked' (Vượt trần nới rộng phạm vi task)

[BƯỚC 7] Áp dụng All-or-Nothing (Git Apply Check):
         ↳ Chạy 'git apply --check' trước
         ↳ Chỉ khi 100% file pass mới thực thi 'git apply' (tránh bẩn git working tree)

[BƯỚC 8] Atomic Write State:
         ↳ Ghi file tạm (.tmp) rồi atomic replace
         ↳ Ghi đồng thời status + scope_expansions (+ last_report nếu terminal)
```

---

## 3. Cơ chế Báo cáo Đầu - Cuối (0-Token Pre/Post Hooks trong `orchestrator.mjs`)

Tuyệt đối không dùng LLM để viết văn báo cáo. Chính `orchestrator.mjs` tự động ghi log và cập nhật state:

### 3.1. Pre-hook (Chạy 1 lần duy nhất ngay trước khi gọi Writer — 1 dòng Console):
```text
[START] T-001 | Goal: Đổi màu nút primary | Scope: Button.tsx, theme.css | Allow-expansion: false
```
*(Ghi chú: Chuỗi Goal được sanitize bỏ `\n`, ANSI escape và cắt ngắn tối đa 80 ký tự).*

### 3.2. Post-hook (Chạy trong khối `finally` ngay khi Task chuyển `done`, `blocked`, hoặc `failed`):
Bắt cả sự kiện ngắt `SIGINT`. Ghi đè 1 lần duy nhất vào trường `last_report` trong file task và in tóm tắt ra console:

```yaml
last_report:
  final_status: "done" # hoặc "blocked" / "failed"
  modified_files: # Lấy từ `git diff --name-only` thực tế sau khi apply
    - "src/components/Button.tsx"
  validation_passed: true # true | false | null (null nếu task bị block trước khi validate)
  retries_used: 0
  blocker_reason: null # Mã lỗi chi tiết nếu bị blocked/failed (VD: "SECURITY: Access to .env.local")
  next_action: "none"  # VD: "Need human approval for scope expansion to api.ts"
  reported_at: "2026-10-31T00:50:00Z"
```

---

## 4. Danh sách File Hệ Thống Được Bảo Vệ Mặc Định (`project.protected_files`)

Cập nhật vào `agent-team/config/project.yaml`:
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
*Bản đặc tả đã được Tech Lead Opus phê duyệt và Sếp chốt ngày 31/10/2026.*
