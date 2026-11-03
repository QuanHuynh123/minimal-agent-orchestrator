# Bản Đặc Tả Kiến Trúc Độc Lập: Agent Runtime & Tool Harness (v3.0)

- **Document ID:** `ARCH-AGENT-RUNTIME-V3.0`
- **Phạm vi Đặc tả:** Lõi **Agent Runtime (`agent-team/runtime/`)** — Hệ thống cấp phát **Context/Vision Adapter ("Mắt")**, **Tool Execution Runtime ("Tay chân")**, và **Persistent Session Memory ("Trí nhớ")** để biến bất kỳ Model LLM trần nào từ `9Router` thành một **Agent độc lập, hoàn chỉnh**.
- **Ranh giới Kiến trúc (Tách biệt hoàn toàn với Orchestrator):**
  > **1. Bài toán Lõi trước mắt (`Agent Runtime / Harness`):** Một Model LLM lấy từ `9Router` chỉ là một HTTP Endpoint trả lời chữ (`stateless`). Muốn nó trở thành một **Agent**, phải trang bị cho nó **Runtime** gồm: khả năng đọc file/nhìn ảnh (`Context & Vision Adapter`), khả năng gọi công cụ đọc/tìm/sửa/chạy kiểm tra (`Tool Execution Runtime`), và bộ nhớ lưu trạng thái xuyên suốt phiên (`Session Memory Store`).
  >
  > **2. Vị trí của `Orchestrator` (`orchestrator.mjs`):** Orchestrator **KHÔNG phải** là nơi tạo ra Agent, mà chỉ là **một quy chuẩn/kịch bản điều phối (Workflow Consumer)** nằm ở tầng bên ngoài, gọi các Agent đã hoàn chỉnh này chạy theo dây chuyền thác nước khi cần làm batch task. Ngay cả khi **không chạy Orchestrator**, từng Agent (`Designer Agent`, `TechLead Agent`, `Writer Agent`) vẫn phải sống và làm việc độc lập được nhờ `Agent Runtime` này.

---

## 1. Tuyên Ngôn Kỹ Thuật & Định Nghĩa Hệ Thống

> **“9Router cung cấp LLM capability; Agent Runtime cung cấp agency. Không có runtime, không có tool access, không có persistent context, và không có bounded authority thì model chỉ là một endpoint gọi prompt, không phải agent.”**

### Cấu Trúc 4 Thành Phần Của Một Agent Độc Lập
$$\text{Standalone Agent} = \underbrace{\text{9Router Provider Adapter}}_{\text{1. Model Endpoint}} + \underbrace{\text{Context \& Vision Adapter}}_{\text{2. Đôi Mắt (File + Ảnh)}} + \underbrace{\text{Tool Execution Runtime}}_{\text{3. Tay Chân (5 Tools + Guard)}} + \underbrace{\text{Session Memory Store}}_{\text{4. Trí Nhớ Phiên}}$$

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                        1. 9ROUTER PROVIDER GATEWAY (:20128/v1)                     │
│          Model Registry (GET /v1/models)  │  Provider Routing (Stateless API)      │
└───────────────────▲────────────────────────────────────────────▲───────────────────┘
                    │ OpenAI Multimodal + Tool Payload           │ Model Response
                    │ (Messages + Image Base64 + Tool Schemas)   │ (Text / Tool Calls)
