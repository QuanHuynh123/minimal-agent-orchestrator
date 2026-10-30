# Triết Lý Thiết Kế & Nguyên Tắc Vận Hành Cốt Lõi
> **Minimal Agent Orchestration Standard — Core Philosophy & Architecture Sign-off**

---

## 1. Vấn Đề (The Problem)

Khi dùng agent AI để hỗ trợ phát triển phần mềm, hệ thống thường gặp các rủi ro sau:

- **Agent vượt scope:** tự làm thêm việc ngoài task đã yêu cầu.
- **Agent không báo trước kế hoạch:** người vận hành không biết nó đang làm gì.
- **Task không có contract rõ ràng:** thiếu goal, scope, allowed files, acceptance criteria.
- **Role bị chồng chéo:** router, writer, reviewer, validator cùng làm giao diện, sửa file, review, kiểm thử mà không bị ràng buộc rõ.
- **Không có checkpoint rõ ràng:** không biết task đang ở trạng thái nào, còn thiếu gì, đã xong phần nào.
- **Không có reporting chuẩn:** sau khi chạy, agent không báo tiến độ, blocker, và bước tiếp theo.
- **Mất tri thức khi đổi người:** logic nằm trong đầu người thay vì nằm trong file config / task schema.

> **Điểm cốt lõi:**  
> AI không thiếu intelligence, mà thiếu giới hạn và protocol.  
> Nếu không có task contract + role boundary + validation gate, agent dễ “tiện tay” làm thêm hoặc vượt scope.

---

## 2. Giải Pháp Khái Quát (The Solution)

Thiết kế một mô hình vận hành tối thiểu nhưng có ranh giới rõ ràng:

### A. Task Contract
Mỗi task phải có contract minh bạch:
- `goal`: Mục tiêu cụ thể duy nhất.
- `scope`: Danh sách file/thư mục được phép đụng tới.
- `allowed_files` & `forbidden_files`: Giới hạn an toàn.
- `acceptance_criteria`: Tiêu chí nghiệm thu rõ ràng.
- `risk_level`: Mức độ rủi ro (`low`, `medium`, `high`).
- `validation_commands`: Chuỗi lệnh kiểm thử bắt buộc (0-token shell).
- `allow_scope_expansion`: Cờ cho phép nới rộng phạm vi (kèm lý do `justification`).

*Không có task rõ ràng thì tuyệt đối không được bắt đầu.*

### B. Role Boundary
Phân tách rõ từng vai trò:
- **Router:** lên kế hoạch, xác định scope, điều phối.
- **Writer:** chỉ sửa file trong scope đã approve.
- **Reviewer:** review diff, approve hoặc reject.
- **Validator:** chạy lint/test/build độc lập.
- **Operator (Human):** theo dõi tiến độ, phê duyệt rủi ro cao, không phải viết code tay.

*Role phải có quyền hạn rõ, không cho bất kỳ agent nào “giải quyết tất cả”.*

### C. Workflow Checkpoint
Mỗi task phải đi qua các trạng thái rõ ràng:
`planned` $\rightarrow$ `ready` $\rightarrow$ `writing` $\rightarrow$ `validating` $\rightarrow$ `reviewed` $\rightarrow$ `done` (hoặc `blocked` / `failed`).

Mỗi checkpoint phải có báo cáo ngắn (0-token console & report artifact):
- Đang làm gì?
- Đã làm gì?
- Còn thiếu gì?
- Có blocker gì?

### D. Validation Gate
Không chấp nhận output “mượt” mà không có kiểm thử:
- Fast checks: Lint, indentation, syntax.
- Suite checks: Unit test, build test.
- Phê duyệt tự động trước khi commit git.

### E. Reporting / Team Operation
Trong quá trình chạy, hệ thống tự động ghi nhận:
- Task đang ở đâu.
- Task đã hoàn thành phần nào.
- Còn gì chưa xong.
- Lỗi hoặc blocker nào đang chặn.
- Kế hoạch tiếp theo.

### F. Tách Tầng Theo Concern
Không trộn lẫn các lớp:
- **Runtime Orchestration:** Scripts điều phối (`orchestrator.mjs`, `applier.mjs`, `git-guard.mjs`).
- **Role Prompts / Contracts:** Các file vai trò markdown (`roles/`).
- **Skills / Tools:** Công cụ thực thi.
- **Project Config:** `project.yaml`, `policy.yaml`, `team.yaml`.
- **Task State:** `task-state.json`, `morning-report.md`.

---

## 3. Mục Tiêu Cuối Cùng (The North Star)

Không xây dựng một platform cồng kềnh cho mọi trường hợp. Mục tiêu cốt lõi là:
- Không để agent “làm thêm”.
- Không để agent “giấu tiến độ”.
- Không để task thiếu contract.
- Không để role chồng lấn.
- Không để validation bị bỏ qua.
- Không để người mới phải học lại toàn bộ workflow mỗi lần.

> **Tuyên ngôn nguyên tắc:**  
> 1. *“Không cho AI suy đoán scope để làm nhanh.”*  
> 2. *“Chỉ cho AI làm đúng những gì đã được định nghĩa rõ, có role rõ, có scope rõ, có validation rõ, và có báo cáo rõ.”*

---

## 4. Thẩm Định Kiến Trúc Từ Tech Lead Claude Opus

1. **Prompt không phải là security boundary:**  
   Ranh giới scope và file cấm bắt buộc phải cưỡng chế bằng code ở tầng runtime (`applier.mjs`), không tin vào prompt của LLM.
2. **Chống "tự chấm điểm" (Anti Self-Grading):**  
   Tuyệt đối cấm Agent sửa file test, CI hay script chấm điểm để gian lận. Toàn bộ file hệ thống phải nằm trong `project.protected_files`.
3. **Sự thật đến từ Artifacts (Observable Truth):**  
   Trạng thái task không dựa vào lời khai của Agent mà dựa trên `git diff` thực tế và mã exit code của test suite.
4. **Cơ chế vượt scope chuẩn:**  
   Khi cần sửa ngoài scope, hành vi duy nhất hợp lệ là: **dừng $\rightarrow$ `blocked` $\rightarrow$ Router sửa contract $\rightarrow$ Human duyệt lại.**

---

## 5. Kết Luận

Đây là một hệ thống tối giản nhưng đủ mạnh cho team nhỏ:
- Đủ chặt để kiểm soát agent.
- Đủ mềm để không over-engineer.
- Đủ rõ để đổi người mà không phải rebuild workflow từ đầu.

Đó là nền tảng đúng đắn để phát triển tiếp khi scale lớn hơn.
