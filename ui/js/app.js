// State
    let isLogPaused = false;
    let logFilterText = '';
    let lastRenderedLogsHash = '';
    let currentStage = 'idle';
    let stageStartedAt = null;
    let taskStartedAt = null;
    let taskDurationStatic = null;

    // DOM Elements: Top Bar
    const txtProject = document.getElementById('txt-project');
    const dotStage = document.getElementById('dot-stage');
    const txtStage = document.getElementById('txt-stage');
    const dotRouter = document.getElementById('dot-router');
    const txtRouter = document.getElementById('txt-router');
    const dotOrchestrator = document.getElementById('dot-orchestrator');
    const txtOrchestrator = document.getElementById('txt-orchestrator');
    const tokIn = document.getElementById('tok-in');
    const tokOut = document.getElementById('tok-out');
    const tokCache = document.getElementById('tok-cache');
    const txtPolling = document.getElementById('txt-polling');

    // Waterfall Pipeline Elements
    const txtStepRouter = document.getElementById('txt-step-router');
    const txtStepWriter = document.getElementById('txt-step-writer');
    const txtStepReviewer = document.getElementById('txt-step-reviewer');
    const writerAttemptBadge = document.getElementById('writer-attempt-badge');
    const retryLoopPill = document.getElementById('retry-loop-pill');
    const retryNum = document.getElementById('retry-num');

    const pipelineSteps = {
      preflight: document.getElementById('step-preflight'),
      router: document.getElementById('step-router'),
      writer: document.getElementById('step-writer'),
      applier: document.getElementById('step-applier'),
      validator: document.getElementById('step-validator'),
      reviewer: document.getElementById('step-reviewer'),
      git: document.getElementById('step-git'),
      done: document.getElementById('step-done')
    };
    const stageSequence = ['preflight', 'router', 'writer', 'applier', 'validator', 'reviewer', 'git', 'done'];

    // Left Column Elements
    const taskCardTitle = document.getElementById('task-card-title');
    const taskId = document.getElementById('task-id');
    const taskAttempt = document.getElementById('task-attempt');
    const taskMode = document.getElementById('task-mode');
    const taskRisk = document.getElementById('task-risk');
    const taskCommitTag = document.getElementById('task-commit-tag');
    const taskTimerTag = document.getElementById('task-timer-tag');
    const taskGoal = document.getElementById('task-goal');

    const squadModelRouter = document.getElementById('squad-model-router');
    const squadStatusRouter = document.getElementById('squad-status-router');
    const squadRowArchitect = document.getElementById('squad-row-architect');
    const squadModelArchitect = document.getElementById('squad-model-architect');
    const squadStatusArchitect = document.getElementById('squad-status-architect');
    const squadModelWriter = document.getElementById('squad-model-writer');
    const squadStatusWriter = document.getElementById('squad-status-writer');
    const squadModelDesigner = document.getElementById('squad-model-designer');
    const squadStatusDesigner = document.getElementById('squad-status-designer');
    const squadStatusValidator = document.getElementById('squad-status-validator');
    const squadModelReviewer = document.getElementById('squad-model-reviewer');
    const squadStatusReviewer = document.getElementById('squad-status-reviewer');
    const squadActiveModeTag = document.getElementById('squad-active-mode-tag');
    let currentSpecModels = null;
    let currentRouterHostLabel = ':20128';

    const scopeFilesList = document.getElementById('scope-files-list');
    const scopeCount = document.getElementById('scope-count');

    const cntActive = document.getElementById('cnt-active');
    const cntDone = document.getElementById('cnt-done');
    const cntBlocked = document.getElementById('cnt-blocked');
    const queueItemsList = document.getElementById('queue-items-list');
    const manualReviewSection = document.getElementById('manual-review-section');
    const cntManualReview = document.getElementById('cnt-manual-review');
    const manualReviewList = document.getElementById('manual-review-list');
    const unseenExactSection = document.getElementById('unseen-exact-section');
    const cntUnseenExact = document.getElementById('cnt-unseen-exact');
    const unseenExactList = document.getElementById('unseen-exact-list');

    // Error Callout Elements
    const lastErrorBanner = document.getElementById('last-error-banner');
    const lastErrorTitle = document.getElementById('last-error-title');
    const lastErrorSummary = document.getElementById('last-error-summary');
    const lastErrorTail = document.getElementById('last-error-tail');
    const lastErrorRaw = document.getElementById('last-error-raw');

    // Central Tabs (4 Tabs)
    const tabBtnCockpit = document.getElementById('tab-btn-cockpit');
    const paneCockpit = document.getElementById('pane-cockpit');
    const tabBtnTopology = document.getElementById('tab-btn-topology');
    const tabBtnOutput = document.getElementById('tab-btn-output');
    const tabBtnSessions = document.getElementById('tab-btn-sessions');
    const paneTopology = document.getElementById('pane-topology');
    const paneOutput = document.getElementById('pane-output');
    const paneSessions = document.getElementById('pane-sessions');
    const outAttemptBadge = document.getElementById('out-attempt-badge');
    const outFinishBadge = document.getElementById('out-finish-badge');
    const btnHeaderConfig = document.getElementById('btn-header-config');
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');
    const bentoContainer = document.querySelector('main.bento-container');
    const modalConfigOverlay = document.getElementById('modal-config-overlay');
    const btnCloseConfigModal = document.getElementById('btn-close-config-modal');

    // Tab 0 Cockpit Elements
    const inpGoalText = document.getElementById('inp-goal-text');
    const selWorkflowPreset = document.getElementById('sel-workflow-preset');
    const selGoalWriterModel = document.getElementById('sel-goal-writer-model');
    const btnDecomposeGoal = document.getElementById('btn-decompose-goal');
    const txtDecomposeBtn = document.getElementById('txt-decompose-btn');
    const spinDecompose = document.getElementById('spin-decompose');
    const lblDecomposeStatus = document.getElementById('lbl-decompose-status');
    const listDraftTasks = document.getElementById('list-draft-tasks');
    const btnApproveRun = document.getElementById('btn-approve-run');
    const btnStopOrchestrator = document.getElementById('btn-stop-orchestrator');
    let csrfToken = null;
    let currentDraftTasks = [];

    // Modal Task Detail Elements
    const modalTaskDetailOverlay = document.getElementById('modal-task-detail-overlay');
    const taskDetailHeaderId = document.getElementById('task-detail-header-id');
    const taskDetailModeBadge = document.getElementById('task-detail-mode-badge');
    const taskDetailRiskBadge = document.getElementById('task-detail-risk-badge');
    const taskDetailStatusBadge = document.getElementById('task-detail-status-badge');
    const btnCloseTaskDetail = document.getElementById('btn-close-task-detail');
    const btnDismissTaskDetail = document.getElementById('btn-dismiss-task-detail');
    const taskDetailTitle = document.getElementById('task-detail-title');
    const taskDetailGoal = document.getElementById('task-detail-goal');
    const taskDetailOwner = document.getElementById('task-detail-owner');
    const taskDetailModel = document.getElementById('task-detail-model');
    const taskDetailScopePills = document.getElementById('task-detail-scope-pills');
    const taskDetailCriteriaList = document.getElementById('task-detail-criteria-list');
    const taskDetailConstraintsList = document.getElementById('task-detail-constraints-list');
    const btnCopyTaskYaml = document.getElementById('btn-copy-task-yaml');
    const taskDetailRawYaml = document.getElementById('task-detail-raw-yaml');
    const btnSaveTaskDetail = document.getElementById('btn-save-task-detail');
    let currentViewingTaskId = null;
    let currentViewingRawYaml = '';

    // Tab 3 Sessions Elements
    const sessionsList = document.getElementById('sessions-list');
    const sessionsCountBadge = document.getElementById('sessions-count-badge');
    const sessionEmptyState = document.getElementById('session-empty-state');
    const sessionActiveContent = document.getElementById('session-active-content');
    const sessRolePill = document.getElementById('sess-role-pill');
    const sessIdTitle = document.getElementById('sess-id-title');
    const sessModelText = document.getElementById('sess-model-text');
    const sessMsgCount = document.getElementById('sess-msg-count');
    const sessToolsCount = document.getElementById('sess-tools-count');
    const sessReceiptsTimeline = document.getElementById('sess-receipts-timeline');
    const sessMessagesContainer = document.getElementById('sess-messages-container');

    let currentSelectedSessionId = null;
    let cachedSessionsList = [];

    // Adaptive Dynamic Star Topology Elements
    const topologySvg = document.getElementById('topology-svg');
    const topologySpokesContainer = document.getElementById('topology-spokes-container');
    const capsuleHub = document.getElementById('capsule-hub');
    const hubStateSub = document.getElementById('hub-state-sub');

    // Telemetry Footer
    const telModelVerify = document.getElementById('tel-model-verify');
    const telFinish = document.getElementById('tel-finish');
    const telBlocks = document.getElementById('tel-blocks');
    const telAttempt = document.getElementById('tel-attempt');
    const telRecoveredBadge = document.getElementById('tel-recovered-badge');

    // Tab 2 Raw Output
    const writerOutput = document.getElementById('writer-output');

    // Console Logs
    const consoleLogs = document.getElementById('console-logs');
    const btnPauseLog = document.getElementById('btn-pause-log');
    const btnClearLog = document.getElementById('btn-clear-log');
    const logFilter = document.getElementById('log-filter');

    // Tab Switching Logic (4 Central Tabs)
    function switchTab(target) {
      const tabs = [
        { btn: tabBtnCockpit, pane: paneCockpit, name: 'cockpit' },
        { btn: tabBtnTopology, pane: paneTopology, name: 'topology' },
        { btn: tabBtnOutput, pane: paneOutput, name: 'output' },
        { btn: tabBtnSessions, pane: paneSessions, name: 'sessions' }
      ];
      tabs.forEach(t => {
        if (!t.btn || !t.pane) return;
        if (t.name === target) {
          t.btn.classList.add('active');
          t.pane.classList.add('active');
        } else {
          t.btn.classList.remove('active');
          t.pane.classList.remove('active');
        }
      });
      if (target === 'topology') {
        requestAnimationFrame(recalculateSvgLinks);
      } else if (target === 'sessions') {
        if (cachedSessionsList.length > 0 && !currentSelectedSessionId) {
          selectSession(cachedSessionsList[0].session_id);
        }
      }
    }

    tabBtnCockpit.addEventListener('click', () => switchTab('cockpit'));
    tabBtnTopology.addEventListener('click', () => switchTab('topology'));
    tabBtnOutput.addEventListener('click', () => switchTab('output'));
    tabBtnSessions.addEventListener('click', () => switchTab('sessions'));

    // Config Modal Overlay Handlers & Tab Switching
    let activeConfigTab = 'team';
    let activeDossierRole = 'router';
    const cfgNavTabs = document.querySelectorAll('.cfg-nav-tab');
    const cfgPanelTeam = document.getElementById('cfg-panel-team');
    const cfgPanelRoles = document.getElementById('cfg-panel-roles');
    const cfgPanelProject = document.getElementById('cfg-panel-project');
    const txtBtnSaveConfig = document.getElementById('txt-btn-save-config');
    const btnSaveTeamConfigEl = document.getElementById('btn-save-team-config');
    let currentPolicyConfig = null;

    // Role Reference Manual Data (Grounded in roles/*.md)
    const ROLE_DOSSIER_CATALOG = {
      router: {
        phase: 'PHA 01',
        specFile: 'roles/router.md',
        title: 'ROUTER',
        subtitle: 'Phân tích yêu cầu & Khóa Scope',
        kpi1: { label: 'VẬN HÀNH', val: '1 lượt mặc định', sub: 'Tối đa 5 lượt nếu thiếu từ khóa' },
        kpi2: { label: 'ĐỊNH MỨC', val: '~5.7K tok / goal', sub: 'Trinh sát 0-token trước gọi AI' },
        rec: {
          tier: 'Fast Tier',
          primary: 'Năng lực: Suy luận nhanh, xuất JSON hợp lệ trong 1 lượt',
          secondary: 'Năng lực dự phòng: Leo thang khi JSON lỗi',
          reason: 'Phân rã tác vụ 1 lượt dựa trên Repo Map, giữ quota model mạnh cho Spec & Review.'
        },
        plainSummary: 'Tách yêu cầu thành 1–3 task nguyên tử (<150 dòng) và khóa chặt danh sách file được phép sửa.',
        operations: [
          {
            title: '01. PHÂN RÃ TÁC VỤ',
            tag: 'JSON Plan',
            desc: 'Chia mục tiêu thành 1–3 task kèm scope, chế độ (quick/standard/consult) và tiêu chí.'
          },
          {
            title: '02. VÒNG LẶP LAI',
            tag: 'Hybrid Loop',
            desc: 'Mặc định 1 lượt từ ngữ cảnh 0-token; chỉ gọi tool (tối đa 5 lượt) khi thiếu khớp từ khóa.'
          },
          {
            title: '03. NGỮ CẢNH ĐẦU VÀO',
            tag: 'Read-Only',
            desc: 'Nhận Repo Map, đồ thị phụ thuộc 1-hop và tự đính kèm tệp kiểm thử liên quan.'
          },
          {
            title: '04. AN TOÀN SCOPE',
            tag: 'Zero Write',
            desc: 'Không sửa code; không bịa tên file ngoài Repo Map; giữ đúng trần max_files_per_task.'
          }
        ],
        proTip: 'Đặt model nhanh làm mặc định và escalation_model dự phòng khi JSON lỗi.',
        defaultImg: '/assets/roles/router.webp'
      },
      architect: {
        phase: 'PHA 02A',
        specFile: 'roles/architect.md',
        title: 'ARCHITECT',
        subtitle: 'Đặc tả Kiến trúc & Bảng hợp đồng',
        kpi1: { label: 'CHỌN MODEL', val: 'Theo risk (spec_models)', sub: 'Low/Med gọn • High/Crit mạnh' },
        kpi2: { label: 'TỐI ƯU RETRY', val: 'Tái dùng Spec 0-token', sub: 'Giữ nguyên khi chỉ lỗi Apply' },
        rec: {
          tier: 'Lead / Spec Tier',
          primary: 'Năng lực: Khóa hợp đồng hàm/API và nhánh lỗi trước khi viết code',
          secondary: 'Cấu hình trong team.yaml -> spec_models',
          reason: 'Lập Bảng hợp đồng để Writer điền đúng ngay 1–2 lượt đầu, tránh lặp sửa mù.'
        },
        plainSummary: 'Đọc scope và láng giềng 1-hop để viết Bảng hợp đồng (Input -> Output | Error) trước khi Writer vá mã.',
        operations: [
          {
            title: '01. BẢNG HỢP ĐỒNG',
            tag: 'Contract Table',
            desc: 'Chốt chữ ký hàm, kiểu trả về và nhánh lỗi theo đúng acceptance_criteria của task.'
          },
          {
            title: '02. PHÂN TẦNG RỦI RO',
            tag: 'spec_models',
            desc: 'Tự chọn model từ spec_models theo risk_level (hoặc roles.architect nếu bật riêng).'
          },
          {
            title: '03. BỎ QUA & TÁI DÙNG',
            tag: 'Smart Reuse',
            desc: 'Trả SKIP_SPEC nếu task rõ; giữ lại Spec 0-token khi chỉ vướng lỗi Applier cơ khí.'
          },
          {
            title: '04. CHỈ XUẤT TÀI LIỆU',
            tag: 'Read-Only Spec',
            desc: 'Ghi đặc tả vào state/runs/, gắn nhãn [ASSUMPTION] cho phần giả định, không sửa mã.'
          }
        ],
        proTip: 'Không cần thêm role riêng nếu đã đặt spec_models; giữ Writer khác model để tránh tự duyệt.',
        defaultImg: '/assets/roles/router.webp'
      },
      designer: {
        phase: 'PHA 02',
        specFile: 'roles/designer.md',
        title: 'DESIGNER',
        subtitle: 'Thẩm định giao diện & Đặc tả UI/UX',
        kpi1: { label: 'KÍCH HOẠT', val: 'Tác vụ UI / Có ảnh', sub: 'SKIP_SPEC nếu sửa logic nhỏ' },
        kpi2: { label: 'YÊU CẦU', val: 'Vision + CSS/DOM', sub: 'Đọc ảnh mẫu & giữ nguyên ID' },
        rec: {
          tier: 'Vision Tier',
          primary: 'Năng lực: Hỗ trợ Vision (đọc ảnh chụp), phân tích bố cục DOM/CSS',
          secondary: 'Năng lực dự phòng: Thẩm định giao diện thay thế',
          reason: 'Dùng model Vision khi cần đọc ảnh mẫu (--image) hoặc tái cấu trúc bố cục lớn.'
        },
        plainSummary: 'Kiểm tra ảnh mẫu, bố cục và tương phản màu rồi xuất đặc tả CSS/DOM cho Writer thi công.',
        operations: [
          {
            title: '01. ĐẶC TẢ UI/UX',
            tag: 'UI/UX Spec',
            desc: 'Chốt lưới bố cục, token màu và độ tương phản đạt chuẩn trước bước viết code.'
          },
          {
            title: '02. BỎ QUA THÔNG MINH',
            tag: 'Smart Skip',
            desc: 'Trả SKIP_SPEC ngay ở lượt đầu nếu chỉ gắn sự kiện JS hoặc sửa nút đơn giản.'
          },
          {
            title: '03. ĐỌC ẢNH & TOKEN',
            tag: 'Vision + Read',
            desc: 'Đọc ảnh --image và tra file giao diện qua read_file để khớp token CSS hiện hữu.'
          },
          {
            title: '04. KHÔNG PHÁ DOM',
            tag: 'No Patching',
            desc: 'Chỉ xuất spec vào state/runs/; không sửa file và không đổi ID đang gắn logic JS.'
          }
        ],
        proTip: 'Chỉ định model có Vision tại roles.designer khi làm mới hoặc chỉnh bố cục trực quan.',
        defaultImg: '/assets/roles/designer.webp'
      },
      writer: {
        phase: 'PHA 03',
        specFile: 'roles/writer.md',
        title: 'WRITER',
        subtitle: 'Thi công mã nguồn & Sinh bản vá',
        kpi1: { label: 'PHẠM VI LƯỢT', val: '2–5 lượt', sub: 'Spec: 2 | Quick: 3 | Standard: 5' },
        kpi2: { label: 'ĐẦU RA', val: 'SEARCH / REPLACE', sub: 'Chuẩn khối tìm kiếm & thay thế' },
        rec: {
          tier: 'Coder Tier',
          primary: 'Năng lực: Xuất khối SEARCH/REPLACE dài ổn định, đúng cú pháp',
          secondary: 'Năng lực dự phòng: Thay thế khi model chính lỗi API',
          reason: 'Đảm nhiệm đọc file và sinh mã nhiều nhất; models[0] chạy chính, models[1..] chỉ dự phòng.'
        },
        plainSummary: 'Đọc file trong scope, bám sát đặc tả và xuất các khối SEARCH / REPLACE để Applier ghi đĩa.',
        operations: [
          {
            title: '01. SINH BẢN VÁ',
            tag: 'Code Patch',
            desc: 'Hiện thực hóa yêu cầu và đặc tả qua khối tìm kiếm / thay thế (SEARCH / REPLACE).'
          },
          {
            title: '02. TIẾT KIỆM TOKEN',
            tag: 'Compact Output',
            desc: 'Giữ phần giải thích ngắn gọn để dồn dung lượng cho đoạn mã đầy đủ, tránh cụt khối.'
          },
          {
            title: '03. CHIA BUCKET',
            tag: 'Bucket Split',
            desc: 'Tự tách bước tuần tự khi task chạm cả Backend/Frontend hoặc file lớn >55KB.'
          },
          {
            title: '04. RÀNG BUỘC AN TOÀN',
            tag: 'Strict Scope',
            desc: 'Không sửa ngoài scope; không rút gọn bằng comment; tuân thủ định dạng dự án và .textContent.'
          }
        ],
        proTip: 'Đặt model viết code tối ưu chi phí ở models[0]; Gatekeeper sẽ kiểm test tự động 0-token.',
        defaultImg: '/assets/roles/writer.webp'
      },
      reviewer: {
        phase: 'PHA 05',
        specFile: 'roles/reviewer.md',
        title: 'REVIEWER',
        subtitle: 'Thẩm định Diff & An toàn kiến trúc',
        kpi1: { label: 'THỜI ĐIỂM', val: 'Sau khi Pass Test', sub: '1 lượt ở Standard / High' },
        kpi2: { label: 'NGỮ CẢNH', val: '~1.1K – 3K tok', sub: 'Chỉ đọc git diff rút gọn (-U8)' },
        rec: {
          tier: 'Review Tier',
          primary: 'Năng lực: Soát lỗi logic, bảo mật & sai lệch hợp đồng',
          secondary: 'Độc lập với Writer (Anti-Self-Review)',
          reason: 'Chỉ gọi 1 lượt cuối sau khi pass hết test nên tốn rất ít quota.'
        },
        plainSummary: 'Đối chiếu git diff với acceptance_criteria để bắt lỗi logic, nghẽn luồng hoặc rò rỉ tài nguyên.',
        operations: [
          {
            title: '01. ĐỐI CHIẾU TIÊU CHÍ',
            tag: 'Correctness',
            desc: 'Kiểm tra bản sửa có giải quyết đúng từng mục trong acceptance_criteria hay không.'
          },
          {
            title: '02. AN TOÀN VẬN HÀNH',
            tag: 'Safety',
            desc: 'Soát rủi ro treo luồng UI, race condition, thiếu timeout mạng và lỗ hổng bảo mật.'
          },
          {
            title: '03. PHẠM VI & TEST',
            tag: 'Scope & Test',
            desc: 'Đảm bảo không sửa lan ngoài scope và không làm yếu các điều kiện kiểm thử.'
          },
          {
            title: '04. DỰ PHÒNG LỖI MẠNG',
            tag: 'Verdict',
            desc: 'Trả JSON approve/reject; nếu dịch vụ Review sập, lưu file .patch đã pass để duyệt tay.'
          }
        ],
        proTip: 'Task quick tự bỏ qua Reviewer; task standard/high giữ Reviewer khác model với Writer.',
        defaultImg: '/assets/roles/reviewer.webp'
      },
      validator: {
        phase: 'PHA 04',
        specFile: 'scripts/applier.mjs & validator.mjs',
        title: 'GATEKEEPER',
        subtitle: 'Kiểm định cơ khí cục bộ (Applier • AST • Suite)',
        kpi1: { label: 'CHI PHÍ AI', val: '0 Token', sub: 'Chạy 100% cục bộ theo policy.yaml' },
        kpi2: { label: 'BẢO VỆ', val: 'Auto Git Rollback', sub: 'Chặn bản vá lỗi trước Reviewer' },
        rec: {
          tier: 'Local Deterministic',
          primary: 'Node.js Applier + Tree-sitter AST + Policy Checks',
          secondary: 'Cấu hình tại tab Chính sách & Test',
          reason: 'Dùng bộ kiểm tra tất định chạy thẳng trên máy để bắt lỗi ngay với 0 token AI.'
        },
        plainSummary: 'Kiểm tra quyền scope, đối chiếu chữ ký AST, chạy Fast Check và Test Suite ngay sau khi Writer xuất patch.',
        operations: [
          {
            title: '01. KHÓA SCOPE',
            tag: 'applier.mjs',
            desc: 'Chặn mọi khối sửa chạm file ngoài scope hoặc nằm trong danh sách protected_files.'
          },
          {
            title: '02. CỔNG AST CHỮ KÝ',
            tag: 'Tree-sitter',
            desc: 'Chặn ngay nếu Writer đổi chữ ký hàm đang được file ngoài scope gọi.'
          },
          {
            title: '03. TOÀN VẸN TEST',
            tag: 'Anti-Tamper',
            desc: 'Cấm xóa bài test, gắn cờ skip hoặc làm yếu assert để qua mặt kiểm thử.'
          },
          {
            title: '04. ROLLBACK TỰ ĐỘNG',
            tag: 'git-guard.mjs',
            desc: 'Chạy Fast Check + Suite; nếu thất bại hết retry thì tự rollback về trạng thái sạch.'
          }
        ],
        proTip: 'Tùy chỉnh lệnh Fast/Suite Check, timeout và danh sách tệp bảo vệ ở tab Chính sách & Test.',
        defaultImg: '/assets/roles/gatekeeper.webp'
      }
    };

    // Clean up any legacy localStorage portrait keys so roles always load fixed static files
    try {
      ['router', 'architect', 'designer', 'writer', 'reviewer', 'validator'].forEach(r => {
        localStorage.removeItem(`cockpit_role_portrait_${r}`);
      });
    } catch {}

    function formatSpecModelsSummary(specModels) {
      if (!specModels || typeof specModels !== 'object') return '';
      const low = specModels.low || specModels.medium || '';
      const med = specModels.medium || low;
      const high = specModels.high || specModels.critical || '';
      const parts = [];
      if (low) parts.push(`low/med: ${String(low).split('/').pop()}`);
      else if (med) parts.push(`med: ${String(med).split('/').pop()}`);
      if (high) parts.push(`high/crit: ${String(high).split('/').pop()}`);
      return parts.join(' | ');
    }

    function getAssignedModelForRole(roleKey) {
      if (roleKey === 'validator') {
        return 'Local 0-Token Engine';
      }
      const matches = squadMembers.filter(m => m.role === roleKey);
      if (matches.length > 0) {
        const first = matches[0].name || matches[0].model.split('/').pop();
        return matches.length === 1 ? first : `${first} (+${matches.length - 1})`;
      }
      const cfgRole = currentSquadRolesConfig?.[roleKey];
      if (cfgRole && cfgRole.enabled !== false && (cfgRole.model || cfgRole.default_model)) {
        const raw = cfgRole.display_name || cfgRole.model || cfgRole.default_model;
        return String(raw).split('/').pop();
      }
      if (roleKey === 'architect') {
        const specSummary = formatSpecModelsSummary(currentSpecModels);
        return specSummary ? `spec_models (${specSummary})` : 'Tự động theo spec_models';
      }
      return 'Chưa gán';
    }

    function updateDossierPortraitImage(roleKey, roleInfo) {
      const imgEl = document.getElementById('dossier-portrait-img');
      if (!imgEl) return;
      imgEl.src = roleInfo.defaultImg;
    }

    function renderRoleDossier(roleKey = 'router') {
      const roleInfo = ROLE_DOSSIER_CATALOG[roleKey] || ROLE_DOSSIER_CATALOG.router;
      activeDossierRole = roleKey;

      const stageGrid = document.getElementById('dossier-stage-grid');
      if (stageGrid) {
        stageGrid.setAttribute('data-active-role', roleKey);
      }

      // Highlight active selector tab
      document.querySelectorAll('.dossier-role-tab').forEach(btn => {
        if (btn.dataset.role === roleKey) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // Text fields (Strict .textContent for Anti-XSS)
      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setTxt('dossier-phase-badge', roleInfo.phase);
      setTxt('dossier-spec-file', roleInfo.specFile);
      setTxt('dossier-role-title', roleInfo.title);
      setTxt('dossier-role-subtitle', roleInfo.subtitle);

      setTxt('dossier-kpi-1-label', roleInfo.kpi1.label);
      setTxt('dossier-kpi-1-val', roleInfo.kpi1.val);
      setTxt('dossier-kpi-1-sub', roleInfo.kpi1.sub);

      setTxt('dossier-kpi-2-label', roleInfo.kpi2.label);
      setTxt('dossier-kpi-2-val', roleInfo.kpi2.val);
      setTxt('dossier-kpi-2-sub', roleInfo.kpi2.sub);

      // Recommended Model Card (read dynamically from live team.yaml when configured)
      const cfgRole = currentSquadRolesConfig?.[roleKey];
      let cfgPrimary = cfgRole && cfgRole.enabled !== false
        ? (extractModelId(Array.isArray(cfgRole.models) ? cfgRole.models[0] : null) || cfgRole.default_model || cfgRole.model || '')
        : '';
      let cfgSecondary = cfgRole && cfgRole.enabled !== false
        ? (extractModelId(Array.isArray(cfgRole.models) ? cfgRole.models[1] : null) || cfgRole.escalation_model || cfgRole.fallback_model || '')
        : '';
      if (roleKey === 'architect' && !cfgPrimary && currentSpecModels) {
        cfgPrimary = currentSpecModels.low || currentSpecModels.medium || '';
        cfgSecondary = currentSpecModels.high || currentSpecModels.critical || '';
      }
      setTxt('dossier-rec-tier-badge', roleInfo.rec.tier);
      setTxt('dossier-rec-primary', cfgPrimary || roleInfo.rec.primary);
      setTxt('dossier-rec-secondary', cfgSecondary || roleInfo.rec.secondary);
      setTxt('dossier-rec-reason', roleInfo.rec.reason);

      // Portrait & Assigned Model
      setTxt('dossier-active-model-pill', `Đang gán: ${getAssignedModelForRole(roleKey)}`);
      updateDossierPortraitImage(roleKey, roleInfo);

      // Right Column: Overview, 4 Specification Cards & Quota Note
      setTxt('dossier-plain-summary', roleInfo.plainSummary);
      setTxt('dossier-protip-text', roleInfo.proTip);

      const opListEl = document.getElementById('dossier-op-list');
      if (opListEl) {
        opListEl.textContent = '';
        roleInfo.operations.forEach(op => {
          const card = document.createElement('div');
          card.className = 'dossier-op-card';

          const top = document.createElement('div');
          top.className = 'dossier-op-top';
          const titleSpan = document.createElement('span');
          titleSpan.className = 'dossier-op-title';
          titleSpan.textContent = op.title;
          const tagSpan = document.createElement('span');
          tagSpan.className = 'dossier-op-tag';
          tagSpan.textContent = op.tag;
          top.appendChild(titleSpan);
          top.appendChild(tagSpan);

          const descP = document.createElement('p');
          descP.className = 'dossier-op-desc';
          descP.textContent = op.desc;

          card.appendChild(top);
          card.appendChild(descP);
          opListEl.appendChild(card);
        });
      }
    }

    function switchConfigTab(tabName) {
      activeConfigTab = tabName;
      cfgNavTabs.forEach(t => {
        if (t.dataset.tab === tabName) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
      if (tabName === 'team') {
        if (cfgPanelTeam) cfgPanelTeam.style.display = 'flex';
        if (cfgPanelRoles) cfgPanelRoles.style.display = 'none';
        if (cfgPanelProject) cfgPanelProject.style.display = 'none';
        if (btnSaveTeamConfigEl) btnSaveTeamConfigEl.style.display = 'inline-flex';
        if (txtBtnSaveConfig) txtBtnSaveConfig.textContent = 'Lưu Đội ngũ';
      } else if (tabName === 'roles') {
        if (cfgPanelTeam) cfgPanelTeam.style.display = 'none';
        if (cfgPanelRoles) cfgPanelRoles.style.display = 'flex';
        if (cfgPanelProject) cfgPanelProject.style.display = 'none';
        if (btnSaveTeamConfigEl) btnSaveTeamConfigEl.style.display = 'none';
        renderRoleDossier(activeDossierRole);
      } else {
        if (cfgPanelTeam) cfgPanelTeam.style.display = 'none';
        if (cfgPanelRoles) cfgPanelRoles.style.display = 'none';
        if (cfgPanelProject) cfgPanelProject.style.display = 'flex';
        if (btnSaveTeamConfigEl) btnSaveTeamConfigEl.style.display = 'inline-flex';
        if (txtBtnSaveConfig) txtBtnSaveConfig.textContent = 'Lưu Chính sách';
        loadPolicyData();
      }
    }

    cfgNavTabs.forEach(tab => {
      tab.addEventListener('click', () => switchConfigTab(tab.dataset.tab));
    });

    // Role Dossier Tab Event Listeners
    document.querySelectorAll('.dossier-role-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        renderRoleDossier(btn.dataset.role || 'router');
      });
    });

    document.querySelectorAll('[data-role-jump]').forEach(pill => {
      pill.addEventListener('click', () => {
        const targetRole = pill.getAttribute('data-role-jump') || 'router';
        activeDossierRole = targetRole;
        switchConfigTab('roles');
      });
    });

    const btnOpenRoleGuide = document.getElementById('btn-open-role-guide');
    if (btnOpenRoleGuide) {
      btnOpenRoleGuide.addEventListener('click', () => {
        switchConfigTab('roles');
      });
    }

    const btnDossierAssignShortcut = document.getElementById('btn-dossier-assign-shortcut');
    if (btnDossierAssignShortcut) {
      btnDossierAssignShortcut.addEventListener('click', () => {
        switchConfigTab('team');
      });
    }

    function openConfigModal() {
      if (modalConfigOverlay) {
        modalConfigOverlay.style.display = 'flex';
        switchConfigTab(activeConfigTab);
        initSquadFromConfig(true);
        load9RouterModels();
        loadPolicyData();
      }
    }
    function closeConfigModal() {
      if (modalConfigOverlay) {
        modalConfigOverlay.style.display = 'none';
      }
    }
    if (btnHeaderConfig) btnHeaderConfig.addEventListener('click', openConfigModal);
    if (btnCloseConfigModal) btnCloseConfigModal.addEventListener('click', closeConfigModal);
    if (modalConfigOverlay) {
      modalConfigOverlay.addEventListener('click', (e) => {
        if (e.target === modalConfigOverlay) closeConfigModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalConfigOverlay && modalConfigOverlay.style.display === 'flex') {
        closeConfigModal();
      }
    });

    // =========================================================
    // CONFIG HUB: MODEL-FIRST SQUAD PERSONNEL & ROLE ASSIGNMENT
    // =========================================================
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    let available9RouterModels = [];
    let currentSquadRolesConfig = {};
    let squadMembers = []; // [{ model, name, role, latency_ms, status }]
    let activeFilter = 'all';

    const cfgRouterBadge = document.getElementById('cfg-router-badge');
    const btnRefreshModels = document.getElementById('btn-refresh-models');
    const spinRefreshModels = document.getElementById('spin-refresh-models');
    const cfgSearchModels = document.getElementById('cfg-search-models');
    const cfgModelsCountText = document.getElementById('cfg-models-count-text');
    const squadMembersList = document.getElementById('squad-members-list');
    const squadCountBadge = document.getElementById('squad-count-badge');
    const modelPoolGrid = document.getElementById('model-pool-grid');
    const btnCancelConfig = document.getElementById('btn-cancel-config');
    const btnSaveTeamConfig = document.getElementById('btn-save-team-config');
    const spinSaveConfig = document.getElementById('spin-save-config');
    const cfgSaveStatusMsg = document.getElementById('cfg-save-status-msg');

    const cfg9RouterUrl = document.getElementById('cfg-9router-url');
    const cfg9RouterKey = document.getElementById('cfg-9router-key');
    const btnReconnect9router = document.getElementById('btn-reconnect-9router');
    const spinReconnect = document.getElementById('spin-reconnect');
    const routerConnStatusBadge = document.getElementById('router-conn-status-badge');

    const covPills = {
      router: document.getElementById('cov-pill-router'),
      architect: document.getElementById('cov-pill-architect'),
      writer: document.getElementById('cov-pill-writer'),
      designer: document.getElementById('cov-pill-designer'),
      reviewer: document.getElementById('cov-pill-reviewer')
    };
    const specModelsSummaryBar = document.getElementById('spec-models-summary-bar');
    const squadTabCountBadge = document.getElementById('squad-tab-count-badge');

    function formatSpecTierPills(specModels) {
      if (!specModels || typeof specModels !== 'object') return [];
      const low = specModels.low || specModels.medium || '';
      const med = specModels.medium || low;
      const high = specModels.high || specModels.critical || '';
      const pills = [];
      if (low) pills.push(`Low/Med · ${String(low).split('/').pop()}`);
      else if (med) pills.push(`Med · ${String(med).split('/').pop()}`);
      if (high) pills.push(`High/Crit · ${String(high).split('/').pop()}`);
      return pills;
    }

    function renderSpecModelsSummaryBar(specModels) {
      if (!specModelsSummaryBar) return;
      const pills = formatSpecTierPills(specModels);
      specModelsSummaryBar.replaceChildren();
      if (pills.length === 0) {
        specModelsSummaryBar.style.display = 'none';
        return;
      }
      specModelsSummaryBar.style.display = 'flex';
      const lbl = document.createElement('span');
      lbl.className = 'spec-bar-label';
      lbl.textContent = 'Architect tự động:';
      specModelsSummaryBar.appendChild(lbl);
      pills.forEach(text => {
        const pill = document.createElement('span');
        pill.className = 'spec-tier-pill';
        pill.textContent = text;
        specModelsSummaryBar.appendChild(pill);
      });
    }

    async function load9RouterModels(force = false) {
      if (available9RouterModels.length > 0 && !force) {
        renderModelPool();
        return;
      }
      if (spinRefreshModels) spinRefreshModels.style.display = 'inline-block';
      if (spinReconnect) spinReconnect.style.display = 'inline-block';
      if (cfgModelsCountText) cfgModelsCountText.textContent = '...';

      const customUrl = (cfg9RouterUrl?.value || '').trim();
      const customKey = (cfg9RouterKey?.value || '').trim();
      let queryStr = '';
      if (customUrl) queryStr += `?url=${encodeURIComponent(customUrl)}`;
      if (customKey) queryStr += `${queryStr ? '&' : '?'}key=${encodeURIComponent(customKey)}`;

      let activeHostLabel = currentRouterHostLabel || ':20128';
      if (customUrl) {
        try {
          const parsedUrl = new URL(customUrl);
          activeHostLabel = parsedUrl.port ? `:${parsedUrl.port}` : (parsedUrl.host || activeHostLabel);
        } catch {}
      }

      try {
        const data = await (await fetch(`/api/models${queryStr}`)).json();

        if (data.ok && Array.isArray(data.models)) {
          available9RouterModels = data.models;
          if (cfgModelsCountText) {
            cfgModelsCountText.textContent = String(data.models.length);
          }
          if (cfgRouterBadge) {
            cfgRouterBadge.className = 'cfg-router-status-pill';
            cfgRouterBadge.textContent = `9Router ${activeHostLabel}`;
          }
          if (routerConnStatusBadge) {
            routerConnStatusBadge.className = 'router-conn-status online';
            routerConnStatusBadge.textContent = `✓ Đã kết nối • ${data.models.length} models`;
          }
          renderModelPool();
        } else {
          throw new Error(data.error || 'Dữ liệu model rỗng');
        }
      } catch (err) {
        if (cfgModelsCountText) cfgModelsCountText.textContent = '0';
        if (routerConnStatusBadge) {
          routerConnStatusBadge.className = 'router-conn-status offline';
          routerConnStatusBadge.textContent = '✕ Lỗi kết nối';
        }
        if (cfgRouterBadge) {
          cfgRouterBadge.className = 'cfg-router-status-pill';
          cfgRouterBadge.style.color = '#f87171';
          cfgRouterBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          cfgRouterBadge.textContent = `9Router ${activeHostLabel} DOWN`;
        }
        if (modelPoolGrid) {
          modelPoolGrid.replaceChildren();
          const errBox = document.createElement('div');
          errBox.style.padding = '16px';
          errBox.style.background = 'rgba(239, 68, 68, 0.08)';
          errBox.style.border = '1px solid rgba(239, 68, 68, 0.25)';
          errBox.style.borderRadius = '6px';
          errBox.style.fontSize = '11.5px';
          errBox.style.color = '#fca5a5';

          const strongEl = document.createElement('strong');
          strongEl.textContent = 'Chú ý: ';
          const msgTxt = document.createTextNode(String(err.message || 'Lỗi kết nối'));
          const brEl = document.createElement('br');
          const hintSpan = document.createElement('span');
          hintSpan.style.fontSize = '11px';
          hintSpan.style.opacity = '0.8';
          hintSpan.style.marginTop = '4px';
          hintSpan.style.display = 'inline-block';
          hintSpan.textContent = 'Gợi ý: Nếu bạn vừa cập nhật code, hãy bấm Ctrl + C trong terminal đang chạy Dashboard và chạy lại: node agent-team/scripts/dashboard.mjs';

          errBox.append(strongEl, msgTxt, brEl, hintSpan);
          modelPoolGrid.appendChild(errBox);
        }
      } finally {
        if (spinRefreshModels) spinRefreshModels.style.display = 'none';
        if (spinReconnect) spinReconnect.style.display = 'none';
      }
    }

    if (btnReconnect9router) {
      btnReconnect9router.addEventListener('click', () => load9RouterModels(true));
    }

    function extractModelId(entry) {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        return String(entry.id || entry.model || '').trim();
      }
      return '';
    }

    function isModelEntryDisabled(entry) {
      return Boolean(entry && typeof entry === 'object' && entry.disabled === true);
    }

    // Khởi tạo squadMembers từ snapshot config hiện có
    function initSquadFromConfig(force = false) {
      if (squadMembers.length > 0 && !force) {
        renderSquadPersonnel();
        return;
      }
      const initial = [];
      const roles = currentSquadRolesConfig || {};

      for (const [rKey, rSpec] of Object.entries(roles)) {
        if (!rSpec || typeof rSpec !== 'object' || rSpec.enabled === false) continue;
        const rawList = Array.isArray(rSpec.models) && rSpec.models.length > 0
          ? rSpec.models
          : (rSpec.model ? [rSpec.model] : []);

        rawList.forEach(entry => {
          if (isModelEntryDisabled(entry)) return;
          const cleanId = extractModelId(entry);
          if (!cleanId) return;
          const shortSlug = cleanId.split('/').pop() || cleanId;
          initial.push({
            model: cleanId,
            name: shortSlug,
            role: rKey,
            latency_ms: null,
            status: 'ready'
          });
        });
      }

      // Khi team.yaml rỗng hoặc không có vai trò nào, giữ nguyên mảng rỗng để phản ánh trung thực trạng thái
      squadMembers = initial;
      renderSquadPersonnel();
      renderModelPool();
    }

    // Render Compact Horizontal Rows (Cao ~54px, chống tràn text)
    function createCapabilityBadge(label) {
      const span = document.createElement('span');
      span.className = 'badge-neutral';
      span.textContent = label;
      return span;
    }

    function splitModelDisplayParts(modelId) {
      const clean = String(modelId || '').trim();
      const idx = clean.lastIndexOf('/');
      if (idx <= 0) return { provider: 'local', slug: clean };
      return {
        provider: clean.slice(0, idx),
        slug: clean.slice(idx + 1)
      };
    }

    function renderSquadPersonnel() {
      if (!squadMembersList) return;
      squadMembersList.replaceChildren();

      if (squadCountBadge) squadCountBadge.textContent = `${squadMembers.length} model`;
      if (squadTabCountBadge) squadTabCountBadge.textContent = `${squadMembers.length}`;

      if (squadMembers.length === 0) {
        const emptyNotice = document.createElement('div');
        emptyNotice.className = 'empty-squad-notice';
        emptyNotice.textContent = 'Chưa có model trong đội. Chọn model ở Kho Model bên dưới để thêm.';
        squadMembersList.appendChild(emptyNotice);
        updateRoleCoverageMatrix();
        return;
      }

      const roleOptions = [
        { value: 'standby', label: 'Dự bị' },
        { value: 'router', label: 'Router · Điều phối' },
        { value: 'architect', label: 'Architect · Đặc tả' },
        { value: 'writer', label: 'Writer · Viết code' },
        { value: 'designer', label: 'Designer · Giao diện' },
        { value: 'reviewer', label: 'Reviewer · Duyệt code' }
      ];
      const standardRoles = new Set(roleOptions.map(o => o.value));

      // Compute role occurrence counts & per-member index for Chính / Dự phòng tags
      const roleTotalCount = {};
      const roleSeenCount = {};
      squadMembers.forEach(m => {
        if (m.role && m.role !== 'standby') {
          roleTotalCount[m.role] = (roleTotalCount[m.role] || 0) + 1;
        }
      });

      squadMembers.forEach((member, idx) => {
        const row = document.createElement('div');
        row.className = 'squad-compact-row';
        row.title = member.model;

        const matchedInPool = available9RouterModels.find(m => m.id === member.model);
        const caps = matchedInPool?.capabilities || {
          vision: member.model.includes('gemini') || member.model.includes('claude'),
          tools: true,
          reasoning: member.model.includes('thinking') || member.model.includes('opus') || member.model.includes('sonnet')
        };

        const parts = splitModelDisplayParts(member.model);
        const roleKey = member.role || 'standby';

        const left = document.createElement('div');
        left.className = 'compact-left';

        const roleDot = document.createElement('span');
        roleDot.className = `squad-role-dot dot-role-${standardRoles.has(roleKey) ? roleKey : 'standby'}`;

        const titleLine = document.createElement('div');
        titleLine.className = 'compact-title-line';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'compact-model-name';
        nameSpan.textContent = parts.slug || member.name || member.model;
        const provSpan = document.createElement('span');
        provSpan.className = 'compact-provider-tag';
        provSpan.textContent = parts.provider;
        titleLine.append(nameSpan, provSpan);

        left.append(roleDot, titleLine);

        if (roleKey !== 'standby' && (roleTotalCount[roleKey] || 0) >= 2) {
          const ord = roleSeenCount[roleKey] || 0;
          roleSeenCount[roleKey] = ord + 1;
          const slotTag = document.createElement('span');
          slotTag.className = ord === 0 ? 'compact-slot-tag' : 'compact-slot-tag is-fallback';
          slotTag.textContent = ord === 0 ? 'Chính' : 'Dự phòng';
          left.appendChild(slotTag);
        }

        if (caps.vision || caps.reasoning) {
          const badgesRow = document.createElement('div');
          badgesRow.className = 'compact-badges-row';
          if (caps.vision) badgesRow.appendChild(createCapabilityBadge('Vision'));
          if (caps.reasoning) badgesRow.appendChild(createCapabilityBadge('Thinking'));
          left.appendChild(badgesRow);
        }

        const right = document.createElement('div');
        right.className = 'compact-right';

        const selectEl = document.createElement('select');
        selectEl.className = 'compact-role-select';
        selectEl.dataset.idx = String(idx);
        roleOptions.forEach(optDef => {
          const opt = document.createElement('option');
          opt.value = optDef.value;
          opt.textContent = optDef.label;
          if (member.role === optDef.value) opt.selected = true;
          selectEl.appendChild(opt);
        });
        if (!standardRoles.has(member.role) && member.role) {
          const customOpt = document.createElement('option');
          customOpt.value = member.role;
          customOpt.textContent = member.role;
          customOpt.selected = true;
          selectEl.appendChild(customOpt);
        }

        const btnTest = document.createElement('button');
        btnTest.type = 'button';
        btnTest.dataset.idx = String(idx);
        if (member.testing) {
          btnTest.className = 'btn-compact-test btn-test-member is-testing';
          btnTest.textContent = '...';
          btnTest.title = 'Đang đo độ trễ';
        } else if (member.latency_ms !== null) {
          if (member.error) {
            btnTest.className = 'btn-compact-test btn-test-member is-err';
            btnTest.textContent = '✕ Lỗi';
            btnTest.title = String(member.error);
          } else {
            btnTest.className = 'btn-compact-test btn-test-member is-ok';
            btnTest.textContent = `✓ ${member.latency_ms}ms`;
            btnTest.title = 'Đo lại độ trễ';
          }
        } else {
          btnTest.className = 'btn-compact-test btn-test-member';
          btnTest.textContent = 'Ping';
          btnTest.title = 'Đo độ trễ mạng thực tế';
        }

        const btnRemove = document.createElement('button');
        btnRemove.type = 'button';
        btnRemove.className = 'btn-compact-remove';
        btnRemove.dataset.idx = String(idx);
        btnRemove.title = 'Gỡ khỏi đội ngũ';
        btnRemove.textContent = '✕';

        right.append(selectEl, btnTest, btnRemove);
        row.append(left, right);
        squadMembersList.appendChild(row);
      });

      // Events
      squadMembersList.querySelectorAll('.compact-role-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          if (squadMembers[idx]) {
            squadMembers[idx].role = e.target.value;
            renderSquadPersonnel();
          }
        });
      });

      squadMembersList.querySelectorAll('.btn-test-member').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const member = squadMembers[idx];
          if (!member) return;

          member.testing = true;
          member.error = null;
          renderSquadPersonnel();

          const result = await pingModelTest(member.model);
          member.testing = false;
          member.latency_ms = result.latency_ms;
          if (!result.ok) {
            member.error = result.error;
          }
          renderSquadPersonnel();
        });
      });

      squadMembersList.querySelectorAll('.btn-compact-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const removed = squadMembers[idx];
          squadMembers.splice(idx, 1);
          renderSquadPersonnel();
          renderModelPool();
          if (cfgSaveStatusMsg) {
            cfgSaveStatusMsg.textContent = `● Đã gỡ "${removed?.name || 'model'}". Bấm "Lưu Đội ngũ" để áp dụng.`;
            cfgSaveStatusMsg.style.color = '#f59e0b';
          }
          if (txtBtnSaveConfig) {
            txtBtnSaveConfig.textContent = 'Lưu Đội ngũ ●';
          }
        });
      });

      updateRoleCoverageMatrix();
    }

    function updateRoleCoverageMatrix() {
      const assignedMap = {};
      squadMembers.forEach(m => {
        if (m.role && m.role !== 'standby') {
          if (!assignedMap[m.role]) assignedMap[m.role] = [];
          const slug = String(m.model || '').split('/').pop() || m.name || m.model;
          assignedMap[m.role].push(slug);
        }
      });

      const roleDisplayNames = {
        router: 'Router',
        architect: 'Architect',
        writer: 'Writer',
        designer: 'Designer',
        reviewer: 'Reviewer'
      };

      const truncSlug = (s, maxLen = 16) => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s);

      for (const [rKey, pillEl] of Object.entries(covPills)) {
        if (!pillEl) continue;
        const roleName = roleDisplayNames[rKey] || (rKey.charAt(0).toUpperCase() + rKey.slice(1));
        const list = assignedMap[rKey] || [];
        pillEl.replaceChildren();
        pillEl.appendChild(document.createTextNode(`${roleName}: `));
        const strongEl = document.createElement('strong');
        if (list.length > 0) {
          pillEl.className = 'cov-mini-pill cov-pill-clickable assigned';
          const shortFirst = truncSlug(list[0]);
          strongEl.textContent = list.length === 1 ? shortFirst : `${shortFirst} (+${list.length - 1})`;
          pillEl.title = `${roleName}: ${list.join(', ')}`;
        } else if (rKey === 'architect' && currentSpecModels) {
          pillEl.className = 'cov-mini-pill cov-pill-clickable assigned';
          strongEl.textContent = 'Auto';
          const specSum = formatSpecModelsSummary(currentSpecModels);
          pillEl.title = specSum ? `Architect tự động (${specSum})` : 'Architect tự động theo spec_models';
        } else {
          pillEl.className = 'cov-mini-pill cov-pill-clickable';
          strongEl.textContent = 'Khuyết';
          pillEl.title = `${roleName}: Chưa gán model`;
        }
        pillEl.appendChild(strongEl);
      }
    }

    // Render Kho Model 9Router (Horizontal Scroll Track)
    function renderModelPool() {
      if (!modelPoolGrid) return;
      modelPoolGrid.replaceChildren();

      const kw = (cfgSearchModels ? cfgSearchModels.value : '').toLowerCase().trim();
      const existingModelSet = new Set(squadMembers.map(m => m.model));

      let filtered = available9RouterModels;
      if (kw) {
        filtered = filtered.filter(m => m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw) || (m.owned_by || '').toLowerCase().includes(kw));
      }
      if (activeFilter === 'vision') {
        filtered = filtered.filter(m => m.capabilities?.vision);
      } else if (activeFilter === 'thinking') {
        filtered = filtered.filter(m => m.capabilities?.reasoning);
      } else if (activeFilter === 'tools') {
        filtered = filtered.filter(m => m.capabilities?.tools);
      }

      if (filtered.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.style.padding = '20px';
        emptyEl.style.textAlign = 'center';
        emptyEl.style.color = 'var(--text-muted)';
        emptyEl.style.fontSize = '11.5px';
        emptyEl.style.whiteSpace = 'nowrap';
        emptyEl.textContent = `Không có model khớp "${kw || activeFilter}".`;
        modelPoolGrid.appendChild(emptyEl);
        return;
      }

      filtered.forEach(m => {
        const card = document.createElement('div');
        const isAdded = existingModelSet.has(m.id);
        card.className = 'pool-card-compact' + (isAdded ? ' in-squad' : '');
        card.title = m.id;

        const parts = splitModelDisplayParts(m.id);

        const top = document.createElement('div');
        top.className = 'pool-card-top';
        const nameEl = document.createElement('div');
        nameEl.className = 'pool-card-name';
        nameEl.textContent = m.name || parts.slug;
        const idEl = document.createElement('div');
        idEl.className = 'pool-card-id';
        idEl.textContent = parts.provider;
        top.append(nameEl, idEl);

        if (m.capabilities?.vision || m.capabilities?.reasoning) {
          const badgesEl = document.createElement('div');
          badgesEl.className = 'pool-card-badges';
          if (m.capabilities?.vision) badgesEl.appendChild(createCapabilityBadge('Vision'));
          if (m.capabilities?.reasoning) badgesEl.appendChild(createCapabilityBadge('Thinking'));
          top.appendChild(badgesEl);
        }

        const actionsEl = document.createElement('div');
        actionsEl.className = 'pool-card-actions';

        const btnTest = document.createElement('button');
        btnTest.type = 'button';
        btnTest.className = 'btn-pool-test';
        btnTest.dataset.model = m.id;
        const spTest = document.createElement('span');
        spTest.textContent = 'Ping';
        const spLbl = document.createElement('span');
        spLbl.className = 'pool-test-lbl';
        btnTest.append(spTest, spLbl);
        actionsEl.appendChild(btnTest);

        if (isAdded) {
          const addedSpan = document.createElement('span');
          addedSpan.className = 'btn-pool-added-badge';
          addedSpan.textContent = '✓ Đã chọn';
          actionsEl.appendChild(addedSpan);
        } else {
          const btnAdd = document.createElement('button');
          btnAdd.type = 'button';
          btnAdd.className = 'btn-pool-add';
          btnAdd.dataset.model = m.id;
          btnAdd.dataset.name = m.name || parts.slug;
          btnAdd.textContent = '+ Thêm';
          actionsEl.appendChild(btnAdd);
        }

        card.append(top, actionsEl);
        modelPoolGrid.appendChild(card);
      });

      // Events for pool buttons
      modelPoolGrid.querySelectorAll('.btn-pool-add').forEach(btn => {
        btn.addEventListener('click', () => {
          const modelId = btn.dataset.model;
          const modelName = btn.dataset.name;
          squadMembers.push({
            model: modelId,
            name: modelName,
            role: 'standby',
            latency_ms: null,
            status: 'ready'
          });
          renderSquadPersonnel();
          renderModelPool();
        });
      });

      modelPoolGrid.querySelectorAll('.btn-pool-test').forEach(btn => {
        btn.addEventListener('click', async () => {
          const modelId = btn.dataset.model;
          const lbl = btn.querySelector('.pool-test-lbl');
          if (lbl) lbl.textContent = '...';
          btn.style.opacity = '0.7';

          const res = await pingModelTest(modelId);
          if (lbl) {
            lbl.textContent = res.ok ? `${res.latency_ms}ms` : 'Lỗi';
          }
          btn.style.opacity = '1';
          btn.style.borderColor = res.ok ? '#10b981' : '#ef4444';
          btn.style.color = res.ok ? '#34d399' : '#f87171';
        });
      });
    }

    async function pingModelTest(model) {
      if (window.CockpitApi?.testModel) {
        return window.CockpitApi.testModel(model);
      }
      const start = Date.now();
      try {
        const res = await fetch('/api/test-model', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Token': csrfToken || ''
          },
          body: JSON.stringify({ model })
        });
        if (!res.ok) {
          return { ok: false, latency_ms: Date.now() - start, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        return data;
      } catch (err) {
        return { ok: false, latency_ms: Date.now() - start, error: err.message };
      }
    }

    // Filter pill events
    const filterButtons = document.querySelectorAll('.cfg-filter-btn, .btn-filter-pill');
    filterButtons.forEach(pill => {
      pill.addEventListener('click', () => {
        filterButtons.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeFilter = pill.dataset.filter || 'all';
        renderModelPool();
      });
    });

    if (cfgSearchModels) {
      cfgSearchModels.addEventListener('input', () => renderModelPool());
    }

    if (btnRefreshModels) {
      btnRefreshModels.addEventListener('click', () => load9RouterModels(true));
    }

    // =========================================================
    // POLICY HUB: POLICY.YAML RENDERING & EXECUTION
    // =========================================================
    function loadPolicyData() {
      if (!currentPolicyConfig) return;
      const pol = currentPolicyConfig;

      // 1. Validation fast & suite
      const fastCmd = document.getElementById('cfg-fast-cmd');
      const fastTimeout = document.getElementById('cfg-fast-timeout');
      const suiteCmd = document.getElementById('cfg-suite-cmd');
      const suiteTimeout = document.getElementById('cfg-suite-timeout');

      if (fastCmd && pol.validation?.fast_checks?.[0]?.run) {
        fastCmd.value = pol.validation.fast_checks[0].run;
      }
      if (fastTimeout && pol.validation?.fast_checks?.[0]?.timeout_sec) {
        fastTimeout.value = pol.validation.fast_checks[0].timeout_sec;
      }
      if (suiteCmd && pol.validation?.suite_checks?.[0]?.run) {
        suiteCmd.value = pol.validation.suite_checks[0].run;
      }
      if (suiteTimeout && pol.validation?.suite_checks?.[0]?.timeout_sec) {
        suiteTimeout.value = pol.validation.suite_checks[0].timeout_sec;
      }

      // 2. Scope control
      const maxFiles = document.getElementById('cfg-max-files');
      const maxScopeInc = document.getElementById('cfg-max-scope-inc');
      const allowNewFiles = document.getElementById('cfg-allow-new-files');
      const strictScope = document.getElementById('cfg-strict-scope');

      if (maxFiles && pol.scope_control?.max_files_per_task !== undefined) {
        maxFiles.value = pol.scope_control.max_files_per_task;
      }
      if (maxScopeInc && pol.scope_control?.max_scope_increase !== undefined) {
        maxScopeInc.value = pol.scope_control.max_scope_increase;
      }
      if (allowNewFiles && pol.scope_control?.allow_new_files !== undefined) {
        allowNewFiles.checked = Boolean(pol.scope_control.allow_new_files);
      }
      if (strictScope && pol.scope_control?.strict_scope_enforcement !== undefined) {
        strictScope.checked = Boolean(pol.scope_control.strict_scope_enforcement);
      }

      // Allowed dirs & protected files badges
      const wrapAllowedDirs = document.getElementById('wrap-allowed-dirs');
      if (wrapAllowedDirs && Array.isArray(pol.scope_control?.allowed_dirs)) {
        wrapAllowedDirs.replaceChildren();
        pol.scope_control.allowed_dirs.forEach(d => {
          const badge = document.createElement('span');
          badge.className = 'dir-badge';
          badge.textContent = d;
          wrapAllowedDirs.appendChild(badge);
        });
      }

      const wrapProtectedFiles = document.getElementById('wrap-protected-files');
      if (wrapProtectedFiles && Array.isArray(pol.scope_control?.protected_files)) {
        wrapProtectedFiles.replaceChildren();
        pol.scope_control.protected_files.forEach(f => {
          const badge = document.createElement('span');
          badge.className = 'prot-badge';
          badge.textContent = f;
          wrapProtectedFiles.appendChild(badge);
        });
      }

      // 3. Guardrails & Git hygiene
      const gitRollback = document.getElementById('cfg-git-rollback');
      const gitAutocommit = document.getElementById('cfg-git-autocommit');
      const enforceTimeouts = document.getElementById('cfg-enforce-timeouts');
      const blockPsCurl = document.getElementById('cfg-block-ps-curl');
      const maxRetries = document.getElementById('cfg-max-retries');
      const tokenBudget = document.getElementById('cfg-token-budget');

      if (gitRollback && pol.git_hygiene?.rollback_on_validation_fail !== undefined) {
        gitRollback.checked = Boolean(pol.git_hygiene.rollback_on_validation_fail);
      }
      if (gitAutocommit && pol.git_hygiene?.auto_commit_on_done !== undefined) {
        gitAutocommit.checked = Boolean(pol.git_hygiene.auto_commit_on_done);
      }
      if (enforceTimeouts && pol.execution_guardrails?.enforce_command_timeouts !== undefined) {
        enforceTimeouts.checked = Boolean(pol.execution_guardrails.enforce_command_timeouts);
      }
      if (blockPsCurl && pol.execution_guardrails?.block_powershell_curl_alias !== undefined) {
        blockPsCurl.checked = Boolean(pol.execution_guardrails.block_powershell_curl_alias);
      }
      if (maxRetries && pol.retry_and_escalation?.max_retries_per_task !== undefined) {
        maxRetries.value = pol.retry_and_escalation.max_retries_per_task;
      }
      if (tokenBudget && pol.retry_and_escalation?.token_budget_per_task !== undefined) {
        tokenBudget.value = pol.retry_and_escalation.token_budget_per_task;
      }
    }

    // Validation Check Test Runners
    const btnRunFastCheck = document.getElementById('btn-run-fast-check');
    const spinFastCheck = document.getElementById('spin-fast-check');
    const fastCheckBadge = document.getElementById('fast-check-badge');

    const btnRunSuiteCheck = document.getElementById('btn-run-suite-check');
    const spinSuiteCheck = document.getElementById('spin-suite-check');
    const suiteCheckBadge = document.getElementById('suite-check-badge');

    const policyTestOutputBox = document.getElementById('policy-test-output-box');
    const policyTermPre = document.getElementById('policy-term-pre');
    const policyTermTitle = document.getElementById('policy-term-title');
    const btnCloseTermOutput = document.getElementById('btn-close-term-output');

    if (btnCloseTermOutput && policyTestOutputBox) {
      btnCloseTermOutput.addEventListener('click', () => {
        policyTestOutputBox.style.display = 'none';
      });
    }

    if (cfg9RouterUrl) cfg9RouterUrl.addEventListener('input', () => { cfg9RouterUrl.dataset.userEdited = 'true'; });
    if (cfg9RouterKey) cfg9RouterKey.addEventListener('input', () => { cfg9RouterKey.dataset.userEdited = 'true'; });

    async function executeValidationCheck(type) {
      const isFast = type === 'fast';
      const spin = isFast ? spinFastCheck : spinSuiteCheck;
      const badge = isFast ? fastCheckBadge : suiteCheckBadge;

      const cmdInput = isFast ? document.getElementById('cfg-fast-cmd') : document.getElementById('cfg-suite-cmd');
      const timeoutInput = isFast ? document.getElementById('cfg-fast-timeout') : document.getElementById('cfg-suite-timeout');
      const cmdVal = (cmdInput?.value || '').trim();
      const timeoutVal = parseInt(timeoutInput?.value, 10) || (isFast ? 15 : 180);

      if (spin) spin.style.display = 'inline-block';
      if (badge) {
        badge.className = 'test-result-badge badge-running';
        badge.textContent = 'Đang chạy...';
      }

      try {
        const payload = {
          check_type: type,
          cmd: cmdVal,
          timeout_sec: timeoutVal
        };

        const res = window.CockpitApi?.runValidationCheck
          ? await window.CockpitApi.runValidationCheck(type, cmdVal, timeoutVal)
          : await (await fetch('/api/run-validation-check', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Dashboard-Token': csrfToken || ''
              },
              body: JSON.stringify(payload)
            })).json();

        if (res.ok) {
          if (badge) {
            badge.className = 'test-result-badge badge-done';
            badge.textContent = `✓ PASS (${res.duration_ms}ms)`;
          }
        } else {
          if (badge) {
            badge.className = 'test-result-badge badge-error';
            badge.textContent = `✕ FAIL (exit ${res.exit_code || 1})`;
          }
        }

        if (policyTestOutputBox && policyTermPre) {
          policyTestOutputBox.style.display = 'block';
          if (policyTermTitle) {
            policyTermTitle.textContent = `Kết quả ${isFast ? 'Fast Check' : 'Suite Check'} — ${res.ok ? 'PASS' : 'FAIL'} (${res.duration_ms}ms)`;
          }
          policyTermPre.textContent = res.output || res.error || 'Không có log đầu ra.';
        }
      } catch (err) {
        if (badge) {
          badge.className = 'test-result-badge badge-error';
          badge.textContent = '✕ Lỗi kết nối';
        }
        if (policyTestOutputBox && policyTermPre) {
          policyTestOutputBox.style.display = 'block';
          policyTermPre.textContent = `Lỗi mạng hoặc server: ${err.message}\nGợi ý: Bấm Ctrl+C trong terminal đang chạy Dashboard và chạy lại: npm run dashboard`;
        }
      } finally {
        if (spin) spin.style.display = 'none';
      }
    }

    if (btnRunFastCheck) btnRunFastCheck.addEventListener('click', () => executeValidationCheck('fast'));
    if (btnRunSuiteCheck) btnRunSuiteCheck.addEventListener('click', () => executeValidationCheck('suite'));

    // Save Unified Config Event (team.yaml hoặc policy.yaml tùy tab đang chọn)
    if (btnSaveTeamConfig) {
      btnSaveTeamConfig.addEventListener('click', async () => {
        if (spinSaveConfig) spinSaveConfig.style.display = 'inline-block';

        // 1. Lưu policy.yaml khi đang ở Tab Chính sách
        if (activeConfigTab === 'project') {
          if (cfgSaveStatusMsg) {
            cfgSaveStatusMsg.textContent = 'Đang lưu chính sách vào policy.yaml...';
            cfgSaveStatusMsg.style.color = 'var(--text-secondary)';
          }

          const prevFast = Array.isArray(currentPolicyConfig?.validation?.fast_checks)
            ? currentPolicyConfig.validation.fast_checks
            : [];
          const prevSuite = Array.isArray(currentPolicyConfig?.validation?.suite_checks)
            ? currentPolicyConfig.validation.suite_checks
            : [];
          const fastCmdVal = (document.getElementById('cfg-fast-cmd')?.value || '').trim();
          const fastTimeoutVal = parseInt(document.getElementById('cfg-fast-timeout')?.value, 10) || 15;
          const suiteCmdVal = (document.getElementById('cfg-suite-cmd')?.value || '').trim();
          const suiteTimeoutVal = parseInt(document.getElementById('cfg-suite-timeout')?.value, 10) || 180;

          const nextFastChecks = (!fastCmdVal && prevFast.length <= 1)
            ? []
            : [
                {
                  ...(prevFast[0] || {}),
                  name: prevFast[0]?.name || 'fast_check',
                  run: fastCmdVal,
                  timeout_sec: fastTimeoutVal
                },
                ...prevFast.slice(1)
              ];
          const nextSuiteChecks = (!suiteCmdVal && prevSuite.length <= 1)
            ? []
            : [
                {
                  ...(prevSuite[0] || {}),
                  name: prevSuite[0]?.name || 'suite_check',
                  run: suiteCmdVal,
                  timeout_sec: suiteTimeoutVal
                },
                ...prevSuite.slice(1)
              ];

          const policyPayload = {
            validation: {
              fast_checks: nextFastChecks,
              suite_checks: nextSuiteChecks
            },
            scope_control: {
              max_files_per_task: parseInt(document.getElementById('cfg-max-files')?.value, 10) || 5,
              max_scope_increase: parseInt(document.getElementById('cfg-max-scope-inc')?.value, 10) || 1,
              allow_new_files: Boolean(document.getElementById('cfg-allow-new-files')?.checked),
              strict_scope_enforcement: Boolean(document.getElementById('cfg-strict-scope')?.checked)
            },
            git_hygiene: {
              rollback_on_validation_fail: Boolean(document.getElementById('cfg-git-rollback')?.checked),
              auto_commit_on_done: Boolean(document.getElementById('cfg-git-autocommit')?.checked)
            },
            execution_guardrails: {
              enforce_command_timeouts: Boolean(document.getElementById('cfg-enforce-timeouts')?.checked),
              block_powershell_curl_alias: Boolean(document.getElementById('cfg-block-ps-curl')?.checked)
            },
            retry_and_escalation: {
              max_retries_per_task: parseInt(document.getElementById('cfg-max-retries')?.value, 10) || 3,
              token_budget_per_task: parseInt(document.getElementById('cfg-token-budget')?.value, 10) || 150000
            }
          };

          try {
            const data = window.CockpitApi?.savePolicyConfig
              ? await window.CockpitApi.savePolicyConfig({ policy: policyPayload })
              : await (await fetch('/api/save-policy-config', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Dashboard-Token': csrfToken || ''
                  },
                  body: JSON.stringify({ policy: policyPayload })
                })).json();

            if (data.ok) {
              if (cfgSaveStatusMsg) {
                cfgSaveStatusMsg.textContent = `✓ ${data.message || 'Đã lưu policy.yaml thành công!'}`;
                cfgSaveStatusMsg.style.color = '#34d399';
              }
              fetchSnapshot();
              setTimeout(() => {
                if (cfgSaveStatusMsg) cfgSaveStatusMsg.textContent = '';
              }, 5000);
            } else {
              if (cfgSaveStatusMsg) {
                cfgSaveStatusMsg.textContent = `✕ Lỗi: ${data.error || 'Không thể lưu chính sách'}`;
                cfgSaveStatusMsg.style.color = '#f87171';
              }
            }
          } catch (err) {
            if (cfgSaveStatusMsg) {
              cfgSaveStatusMsg.textContent = `✕ Lỗi: ${err.message}`;
              cfgSaveStatusMsg.style.color = '#f87171';
            }
          } finally {
            if (spinSaveConfig) spinSaveConfig.style.display = 'none';
          }
          return;
        }

        // 2. Lưu team.yaml khi đang ở Tab Đội ngũ
        if (cfgSaveStatusMsg) {
          cfgSaveStatusMsg.textContent = 'Đang lưu cấu hình vào team.yaml...';
          cfgSaveStatusMsg.style.color = 'var(--text-secondary)';
        }

        const rolesPayload = {};
        squadMembers.forEach(m => {
          if (m.role && m.role !== 'standby') {
            if (!rolesPayload[m.role]) {
              rolesPayload[m.role] = {
                model: m.model,
                models: [m.model],
                display_name: m.name || m.model.split('/').pop()
              };
            } else {
              if (!rolesPayload[m.role].models.includes(m.model)) {
                rolesPayload[m.role].models.push(m.model);
              }
            }
          }
        });

        if (Object.keys(rolesPayload).length === 0) {
          if (cfgSaveStatusMsg) {
            cfgSaveStatusMsg.textContent = '✕ Lỗi: Đội ngũ không được để trống! Cần tối thiểu 1 vai trò (khuyên dùng Writer) để hệ thống hoạt động.';
            cfgSaveStatusMsg.style.color = '#f87171';
          }
          if (spinSaveConfig) spinSaveConfig.style.display = 'none';
          return;
        }

        const providerPayload = {
          base_url: (cfg9RouterUrl?.value || 'http://127.0.0.1:20128/v1').trim(),
          default_key: (cfg9RouterKey?.value || 'sk-default').trim()
        };

        try {
          const data = window.CockpitApi?.saveTeamConfig
            ? await window.CockpitApi.saveTeamConfig({ roles: rolesPayload, provider: providerPayload })
            : await (await fetch('/api/save-team-config', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Dashboard-Token': csrfToken || ''
                },
                body: JSON.stringify({ roles: rolesPayload, provider: providerPayload })
              })).json();
          if (data.ok) {
            if (cfgSaveStatusMsg) {
              const warnSuffix = (Array.isArray(data.warnings) && data.warnings.length > 0)
                ? ` ⚠ ${data.warnings.join(' | ')}`
                : '';
              cfgSaveStatusMsg.textContent = `✓ ${data.message}${warnSuffix}`;
              cfgSaveStatusMsg.style.color = warnSuffix ? '#fbbf24' : '#34d399';
            }
            if (txtBtnSaveConfig) {
              txtBtnSaveConfig.textContent = 'Lưu Đội ngũ';
            }
            await fetchSnapshot();
            initSquadFromConfig(true);
            setTimeout(() => {
              if (cfgSaveStatusMsg) cfgSaveStatusMsg.textContent = '';
            }, 5000);
          } else {
            if (cfgSaveStatusMsg) {
              cfgSaveStatusMsg.textContent = `✕ Lỗi: ${data.error || 'Không thể lưu'}`;
              cfgSaveStatusMsg.style.color = '#f87171';
            }
          }
        } catch (err) {
          if (cfgSaveStatusMsg) {
            cfgSaveStatusMsg.textContent = `✕ Lỗi: ${err.message}`;
            cfgSaveStatusMsg.style.color = '#f87171';
          }
        } finally {
          if (spinSaveConfig) spinSaveConfig.style.display = 'none';
        }
      });
    }

    if (btnCancelConfig) {
      btnCancelConfig.addEventListener('click', closeConfigModal);
    }

    // Collapsible Sidebar Toggle Logic (Mặc định ẩn sang trái - Bấm thì đẩy ra)
    function setSidebarCollapsed(collapsed) {
      if (!bentoContainer) return;
      if (collapsed) {
        bentoContainer.classList.add('sidebar-collapsed');
        if (btnToggleSidebar) btnToggleSidebar.classList.add('collapsed');
        if (sidebarToggleIcon) sidebarToggleIcon.textContent = '◧';
      } else {
        bentoContainer.classList.remove('sidebar-collapsed');
        if (btnToggleSidebar) btnToggleSidebar.classList.remove('collapsed');
        if (sidebarToggleIcon) sidebarToggleIcon.textContent = '◨';
      }
      setTimeout(() => {
        requestAnimationFrame(recalculateSvgLinks);
      }, 300);
    }

    if (btnToggleSidebar && bentoContainer) {
      btnToggleSidebar.addEventListener('click', () => {
        const isCollapsed = bentoContainer.classList.contains('sidebar-collapsed');
        setSidebarCollapsed(!isCollapsed);
      });
      // Mặc định luôn ẩn về bên trái khi tải trang lần đầu
      setSidebarCollapsed(true);
    }

    // Quick Prompt Chips
    document.querySelectorAll('.chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const goal = btn.getAttribute('data-goal');
        if (goal && inpGoalText) {
          inpGoalText.value = goal;
          inpGoalText.focus();
        }
      });
    });

    // Decompose Goal Action
    btnDecomposeGoal.addEventListener('click', async () => {
      const goal = inpGoalText.value.trim();
      if (!goal) {
        alert('Vui lòng nhập mục tiêu tính năng cần phân tích!');
        return;
      }

      const preset = selWorkflowPreset ? selWorkflowPreset.value : 'auto';
      const selectedWriterModel = selGoalWriterModel ? String(selGoalWriterModel.value || '').trim() : '';
      btnDecomposeGoal.disabled = true;
      spinDecompose.style.display = 'inline-block';
      txtDecomposeBtn.textContent = 'Router Agent đang khảo sát codebase...';
      lblDecomposeStatus.textContent = `Đang gọi Router Agent đọc cấu trúc code (Preset: ${preset.toUpperCase()})...`;

      try {
        const decompPayload = { preset, ...(selectedWriterModel ? { writer_model: selectedWriterModel } : {}) };
        const data = window.CockpitApi?.decomposeGoal
          ? await window.CockpitApi.decomposeGoal(goal, decompPayload)
          : await (await fetch('/api/decompose', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Dashboard-Token': csrfToken || ''
              },
              body: JSON.stringify({ goal, ...decompPayload })
            })).json();
        if (!data || !data.ok) {
          throw new Error(data?.error || 'Lỗi bóc tách mục tiêu');
        }
        currentDraftTasks = data.tasks || [];
        renderDraftTasks(currentDraftTasks);
        lblDecomposeStatus.textContent = `Đã sinh thành công ${currentDraftTasks.length} task(s)! Bạn hãy xem lại và bấm "Phê duyệt & Khởi động".`;
      } catch (err) {
        lblDecomposeStatus.textContent = `Lỗi: ${err.message}`;
        alert('Lỗi phân tích goal: ' + err.message);
      } finally {
        btnDecomposeGoal.disabled = false;
        spinDecompose.style.display = 'none';
        txtDecomposeBtn.textContent = 'Phân tích & Lập kế hoạch';
      }
    });

    function renderDraftTasks(tasks) {
      while (listDraftTasks.firstChild) {
        listDraftTasks.removeChild(listDraftTasks.firstChild);
      }
      if (!tasks || tasks.length === 0) {
        const empty = document.createElement('div');
        empty.style.color = 'var(--text-muted)';
        empty.style.fontSize = '11px';
        empty.style.fontStyle = 'italic';
        empty.style.textAlign = 'center';
        empty.style.padding = '24px';
        empty.textContent = 'Chưa có task nào được sinh ra.';
        listDraftTasks.appendChild(empty);
        btnApproveRun.disabled = true;
        return;
      }

      tasks.forEach(t => {
        const card = document.createElement('div');
        card.className = 'draft-card';

        const head = document.createElement('div');
        head.className = 'draft-card-header';

        const idSpan = document.createElement('span');
        idSpan.className = 'draft-card-id';
        idSpan.textContent = t.task_id;

        const badges = document.createElement('div');
        badges.style.display = 'flex';
        badges.style.alignItems = 'center';
        badges.style.gap = '6px';

        const effectiveTaskModel = t.writer_model || t.model;
        if (effectiveTaskModel) {
          const modelSrc = t.writer_model_source === 'router_hint' || t.model_source === 'router_hint'
            ? 'router_hint'
            : 'user';
          const modelTag = document.createElement('span');
          modelTag.className = 'tag';
          modelTag.style.background = modelSrc === 'router_hint'
            ? 'rgba(245, 158, 11, 0.12)'
            : 'rgba(56, 189, 248, 0.12)';
          modelTag.style.border = modelSrc === 'router_hint'
            ? '1px solid rgba(245, 158, 11, 0.35)'
            : '1px solid rgba(56, 189, 248, 0.35)';
          modelTag.style.color = modelSrc === 'router_hint' ? '#fbbf24' : '#38bdf8';
          modelTag.textContent = `${effectiveTaskModel.split('/').pop()} • ${modelSrc}`;
          modelTag.title = `Model: ${effectiveTaskModel} • Nguồn: ${modelSrc}`;
          badges.appendChild(modelTag);
        }

        const modeBadge = document.createElement('span');
        modeBadge.className = 'tag tag-' + (t.mode === 'full' ? 'standard' : 'quick');
        modeBadge.textContent = (t.mode || 'quick').toUpperCase();

        const riskBadge = document.createElement('span');
        riskBadge.className = 'tag tag-' + (t.risk_level || 'low');
        riskBadge.textContent = (t.risk_level || 'low').toUpperCase();

        badges.appendChild(modeBadge);
        badges.appendChild(riskBadge);

        // Actions: Chi tiết & Xóa
        const actions = document.createElement('div');
        actions.className = 'draft-card-actions';

        const btnDetail = document.createElement('button');
        btnDetail.className = 'btn-draft-action';
        btnDetail.textContent = 'Chi tiết';
        btnDetail.title = 'Xem chi tiết file task YAML';
        btnDetail.addEventListener('click', (e) => {
          e.stopPropagation();
          openTaskDetailModal(t.task_id);
        });

        const btnDelete = document.createElement('button');
        btnDelete.className = 'btn-draft-action btn-draft-delete';
        btnDelete.textContent = 'Xóa';
        btnDelete.title = 'Xóa vĩnh viễn file task này';
        btnDelete.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Bạn có chắc muốn xóa task "${t.task_id}" không?\nFile task YAML trong tasks/active/ sẽ bị xóa.`)) {
            return;
          }
          try {
            btnDelete.disabled = true;
            btnDelete.textContent = 'Đang xóa...';
            const res = window.CockpitApi?.deleteTask
              ? await window.CockpitApi.deleteTask(t.task_id)
              : await (await fetch('/api/task/delete', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Dashboard-Token': csrfToken || ''
                  },
                  body: JSON.stringify({ task_id: t.task_id })
                })).json();
            if (!res.ok) throw new Error(res.error || 'Không thể xóa task');
            currentDraftTasks = currentDraftTasks.filter(item => item.task_id !== t.task_id);
            renderDraftTasks(currentDraftTasks);
            fetchSnapshot();
          } catch (err) {
            alert('Lỗi xóa task: ' + err.message);
            btnDelete.disabled = false;
            btnDelete.textContent = 'Xóa';
          }
        });

        actions.appendChild(btnDetail);
        actions.appendChild(btnDelete);
        badges.appendChild(actions);

        head.appendChild(idSpan);
        head.appendChild(badges);

        const title = document.createElement('div');
        title.className = 'draft-card-title';
        title.textContent = t.title || t.goal;

        const scope = document.createElement('div');
        scope.className = 'draft-card-scope';
        scope.textContent = 'Scope: ' + (t.scope && t.scope.length > 0 ? t.scope.join(', ') : '(None)');

        const crit = document.createElement('div');
        crit.className = 'draft-card-criteria';
        const critList = t.acceptance_criteria || [];
        crit.textContent = 'Tiêu chí nghiệm thu: ' + (critList.length > 0 ? critList.join(' • ') : '(None)');

        // Workflow steps badge (Task-Demand × Squad-Roster Engine)
        const wfRow = document.createElement('div');
        wfRow.style.fontSize = '10.5px';
        wfRow.style.color = 'var(--text-secondary)';
        wfRow.style.marginTop = '4px';
        const wfSteps = Array.isArray(t.writer_hub_workflow) ? t.writer_hub_workflow : [];
        if (t.mode === 'consult') {
          wfRow.textContent = 'Luồng thực thi: Consult Read-Only (Tư vấn báo cáo)';
        } else if (wfSteps.length > 0) {
          const wfSummary = wfSteps.map(s => {
            const act = s.action === 'draft_spec' ? 'Spec' : `Patch(${s.domain || 'code'})`;
            return `${act}[${s.role || 'writer'}]`;
          }).join(' ➔ ');
          wfRow.textContent = `Luồng Writer Hub: ${wfSummary}`;
        } else {
          wfRow.textContent = 'Luồng Writer Hub: 1-Step Direct Patch [writer]';
        }

        card.appendChild(head);
        card.appendChild(title);
        card.appendChild(scope);
        card.appendChild(crit);
        card.appendChild(wfRow);

        if (Array.isArray(t.scope_warnings) && t.scope_warnings.length > 0) {
          const warnRow = document.createElement('div');
          warnRow.style.fontSize = '10.5px';
          warnRow.style.color = '#c45519';
          warnRow.style.marginTop = '3px';
          warnRow.textContent = t.scope_warnings.join(' | ');
          card.appendChild(warnRow);
        }

        listDraftTasks.appendChild(card);
      });

      btnApproveRun.disabled = false;
    }

    // ==============================================================================
    // TASK DETAIL MODAL HANDLERS
    // ==============================================================================
    async function openTaskDetailModal(taskId) {
      if (!modalTaskDetailOverlay) return;
      modalTaskDetailOverlay.style.display = 'flex';
      currentViewingTaskId = taskId;

      // Loading placeholder
      if (taskDetailHeaderId) taskDetailHeaderId.textContent = `Chi Tiết: ${taskId}`;
      if (taskDetailTitle) taskDetailTitle.value = 'Đang tải thông tin task...';
      if (taskDetailGoal) taskDetailGoal.value = '';
      if (taskDetailOwner) taskDetailOwner.value = '';
      if (taskDetailModel) taskDetailModel.value = '';
      if (taskDetailScopePills) taskDetailScopePills.replaceChildren();
      if (taskDetailCriteriaList) taskDetailCriteriaList.replaceChildren();
      if (taskDetailConstraintsList) taskDetailConstraintsList.replaceChildren();
      if (taskDetailRawYaml) taskDetailRawYaml.textContent = 'Đang tải file YAML...';

      try {
        const res = window.CockpitApi?.getTaskDetail
          ? await window.CockpitApi.getTaskDetail(taskId)
          : await (await fetch(`/api/task/detail?id=${encodeURIComponent(taskId)}`)).json();

        if (!res.ok) throw new Error(res.error || 'Không thể tải chi tiết task');
        const t = res.task || {};
        currentViewingRawYaml = res.raw_yaml || '';

        if (taskDetailHeaderId) taskDetailHeaderId.textContent = `Chi Tiết: ${res.task_id || taskId}`;
        if (taskDetailModeBadge) {
          taskDetailModeBadge.textContent = (t.mode || 'quick').toUpperCase();
          taskDetailModeBadge.className = 'tag tag-' + (t.mode === 'full' ? 'standard' : 'quick');
        }
        if (taskDetailRiskBadge) {
          taskDetailRiskBadge.textContent = (t.risk_level || 'low').toUpperCase();
          taskDetailRiskBadge.className = 'tag tag-' + (t.risk_level || 'low');
        }
        if (taskDetailStatusBadge) {
          taskDetailStatusBadge.textContent = (t.status || 'draft_review').toUpperCase();
        }
        if (taskDetailTitle) taskDetailTitle.value = t.title || '';
        if (taskDetailGoal) taskDetailGoal.value = t.goal || '';
        if (taskDetailOwner) taskDetailOwner.value = t.owner || 'writer';
        if (taskDetailModel) {
          const effDetModel = t.writer_model || t.model;
          const effDetSrc = t.writer_model_source || t.model_source || 'user';
          taskDetailModel.value = effDetModel ? `${effDetModel} (${effDetSrc})` : '(Mặc định theo team.yaml)';
        }

        // Scope pills
        if (taskDetailScopePills) {
          taskDetailScopePills.replaceChildren();
          const scopes = Array.isArray(t.scope) ? t.scope : [];
          if (scopes.length === 0) {
            const emptyScope = document.createElement('span');
            emptyScope.style.color = 'var(--text-muted)';
            emptyScope.style.fontStyle = 'italic';
            emptyScope.style.fontSize = '11px';
            emptyScope.textContent = '(Chưa giới hạn scope)';
            taskDetailScopePills.appendChild(emptyScope);
          } else {
            scopes.forEach(sc => {
              const pill = document.createElement('span');
              pill.className = 'task-scope-pill';
              pill.textContent = sc;
              taskDetailScopePills.appendChild(pill);
            });
          }
        }

        // Criteria list
        if (taskDetailCriteriaList) {
          taskDetailCriteriaList.replaceChildren();
          const crits = Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [];
          crits.forEach(c => {
            const li = document.createElement('li');
            li.textContent = c;
            taskDetailCriteriaList.appendChild(li);
          });
          if (crits.length === 0) {
            const emptyCrit = document.createElement('li');
            emptyCrit.style.color = 'var(--text-muted)';
            emptyCrit.style.fontStyle = 'italic';
            emptyCrit.textContent = '(Không có)';
            taskDetailCriteriaList.appendChild(emptyCrit);
          }
        }

        // Constraints list
        if (taskDetailConstraintsList) {
          taskDetailConstraintsList.replaceChildren();
          const cons = Array.isArray(t.constraints) ? t.constraints : [];
          cons.forEach(c => {
            const li = document.createElement('li');
            li.textContent = c;
            taskDetailConstraintsList.appendChild(li);
          });
          if (cons.length === 0) {
            const emptyCon = document.createElement('li');
            emptyCon.style.color = 'var(--text-muted)';
            emptyCon.style.fontStyle = 'italic';
            emptyCon.textContent = '(Không có)';
            taskDetailConstraintsList.appendChild(emptyCon);
          }
        }

        // Raw YAML Viewer
        if (taskDetailRawYaml) {
          taskDetailRawYaml.textContent = currentViewingRawYaml;
        }
      } catch (err) {
        if (taskDetailTitle) taskDetailTitle.value = `Lỗi tải task: ${err.message}`;
        if (taskDetailRawYaml) taskDetailRawYaml.textContent = `Lỗi: ${err.message}`;
      }
    }

    function closeTaskDetailModal() {
      if (modalTaskDetailOverlay) {
        modalTaskDetailOverlay.style.display = 'none';
        currentViewingTaskId = null;
        currentViewingRawYaml = '';
      }
    }

    if (btnCloseTaskDetail) btnCloseTaskDetail.addEventListener('click', closeTaskDetailModal);
    if (btnDismissTaskDetail) btnDismissTaskDetail.addEventListener('click', closeTaskDetailModal);
    if (modalTaskDetailOverlay) {
      modalTaskDetailOverlay.addEventListener('click', (e) => {
        if (e.target === modalTaskDetailOverlay) closeTaskDetailModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalTaskDetailOverlay && modalTaskDetailOverlay.style.display === 'flex') {
        closeTaskDetailModal();
      }
    });

    if (btnCopyTaskYaml) {
      btnCopyTaskYaml.addEventListener('click', async () => {
        if (!currentViewingRawYaml) return;
        try {
          await navigator.clipboard.writeText(currentViewingRawYaml);
          const old = btnCopyTaskYaml.textContent;
          btnCopyTaskYaml.textContent = '✓ Đã Copy!';
          setTimeout(() => { btnCopyTaskYaml.textContent = old; }, 1500);
        } catch {
          alert('Không thể copy vào clipboard');
        }
      });
    }

    // ==============================================================================
    // RESERVED HOOK: SỬA VÀ LƯU CHI TIẾT TASK (Chờ User giải thích quy trình)
    // ==============================================================================
    async function handleSaveTaskEdit(taskId, updatedTaskData = null, rawYaml = null) {
      const tid = taskId || currentViewingTaskId;
      if (!tid) throw new Error('Không xác định được task_id để lưu');
      const res = window.CockpitApi?.saveTask
        ? await window.CockpitApi.saveTask(tid, updatedTaskData, rawYaml)
        : await (await fetch('/api/task/save', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Dashboard-Token': csrfToken || ''
            },
            body: JSON.stringify({ task_id: tid, task: updatedTaskData, raw_yaml: rawYaml })
          })).json();
      if (!res.ok) throw new Error(res.error || 'Không thể lưu task');
      fetchSnapshot();
      return res;
    }
    // Expose on window for programmatic call & future binding
    window.handleSaveTaskEdit = handleSaveTaskEdit;

    if (btnSaveTaskDetail) {
      btnSaveTaskDetail.addEventListener('click', async () => {
        try {
          btnSaveTaskDetail.disabled = true;
          btnSaveTaskDetail.textContent = 'Đang lưu...';
          await handleSaveTaskEdit(currentViewingTaskId);
          alert('Đã lưu thành công!');
          closeTaskDetailModal();
        } catch (err) {
          alert('Lỗi lưu task: ' + err.message);
        } finally {
          btnSaveTaskDetail.disabled = false;
          btnSaveTaskDetail.textContent = 'Lưu Thay Đổi';
        }
      });
    }

    // Approve & Run Action
    btnApproveRun.addEventListener('click', async () => {
      btnApproveRun.disabled = true;
      const oldText = btnApproveRun.textContent;
      btnApproveRun.textContent = 'Đang khởi chạy Orchestrator...';

      try {
        const data = window.CockpitApi?.approveRun
          ? await window.CockpitApi.approveRun()
          : await (await fetch('/api/approve-run', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Dashboard-Token': csrfToken || ''
              },
              body: JSON.stringify({})
            })).json();
        if (!data || !data.ok) {
          throw new Error(data?.error || 'Lỗi phê duyệt task');
        }
        btnApproveRun.textContent = '✓ Đã khởi chạy Squad!';
        setTimeout(() => {
          btnApproveRun.textContent = oldText;
          btnApproveRun.disabled = false;
          switchTab('topology');
        }, 900);
      } catch (err) {
        alert('Lỗi: ' + err.message);
        btnApproveRun.disabled = false;
        btnApproveRun.textContent = oldText;
      }
    });

    // Stop Action
    btnStopOrchestrator.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc chắn muốn dừng Orchestrator đang chạy?')) return;
      try {
        const data = window.CockpitApi?.stopOrchestrator
          ? await window.CockpitApi.stopOrchestrator()
          : await (await fetch('/api/stop', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Dashboard-Token': csrfToken || ''
              }
            })).json();
        alert(data.message || 'Đã gửi lệnh dừng');
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    });

    window.addEventListener('resize', () => {
      requestAnimationFrame(recalculateSvgLinks);
    });

    // Format Token Numbers
    function formatTokens(num) {
      if (!num || isNaN(num)) return '0';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
      return String(num);
    }

    // Format Elapsed Seconds (e.g. 97s -> 1m 37s)
    function formatSeconds(sec) {
      if (!sec || isNaN(sec) || sec <= 0) return '0s';
      if (sec < 60) return `${sec}s`;
      const mins = Math.floor(sec / 60);
      const s = sec % 60;
      return `${mins}m ${s}s`;
    }

    // Update Waterfall Pipeline Stages Visual State
    function updateWaterfallPipeline(activeStage, stageStartTime, mode, attempt, isRunning, lastTask) {
      currentStage = activeStage;
      stageStartedAt = stageStartTime ? new Date(stageStartTime).getTime() : null;

      // Quick mode router & reviewer labels
      if (mode === 'quick') {
        txtStepRouter.textContent = '1. Router (Direct)';
        txtStepReviewer.textContent = '4b. Review (Skip)';
      } else {
        txtStepRouter.textContent = '1. Router';
        txtStepReviewer.textContent = '4b. Review';
      }

      if (txtStepWriter) {
        txtStepWriter.textContent = '2. Writer Hub';
      }

      // Retry Loop Indicator
      if (attempt && attempt > 1) {
        writerAttemptBadge.textContent = 'Att ' + attempt;
        writerAttemptBadge.style.display = 'inline-block';
        retryNum.textContent = String(attempt - 1);
        retryLoopPill.style.display = 'inline-flex';
      } else {
        writerAttemptBadge.style.display = 'none';
        retryLoopPill.style.display = 'none';
      }

      const activeIdx = stageSequence.indexOf(activeStage);

      stageSequence.forEach((stage, idx) => {
        const el = pipelineSteps[stage];
        if (!el) return;

        el.className = 'stage-item';
        const iconSpan = el.querySelector('.step-icon');
        const timerSpan = el.querySelector('.stage-timer');

        if (!isRunning) {
          if (lastTask && lastTask.status === 'done') {
            el.classList.add('done');
            if (iconSpan) iconSpan.textContent = '✓';
          } else {
            if (iconSpan) iconSpan.textContent = '○';
          }
          if (timerSpan) timerSpan.style.display = 'none';
          return;
        }

        if (stage === 'reviewer' && mode === 'quick') {
          el.classList.add('skipped');
          if (iconSpan) iconSpan.textContent = '—';
          if (timerSpan) timerSpan.style.display = 'none';
          return;
        }

        if (activeStage === 'idle') {
          if (iconSpan) iconSpan.textContent = '○';
          if (timerSpan) timerSpan.style.display = 'none';
        } else if (activeStage === 'blocked' || activeStage === 'failed') {
          if (idx < activeIdx) {
            el.classList.add('done');
            if (iconSpan) iconSpan.textContent = '✓';
            if (timerSpan) timerSpan.style.display = 'none';
          } else if (idx === activeIdx || (activeIdx === -1 && idx === stageSequence.length - 1)) {
            el.classList.add('failed');
            if (iconSpan) iconSpan.textContent = '✕';
            if (timerSpan) timerSpan.style.display = 'none';
          } else {
            if (iconSpan) iconSpan.textContent = '○';
            if (timerSpan) timerSpan.style.display = 'none';
          }
        } else if (activeStage === 'done') {
          el.classList.add('done');
          if (iconSpan) iconSpan.textContent = '✓';
          if (timerSpan) timerSpan.style.display = 'none';
        } else {
          if (idx < activeIdx) {
            el.classList.add('done');
            if (iconSpan) iconSpan.textContent = '✓';
            if (timerSpan) timerSpan.style.display = 'none';
          } else if (idx === activeIdx) {
            el.classList.add('active');
            if (iconSpan) iconSpan.textContent = '●';
            if (timerSpan && stageStartedAt) {
              timerSpan.style.display = 'inline-block';
            }
          } else {
            if (iconSpan) iconSpan.textContent = '○';
            if (timerSpan) timerSpan.style.display = 'none';
          }
        }
      });
    }

    // Universal Timer Ticker (Fixes runaway 53553s timer)
    setInterval(() => {
      // 1. Active stage timer
      if (currentStage && currentStage !== 'idle' && currentStage !== 'done' && currentStage !== 'blocked' && stageStartedAt) {
        const el = pipelineSteps[currentStage];
        if (el) {
          const timerSpan = el.querySelector('.stage-timer');
          if (timerSpan) {
            const sec = Math.max(0, Math.floor((Date.now() - stageStartedAt) / 1000));
            timerSpan.textContent = sec + 's';
            timerSpan.style.display = 'inline-block';
          }
        }
      }

      // 2. Task duration timer
      if (taskDurationStatic !== null) {
        taskTimerTag.textContent = 'Duration: ' + formatSeconds(taskDurationStatic);
        taskTimerTag.style.display = 'inline-block';
      } else if (taskStartedAt && currentStage !== 'idle') {
        const totalSec = Math.max(0, Math.floor((Date.now() - taskStartedAt) / 1000));
        taskTimerTag.textContent = 'Task: ' + formatSeconds(totalSec);
        taskTimerTag.style.display = 'inline-block';
      } else {
        taskTimerTag.style.display = 'none';
      }
    }, 200);

    // Render Left Column Workflow Squad Cards dynamically from team.yaml & live state
    function renderWorkflowSquad(activeStage, rolesStatus, rolesConfig, live) {
      const isRunning = Boolean(live?.active && activeStage !== 'idle');
      const mode = live?.mode || 'standard';

      if (squadActiveModeTag) {
        squadActiveModeTag.textContent = isRunning ? mode.toUpperCase() : 'Adaptive';
      }

      function getCleanRoleModelText(roleSpec, fallback) {
        if (!roleSpec || roleSpec.enabled === false || !roleSpec.model) return 'Chưa cấu hình';
        if (roleSpec.display_name && roleSpec.display_name.trim()) return roleSpec.display_name.trim();
        const m = (roleSpec.model || '').trim();
        return m.split('/').pop() || fallback;
      }

      // 1. Router Agent
      if (squadModelRouter) {
        squadModelRouter.textContent = getCleanRoleModelText(rolesConfig.router, 'Chưa cấu hình');
      }
      const cockpitRouterTag = document.getElementById('cockpit-router-model-tag');
      if (cockpitRouterTag) {
        cockpitRouterTag.textContent = getCleanRoleModelText(rolesConfig.router, 'Router');
      }
      if (squadStatusRouter) {
        if (!isRunning) {
          squadStatusRouter.textContent = 'IDLE';
          squadStatusRouter.className = 'status-badge badge-idle';
        } else if (mode === 'quick') {
          squadStatusRouter.textContent = 'SKIPPED';
          squadStatusRouter.className = 'status-badge badge-skipped';
        } else if (activeStage === 'router') {
          squadStatusRouter.textContent = 'WORKING';
          squadStatusRouter.className = 'status-badge badge-working';
        } else if (['writer', 'designer', 'applier', 'validator', 'reviewer', 'git', 'done'].includes(activeStage) || rolesStatus.router?.status === 'done') {
          squadStatusRouter.textContent = 'DONE';
          squadStatusRouter.className = 'status-badge badge-done';
        } else {
          squadStatusRouter.textContent = 'IDLE';
          squadStatusRouter.className = 'status-badge badge-idle';
        }
      }

      // 1b. Architect Spec Lead (roles.architect or team.yaml spec_models)
      const hasExplicitArchitect = Boolean(rolesConfig.architect && rolesConfig.architect.enabled !== false && (rolesConfig.architect.model || rolesConfig.architect.default_model));
      const specSummary = formatSpecModelsSummary(currentSpecModels);
      if (squadRowArchitect) {
        squadRowArchitect.style.display = (hasExplicitArchitect || specSummary) ? 'flex' : 'none';
      }
      if (squadModelArchitect) {
        squadModelArchitect.textContent = hasExplicitArchitect
          ? getCleanRoleModelText(rolesConfig.architect, 'Architect')
          : (specSummary || 'spec_models');
      }
      if (squadStatusArchitect) {
        if (!isRunning) {
          squadStatusArchitect.textContent = 'IDLE';
          squadStatusArchitect.className = 'status-badge badge-idle';
        } else if (mode === 'quick') {
          squadStatusArchitect.textContent = 'SKIPPED';
          squadStatusArchitect.className = 'status-badge badge-skipped';
        } else if (activeStage === 'architect' || rolesStatus.architect?.status === 'working') {
          squadStatusArchitect.textContent = 'WORKING';
          squadStatusArchitect.className = 'status-badge badge-working';
        } else if (rolesStatus.architect?.status === 'done' || ['applier', 'validator', 'reviewer', 'git', 'done'].includes(activeStage)) {
          squadStatusArchitect.textContent = 'DONE';
          squadStatusArchitect.className = 'status-badge badge-done';
        } else {
          squadStatusArchitect.textContent = 'STANDBY';
          squadStatusArchitect.className = 'status-badge badge-idle';
        }
      }

      // 2. Writer Agent
      if (squadModelWriter) {
        const safeWriterModels = Array.isArray(rolesConfig.writer?.models)
          ? rolesConfig.writer.models.filter(e => !isModelEntryDisabled(e)).map(extractModelId).filter(Boolean)
          : [];
        if (safeWriterModels.length > 1) {
          squadModelWriter.replaceChildren();
          safeWriterModels.forEach((m, idx) => {
            const clean = m.split('/').pop() || m;
            const div = document.createElement('div');
            div.className = 'sidebar-writer-row';
            div.textContent = `${idx === 0 ? '★ ' : '↳ '}${clean}`;
            squadModelWriter.appendChild(div);
          });
        } else {
          squadModelWriter.textContent = getCleanRoleModelText(rolesConfig.writer, 'Chưa cấu hình');
        }
      }
      const isSpecWorking = rolesStatus.architect?.status === 'working' || rolesStatus.designer?.status === 'working';
      if (squadStatusWriter) {
        if (!isRunning) {
          squadStatusWriter.textContent = 'IDLE';
          squadStatusWriter.className = 'status-badge badge-idle';
        } else if (rolesStatus.writer?.status === 'working' || (activeStage === 'writer' && !isSpecWorking)) {
          squadStatusWriter.textContent = 'WORKING';
          squadStatusWriter.className = 'status-badge badge-working';
        } else if (['applier', 'validator', 'reviewer', 'git', 'done'].includes(activeStage) || rolesStatus.writer?.status === 'done') {
          squadStatusWriter.textContent = 'DONE';
          squadStatusWriter.className = 'status-badge badge-done';
        } else {
          squadStatusWriter.textContent = 'IDLE';
          squadStatusWriter.className = 'status-badge badge-idle';
        }
      }

      // 3. Designer Agent
      if (squadModelDesigner) {
        squadModelDesigner.textContent = getCleanRoleModelText(rolesConfig.designer, 'Chưa cấu hình');
      }
      if (squadStatusDesigner) {
        if (!isRunning) {
          squadStatusDesigner.textContent = 'IDLE';
          squadStatusDesigner.className = 'status-badge badge-idle';
        } else if (activeStage === 'designer' || rolesStatus.designer?.status === 'working') {
          squadStatusDesigner.textContent = 'WORKING';
          squadStatusDesigner.className = 'status-badge badge-working';
        } else if (rolesStatus.designer?.status === 'done') {
          squadStatusDesigner.textContent = 'DONE';
          squadStatusDesigner.className = 'status-badge badge-done';
        } else {
          squadStatusDesigner.textContent = 'STANDBY';
          squadStatusDesigner.className = 'status-badge badge-idle';
        }
      }

      // 4. Reviewer Agent
      if (squadModelReviewer) {
        squadModelReviewer.textContent = getCleanRoleModelText(rolesConfig.reviewer, 'Chưa cấu hình');
      }
      if (squadStatusReviewer) {
        if (!isRunning) {
          squadStatusReviewer.textContent = 'IDLE';
          squadStatusReviewer.className = 'status-badge badge-idle';
        } else if (mode === 'quick') {
          squadStatusReviewer.textContent = 'SKIPPED';
          squadStatusReviewer.className = 'status-badge badge-skipped';
        } else if (activeStage === 'reviewer') {
          squadStatusReviewer.textContent = 'REVIEWING';
          squadStatusReviewer.className = 'status-badge badge-working';
        } else if (rolesStatus.reviewer?.status === 'approved' || ['git', 'done'].includes(activeStage)) {
          squadStatusReviewer.textContent = 'APPROVED';
          squadStatusReviewer.className = 'status-badge badge-done';
        } else {
          squadStatusReviewer.textContent = 'IDLE';
          squadStatusReviewer.className = 'status-badge badge-idle';
        }
      }

      // 5. Validator Guard
      if (squadStatusValidator) {
        if (!isRunning) {
          squadStatusValidator.textContent = 'IDLE';
          squadStatusValidator.className = 'status-badge badge-idle';
        } else if (['applier', 'validator'].includes(activeStage)) {
          squadStatusValidator.textContent = 'TESTING';
          squadStatusValidator.className = 'status-badge badge-working';
        } else if (['reviewer', 'git', 'done'].includes(activeStage)) {
          squadStatusValidator.textContent = 'PASS ✓';
          squadStatusValidator.className = 'status-badge badge-done';
        } else {
          squadStatusValidator.textContent = 'IDLE';
          squadStatusValidator.className = 'status-badge badge-idle';
        }
      }
    }

    function renderCircuitBreakerBanner(cbData) {
      const el = document.getElementById('squad-circuit-breaker-status');
      if (!el) return;
      const ttlMs = Number(cbData?.ttl_ms) > 0 ? Number(cbData.ttl_ms) : 600000;
      const ttlMin = Math.round(ttlMs / 60000);
      const brokenList = Array.isArray(cbData?.models) ? cbData.models : [];
      el.textContent = '';

      if (brokenList.length === 0) {
        el.style.color = 'var(--text-secondary)';
        el.textContent = `Circuit Breaker: OK (TTL ${ttlMin}m)`;
        return;
      }

      el.style.color = '#fbbf24';
      const header = document.createElement('div');
      header.textContent = `Circuit Breaker TRIPPED (${brokenList.length}, TTL ${ttlMin}m):`;
      el.appendChild(header);

      for (const item of brokenList) {
        const row = document.createElement('div');
        const remainSec = Math.max(0, Math.ceil(Number(item.remaining_ms || 0) / 1000));
        row.textContent = `• ${String(item.model || '')} (${remainSec}s left) — ${String(item.reason || '')}`;
        el.appendChild(row);
      }
    }

    // Update Adaptive Star Topology SVG Links and Nodes dynamically from team.yaml squad
    function updateTopologyNetwork(activeStage, rolesStatus, rolesConfig, snap) {
      const spokesContainer = document.getElementById('topology-spokes-container');
      const svgEl = document.getElementById('topology-svg');
      if (!spokesContainer || !svgEl) return;

      const isRunning = Boolean(snap?.live_status?.active && activeStage !== 'idle');
      const mode = snap?.live_status?.mode || 'standard';

      // 1. Center Hub State
      if (hubStateSub) {
        if (!isRunning) {
          hubStateSub.textContent = activeStage === 'done' ? 'State Hub • Completed ✓' : 'State Hub • Idle';
        } else {
          hubStateSub.textContent = `State Hub • ${mode.toUpperCase()} (${activeStage.toUpperCase()})`;
        }
      }
      if (capsuleHub) {
        capsuleHub.className = 'ai-capsule-node node-orchestrator-hub' + (isRunning ? ' active' : (activeStage === 'done' ? ' done' : ''));
        capsuleHub.title = `Mini Orchestrator Core (Mode: ${mode || 'idle'}, Stage: ${activeStage})`;
      }

      function formatCleanModel(roleSpec, fallback) {
        if (!roleSpec) return fallback;
        if (roleSpec.display_name && roleSpec.display_name.trim()) return roleSpec.display_name.trim();
        const m = (roleSpec.model || '').trim();
        return m.split('/').pop() || fallback;
      }

      // 2. Build Active Spoke Definitions directly from rolesConfig
      const activeSpokeDefs = [];

      // Router
      if (rolesConfig.router && rolesConfig.router.enabled !== false && rolesConfig.router.model) {
        activeSpokeDefs.push({
          key: 'router',
          roleTag: 'Router',
          icon: 'R',
          modelName: formatCleanModel(rolesConfig.router, 'Router'),
          fullModel: rolesConfig.router.model,
          tooltip: `Router Agent (${rolesConfig.router.model}) - Plan & Scope Router`,
          defaultPos: { left: '18%', top: '23%' }
        });
      }

      // Architect (Rendered if roles.architect OR spec_models is configured in team.yaml)
      const hasArchRole = Boolean(rolesConfig.architect && rolesConfig.architect.enabled !== false && rolesConfig.architect.model);
      const specSummaryTopo = formatSpecModelsSummary(snap?.spec_models || currentSpecModels);
      if (hasArchRole || specSummaryTopo) {
        activeSpokeDefs.push({
          key: 'architect',
          roleTag: 'Architect',
          icon: 'A',
          modelName: hasArchRole ? formatCleanModel(rolesConfig.architect, 'Architect') : specSummaryTopo,
          fullModel: hasArchRole ? rolesConfig.architect.model : specSummaryTopo,
          tooltip: hasArchRole
            ? `Architect Agent (${rolesConfig.architect.model}) - Tech Spec & Contract Table`
            : `Architect Tech Spec (team.yaml spec_models: ${specSummaryTopo})`,
          defaultPos: { left: '50%', top: '14%' }
        });
      }

      // Designer (Rendered ONLY if present in team.yaml rolesConfig!)
      if (rolesConfig.designer && rolesConfig.designer.enabled !== false && rolesConfig.designer.model) {
        activeSpokeDefs.push({
          key: 'designer',
          roleTag: 'Designer',
          icon: 'D',
          modelName: formatCleanModel(rolesConfig.designer, 'Designer'),
          fullModel: rolesConfig.designer.model,
          tooltip: `Designer Agent (${rolesConfig.designer.model}) - UI / UX Visual Audit`,
          defaultPos: { left: '82%', top: '23%' }
        });
      }

      // Writer (Rendered with stacked models if multiple)
      if (rolesConfig.writer && rolesConfig.writer.enabled !== false && (rolesConfig.writer.model || (Array.isArray(rolesConfig.writer.models) && rolesConfig.writer.models.length > 0))) {
        const rawModels = Array.isArray(rolesConfig.writer.models) && rolesConfig.writer.models.length > 0
          ? rolesConfig.writer.models.filter(e => !isModelEntryDisabled(e)).map(extractModelId).filter(Boolean)
          : [extractModelId(rolesConfig.writer.model)].filter(Boolean);

        const writerModels = rawModels.map((m, idx) => {
          let clean = m.split('/').pop() || m;
          return {
            id: m,
            name: clean,
            isPrimary: idx === 0,
            tag: idx === 0 ? 'Primary Coder' : 'Fallback'
          };
        });

        const isMulti = writerModels.length > 1;
        const topPos = writerModels.length >= 4 ? '70%' : (writerModels.length === 3 ? '72%' : '74%');

        activeSpokeDefs.push({
          key: 'writer',
          roleTag: isMulti ? `Writer Squad (${writerModels.length})` : 'Writer',
          icon: 'W',
          models: writerModels,
          modelName: writerModels[0].name,
          fullModel: rolesConfig.writer.model,
          tooltip: `Writer Squad: ${writerModels.map(w => w.id).join(' | ')}`,
          defaultPos: { left: '20%', top: topPos }
        });
      }

      // Validator Guard (Always present as engine test gate)
      activeSpokeDefs.push({
        key: 'validator',
        roleTag: 'Guard',
        icon: 'V',
        modelName: 'Validator Guard',
        fullModel: 'validator.mjs',
        tooltip: 'Validator Guard (scripts/validator.mjs) - Fast Checks & Test Suite',
        defaultPos: { left: '50%', top: '84%' }
      });

      // Reviewer (Rendered ONLY if present in team.yaml rolesConfig!)
      if (rolesConfig.reviewer && rolesConfig.reviewer.enabled !== false && rolesConfig.reviewer.model) {
        activeSpokeDefs.push({
          key: 'reviewer',
          roleTag: 'Reviewer',
          icon: 'T',
          modelName: formatCleanModel(rolesConfig.reviewer, 'Reviewer'),
          fullModel: rolesConfig.reviewer.model,
          tooltip: `Reviewer Agent (${rolesConfig.reviewer.model}) - TechLead Reviewer`,
          defaultPos: { left: '80%', top: '74%' }
        });
      }

      // 3. Render Spoke Nodes & SVG Lines dynamically (Strict DOM nodes)
      spokesContainer.replaceChildren();
      svgEl.replaceChildren();

      const isSpecStageWorking = rolesStatus.architect?.status === 'working' || rolesStatus.designer?.status === 'working';

      activeSpokeDefs.forEach(def => {
        let statusClass = '';
        let lineClass = 'link-path';

        const rStat = rolesStatus[def.key]?.status || 'idle';
        const isDefActive = (def.key === 'validator' && ['applier', 'validator'].includes(activeStage))
          || (def.key === 'writer' && (rStat === 'working' || (activeStage === 'writer' && !isSpecStageWorking)))
          || (def.key !== 'writer' && (activeStage === def.key || rStat === 'working'));

        if (mode === 'quick' && (def.key === 'router' || def.key === 'architect' || def.key === 'reviewer')) {
          statusClass = 'skipped';
          lineClass = 'link-path skipped';
        } else if (isDefActive) {
          statusClass = 'active';
          lineClass = 'link-path active';
        } else if (rStat === 'done' || rStat === 'approved' || activeStage === 'done' ||
                   (def.key === 'router' && ['writer', 'architect', 'designer', 'applier', 'validator', 'reviewer', 'git'].includes(activeStage)) ||
                   (def.key === 'writer' && ['applier', 'validator', 'reviewer', 'git'].includes(activeStage)) ||
                   (def.key === 'validator' && ['reviewer', 'git'].includes(activeStage)) ||
                   (def.key === 'reviewer' && ['git'].includes(activeStage))) {
          statusClass = 'done';
          lineClass = 'link-path done';
        }

        const isStacked = Array.isArray(def.models) && def.models.length > 1;

        // Spoke node element
        const nodeEl = document.createElement('div');
        nodeEl.className = `ai-capsule-node spoke-node node-${def.key} ${statusClass} ${isStacked ? 'stacked-models' : ''}`.trim();
        nodeEl.id = `capsule-${def.key}`;
        nodeEl.title = def.tooltip;
        nodeEl.style.left = def.defaultPos.left;
        nodeEl.style.top = def.defaultPos.top;

        const iconDiv = document.createElement('div');
        iconDiv.className = `node-icon icon-${def.key}`;
        iconDiv.textContent = def.icon;

        const spokeText = document.createElement('div');
        spokeText.className = 'spoke-text';

        const roleTagSpan = document.createElement('span');
        roleTagSpan.className = 'node-role-tag';
        roleTagSpan.textContent = def.roleTag;
        spokeText.appendChild(roleTagSpan);

        if (isStacked) {
          const stackDiv = document.createElement('div');
          stackDiv.className = 'spoke-models-stack';
          def.models.forEach(m => {
            const mRow = document.createElement('div');
            mRow.className = `spoke-model-row ${m.isPrimary ? 'primary-writer' : 'sub-writer'}`;
            mRow.title = `${m.id} (${m.tag})`;
            const bulletSpan = document.createElement('span');
            bulletSpan.className = 'spoke-model-bullet';
            bulletSpan.textContent = m.isPrimary ? '●' : '○';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'spoke-model-name';
            nameSpan.textContent = m.name;
            mRow.append(bulletSpan, nameSpan);
            stackDiv.appendChild(mRow);
          });
          spokeText.appendChild(stackDiv);
        } else {
          const labelSpan = document.createElement('span');
          labelSpan.className = 'node-label';
          labelSpan.textContent = def.modelName;
          spokeText.appendChild(labelSpan);
        }

        const dotDiv = document.createElement('div');
        dotDiv.className = 'node-status-dot';

        nodeEl.append(iconDiv, spokeText, dotDiv);
        spokesContainer.appendChild(nodeEl);

        // SVG connection line
        const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineEl.id = `link-hub-${def.key}`;
        lineEl.setAttribute('class', lineClass);
        svgEl.appendChild(lineEl);
      });

      // 4. Calculate coordinates from Hub to all active Spokes
      requestAnimationFrame(() => {
        const canvas = document.querySelector('.topology-canvas');
        if (!canvas) return;
        const cRect = canvas.getBoundingClientRect();
        if (cRect.width === 0 || cRect.height === 0) return;

        function getCenter(el) {
          if (!el) return { x: 0, y: 0 };
          const r = el.getBoundingClientRect();
          return {
            x: r.left + r.width / 2 - cRect.left,
            y: r.top + r.height / 2 - cRect.top
          };
        }

        const pHub = getCenter(capsuleHub);

        activeSpokeDefs.forEach(def => {
          const nodeEl = document.getElementById(`capsule-${def.key}`);
          const lineEl = document.getElementById(`link-hub-${def.key}`);
          if (!nodeEl || !lineEl) return;
          const pSpoke = getCenter(nodeEl);
          lineEl.setAttribute('x1', pHub.x.toFixed(1));
          lineEl.setAttribute('y1', pHub.y.toFixed(1));
          lineEl.setAttribute('x2', pSpoke.x.toFixed(1));
          lineEl.setAttribute('y2', pSpoke.y.toFixed(1));
        });
      });
    }

    // Recalculate dynamic SVG links on resize or tab switch
    function recalculateSvgLinks() {
      const canvas = document.querySelector('.topology-canvas');
      if (!canvas) return;
      const cRect = canvas.getBoundingClientRect();
      if (cRect.width === 0 || cRect.height === 0) return;

      function getCenter(el) {
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
          x: r.left + r.width / 2 - cRect.left,
          y: r.top + r.height / 2 - cRect.top
        };
      }

      const pHub = getCenter(capsuleHub);
      const allLines = document.querySelectorAll('#topology-svg line');
      allLines.forEach(lineEl => {
        const spokeKey = lineEl.id.replace('link-hub-', '');
        const nodeEl = document.getElementById(`capsule-${spokeKey}`);
        if (!nodeEl) return;
        const pSpoke = getCenter(nodeEl);
        lineEl.setAttribute('x1', pHub.x.toFixed(1));
        lineEl.setAttribute('y1', pHub.y.toFixed(1));
        lineEl.setAttribute('x2', pSpoke.x.toFixed(1));
        lineEl.setAttribute('y2', pSpoke.y.toFixed(1));
      });
    }

    // Intelligent Failure Tail Extraction (Zero Noise)
    function extractFailureTail(rawText) {
      if (!rawText || typeof rawText !== 'string') return null;
      const text = rawText.trim();
      if (!text) return null;

      const anchorMatch = text.search(/(?:FAIL:|ERROR:|AssertionError:|SyntaxError:|Traceback \(most recent call last\):|ValidationError:|ApplierRejection:)/i);

      if (anchorMatch !== -1) {
        const tail = text.slice(anchorMatch).trim();
        const lines = tail.split(/\r?\n/).filter(Boolean);
        const headline = lines[0] || 'Execution Error';

        return {
          title: headline.split('(')[0].trim().slice(0, 60),
          summary: headline.slice(0, 160),
          tail: tail.slice(0, 3000),
          raw: text
        };
      }

      const lines = text.split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(-15).join('\n');
      return {
        title: 'EXECUTION ERROR / FAILURE',
        summary: lines[lines.length - 1]?.slice(0, 160) || 'Error occurred during execution',
        tail: tail,
        raw: text
      };
    }

    let bannerRetryBtn = null;

    async function handleRetryBlockedTask(taskId, btnEl) {
      if (!taskId) return;
      const origText = btnEl ? btnEl.textContent : 'Retry';
      try {
        if (btnEl) {
          btnEl.disabled = true;
          btnEl.textContent = 'Retrying...';
        }
        const res = window.CockpitApi?.retryTask
          ? await window.CockpitApi.retryTask(taskId)
          : await (await fetch('/api/task/retry', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Dashboard-Token': csrfToken || ''
              },
              body: JSON.stringify({ task_id: taskId })
            })).json();
        if (!res.ok) throw new Error(res.error || 'Không thể retry task');
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = origText;
        }
        fetchSnapshot();
      } catch (err) {
        alert('Lỗi retry task: ' + err.message);
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.textContent = origText;
        }
      }
    }

    function ensureBannerRetryButton() {
      if (bannerRetryBtn || !lastErrorTitle || !lastErrorTitle.parentElement) {
        return bannerRetryBtn;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-queue-retry btn-banner-retry';
      btn.style.display = 'none';
      btn.textContent = 'Retry';
      btn.title = 'Đưa task blocked về ready và chạy lại Orchestrator';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.dataset.taskId;
        if (tid) handleRetryBlockedTask(tid, btn);
      });
      lastErrorTitle.parentElement.appendChild(btn);
      bannerRetryBtn = btn;
      return btn;
    }

    function renderLastError(errorText, isTaskDone, blockedTarget = null) {
      const btnRetry = ensureBannerRetryButton();

      // AC-4: If task succeeded on retry (isTaskDone), suppress old error banner!
      if (isTaskDone) {
        lastErrorBanner.style.display = 'none';
        if (btnRetry) btnRetry.style.display = 'none';
        return;
      }

      const parsed = extractFailureTail(errorText);
      if (parsed) {
        lastErrorBanner.style.display = 'flex';
        lastErrorTitle.textContent = parsed.title;
        lastErrorSummary.textContent = parsed.summary;
        lastErrorTail.textContent = parsed.tail;
        lastErrorRaw.textContent = parsed.raw;
        if (btnRetry) {
          if (blockedTarget && blockedTarget.task_id) {
            btnRetry.dataset.taskId = blockedTarget.task_id;
            btnRetry.textContent = 'Retry';
            btnRetry.title = `Retry ${blockedTarget.task_id} sau khi đã commit/stash`;
            btnRetry.style.display = 'inline-flex';
          } else {
            btnRetry.dataset.taskId = '';
            btnRetry.style.display = 'none';
          }
        }
      } else {
        lastErrorBanner.style.display = 'none';
        if (btnRetry) btnRetry.style.display = 'none';
      }
    }

    // Render Scoped Files securely
    function renderScopedFiles(files) {
      while (scopeFilesList.firstChild) {
        scopeFilesList.removeChild(scopeFilesList.firstChild);
      }

      if (!files || files.length === 0) {
        const li = document.createElement('li');
        li.className = 'file-item';
        const sp = document.createElement('span');
        sp.className = 'file-path';
        sp.textContent = 'No scope locked';
        li.appendChild(sp);
        scopeFilesList.appendChild(li);
        scopeCount.textContent = '0 files';
        return;
      }

      scopeCount.textContent = files.length + (files.length === 1 ? ' file' : ' files');

      files.forEach(f => {
        const filePath = typeof f === 'object' ? f.path : String(f);
        const fileStatus = typeof f === 'object' ? (f.status || 'pending') : 'pending';

        const li = document.createElement('li');
        li.className = 'file-item';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'file-path';
        pathSpan.textContent = filePath;
        pathSpan.title = filePath;

        const tagSpan = document.createElement('span');
        tagSpan.className = 'file-tag file-' + fileStatus;
        tagSpan.textContent = fileStatus;

        li.appendChild(pathSpan);
        li.appendChild(tagSpan);
        scopeFilesList.appendChild(li);
      });
    }

    // Render Task Queue list
    function renderTaskQueue(q) {
      cntActive.textContent = String(q.active_count ?? 0);
      cntDone.textContent = String(q.completed_count ?? 0);
      cntBlocked.textContent = String(q.blocked_count ?? 0);

      while (queueItemsList.firstChild) {
        queueItemsList.removeChild(queueItemsList.firstChild);
      }

      let hasItems = false;

      // 1. Active tasks
      if (Array.isArray(q.active) && q.active.length > 0) {
        q.active.forEach(t => {
          hasItems = true;
          const item = document.createElement('div');
          item.className = 'queue-item queue-item-clickable';
          if (t.task_id) {
            item.addEventListener('click', () => openTaskDetailModal(t.task_id));
          }

          const left = document.createElement('div');
          left.className = 'queue-item-left';

          const icon = document.createElement('span');
          icon.className = 'queue-item-dot dot-active';

          const tid = document.createElement('span');
          tid.className = 'queue-item-id';
          tid.textContent = t.task_id || 'active-task';
          tid.title = t.title || t.task_id || '';

          left.appendChild(icon);
          left.appendChild(tid);

          const badge = document.createElement('span');
          badge.className = 'queue-item-badge q-active';
          badge.textContent = 'ACTIVE';

          item.appendChild(left);
          item.appendChild(badge);
          queueItemsList.appendChild(item);
        });
      }

      // 2. Blocked tasks
      if (Array.isArray(q.blocked) && q.blocked.length > 0) {
        q.blocked.forEach(t => {
          hasItems = true;
          const item = document.createElement('div');
          item.className = 'queue-item queue-item-clickable';
          if (t.task_id) {
            item.addEventListener('click', () => openTaskDetailModal(t.task_id));
          }

          const left = document.createElement('div');
          left.className = 'queue-item-left';

          const icon = document.createElement('span');
          icon.className = 'queue-item-dot dot-blocked';

          const tid = document.createElement('span');
          tid.className = 'queue-item-id';
          tid.textContent = t.task_id || 'blocked-task';
          tid.title = (t.block_reason || t.title) ? `Reason: ${t.block_reason || t.title}` : t.task_id;

          left.appendChild(icon);
          left.appendChild(tid);

          const actions = document.createElement('div');
          actions.className = 'queue-item-actions';

          const btnRetry = document.createElement('button');
          btnRetry.type = 'button';
          btnRetry.className = 'btn-queue-retry';
          btnRetry.textContent = 'Retry';
          btnRetry.title = t.task_id
            ? `Retry ${t.task_id} sau khi đã xử lý nguyên nhân block`
            : 'Retry task';
          btnRetry.addEventListener('click', (e) => {
            e.stopPropagation();
            if (t.task_id) handleRetryBlockedTask(t.task_id, btnRetry);
          });

          const badge = document.createElement('span');
          badge.className = 'queue-item-badge q-blocked';
          badge.textContent = 'BLOCKED';

          actions.appendChild(btnRetry);
          actions.appendChild(badge);

          item.appendChild(left);
          item.appendChild(actions);
          queueItemsList.appendChild(item);
        });
      }

      // 3. Recent completed tasks
      if (Array.isArray(q.recent_completed) && q.recent_completed.length > 0) {
        q.recent_completed.forEach(t => {
          hasItems = true;
          const item = document.createElement('div');
          item.className = 'queue-item queue-item-clickable';
          if (t.task_id) {
            item.addEventListener('click', () => openTaskDetailModal(t.task_id));
          }

          const left = document.createElement('div');
          left.className = 'queue-item-left';

          const icon = document.createElement('span');
          icon.textContent = '✓';
          icon.style.color = '#34d399';

          const tid = document.createElement('span');
          tid.className = 'queue-item-id';
          tid.textContent = t.task_id || 'done-task';
          tid.title = t.title || t.task_id;

          left.appendChild(icon);
          left.appendChild(tid);

          if (t.commit_hash) {
            const cSpan = document.createElement('span');
            cSpan.className = 'q-commit';
            cSpan.textContent = '[' + String(t.commit_hash).substring(0, 7) + ']';
            left.appendChild(cSpan);
          }

          const badge = document.createElement('span');
          badge.className = 'queue-item-badge q-done';
          badge.textContent = 'DONE';

          item.appendChild(left);
          item.appendChild(badge);
          queueItemsList.appendChild(item);
        });
      }

      if (!hasItems) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.color = 'var(--text-muted)';
        emptyDiv.style.fontSize = '11px';
        emptyDiv.style.fontStyle = 'italic';
        emptyDiv.style.padding = '4px 6px';
        emptyDiv.textContent = '(Queue is empty)';
        queueItemsList.appendChild(emptyDiv);
      }

      renderManualReviewQueue(q);
      renderUnseenExactMatches(q);
    }

    function renderUnseenExactMatches(q) {
      if (!unseenExactSection || !unseenExactList) return;
      const items = Array.isArray(q?.unseen_exact_matches) ? q.unseen_exact_matches : [];
      const totalBlocks = items.reduce((acc, entry) => acc + Number(entry?.block_count ?? entry?.blocks?.length ?? 0), 0);

      if (cntUnseenExact) cntUnseenExact.textContent = String(totalBlocks);
      unseenExactList.replaceChildren();

      if (items.length === 0 || totalBlocks === 0) {
        unseenExactSection.style.display = 'none';
        return;
      }

      unseenExactSection.style.display = 'block';
      items.forEach(entry => {
        const card = document.createElement('div');
        card.className = 'queue-item';
        card.style.flexDirection = 'column';
        card.style.alignItems = 'stretch';
        card.style.gap = '4px';

        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.justifyContent = 'space-between';
        topRow.style.alignItems = 'center';
        topRow.style.gap = '6px';

        const tid = document.createElement('span');
        tid.className = 'queue-item-id queue-item-clickable';
        tid.textContent = entry.task_id || 'task';
        tid.title = entry.title || entry.task_id || '';
        if (entry.task_id) {
          tid.addEventListener('click', () => openTaskDetailModal(entry.task_id));
        }

        const delCnt = Number(entry.delete_count || 0);
        const blkCnt = Number(entry.block_count ?? entry.blocks?.length ?? 0);
        const summaryTag = document.createElement('span');
        summaryTag.className = delCnt > 0 ? 'queue-item-badge q-blocked' : 'queue-item-badge q-active';
        summaryTag.textContent = delCnt > 0
          ? `${blkCnt} block(s) • ${delCnt} DELETE`
          : `${blkCnt} block(s)`;

        topRow.appendChild(tid);
        topRow.appendChild(summaryTag);
        card.appendChild(topRow);

        const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
        blocks.forEach(blk => {
          const row = document.createElement('div');
          row.style.display = 'flex';
          row.style.justifyContent = 'space-between';
          row.style.alignItems = 'center';
          row.style.gap = '6px';
          row.style.fontSize = '10px';
          row.style.color = 'var(--text-secondary)';

          const locSpan = document.createElement('span');
          locSpan.style.wordBreak = 'break-all';
          locSpan.textContent = `#${blk.block || '?'} ${blk.file || ''}:${blk.start_line || 0}-${blk.end_line || 0}`;

          const kindSpan = document.createElement('span');
          const isDelete = Boolean(blk.is_delete || blk.action_kind === 'delete');
          kindSpan.className = isDelete ? 'queue-item-badge q-blocked' : 'queue-item-badge q-done';
          kindSpan.textContent = isDelete ? '[DELETE]' : '[MODIFY]';

          row.appendChild(locSpan);
          row.appendChild(kindSpan);
          card.appendChild(row);
        });

        unseenExactList.appendChild(card);
      });
    }

    function renderManualReviewQueue(q) {
      if (!manualReviewSection || !manualReviewList) return;
      const items = Array.isArray(q?.manual_review)
        ? q.manual_review
        : (Array.isArray(q?.blocked)
            ? q.blocked.filter(t => t?.failure_class === 'review_unavailable' || /review_unavailable/i.test(String(t?.block_reason || '')))
            : []);

      if (cntManualReview) cntManualReview.textContent = String(items.length);
      manualReviewList.replaceChildren();

      if (items.length === 0) {
        manualReviewSection.style.display = 'none';
        return;
      }

      manualReviewSection.style.display = 'block';
      items.forEach(entry => {
        const card = document.createElement('div');
        card.className = 'queue-item';
        card.style.flexDirection = 'column';
        card.style.alignItems = 'stretch';
        card.style.gap = '4px';

        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.justifyContent = 'space-between';
        topRow.style.alignItems = 'center';
        topRow.style.gap = '6px';

        const tid = document.createElement('span');
        tid.className = 'queue-item-id queue-item-clickable';
        tid.textContent = entry.task_id || 'review-task';
        tid.title = entry.title || entry.task_id || '';
        if (entry.task_id) {
          tid.addEventListener('click', () => openTaskDetailModal(entry.task_id));
        }

        const badge = document.createElement('span');
        badge.className = 'queue-item-badge q-blocked';
        badge.textContent = 'MANUAL REVIEW';

        topRow.appendChild(tid);
        topRow.appendChild(badge);
        card.appendChild(topRow);

        if (entry.pending_review_patch) {
          const patchLine = document.createElement('div');
          patchLine.style.fontSize = '10px';
          patchLine.style.color = 'var(--text-secondary)';
          patchLine.style.wordBreak = 'break-all';
          patchLine.textContent = 'Patch: ' + String(entry.pending_review_patch);
          card.appendChild(patchLine);
        }

        const applyCmd = entry.apply_command || (entry.pending_review_patch ? ('git apply ' + String(entry.pending_review_patch)) : '');
        if (applyCmd) {
          const cmdRow = document.createElement('div');
          cmdRow.style.display = 'flex';
          cmdRow.style.alignItems = 'center';
          cmdRow.style.gap = '6px';

          const cmdCode = document.createElement('code');
          cmdCode.style.flex = '1';
          cmdCode.style.fontSize = '10px';
          cmdCode.style.padding = '3px 6px';
          cmdCode.style.borderRadius = '4px';
          cmdCode.style.background = 'rgba(0,0,0,0.28)';
          cmdCode.style.overflowX = 'auto';
          cmdCode.style.whiteSpace = 'nowrap';
          cmdCode.textContent = applyCmd;

          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'btn-retry-task';
          copyBtn.textContent = 'Copy';
          copyBtn.title = 'Copy lệnh git apply patch';
          copyBtn.addEventListener('click', () => {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(applyCmd).catch(() => {});
            }
            copyBtn.textContent = 'Copied ✓';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          });

          cmdRow.appendChild(cmdCode);
          cmdRow.appendChild(copyBtn);
          card.appendChild(cmdRow);
        }

        manualReviewList.appendChild(card);
      });
    }

    // Render Logs securely with auto-scroll
    function renderLogs(logs) {
      if (isLogPaused || !logs) return;

      const filterLower = logFilterText.toLowerCase().trim();
      const filtered = filterLower
        ? logs.filter(l => (l.msg || '').toLowerCase().includes(filterLower))
        : logs;

      const newHash = JSON.stringify(filtered);
      if (newHash === lastRenderedLogsHash) return;
      lastRenderedLogsHash = newHash;

      while (consoleLogs.firstChild) {
        consoleLogs.removeChild(consoleLogs.firstChild);
      }

      filtered.forEach(log => {
        const row = document.createElement('div');
        row.className = 'log-line';

        const tsSpan = document.createElement('span');
        tsSpan.className = 'log-ts';
        tsSpan.textContent = log.ts || '--:--:--';

        const lvlSpan = document.createElement('span');
        lvlSpan.className = 'log-lvl log-lvl-' + (log.level || 'info');
        lvlSpan.textContent = log.level || 'info';

        const msgSpan = document.createElement('span');
        msgSpan.className = 'log-msg';
        msgSpan.textContent = log.msg || '';

        row.appendChild(tsSpan);
        row.appendChild(lvlSpan);
        row.appendChild(msgSpan);
        consoleLogs.appendChild(row);
      });

      consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }

    // Count search blocks in writer output
    function countSearchBlocks(text) {
      if (!text || typeof text !== 'string') return 0;
      const matches = text.match(/<<<<<<< SEARCH/g);
      return matches ? matches.length : 0;
    }

    // Render Sessions List & Receipts
    function renderSessionsList(sessions) {
      cachedSessionsList = sessions || [];
      if (sessionsCountBadge) {
        sessionsCountBadge.textContent = String(cachedSessionsList.length);
      }

      if (!sessionsList) return;
      const activeId = currentSelectedSessionId;
      while (sessionsList.firstChild) {
        sessionsList.removeChild(sessionsList.firstChild);
      }

      if (cachedSessionsList.length === 0) {
        const empty = document.createElement('div');
        empty.style.color = 'var(--text-muted)';
        empty.style.fontSize = '11px';
        empty.style.fontStyle = 'italic';
        empty.style.padding = '8px';
        empty.textContent = '(No active sessions found)';
        sessionsList.appendChild(empty);
        return;
      }

      cachedSessionsList.forEach(s => {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.session_id === activeId ? ' active' : '');
        item.addEventListener('click', () => selectSession(s.session_id));

        const topRow = document.createElement('div');
        topRow.className = 'session-item-row';

        const idSpan = document.createElement('span');
        idSpan.className = 'session-item-id';
        idSpan.textContent = s.session_id;
        idSpan.title = s.session_id;

        const roleSpan = document.createElement('span');
        roleSpan.className = 'session-item-role role-' + (s.role || 'writer');
        roleSpan.textContent = (s.role || 'writer').toUpperCase();

        topRow.appendChild(idSpan);
        topRow.appendChild(roleSpan);

        const subRow = document.createElement('div');
        subRow.className = 'session-item-sub';

        const msgsSpan = document.createElement('span');
        msgsSpan.textContent = `${s.message_count || 0} msgs • ${s.tool_receipts_count || 0} tools`;

        const timeSpan = document.createElement('span');
        timeSpan.textContent = s.updated_at ? new Date(s.updated_at).toLocaleTimeString() : '';

        subRow.appendChild(msgsSpan);
        subRow.appendChild(timeSpan);

        item.appendChild(topRow);
        item.appendChild(subRow);
        sessionsList.appendChild(item);
      });
    }

    async function selectSession(sessionId) {
      if (!sessionId || !sessionActiveContent || !sessionEmptyState) return;
      currentSelectedSessionId = sessionId;

      // Update sidebar active highlights
      const items = sessionsList.querySelectorAll('.session-item');
      items.forEach(el => {
        const idEl = el.querySelector('.session-item-id');
        if (idEl && idEl.textContent === sessionId) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });

      try {
        const data = window.CockpitApi?.fetchSession
          ? await window.CockpitApi.fetchSession(sessionId)
          : await (await fetch(`/api/session?id=${encodeURIComponent(sessionId)}`)).json();
        if (!data || !data.ok || !data.session) return;

        const s = data.session;
        sessionEmptyState.style.display = 'none';
        sessionActiveContent.style.display = 'flex';

        sessRolePill.textContent = (s.role || 'writer').toUpperCase();
        sessRolePill.className = 'session-item-role role-' + (s.role || 'writer');
        sessIdTitle.textContent = s.session_id;
        sessModelText.textContent = s.model || 'unknown';
        sessMsgCount.textContent = String(s.messages ? s.messages.length : 0);
        sessToolsCount.textContent = String(s.tool_receipts ? s.tool_receipts.length : 0);

        // Render Tool Receipts Timeline
        while (sessReceiptsTimeline.firstChild) {
          sessReceiptsTimeline.removeChild(sessReceiptsTimeline.firstChild);
        }
        const receipts = s.tool_receipts || [];
        if (receipts.length === 0) {
          const noReceipt = document.createElement('span');
          noReceipt.style.fontSize = '11px';
          noReceipt.style.color = 'var(--text-muted)';
          noReceipt.style.fontStyle = 'italic';
          noReceipt.textContent = '(No tool calls executed yet in this session)';
          sessReceiptsTimeline.appendChild(noReceipt);
        } else {
          receipts.forEach(r => {
            const pill = document.createElement('div');
            pill.className = 'receipt-pill' + (r.status === 'ok' ? '' : ' error');
            pill.textContent = `[Turn ${r.turn || 1}] ${r.tool} -> ${r.status} (${r.summary || 'done'})`;
            sessReceiptsTimeline.appendChild(pill);
          });
        }

        // Render Messages Trajectory
        while (sessMessagesContainer.firstChild) {
          sessMessagesContainer.removeChild(sessMessagesContainer.firstChild);
        }
        const msgs = s.messages || [];
        msgs.forEach(m => {
          const bubble = document.createElement('div');
          bubble.className = 'msg-bubble msg-' + (m.role || 'user');

          let textContent = '';
          if (typeof m.content === 'string') {
            textContent = m.content;
          } else if (Array.isArray(m.content)) {
            textContent = m.content.map(part => {
              if (part.type === 'text') return part.text || '';
              if (part.type === 'image_url') return '[Attached Image: Base64]';
              return JSON.stringify(part);
            }).join('\n');
          } else {
            textContent = JSON.stringify(m.content || '');
          }

          if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const callsText = m.tool_calls.map(tc => `Tool Call: ${tc.function?.name || tc.name}(${tc.function?.arguments || ''})`).join('\n');
            textContent = textContent ? `${textContent}\n\n${callsText}` : callsText;
          }

          bubble.textContent = `[${(m.role || 'user').toUpperCase()}]: ${textContent}`;
          sessMessagesContainer.appendChild(bubble);
        });

        sessMessagesContainer.scrollTop = sessMessagesContainer.scrollHeight;
      } catch (err) {
        console.error('Failed to load session details:', err);
      }
    }

    function populateGoalWriterModelSelect(rosterModels, rolesConfig) {
      if (!selGoalWriterModel) return;
      const list = [];
      const seen = new Set();
      if (Array.isArray(rosterModels)) {
        rosterModels.forEach(entry => {
          const id = typeof entry === 'string' ? entry : entry?.model;
          if (id && !seen.has(id)) {
            seen.add(id);
            list.push(id);
          }
        });
      } else if (rolesConfig && typeof rolesConfig === 'object') {
        Object.values(rolesConfig).forEach(r => {
          if (!r || r.enabled === false) return;
          const disabledSet = new Set(
            (Array.isArray(r.disabled_models) ? r.disabled_models : [])
              .map(d => (typeof d === 'string' ? d : (d?.disabled !== false ? (d?.id || d?.model) : '')))
              .filter(Boolean)
          );
          const rawList = [
            ...(Array.isArray(r.models) ? r.models.map(m => (typeof m === 'string' ? m : (m?.disabled ? '' : (m?.id || m?.model)))) : []),
            r.default_model,
            r.model,
            r.fallback_model
          ];
          rawList.forEach(id => {
            if (id && !disabledSet.has(id) && !seen.has(id)) {
              seen.add(id);
              list.push(id);
            }
          });
        });
      }
      const prevVal = selGoalWriterModel.value;
      const hash = list.join('|');
      if (selGoalWriterModel.dataset.rosterHash === hash) return;
      selGoalWriterModel.dataset.rosterHash = hash;
      while (selGoalWriterModel.firstChild) {
        selGoalWriterModel.removeChild(selGoalWriterModel.firstChild);
      }
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Writer: Mặc định (team.yaml)';
      selGoalWriterModel.appendChild(defaultOpt);
      list.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `Writer: ${id}`;
        selGoalWriterModel.appendChild(opt);
      });
      selGoalWriterModel.value = list.includes(prevVal) ? prevVal : '';
    }

    // Main Snapshot Fetcher
    async function fetchSnapshot() {
      try {
        const data = window.CockpitApi?.fetchSnapshot
          ? await window.CockpitApi.fetchSnapshot()
          : await (await fetch('/api/snapshot')).json();

        if (data.csrf_token) {
          csrfToken = data.csrf_token;
          if (window.CockpitApi?.setCsrfToken) window.CockpitApi.setCsrfToken(data.csrf_token);
        }

        if (data.policy) {
          currentPolicyConfig = data.policy;
        }

        if (data.router_provider) {
          if (data.router_provider.host_label) {
            currentRouterHostLabel = data.router_provider.host_label;
          }
          if (cfg9RouterUrl && !cfg9RouterUrl.dataset.userEdited && data.router_provider.base_url) {
            cfg9RouterUrl.value = data.router_provider.base_url;
          }
          if (cfg9RouterKey && !cfg9RouterKey.dataset.userEdited && data.router_provider.default_key) {
            cfg9RouterKey.value = data.router_provider.default_key;
          }
        }

        currentSpecModels = (data.spec_models && typeof data.spec_models === 'object') ? data.spec_models : null;
        renderSpecModelsSummaryBar(currentSpecModels);

        txtPolling.textContent = '1s Polling';

        // 1. Project Info
        if (data.project && data.project.id) {
          txtProject.textContent = data.project.id;
        }

        // 2. 9Router Hub Health & Latency
        const hostLabel = data.router_health?.host_label || currentRouterHostLabel || ':20128';
        if (data.router_health && data.router_health.ok) {
          dotRouter.className = 'dot online';
          txtRouter.textContent = '9Router ' + hostLabel + ' (' + data.router_health.latency_ms + 'ms)';
        } else {
          dotRouter.className = 'dot offline';
          txtRouter.textContent = '9Router ' + hostLabel + ' DOWN';
        }

        // 3. Orchestrator Process Status
        const isRunning = Boolean(data.orchestrator && data.orchestrator.running);
        if (isRunning) {
          dotOrchestrator.className = 'dot running';
          txtOrchestrator.textContent = 'RUNNING (PID ' + data.orchestrator.pid + ')';
          if (btnStopOrchestrator) btnStopOrchestrator.style.display = 'inline-block';
        } else {
          dotOrchestrator.className = 'dot';
          txtOrchestrator.textContent = 'IDLE';
          if (btnStopOrchestrator) btnStopOrchestrator.style.display = 'none';
        }

        // 4. Tokens & Cache Hit Telemetry
        const live = data.live_status || {};
        tokIn.textContent = formatTokens(live.tokens?.session_input || 0);
        tokOut.textContent = formatTokens(live.tokens?.session_output || 0);
        if (tokCache) {
          tokCache.textContent = (live.tokens?.cache_hit_pct ?? 0) + '%';
        }

        // 5. Pipeline Stages & Top Stage Indicator
        const activeStage = live.current_stage || (isRunning ? 'preflight' : 'idle');
        let stageDisplay = activeStage.toUpperCase();
        if (activeStage === 'writer') stageDisplay = 'WRITER HUB';
        else if (activeStage === 'applier') stageDisplay = 'APPLIER (GHI ĐĨA)';
        txtStage.textContent = 'Stage: ' + stageDisplay;
        if (activeStage === 'idle') {
          dotStage.className = 'dot';
        } else if (activeStage === 'done') {
          dotStage.className = 'dot online';
        } else if (activeStage === 'blocked' || activeStage === 'failed') {
          dotStage.className = 'dot offline';
        } else {
          dotStage.className = 'dot running';
        }

        const isTaskDone = (live.current_stage === 'done') || (!isRunning && data.last_completed_task);

        // Calculate static duration if task completed
        if (isTaskDone) {
          if (live.task_completed_at && live.task_started_at) {
            const diff = Math.floor((new Date(live.task_completed_at).getTime() - new Date(live.task_started_at).getTime()) / 1000);
            taskDurationStatic = Math.max(1, diff);
          } else if (data.last_completed_task?.completed_at && data.last_completed_task?.created_at) {
            const diff = Math.floor((new Date(data.last_completed_task.completed_at).getTime() - new Date(data.last_completed_task.created_at).getTime()) / 1000);
            taskDurationStatic = Math.max(1, diff);
          } else {
            taskDurationStatic = null;
          }
        } else {
          taskDurationStatic = null;
        }

        taskStartedAt = live.task_started_at ? new Date(live.task_started_at).getTime() : null;

        // Update Waterfall Strip
        updateWaterfallPipeline(activeStage, live.stage_started_at, live.mode || 'quick', live.attempt || 1, isRunning, data.last_completed_task);

        // 6. Active Task Card or Idle Summary
        if (isRunning && live.current_task_id) {
          taskCardTitle.textContent = 'Active Task';
          taskId.textContent = live.current_task_id;
          taskAttempt.textContent = 'Attempt ' + (live.attempt || 1) + ' / ' + (live.max_retries || 3);
          taskMode.textContent = 'MODE: ' + (live.mode || 'QUICK').toUpperCase();
          taskMode.className = 'tag tag-' + (live.mode === 'standard' ? 'standard' : 'quick');
          taskRisk.textContent = 'RISK: ' + (live.risk_level || 'LOW').toUpperCase();
          taskRisk.className = 'tag tag-' + (live.risk_level || 'low');
          taskCommitTag.style.display = 'none';
          taskGoal.textContent = live.current_task_title || '(No task goal declared)';
        } else if (data.last_completed_task) {
          const lt = data.last_completed_task;
          taskCardTitle.textContent = 'Last Completed Task (Idle)';
          taskId.textContent = lt.task_id;
          taskAttempt.textContent = 'Finished (' + (lt.retries || 1) + ' attempts)';
          taskMode.textContent = 'DONE ✓';
          taskMode.className = 'tag tag-low';
          taskRisk.textContent = (lt.mode || 'quick').toUpperCase();
          taskRisk.className = 'tag tag-quick';

          if (lt.commit_hash) {
            taskCommitTag.textContent = lt.commit_hash.slice(0, 7);
            taskCommitTag.style.display = 'inline-block';
          } else {
            taskCommitTag.style.display = 'none';
          }

          taskGoal.textContent = lt.title || 'Orchestrator idle — Ready for next task in agent-team/tasks/active/';
        } else {
          taskCardTitle.textContent = 'Active Task';
          taskId.textContent = isRunning ? 'Preparing task...' : 'No active task';
          taskAttempt.textContent = 'Attempt 0 / 3';
          taskMode.textContent = 'MODE: IDLE';
          taskMode.className = 'tag tag-quick';
          taskRisk.textContent = 'RISK: LOW';
          taskRisk.className = 'tag tag-low';
          taskCommitTag.style.display = 'none';
          taskGoal.textContent = 'Waiting for orchestrator task...';
        }

        // 7. Left Column AI Personnel Models (Workflow Squad)
        const rolesStatus = live.roles_status || {};
        const rolesConfig = data.roles || {};
        currentSquadRolesConfig = rolesConfig;
        populateGoalWriterModelSelect(data.roster_models, rolesConfig);

        renderWorkflowSquad(activeStage, rolesStatus, rolesConfig, live);
        renderCircuitBreakerBanner(data.circuit_breakers);

        // 8. Update Adaptive Star Topology Network (Center Hub & Spoke Links)
        updateTopologyNetwork(activeStage, rolesStatus, rolesConfig, data);

        // 9. Scoped Files
        renderScopedFiles(live.scope_files);

        // 10. Task Queue List
        renderTaskQueue(data.queue || {});

        // 10a. Auto-sync pending tasks in Cockpit (draft_review or ready status)
        const activeDrafts = (data.queue?.active || []).filter(t => t.status === 'draft_review' || t.status === 'ready');
        if (currentDraftTasks.length === 0 && activeDrafts.length > 0) {
          currentDraftTasks = activeDrafts;
          renderDraftTasks(currentDraftTasks);
        } else if (currentDraftTasks.length > 0) {
          const activeIds = new Set((data.queue?.active || []).map(t => t.task_id));
          const stillExisting = currentDraftTasks.filter(t => activeIds.has(t.task_id));
          if (stillExisting.length !== currentDraftTasks.length) {
            currentDraftTasks = stillExisting;
            renderDraftTasks(currentDraftTasks);
          }
        }

        // 10b. Agent Sessions & Tool Receipts
        renderSessionsList(data.sessions || []);

        // 11. Error Callout (Intelligent Failure Tail, suppressed if task is done)
        const blockedList = Array.isArray(data.queue?.blocked) ? data.queue.blocked : [];
        const blockedTarget = blockedList.find(t => t.task_id === live.current_task_id) || blockedList[0] || null;
        const effectiveLastError = live.last_error || (blockedTarget?.block_reason || null);
        renderLastError(effectiveLastError, isTaskDone, blockedTarget);

        // 12. Telemetry Footer Chips
        const out = data.latest_output || {};
        const reqModel = out.model_requested || 'N/A';
        const respModel = out.model_responded || 'N/A';
        const isMatch = (reqModel !== 'N/A' && respModel !== 'N/A' && reqModel.toLowerCase().includes(respModel.toLowerCase()));

        telModelVerify.textContent = isMatch ? 'Req == Resp ✓' : `${respModel || 'OK'}`;
        telFinish.textContent = (out.finish_reason || 'stop') + ' ✓';

        const blocks = countSearchBlocks(out.content);
        telBlocks.textContent = `${blocks} SEARCH/REPLACE blocks`;
        telAttempt.textContent = `${live.attempt || 1} / ${live.max_retries || 3}`;

        if (live.recovered_on_retry || (isTaskDone && (live.attempt || 1) > 1)) {
          telRecoveredBadge.textContent = `✓ Auto-Recovered on Retry ${live.attempt ? live.attempt - 1 : 1}`;
          telRecoveredBadge.style.display = 'inline-block';
        } else {
          telRecoveredBadge.style.display = 'none';
        }

        outAttemptBadge.textContent = `${live.attempt || 1} / ${live.max_retries || 3}`;
        outFinishBadge.textContent = out.finish_reason || 'stop';

        // 13. Tab 2 Raw Content
        writerOutput.textContent = out.content || '(No writer output recorded yet)';

        // 14. Console Logs
        renderLogs(live.recent_logs);

      } catch (err) {
        txtPolling.textContent = '○ Reconnecting...';
        dotOrchestrator.className = 'dot';
        dotStage.className = 'dot';
        txtStage.textContent = 'Stage: OFFLINE';
      }
    }

    // UI Event Listeners
    btnPauseLog.addEventListener('click', () => {
      isLogPaused = !isLogPaused;
      btnPauseLog.textContent = isLogPaused ? 'Resume' : 'Pause';
      btnPauseLog.style.background = isLogPaused ? 'var(--status-warning)' : '';
      btnPauseLog.style.color = isLogPaused ? '#000' : '';
    });

    btnClearLog.addEventListener('click', () => {
      if (consoleLogs) {
        while (consoleLogs.firstChild) {
          consoleLogs.removeChild(consoleLogs.firstChild);
        }
      }
      lastRenderedLogsHash = '';
    });

    logFilter.addEventListener('input', (e) => {
      logFilterText = e.target.value;
      lastRenderedLogsHash = '';
    });

    // Start Polling (every 1000ms) & initial dynamic anchor alignment
    window.addEventListener('load', () => requestAnimationFrame(recalculateSvgLinks));
    fetchSnapshot();
    setInterval(fetchSnapshot, 1000);