╔═══════════════════╧════════════════════════════════════════════╧═══════════════════╗
║                     AGENT RUNTIME CORE (agent-team/runtime/)                       ║
║              (Biến Model LLM trần thành Agent độc lập có Mắt, Tay, Trí nhớ)        ║
╠═══════════════════════════╦════════════════════════════╦═══════════════════════════╣
║ 2. CONTEXT & VISION       ║ 3. TOOL EXECUTION          ║ 4. PERSISTENT SESSION     ║
║    ADAPTER ("ĐÔI MẮT")    ║    RUNTIME ("TAY CHÂN")    ║    MEMORY ("TRÍ NHỚ")     ║
║ • Đọc file workspace      ║ • list_files(dir)          ║ • state/sessions/<id>.json║
║   an toàn (chặn .env/.. ) ║ • search_code(pattern)     ║ • Lưu facts, decisions,   ║
║ • Mã hóa ảnh .png/.jpg    ║ • read_file(path, lines)   ║   tool_receipts, diffs    ║
║   sang Base64 image_url   ║ • apply_patch (Applier)    ║ • Tự động nén (Compact)   ║
║ • Kiểm tra Capability     ║ • run_validator(fast/suite)║   output tool cũ để giữ   ║
║   Matrix của Model        ║ • Role RBAC & Max Turns    ║   mạch hội thoại dài hạn  ║
╚═══════════════════════════╩═════════════╤══════════════╩═══════════════════════════╝
                                          │
          ┌───────────────────────────────┼───────────────────────────────┐
          ▼                               ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│  Cách dùng 1: Standalone  │   │  Cách dùng 2: MCP Bridge  │   │  Cách dùng 3: External    │
│  CLI Agent (Gọi lẻ 1 Agent│   │  (Gọi Designer / TechLead │   │  Workflow (Orchestrator   │
│  làm việc trực tiếp)      │   │  từ IDE có đủ ảnh/file)   │   │  chỉ là 1 khách hàng gọi) │
└───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

---

## 2. Thành Phần 1: `9Router Provider Adapter` & `Capability Matrix` (`runtime/provider-gateway.mjs`)

### 2.1. Vai trò của 9Router
- `9Router` (`http://127.0.0.1:20128/v1`) chỉ làm nhiệm vụ:
  1. **Model Registry:** Trả danh sách các model từ các provider đã kết nối (`GET /v1/models`).
  2. **API Adapter & Router:** Chuyển tiếp request `POST /v1/chat/completions` tới model đích và trả về kết quả.
- `9Router` hoàn toàn không biết gì về dự án, file, ảnh trên đĩa hay lịch sử phiên.

### 2.2. Ma Trận Năng Lực (`Capability Matrix`)
Để Runtime biết model nào trên 9Router nhìn được ảnh, model nào gọi được tool, `provider-gateway.mjs` duy trì bảng **Capability Matrix**:

| Cờ Năng Lực (`Capability Flag`) | Phân loại | Ý nghĩa Kỹ thuật & Hành vi của Runtime |
| :--- | :--- | :--- |
| **`supports_vision`** | Model Capability | Model nhận được ảnh qua `content: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }]`. Nếu `false` mà người dùng truyền ảnh $\rightarrow$ Runtime báo lỗi rõ ràng ngay từ đầu, không gửi mù. |
| **`supports_multimodal`** | Model Capability | Hỗ trợ gửi nhiều ảnh + nhiều khối văn bản trong cùng 1 lượt. |
| **`supports_tool_calls`** | Model + Runtime | Hỗ trợ gọi công cụ qua chuẩn OpenAI `tools` JSON hoặc qua cú pháp fallback `<tool_call>{...}</tool_call>` do Runtime bóc tách. |
| **`supports_long_context`** | Model Capability | Cửa sổ ngữ cảnh `>= 128k tokens` (quyết định hạn mức đính kèm file của Context Adapter). |
| **`supports_json_schema`** | Model Capability | Đảm bảo xuất JSON hợp lệ theo schema yêu cầu. |
| **`supports_code_generation`** | Model Capability | Đủ năng lực sinh code và khối `SEARCH/REPLACE` chính xác. |
| **`supports_file_reading`** | Runtime Capability | Được Runtime cấp quyền đọc file trong workspace (`list_files`, `search_code`, `read_file`). |
| **`supports_file_writing`** | Runtime Capability | Được Runtime cấp quyền sửa file qua `apply_patch` trong phạm vi `allowed_scope`. |
| **`supports_terminal`** | Runtime Capability | Được Runtime cấp quyền chạy `run_validator` (có timeout cứng). |

---

## 3. Thành Phần 2: `Context & Vision Adapter` — Cấp "Đôi Mắt" Cho Agent (`runtime/context-adapter.mjs`)

