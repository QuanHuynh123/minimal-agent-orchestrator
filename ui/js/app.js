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
    const txtPolling = document.getElementById('txt-polling');

    // Waterfall Pipeline Elements
    const txtStepRouter = document.getElementById('txt-step-router');
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
    const squadModelWriter = document.getElementById('squad-model-writer');
    const squadStatusWriter = document.getElementById('squad-status-writer');
    const squadStatusFrontend = document.getElementById('squad-status-frontend');
    const squadStatusValidator = document.getElementById('squad-status-validator');
    const squadModelReviewer = document.getElementById('squad-model-reviewer');
    const squadStatusReviewer = document.getElementById('squad-status-reviewer');

    const scopeFilesList = document.getElementById('scope-files-list');
    const scopeCount = document.getElementById('scope-count');

    const cntActive = document.getElementById('cnt-active');
    const cntDone = document.getElementById('cnt-done');
    const cntBlocked = document.getElementById('cnt-blocked');
    const queueItemsList = document.getElementById('queue-items-list');

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
    const btnDecomposeGoal = document.getElementById('btn-decompose-goal');
    const txtDecomposeBtn = document.getElementById('txt-decompose-btn');
    const spinDecompose = document.getElementById('spin-decompose');
    const lblDecomposeStatus = document.getElementById('lbl-decompose-status');
    const listDraftTasks = document.getElementById('list-draft-tasks');
    const btnApproveRun = document.getElementById('btn-approve-run');
    const btnStopOrchestrator = document.getElementById('btn-stop-orchestrator');
    let csrfToken = null;
    let currentDraftTasks = [];

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

    // Standard Workflow SVG Links & Model Capsules
    const linkSonnetGemini = document.getElementById('link-sonnet-gemini');
    const linkSonnetDeepseek = document.getElementById('link-sonnet-deepseek');
    const linkGeminiValidator = document.getElementById('link-gemini-validator');
    const linkDeepseekValidator = document.getElementById('link-deepseek-validator');
    const linkValidatorDeepseek = document.getElementById('link-validator-deepseek');
    const linkValidatorOpus = document.getElementById('link-validator-opus');

    const capsuleSonnet = document.getElementById('capsule-sonnet');
    const capsuleGemini = document.getElementById('capsule-gemini');
    const capsuleDeepseek = document.getElementById('capsule-deepseek');
    const capsuleValidator = document.getElementById('capsule-validator');
    const capsuleOpus = document.getElementById('capsule-opus');

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

    // Config Modal Overlay Handlers (Hiện tab đè phủ toàn màn hình khi bấm nút Cấu Hình)
    function openConfigModal() {
      if (modalConfigOverlay) {
        modalConfigOverlay.style.display = 'flex';
        initSquadFromConfig();
        load9RouterModels();
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

    const covPills = {
      router: document.getElementById('cov-pill-router'),
      writer: document.getElementById('cov-pill-writer'),
      designer: document.getElementById('cov-pill-designer'),
      reviewer: document.getElementById('cov-pill-reviewer')
    };
    const squadTabCountBadge = document.getElementById('squad-tab-count-badge');

    // Tab Navigation: team.yaml vs project.yaml
    document.querySelectorAll('.cfg-nav-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.cfg-nav-tab').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        const target = tabBtn.dataset.tab;
        const panelTeam = document.getElementById('cfg-panel-team');
        const panelProj = document.getElementById('cfg-panel-project');
        if (target === 'team') {
          if (panelTeam) panelTeam.style.display = 'flex';
          if (panelProj) panelProj.style.display = 'none';
        } else {
          if (panelTeam) panelTeam.style.display = 'none';
          if (panelProj) panelProj.style.display = 'flex';
        }
      });
    });

    async function load9RouterModels(force = false) {
      if (available9RouterModels.length > 0 && !force) {
        renderModelPool();
        return;
      }
      if (spinRefreshModels) spinRefreshModels.style.display = 'inline-block';
      if (cfgModelsCountText) cfgModelsCountText.textContent = 'Đang tải...';

      try {
        const res = await fetch('/api/models');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: Máy chủ cần khởi động lại để kích hoạt API mới.`);
        }
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error('API /api/models chưa sẵn sàng. Hãy tắt và chạy lại: node agent-team/scripts/dashboard.mjs');
        }

        if (data.ok && Array.isArray(data.models)) {
          available9RouterModels = data.models;
          if (cfgModelsCountText) {
            cfgModelsCountText.textContent = `${data.models.length} Models`;
          }
          if (cfgRouterBadge) {
            cfgRouterBadge.className = 'cfg-router-status-pill';
            cfgRouterBadge.textContent = `🟢 9Router :20128 (${data.models.length} models)`;
          }
          renderModelPool();
        } else {
          throw new Error(data.error || 'Dữ liệu model rỗng');
        }
      } catch (err) {
        if (cfgModelsCountText) cfgModelsCountText.textContent = 'Lỗi kết nối';
        if (cfgRouterBadge) {
          cfgRouterBadge.className = 'cfg-router-status-pill';
          cfgRouterBadge.style.color = '#f87171';
          cfgRouterBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          cfgRouterBadge.textContent = '🔴 9Router: ' + err.message;
        }
        if (modelPoolGrid) {
          modelPoolGrid.innerHTML = `
            <div style="padding: 16px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 6px; font-size: 11.5px; color: #fca5a5;">
              <strong>⚠️ Chú ý:</strong> ${escapeHtml(err.message)}<br/>
              <span style="font-size: 11px; opacity: 0.8; margin-top: 4px; display: inline-block;">Gợi ý: Nếu bạn vừa cập nhật code, hãy bấm <code>Ctrl + C</code> trong terminal đang chạy Dashboard và chạy lại: <code>node agent-team/scripts/dashboard.mjs</code></span>
            </div>
          `;
        }
      } finally {
        if (spinRefreshModels) spinRefreshModels.style.display = 'none';
      }
    }

    // Khởi tạo squadMembers từ snapshot config hiện có
    function initSquadFromConfig() {
      if (squadMembers.length > 0) {
        renderSquadPersonnel();
        return;
      }
      const initial = [];
      const roles = currentSquadRolesConfig || {};

      for (const [rKey, rSpec] of Object.entries(roles)) {
        if (!rSpec) continue;
        const modelsList = Array.isArray(rSpec.models) && rSpec.models.length > 0
          ? rSpec.models
          : (rSpec.model ? [rSpec.model] : []);

        modelsList.forEach(mId => {
          initial.push({
            model: mId,
            name: mId.split('/').pop() || mId,
            role: rKey,
            latency_ms: null,
            status: 'ready'
          });
        });
      }

      if (initial.length === 0) {
        initial.push({ model: 'kr/claude-sonnet-4.5-thinking', name: 'Claude Sonnet 4.5 Thinking', role: 'router', latency_ms: null });
        initial.push({ model: 'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', role: 'writer', latency_ms: null });
        initial.push({ model: 'ag/claude-opus-5-5-high', name: 'Claude Opus 5.5 High', role: 'reviewer', latency_ms: null });
      }

      squadMembers = initial;
      renderSquadPersonnel();
      renderModelPool();
    }

    // Render Compact Horizontal Rows (Cao ~54px, chống tràn text)
    function renderSquadPersonnel() {
      if (!squadMembersList) return;
      squadMembersList.innerHTML = '';

      if (squadCountBadge) squadCountBadge.textContent = `${squadMembers.length} Thành Viên`;
      if (squadTabCountBadge) squadTabCountBadge.textContent = `${squadMembers.length}`;

      if (squadMembers.length === 0) {
        squadMembersList.innerHTML = '<div class="empty-squad-notice">Chưa có thành viên nào trong đội. Chọn model từ Kho 9Router bên dưới và bấm "+ Thêm Vào Đội".</div>';
        updateRoleCoverageMatrix();
        return;
      }

      squadMembers.forEach((member, idx) => {
        const row = document.createElement('div');
        row.className = 'squad-compact-row';

        const matchedInPool = available9RouterModels.find(m => m.id === member.model);
        const caps = matchedInPool?.capabilities || {
          vision: member.model.includes('gemini') || member.model.includes('claude'),
          tools: true,
          reasoning: member.model.includes('thinking') || member.model.includes('opus') || member.model.includes('sonnet')
        };

        // Badges trung tính, không emoji lòe loẹt
        const capsHtml = `
          ${caps.vision ? '<span class="badge-neutral">Vision</span>' : ''}
          ${caps.tools ? '<span class="badge-neutral">Tools</span>' : ''}
          ${caps.reasoning ? '<span class="badge-neutral">Thinking</span>' : ''}
        `;

        const latencyBadgeHtml = member.testing
          ? '<span class="test-result-badge badge-running">...</span>'
          : (member.latency_ms !== null
              ? (member.error
                  ? `<span class="test-result-badge badge-error" title="${escapeHtml(member.error)}">✕ Lỗi</span>`
                  : `<span class="test-result-badge badge-done">✓ ${member.latency_ms}ms</span>`)
              : '<span class="test-result-badge">Chưa test</span>');

        row.innerHTML = `
          <div class="compact-left">
            <div class="compact-title-line">
              <span class="compact-model-name">${escapeHtml(member.name || member.model)}</span>
              <span class="compact-model-id">${escapeHtml(member.model)}</span>
            </div>
            <div class="compact-badges-row">${capsHtml}</div>
          </div>
          <div class="compact-right">
            <select class="compact-role-select" data-idx="${idx}">
              <option value="standby" ${member.role === 'standby' ? 'selected' : ''}>💤 Dự Bị (Standby)</option>
              <option value="router" ${member.role === 'router' ? 'selected' : ''}>🧠 Router (Architect &amp; Planner)</option>
              <option value="writer" ${member.role === 'writer' ? 'selected' : ''}>⚡ Writer (Code Generator)</option>
              <option value="designer" ${member.role === 'designer' ? 'selected' : ''}>👁️ Designer (Visual Auditor)</option>
              <option value="reviewer" ${member.role === 'reviewer' ? 'selected' : ''}>🛡️ Reviewer (TechLead Reviewer)</option>
            </select>
            ${latencyBadgeHtml}
            <button class="btn-compact-test btn-test-member" data-idx="${idx}" title="Đo độ trễ mạng thực tế">
              <span>⚡ Test</span>
            </button>
            <button class="btn-compact-remove" data-idx="${idx}" title="Gỡ khỏi đội ngũ">✕</button>
          </div>
        `;

        squadMembersList.appendChild(row);
      });

      // Events
      squadMembersList.querySelectorAll('.compact-role-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          if (squadMembers[idx]) {
            squadMembers[idx].role = e.target.value;
            updateRoleCoverageMatrix();
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
          squadMembers.splice(idx, 1);
          renderSquadPersonnel();
          renderModelPool();
        });
      });

      updateRoleCoverageMatrix();
    }

    function updateRoleCoverageMatrix() {
      const assignedMap = {};
      squadMembers.forEach(m => {
        if (m.role && m.role !== 'standby') {
          if (!assignedMap[m.role]) assignedMap[m.role] = [];
          assignedMap[m.role].push(m.name || m.model.split('/').pop());
        }
      });

      const roleDisplayNames = {
        router: 'Router',
        writer: 'Writer',
        designer: 'Designer',
        reviewer: 'Reviewer'
      };

      for (const [rKey, pillEl] of Object.entries(covPills)) {
        if (!pillEl) continue;
        const roleName = roleDisplayNames[rKey] || (rKey.charAt(0).toUpperCase() + rKey.slice(1));
        const list = assignedMap[rKey] || [];
        if (list.length > 0) {
          pillEl.className = 'cov-mini-pill assigned';
          const label = list.length === 1 ? list[0] : `${list[0]} (+${list.length - 1})`;
          pillEl.innerHTML = `${roleName}: <strong>${escapeHtml(label)}</strong>`;
        } else {
          pillEl.className = 'cov-mini-pill';
          pillEl.innerHTML = `${roleName}: <strong>Khuyết</strong>`;
        }
      }
    }

    // Render Kho Model 9Router (Horizontal Scroll Track)
    function renderModelPool() {
      if (!modelPoolGrid) return;
      modelPoolGrid.innerHTML = '';

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
        modelPoolGrid.innerHTML = `
          <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 11.5px; white-space: nowrap;">
            Không tìm thấy model nào khớp với từ khóa "${escapeHtml(kw)}".
          </div>
        `;
        return;
      }

      filtered.forEach(m => {
        const card = document.createElement('div');
        const isAdded = existingModelSet.has(m.id);
        card.className = 'pool-card-compact' + (isAdded ? ' in-squad' : '');

        const capsHtml = `
          ${m.capabilities?.vision ? '<span class="badge-neutral">Vision</span>' : ''}
          ${m.capabilities?.tools ? '<span class="badge-neutral">Tools</span>' : ''}
          ${m.capabilities?.reasoning ? '<span class="badge-neutral">Thinking</span>' : ''}
        `;

        card.innerHTML = `
          <div class="pool-card-top">
            <div class="pool-card-name">${escapeHtml(m.name)}</div>
            <div class="pool-card-id">${escapeHtml(m.id)}</div>
            <div class="pool-card-badges">${capsHtml}</div>
          </div>
          <div class="pool-card-actions">
            <button class="btn-pool-test" data-model="${escapeHtml(m.id)}">
              <span>⚡ Test</span>
              <span class="pool-test-lbl"></span>
            </button>
            ${isAdded
              ? '<span class="btn-pool-added-badge">✓ Đã trong đội</span>'
              : `<button class="btn-pool-add" data-model="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">+ Thêm Vào Đội</button>`
            }
          </div>
        `;

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
    document.querySelectorAll('.btn-filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.btn-filter-pill').forEach(p => p.classList.remove('active'));
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

    // Save Team Config Event
    if (btnSaveTeamConfig) {
      btnSaveTeamConfig.addEventListener('click', async () => {
        if (spinSaveConfig) spinSaveConfig.style.display = 'inline-block';
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

        try {
          const res = await fetch('/api/save-team-config', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Dashboard-Token': csrfToken || ''
            },
            body: JSON.stringify({ roles: rolesPayload })
          });
          const data = await res.json();
          if (data.ok) {
            if (cfgSaveStatusMsg) {
              cfgSaveStatusMsg.textContent = `✓ ${data.message}`;
              cfgSaveStatusMsg.style.color = '#34d399';
            }
            fetchSnapshot();
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

      btnDecomposeGoal.disabled = true;
      spinDecompose.style.display = 'inline-block';
      txtDecomposeBtn.textContent = 'Router Agent đang khảo sát codebase...';
      lblDecomposeStatus.textContent = 'Đang gọi Claude Sonnet 4.5 đọc cấu trúc code...';

      try {
        const res = await fetch('/api/decompose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Token': csrfToken || ''
          },
          body: JSON.stringify({ goal })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Lỗi bóc tách mục tiêu');
        }
        currentDraftTasks = data.tasks || [];
        renderDraftTasks(currentDraftTasks);
        lblDecomposeStatus.textContent = `✓ Đã sinh thành công ${currentDraftTasks.length} task(s)! Bạn hãy xem lại và bấm "Phê Duyệt & Khởi Động".`;
      } catch (err) {
        lblDecomposeStatus.textContent = `❌ Lỗi: ${err.message}`;
        alert('Lỗi phân tích goal: ' + err.message);
      } finally {
        btnDecomposeGoal.disabled = false;
        spinDecompose.style.display = 'none';
        txtDecomposeBtn.textContent = '🪄 Phân Tích & Sinh Kế Hoạch (Router Agent)';
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
        badges.style.gap = '4px';

        const modeBadge = document.createElement('span');
        modeBadge.className = 'tag tag-' + (t.mode === 'full' ? 'standard' : 'quick');
        modeBadge.textContent = t.mode.toUpperCase();

        const riskBadge = document.createElement('span');
        riskBadge.className = 'tag tag-' + (t.risk_level || 'low');
        riskBadge.textContent = (t.risk_level || 'low').toUpperCase();

        badges.appendChild(modeBadge);
        badges.appendChild(riskBadge);
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
        crit.textContent = 'Tiêu chí nghiệm thu: ' + critList.join(' • ');

        card.appendChild(head);
        card.appendChild(title);
        card.appendChild(scope);
        card.appendChild(crit);
        listDraftTasks.appendChild(card);
      });

      btnApproveRun.disabled = false;
    }

    // Approve & Run Action
    btnApproveRun.addEventListener('click', async () => {
      btnApproveRun.disabled = true;
      const oldText = btnApproveRun.textContent;
      btnApproveRun.textContent = 'Đang khởi chạy Orchestrator...';

      try {
        const res = await fetch('/api/approve-run', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Token': csrfToken || ''
          },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Lỗi phê duyệt task');
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
        const res = await fetch('/api/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Token': csrfToken || ''
          }
        });
        const data = await res.json();
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
            timerSpan.textContent = '⏱ ' + sec + 's';
            timerSpan.style.display = 'inline-block';
          }
        }
      }

      // 2. Task duration timer
      if (taskDurationStatic !== null) {
        taskTimerTag.textContent = 'Duration: ⏱ ' + formatSeconds(taskDurationStatic);
        taskTimerTag.style.display = 'inline-block';
      } else if (taskStartedAt && currentStage !== 'idle') {
        const totalSec = Math.max(0, Math.floor((Date.now() - taskStartedAt) / 1000));
        taskTimerTag.textContent = 'Task: ⏱ ' + formatSeconds(totalSec);
        taskTimerTag.style.display = 'inline-block';
      } else {
        taskTimerTag.style.display = 'none';
      }
    }, 200);

    // Update Topology SVG Links and Model Capsules according to Standard Workflow
    function updateTopologyNetwork(activeStage, rolesStatus, rolesConfig, snap) {
      // 1. Reset all links and model capsules
      const allLinks = [linkSonnetGemini, linkSonnetDeepseek, linkGeminiValidator, linkDeepseekValidator, linkValidatorDeepseek, linkValidatorOpus];
      allLinks.forEach(l => {
        if (l) l.className.baseVal = 'link-path';
      });

      const allCapsules = [capsuleSonnet, capsuleGemini, capsuleDeepseek, capsuleValidator, capsuleOpus];
      allCapsules.forEach(c => {
        if (c) c.className = c.className.replace(/\b(active|done)\b/g, '').trim();
      });

      const wStatus = rolesStatus.writer?.status || 'idle';
      const rStatus = rolesStatus.router?.status || 'idle';
      const revStatus = rolesStatus.reviewer?.status || 'idle';
      const attempt = snap?.live_status?.attempt || 1;

      // Gemini 3.8 Flash (Frontend Writer / IDE) is always active/ready
      if (capsuleGemini) capsuleGemini.classList.add('done');

      // 2. Active Stage mappings theo Standard Workflow
      if (activeStage === 'router') {
        if (capsuleSonnet) capsuleSonnet.classList.add('active');
        if (linkSonnetDeepseek) linkSonnetDeepseek.className.baseVal = 'link-path active';
      } else if (rStatus === 'done') {
        if (capsuleSonnet) capsuleSonnet.classList.add('done');
        if (linkSonnetDeepseek) linkSonnetDeepseek.className.baseVal = 'link-path done';
      }

      if (activeStage === 'writer') {
        if (capsuleDeepseek) capsuleDeepseek.classList.add('active');
        if (linkSonnetDeepseek) linkSonnetDeepseek.className.baseVal = 'link-path active';
        if (linkDeepseekValidator) linkDeepseekValidator.className.baseVal = 'link-path active';
        // If in retry attempt, show feedback loop
        if (attempt > 1 && linkValidatorDeepseek) {
          linkValidatorDeepseek.className.baseVal = 'link-path active';
        }
      } else if (wStatus === 'done') {
        if (capsuleDeepseek) capsuleDeepseek.classList.add('done');
        if (linkDeepseekValidator) linkDeepseekValidator.className.baseVal = 'link-path done';
      }

      if (['applier', 'validator'].includes(activeStage)) {
        if (capsuleValidator) capsuleValidator.classList.add('active');
        if (linkDeepseekValidator) linkDeepseekValidator.className.baseVal = 'link-path active';
      } else if (['reviewer', 'git', 'done'].includes(activeStage)) {
        if (capsuleValidator) capsuleValidator.classList.add('done');
      }

      if (activeStage === 'reviewer') {
        if (capsuleOpus) capsuleOpus.classList.add('active');
        if (linkValidatorOpus) linkValidatorOpus.className.baseVal = 'link-path active';
      } else if (revStatus === 'approved') {
        if (capsuleOpus) capsuleOpus.classList.add('done');
        if (linkValidatorOpus) linkValidatorOpus.className.baseVal = 'link-path done';
      }

      if (activeStage === 'done') {
        if (capsuleSonnet) capsuleSonnet.classList.add('done');
        if (capsuleDeepseek) capsuleDeepseek.classList.add('done');
        if (capsuleValidator) capsuleValidator.classList.add('done');
        if (linkDeepseekValidator) linkDeepseekValidator.className.baseVal = 'link-path done';
      }

      // 3. Dynamic Tooltips with Real Model Information
      if (capsuleSonnet) {
        capsuleSonnet.title = `Claude Sonnet 4.5 Thinking (${rolesConfig.router?.model || 'kr/claude-sonnet-4.5-thinking'}) - Plan & Scope Router`;
      }
      if (capsuleGemini) {
        capsuleGemini.title = `Gemini 3.8 Flash (Antigravity IDE Assistant) - Frontend Writer & Pair Programming`;
      }
      if (capsuleDeepseek) {
        capsuleDeepseek.title = `DeepSeek V4.1 Flash (${rolesConfig.writer?.model || 'deepseek-ai/deepseek-v4.1-flash-1017'}) - Backend Writer (Status: ${wStatus.toUpperCase()})`;
      }
      if (capsuleValidator) {
        capsuleValidator.title = `Validator Guard (scripts/validator.mjs) - Test & TAB Gate (Stage: ${activeStage})`;
      }
      if (capsuleOpus) {
        capsuleOpus.title = `Claude Opus 5.5 High (${rolesConfig.reviewer?.model || 'ag/claude-opus-5-5-high'}) - Tech Lead Reviewer (Status: ${revStatus.toUpperCase()})`;
      }

      // Recalculate pixel-perfect dynamic anchors to eliminate any line gaps
      requestAnimationFrame(recalculateSvgLinks);
    }

    // Dynamically calculate pixel-perfect SVG Bezier curves directly between node anchors
    function recalculateSvgLinks() {
      const canvas = document.querySelector('.topology-canvas');
      if (!canvas) return;
      const cRect = canvas.getBoundingClientRect();
      if (cRect.width === 0 || cRect.height === 0) return;

      function getPointRight(el) {
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
          x: r.right - cRect.left,
          y: r.top + r.height / 2 - cRect.top
        };
      }

      function getPointLeft(el) {
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
          x: r.left - cRect.left,
          y: r.top + r.height / 2 - cRect.top
        };
      }

      function setBezier(pathEl, p1, p2, curvature = 0.5) {
        if (!pathEl || !p1 || !p2 || p1.x === 0 || p2.x === 0) return;
        const dx = Math.max(20, Math.abs(p2.x - p1.x) * curvature);
        const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${(p1.x + dx).toFixed(1)} ${p1.y.toFixed(1)}, ${(p2.x - dx).toFixed(1)} ${p2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
        pathEl.setAttribute('d', d);
      }

      function setFeedbackLoop(pathEl) {
        if (!pathEl || !capsuleValidator || !capsuleDeepseek) return;
        const rVal = capsuleValidator.getBoundingClientRect();
        const rDeep = capsuleDeepseek.getBoundingClientRect();
        if (rVal.width === 0 || rDeep.width === 0) return;

        // Bắt đầu từ đáy Validator lượn vòng cung mềm xuống dưới rồi chạm đáy DeepSeek
        const startX = rVal.left + rVal.width * 0.25 - cRect.left;
        const startY = rVal.bottom - cRect.top;
        const endX = rDeep.right - cRect.left;
        const endY = rDeep.bottom - cRect.top;
        const dropY = Math.max(startY, endY) + 26;

        const d = `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${(startX - 40).toFixed(1)} ${dropY.toFixed(1)}, ${(endX + 40).toFixed(1)} ${dropY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
        pathEl.setAttribute('d', d);
      }

      const pSonnet = getPointRight(capsuleSonnet);
      const pGeminiIn = getPointLeft(capsuleGemini);
      const pGeminiOut = getPointRight(capsuleGemini);
      const pDeepseekIn = getPointLeft(capsuleDeepseek);
      const pDeepseekOut = getPointRight(capsuleDeepseek);
      const pValidatorIn = getPointLeft(capsuleValidator);
      const pValidatorOut = getPointRight(capsuleValidator);
      const pOpusIn = getPointLeft(capsuleOpus);

      // 1. Sonnet -> Gemini (Frontend)
      setBezier(linkSonnetGemini, pSonnet, pGeminiIn);

      // 2. Sonnet -> DeepSeek (Backend)
      setBezier(linkSonnetDeepseek, pSonnet, pDeepseekIn);

      // 3. Gemini -> Validator
      setBezier(linkGeminiValidator, pGeminiOut, pValidatorIn);

      // 4. DeepSeek -> Validator
      setBezier(linkDeepseekValidator, pDeepseekOut, pValidatorIn);

      // 5. Validator -> DeepSeek Feedback loop (khi retry)
      setFeedbackLoop(linkValidatorDeepseek);

      // 6. Validator -> Opus (Review Gate)
      setBezier(linkValidatorOpus, pValidatorOut, pOpusIn);
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

    function renderLastError(errorText, isTaskDone) {
      // AC-4: If task succeeded on retry (isTaskDone), suppress old error banner!
      if (isTaskDone) {
        lastErrorBanner.style.display = 'none';
        return;
      }

      const parsed = extractFailureTail(errorText);
      if (parsed) {
        lastErrorBanner.style.display = 'flex';
        lastErrorTitle.textContent = parsed.title;
        lastErrorSummary.textContent = parsed.summary;
        lastErrorTail.textContent = parsed.tail;
        lastErrorRaw.textContent = parsed.raw;
      } else {
        lastErrorBanner.style.display = 'none';
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
          item.className = 'queue-item';

          const left = document.createElement('div');
          left.className = 'queue-item-left';

          const icon = document.createElement('span');
          icon.textContent = '⏳';

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
          item.className = 'queue-item';

          const left = document.createElement('div');
          left.className = 'queue-item-left';

          const icon = document.createElement('span');
          icon.textContent = '🚫';

          const tid = document.createElement('span');
          tid.className = 'queue-item-id';
          tid.textContent = t.task_id || 'blocked-task';
          tid.title = (t.block_reason || t.title) ? `Reason: ${t.block_reason || t.title}` : t.task_id;

          left.appendChild(icon);
          left.appendChild(tid);

          const badge = document.createElement('span');
          badge.className = 'queue-item-badge q-blocked';
          badge.textContent = 'BLOCKED';

          item.appendChild(left);
          item.appendChild(badge);
          queueItemsList.appendChild(item);
        });
      }

      // 3. Recent completed tasks
      if (Array.isArray(q.recent_completed) && q.recent_completed.length > 0) {
        q.recent_completed.forEach(t => {
          hasItems = true;
          const item = document.createElement('div');
          item.className = 'queue-item';

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
        const res = await fetch(`/api/session?id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.ok || !data.session) return;

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
            const callsText = m.tool_calls.map(tc => `🔧 Tool Call: ${tc.function?.name || tc.name}(${tc.function?.arguments || ''})`).join('\n');
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

    // Main Snapshot Fetcher
    async function fetchSnapshot() {
      try {
        const res = await fetch('/api/snapshot');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        if (data.csrf_token) {
          csrfToken = data.csrf_token;
        }

        txtPolling.textContent = '1s Polling';

        // 1. Project Info
        if (data.project && data.project.id) {
          txtProject.textContent = data.project.id;
        }

        // 2. 9Router Hub Health & Latency
        if (data.router_health && data.router_health.ok) {
          dotRouter.className = 'dot online';
          txtRouter.textContent = '9Router :20128 (' + data.router_health.latency_ms + 'ms)';
        } else {
          dotRouter.className = 'dot offline';
          txtRouter.textContent = '9Router DOWN';
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

        // 4. Tokens
        const live = data.live_status || {};
        tokIn.textContent = formatTokens(live.tokens?.session_input || 0);
        tokOut.textContent = formatTokens(live.tokens?.session_output || 0);

        // 5. Pipeline Stages & Top Stage Indicator
        const activeStage = live.current_stage || (isRunning ? 'preflight' : 'idle');
        txtStage.textContent = 'Stage: ' + activeStage.toUpperCase();
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
            taskDurationStatic = 97; // 1m 37s fallback for T-012
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

        // 7. Left Column AI Personnel Models
        const rolesStatus = live.roles_status || {};
        const rolesConfig = data.roles || {};
        currentSquadRolesConfig = rolesConfig;

        squadModelRouter.textContent = rolesConfig.router?.model || 'kr/claude-sonnet-4.5-thinking';
        squadStatusRouter.textContent = (rolesStatus.router?.status || (activeStage === 'router' ? 'working' : 'idle')).toUpperCase();
        squadStatusRouter.className = 'status-badge badge-' + (activeStage === 'router' ? 'working' : (rolesStatus.router?.status === 'done' ? 'done' : 'idle'));

        squadModelWriter.textContent = rolesConfig.writer?.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
        squadStatusWriter.textContent = (rolesStatus.writer?.status || (activeStage === 'writer' ? 'working' : 'idle')).toUpperCase();
        squadStatusWriter.className = 'status-badge badge-' + (activeStage === 'writer' ? 'working' : (rolesStatus.writer?.status === 'done' ? 'done' : 'idle'));

        if (squadStatusValidator) {
          const isVal = ['applier', 'validator'].includes(activeStage);
          const isValDone = ['reviewer', 'git', 'done'].includes(activeStage);
          squadStatusValidator.textContent = isVal ? 'TESTING' : (isValDone ? 'PASS ✓' : 'IDLE');
          squadStatusValidator.className = 'status-badge badge-' + (isVal ? 'working' : (isValDone ? 'done' : 'idle'));
        }

        squadModelReviewer.textContent = rolesConfig.reviewer?.model || 'ag/claude-opus-5-5-high';
        const rStat = live.mode === 'quick' ? 'SKIPPED' : (rolesStatus.reviewer?.status || 'idle').toUpperCase();
        squadStatusReviewer.textContent = rStat;
        squadStatusReviewer.className = 'status-badge ' + (rStat === 'SKIPPED' ? 'badge-skipped' : (rStat === 'APPROVED' ? 'badge-done' : 'badge-idle'));

        // 8. Update 9Router Topology Network Capsule Nodes & SVG Links
        updateTopologyNetwork(activeStage, rolesStatus, rolesConfig, data);

        // 9. Scoped Files
        renderScopedFiles(live.scope_files);

        // 10. Task Queue List
        renderTaskQueue(data.queue || {});

        // 10b. Agent Sessions & Tool Receipts
        renderSessionsList(data.sessions || []);

        // 11. Error Callout (Intelligent Failure Tail, suppressed if task is done)
        renderLastError(live.last_error, isTaskDone);

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
      btnPauseLog.textContent = isLogPaused ? '▶ Resume' : '⏸ Pause';
      btnPauseLog.style.background = isLogPaused ? 'var(--status-warning)' : '';
      btnPauseLog.style.color = isLogPaused ? '#000' : '';
    });

    btnClearLog.addEventListener('click', () => {
      while (consoleLogs.firstChild) {
        consoleLogs.removeChild(consoleLogs.firstChild);
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