Giải quyết trực tiếp vấn đề: *"Làm sao để gửi file và gửi ảnh thiết kế trong dự án cho Claude Sonnet 4.5 / Opus 5.5 trên 9Router xem được?"*

### 3.1. Cơ chế Đính kèm & Mã hóa Ảnh (`Image Attachment Pipeline`)
Khi người dùng hoặc hệ thống truyền danh sách đường dẫn ảnh (`images: ["agent-team/ui/reference-9router-graph.png"]`):
1. **Path & Security Check:** Kiểm tra qua `normalizeOrThrow(REPO_ROOT, imagePath)` để đảm bảo ảnh nằm trong workspace.
2. **Format & Size Check:** Chỉ chấp nhận `.png`, `.jpg`, `.jpeg`, `.webp` và kích thước `<= 5 MB` mỗi ảnh.
3. **Capability Verification:** Kiểm tra model đích có `supports_vision === true` hay không.
4. **Base64 Multimodal Serialization:** Đọc buffer nhị phân của ảnh và đóng gói thẳng vào mảng `content` của message gửi qua 9Router:
   ```json
   {
     "role": "user",
     "content": [
       {
         "type": "text",
         "text": "[ATTACHED IMAGE: agent-team/ui/reference-9router-graph.png]\nHãy phân tích bố cục Node Graph trong ảnh này..."
       },
       {
         "type": "image_url",
         "image_url": {
           "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
         }
       }
     ]
   }
   ```

### 3.2. Cơ chế Đính kèm File Văn bản An toàn (`File Attachment Pipeline`)
Khi truyền danh sách file (`files: ["agent-team/UI_DASHBOARD_SPEC.md", "agent-team/ui/index.html"]`):
1. Đi qua chốt `normalizeOrThrow(REPO_ROOT, filePath)` và `checkForbidden(filePath, protectedFiles)` (tuyệt đối chặn `.env*`, file chứa key/secret, `.git/**`).
2. Đọc nội dung file (kèm đánh số dòng hoặc cắt lát thông minh nếu file quá lớn) và đóng gói thành khối `<attached_file path="...">...</attached_file>` đưa thẳng vào message.

---

## 4. Thành Phần 3: `Tool Execution Runtime` — Cấp "Đôi Tay" Cho Agent (`runtime/tool-runtime.mjs`)

Giải quyết trực tiếp vấn đề: *"Model trên 9Router không phải CLI nên không tự mò vào dự án đọc file, tìm code hay sửa file được."*

### 4.1. Danh mục 5 Công cụ Cơ bản (`Pre-registered Tool Catalog`)
Runtime cung cấp sẵn 5 công cụ nội bộ. Khi một Model trên 9Router cần tìm hiểu dự án hoặc sửa code, nó trả về yêu cầu gọi tool, và **chính `tool-runtime.mjs` tại máy local sẽ thực thi rồi trả kết quả lại cho Model**:

| Tên Tool | Tham số (`arguments`) | Nghiệp vụ Thực thi tại Local & Chốt chặn An toàn |
| :--- | :--- | :--- |
| **`list_files`** | `{ "dir": "agent-team/ui", "max_results": 200 }` | Quét và trả về danh sách đường dẫn file thật trong thư mục (bỏ qua `.venv`, `node_modules`, `__pycache__`, `.git`). |
| **`search_code`** | `{ "pattern": "renderSquadRoles", "dir": "agent-team/ui" }` | Tìm kiếm chuỗi/regex trong các file thuộc phạm vi cho phép, trả về `file:line: content` (tối đa 50 dòng khớp). |
| **`read_file`** | `{ "path": "agent-team/ui/index.html", "start_line": 1, "end_line": 200 }` | Đọc chính xác từ dòng `start_line` đến `end_line` (tối đa 300 dòng/lần đọc) của bất kỳ file không bị cấm nào trong repo. |
| **`apply_patch`** | `{ "patch": "FILE: ...\n<<<<<<< SEARCH..." }` | Đưa khối `SEARCH/REPLACE` qua 8 bước kiểm định của [`applier.mjs`](scripts/applier.mjs) (kiểm tra `allowed_scope`, cấm xóa trắng, ghi nguyên tử qua `.tmp`). |
| **`run_validator`** | `{ "mode": "fast", "scope": ["agent-team/ui/index.html"] }` | Chạy [`validator.mjs`](scripts/validator.mjs) và trả về kết quả kiểm tra (`ok: true/false` kèm đuôi lỗi đã lọc nhiễu). |

### 4.2. Cơ chế Thực thi Vòng lặp (`Bounded Tool Loop`) & Dual-Protocol
1. **Kiểm tra Quyền (`Role RBAC`):** Mỗi Role chỉ được gọi các tool nằm trong `role.allowed_tools`. Nếu gọi tool ngoài danh sách $\rightarrow$ trả về `{ ok: false, error: "PERMISSION_DENIED" }`.
2. **Hỗ trợ Kép (`Native OpenAI tool_calls` + `Structured <tool_call> Fallback`):**
   - Nếu provider trên 9Router hỗ trợ trường `tool_calls` chuẩn OpenAI $\rightarrow$ Runtime đọc `message.tool_calls`.
   - Nếu provider trên 9Router không bật native function calling $\rightarrow$ Model viết `<tool_call>{"name": "read_file", "arguments": {"path": "..."}}</tool_call>` hoặc khối `FILE: ... <<<<<<< SEARCH`, Runtime tự động parse và chạy tool y hệt!
3. **Trần Vòng lặp (`max_tool_turns`):** Giới hạn cứng tối đa `4` vòng gọi tool cho mỗi yêu cầu để tránh vòng lặp vô hạn và bảo vệ quota.

---

## 5. Thành Phần 4: `Persistent Session Memory Store` — Cấp "Trí Nhớ" Cho Agent (`runtime/session-store.mjs`)

Giải quyết trực tiếp vấn đề: *"Sau mỗi request gửi qua 9Router, Claude Sonnet lại mất sạch trí nhớ."*

- Mọi cuộc gọi vào `Agent Runtime` đều gắn với một `session_id` (nếu không truyền thì tự sinh mới; nếu truyền lại `session_id` cũ như `"design-ui-v3"` thì tự động khôi phục trí nhớ).
- Trạng thái phiên được lưu bền vững trên đĩa tại `agent-team/state/sessions/<session_id>.json` theo cấu trúc chuẩn:
  ```json
  {
    "session_id": "design-ui-v3",
    "task_id": null,
    "role": "designer",
    "model": "kr/claude-sonnet-4.5-thinking",
    "summary": "Thiết kế giao diện Live Monitor v3.0 theo mẫu 9Router Node Graph",
    "facts": [
      "Đã xem ảnh mẫu agent-team/ui/reference-9router-graph.png",
      "Backend /api/snapshot chạy tại cổng 4310"
    ],
    "previous_errors": [],
    "current_diff": "agent-team/ui/index.html | 180 +++++---",
    "tool_receipts": [
      {
        "turn": 1,
        "tool": "read_file",
        "target": "agent-team/UI_DASHBOARD_SPEC.md",
        "lines": "1-195",
        "status": "ok"
      }
    ],
    "last_decisions": [
      "Dùng nền lưới 32x32px #121215, đặt node [9] 9Router ở tâm (400, 180)"
    ],
    "compacted_memory": [
      {
        "turn": 1,
        "user": "Xem ảnh mẫu reference-9router-graph.png và đọc UI_DASHBOARD_SPEC.md",
        "assistant": "Đã phân tích bố cục 5 node và đường cong SVG Bezier..."
      }
    ],
    "timestamps": {
      "created_at": "2026-11-02T16:20:00.000Z",
      "updated_at": "2026-11-02T16:25:00.000Z"
    }
  }
  ```
- **Tự động Nén Ngữ Cảnh (`Tool Output Compaction`):** Các đoạn file dài hàng trăm dòng do `read_file` đọc ở lượt trước được thu gọn thành `tool_receipts` + `compacted_memory` ở các lượt sau, giúp Agent giữ trọn vẹn mạch tư duy qua hàng chục lượt trao đổi mà không tốn lại tiền token cho các file đã đọc.

---

## 6. Định Nghĩa Cấu Hình Các `Role Agents` Độc Lập (`config/team.yaml`)

Khi đã có `Agent Runtime`, mỗi Role trong [`team.yaml`](config/team.yaml) trở thành một **Agent độc lập có đầy đủ quyền năng**:

| Role Agent | Model (9Router) | Vision (`Đôi mắt ảnh`) | `allowed_tools` (`Đôi tay`) | `allowed_scope` (`Ranh giới quyền hạn`) | Session Memory |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`designer`** | `kr/claude-sonnet-4.5-thinking` | `true` (Nhận ảnh `.png`/`.jpg` Base64) | `list_files`, `search_code`, `read_file`, `apply_patch`, `run_validator` | `["src/ui/**", "ui/**", "agent-team/ui/**", "agent-team/*.md"]` | `persistent` (Giữ mạch thiết kế nhiều lượt) |
| **`writer`** | `Deepseek V4.1 Flash/...` | `false` | `list_files`, `search_code`, `read_file`, `apply_patch`, `run_validator` | Khóa chặt theo `--scope` (hoặc `task.scope`) | `task_scoped` |
| **`router`** | `kr/claude-sonnet-4.5-thinking` | `false` | `list_files`, `search_code`, `read_file` *(Read-Only)* | Toàn bộ `project.allowed_dirs` (Chỉ đọc) | `task_scoped` |
| **`reviewer`** | `ag/claude-opus-5-5-high` | `true` | `read_file`, `search_code` *(Read-Only)* | Toàn bộ `project.allowed_dirs` (Chỉ đọc) | `issues_only` (Chỉ giữ `previousReviewIssues`) |

---

## 7. Giao Diện Sử Dụng (`CLI & API Contract` Của Agent Runtime)

Sau khi xây dựng xong `agent-team/runtime/`, chúng ta có thể gọi trực tiếp bất kỳ Agent nào mà **không cần qua Orchestrator**:

### 7.1. Gọi trực tiếp từ dòng lệnh (Standalone Agent CLI)
```powershell
# Ví dụ 1: Gọi Designer Agent (Sonnet 4.5) xem trực tiếp ảnh .png + đọc spec + tự sửa file UI
node agent-team/runtime/index.mjs `
  --role designer `
  --session ui-v3 `
  --image agent-team/ui/reference-9router-graph.png `
  --file agent-team/UI_DASHBOARD_SPEC.md `
  --scope agent-team/ui/index.html `
  --prompt "Hãy xem bức ảnh mẫu 9Router đính kèm, đối chiếu với UI_DASHBOARD_SPEC.md, tự đọc và cập nhật agent-team/ui/index.html"

# Ví dụ 2: Nói chuyện tiếp với Designer Agent ở lượt thứ 2 (Nó tự nhớ toàn bộ lượt 1 nhờ --session ui-v3!)
node agent-team/runtime/index.mjs `
  --role designer `
  --session ui-v3 `
  --scope agent-team/ui/index.html `
  --prompt "Cho đường dây SVG nối từ 9Router sang Node đang active dày lên 2.5px và thêm hiệu ứng glow cam"
```

### 7.2. Gọi từ bên trong Code (Programmatic API — Dành cho MCP Server hoặc Orchestrator)
```javascript
import { runAgent } from '../runtime/index.mjs';

const result = await runAgent({
  role: 'designer',
  sessionId: 'ui-v3',
  images: ['agent-team/ui/reference-9router-graph.png'],
  files: ['agent-team/UI_DASHBOARD_SPEC.md'],
  scope: ['agent-team/ui/index.html'],
  prompt: 'Implement the 9Router Live Node Graph Canvas in Tab 1.'
});
```
*(Và khi đó, `orchestrator.mjs` chỉ đơn giản là một kịch bản import hàm `runAgent()` này để chạy dây chuyền tự động khi cần!).*
