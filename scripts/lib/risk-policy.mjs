import fs from 'node:fs';
import path from 'node:path';
import { computeDeterministicRisk } from '../applier.mjs';

export const RISK_LEVEL_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  ultra: 4
};

/**
 * Built-in Safe Operational Policy Defaults (Engine Invariants).
 * The engine guarantees these values if policy.yaml is missing, partial, or corrupted.
 */
export const DEFAULT_POLICY_CONFIG = Object.freeze({
  scope_control: Object.freeze({
    max_files_per_task: 5,
    max_scope_increase: 1,
    allow_new_files: true,
    new_files_only_in_scope: true,
    strict_scope_enforcement: true
  }),
  task_modes: Object.freeze({
    quick: Object.freeze({
      max_files: 3,
      max_runtime_sec: 180,
      skip_router_and_reviewer: true
    }),
    standard: Object.freeze({
      max_runtime_sec: 600,
      skip_router_and_reviewer: false
    }),
    consult: Object.freeze({
      max_runtime_sec: 180,
      skip_router_and_reviewer: true,
      mutation_enabled: false
    })
  }),
  approval_gates: Object.freeze({
    plan_approval_mode: 'auto_if_small',
    small_task_threshold_files: 3,
    require_code_review: true,
    review_min_risk_level: 'high',
    require_human_approval_for_cross_role_edit: true
  }),
  retry_and_escalation: Object.freeze({
    max_retries_per_task: 3,
    abort_on_identical_error_count: 2,
    on_exhausted: 'mark_blocked_and_continue',
    token_budget_per_task: 150000,
    night_token_budget_total: 3000000
  }),
  execution_guardrails: Object.freeze({
    enforce_command_timeouts: true,
    kill_process_tree_on_timeout: true,
    default_cli_timeout_sec: 180,
    healthcheck_timeout_sec: 15,
    network_connect_timeout_sec: 5,
    network_max_time_sec: 180,
    max_silence_duration_sec: 60,
    prefer_mcp_tools: true,
    ban_unbounded_commands: true,
    block_powershell_curl_alias: true,
    strict_model_match: true,
    circuit_breaker_ttl_ms: 600000,
    model_aliases: Object.freeze({})
  }),
  git_hygiene: Object.freeze({
    require_clean_worktree_before_start: true,
    rollback_on_validation_fail: true,
    auto_commit_on_done: true,
    confirm_frontend_branch_before_merge: true,
    commit_message_prefix: '[AI-Task]'
  }),
  validation: Object.freeze({
    max_baseline_failures: 3,
    flaky_baseline_failures: Object.freeze([]),
    fast_checks: Object.freeze([]),
    suite_checks: Object.freeze([])
  }),
  cockpit: Object.freeze({
    host: '127.0.0.1',
    port: 4310
  }),
  workflow_optimization: Object.freeze({
    // Feature flag (default false): when true, skips pre-code draft_spec for remove/refactor/bugfix
    // tasks that already have clear acceptance criteria and no new cross-domain API contracts.
    solo_first_for_clear_tasks: false
  })
});

/**
 * Deep merges user-defined policy overrides onto safe engine defaults.
 * Preserves framework invariants (e.g. consult mode cannot mutate files).
 */
export function mergePolicyWithDefaults(userPolicy = {}) {
  const user = userPolicy?.policy || userPolicy || {};
  const merged = JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG));

  if (typeof user.version === 'string' && user.version.trim()) {
    merged.version = user.version.trim();
  }
  if (typeof user.project_id === 'string' && user.project_id.trim()) {
    merged.project_id = user.project_id.trim();
  }
  if (typeof user.repo_root === 'string' && user.repo_root.trim()) {
    merged.repo_root = user.repo_root.trim();
  }
  if (user.domain_patterns && typeof user.domain_patterns === 'object') {
    merged.domain_patterns = { ...user.domain_patterns };
  }

  if (user.scope_control && typeof user.scope_control === 'object') {
    Object.assign(merged.scope_control, user.scope_control);
  }

  if (user.task_modes && typeof user.task_modes === 'object') {
    for (const [mode, overrides] of Object.entries(user.task_modes)) {
      if (merged.task_modes[mode] && typeof overrides === 'object' && overrides !== null) {
        Object.assign(merged.task_modes[mode], overrides);
      }
    }
  }
  // HARD INVARIANT: consult mode is read-only advisory and can NEVER mutate code
  merged.task_modes.consult.mutation_enabled = false;

  if (user.approval_gates && typeof user.approval_gates === 'object') {
    Object.assign(merged.approval_gates, user.approval_gates);
  }

  if (user.retry_and_escalation && typeof user.retry_and_escalation === 'object') {
    Object.assign(merged.retry_and_escalation, user.retry_and_escalation);
  }

  if (user.execution_guardrails && typeof user.execution_guardrails === 'object') {
    const prevAliases = merged.execution_guardrails.model_aliases || {};
    Object.assign(merged.execution_guardrails, user.execution_guardrails);
    if (user.execution_guardrails.model_aliases && typeof user.execution_guardrails.model_aliases === 'object') {
      merged.execution_guardrails.model_aliases = {
        ...prevAliases,
        ...user.execution_guardrails.model_aliases
      };
    }
  }

  if (user.git_hygiene && typeof user.git_hygiene === 'object') {
    Object.assign(merged.git_hygiene, user.git_hygiene);
  }

  if (user.validation && typeof user.validation === 'object') {
    merged.validation = Object.assign({}, merged.validation, user.validation);
  }

  if (user.cockpit && typeof user.cockpit === 'object') {
    Object.assign(merged.cockpit, user.cockpit);
  }

  if (user.workflow_optimization && typeof user.workflow_optimization === 'object') {
    Object.assign(merged.workflow_optimization, user.workflow_optimization);
  }

  return merged;
}

export function resolveCircuitBreakerTtlMs(policyConfig = {}) {
  const guardrails = policyConfig?.policy?.execution_guardrails
    || policyConfig?.execution_guardrails
    || {};
  const rawMs = Number(guardrails.circuit_breaker_ttl_ms);
  if (Number.isFinite(rawMs) && rawMs > 0) return rawMs;
  const rawSec = Number(guardrails.circuit_breaker_ttl_sec);
  if (Number.isFinite(rawSec) && rawSec > 0) return rawSec * 1000;
  return DEFAULT_POLICY_CONFIG.execution_guardrails.circuit_breaker_ttl_ms;
}

export function resolveEffectiveRisk(task = {}) {
  const declared = String(task.risk_level || '').toLowerCase().trim();
  const computed = computeDeterministicRisk(task.scope || []);
  const scopeLen = Array.isArray(task.scope) ? task.scope.length : 0;
  const inferred = computed === 'high' ? 'high' : (scopeLen > 3 ? 'medium' : 'low');
  const declaredRank = RISK_LEVEL_RANK[declared] || 1;
  const inferredRank = RISK_LEVEL_RANK[inferred] || 1;
  if (declaredRank >= inferredRank && RISK_LEVEL_RANK[declared]) {
    return declared === 'ultra' ? 'critical' : declared;
  }
  return inferred;
}

const DESTRUCTIVE_DIFF_CALL_PATTERNS = [
  { name: 'os.remove', regex: /\bos\.remove\s*\(/ },
  { name: 'os.unlink', regex: /\bos\.unlink\s*\(/ },
  { name: 'os.rmdir', regex: /\bos\.rmdir\s*\(/ },
  { name: 'shutil.rmtree', regex: /\bshutil\.rmtree\s*\(/ },
  { name: 'Path.unlink', regex: /\bPath(?:\([^)]*\))?\.unlink\s*\(/ },
  { name: '.unlink(', regex: /\.unlink\s*\(/ },
  { name: 'send2trash', regex: /\bsend2trash\s*\(/ },
  { name: 'fs.unlink', regex: /\bfs(?:\.promises)?\.unlink(?:Sync)?\s*\(/ },
  { name: 'fs.rm', regex: /\bfs(?:\.promises)?\.rm(?:Sync)?\s*\(/ },
  { name: 'fs.rmdir', regex: /\bfs(?:\.promises)?\.rmdir(?:Sync)?\s*\(/ }
];

/**
 * Scans unified diff `+` lines for physical file/data deletion calls (Python & JS/Node).
 * Ignores removed `-` lines, diff headers (`+++`), and pure comment lines.
 */
export function detectDestructiveDiffCalls(diffText = '') {
  const matches = [];
  const raw = String(diffText || '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return matches;

  let currentFile = 'unknown';
  let currentLine = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim().replace(/\\/g, '/');
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = Math.max(0, Number(hunkMatch[1]) - 1);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      continue;
    }
    if (line.startsWith('-')) {
      continue;
    }
    if (line.startsWith(' ')) {
      currentLine++;
      continue;
    }
    if (!line.startsWith('+')) {
      continue;
    }

    currentLine++;
    const code = line.slice(1);
    const trimmed = code.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    for (const pat of DESTRUCTIVE_DIFF_CALL_PATTERNS) {
      if (pat.regex.test(code)) {
        matches.push({
          pattern: pat.name,
          file: currentFile,
          line: currentLine,
          snippet: trimmed.slice(0, 140)
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * Computes Post-Patch Diff Risk Floor: if added diff lines introduce physical file/data
 * deletion calls, lifts `post_patch_risk_level` to at least `high`.
 */
export function evaluatePostPatchDiffRisk(task = {}, diffText = '') {
  const prePatchRisk = task?.pre_patch_risk_level
    ? String(task.pre_patch_risk_level).toLowerCase()
    : resolveEffectiveRisk(task);
  const preRank = RISK_LEVEL_RANK[prePatchRisk] || RISK_LEVEL_RANK.low;
  const destructiveCalls = detectDestructiveDiffCalls(diffText);
  const floorRisk = destructiveCalls.length > 0 ? 'high' : prePatchRisk;
  const floorRank = RISK_LEVEL_RANK[floorRisk] || RISK_LEVEL_RANK.low;
  const postPatchRisk = floorRank > preRank ? floorRisk : prePatchRisk;
  const postRank = RISK_LEVEL_RANK[postPatchRisk] || RISK_LEVEL_RANK.low;
  const escalated = postRank > preRank;

  return {
    pre_patch_risk_level: prePatchRisk,
    post_patch_risk_level: postPatchRisk,
    risk_escalated: escalated,
    escalated_to_high: escalated && postRank >= RISK_LEVEL_RANK.high,
    destructive_calls: destructiveCalls,
    reason: destructiveCalls.length > 0
      ? `Post-patch diff introduces physical deletion call(s): ${destructiveCalls.map(m => `${m.pattern} at ${m.file}:${m.line}`).slice(0, 4).join(', ')}`
      : null
  };
}

/**
 * Resolves dynamic thinking token budget based on task risk level and model capability.
 * - Low/medium risk: returns null (thinking disabled to save tokens and prevent Anthropic >=1024 error).
 * - High/critical risk: returns >= 1024 if model supports reasoning/thinking.
 */
export function resolveThinkingBudget(riskLevel, modelName, roleCfg = {}) {
  const isThinkingModel = String(modelName || '').toLowerCase().includes('thinking');
  const risk = String(riskLevel || 'low').toLowerCase();

  if (risk === 'low' || risk === 'medium') {
    return null;
  }

  if (isThinkingModel || roleCfg.max_thinking_tokens) {
    const configured = Number(roleCfg.max_thinking_tokens) || 0;
    return Math.max(1024, configured);
  }

  return null;
}

export function shouldRunReviewerGate(task = {}, policy = {}, roles = {}, activeWriterModel = null) {
  const reviewerCfg = (roles?.reviewer && roles.reviewer.enabled !== false)
    ? roles.reviewer
    : ((roles?.techlead && roles.techlead.enabled !== false) ? roles.techlead : null);

  if (!reviewerCfg) {
    return false;
  }

  const reviewerModel = reviewerCfg.default_model
    || reviewerCfg.model
    || (Array.isArray(reviewerCfg.models) && reviewerCfg.models.length > 0 ? reviewerCfg.models[0] : null);

  // Anti-Self-Review Invariant (SPEC Section 3.6.3 Rule 3):
  // If the Reviewer model is identical to ANY active Writer model that produced the patch
  // (including after fallback), skip redundant self-review even when force_ai_review is true.
  const defaultWriterModel = task.writer_model
    || task.model
    || roles?.writer?.default_model
    || roles?.writer?.model
    || (Array.isArray(roles?.writer?.models) ? roles.writer.models[0] : null);
  const usedWriterModels = Array.isArray(activeWriterModel)
    ? activeWriterModel.filter(Boolean)
    : [activeWriterModel || defaultWriterModel].filter(Boolean);

  if (reviewerModel && usedWriterModels.includes(reviewerModel)) {
    return false;
  }

  if (task.force_ai_review === true) {
    return true;
  }

  const mode = (task.mode || '').toLowerCase();
  const modeConfig = policy.task_modes?.[mode] || {};
  const skipReviewer = task.post_patch_high_risk_escalated
    ? false
    : (modeConfig.skip_router_and_reviewer ?? (mode === 'quick' || mode === 'direct' || mode === 'consult'));
  const requireReview = policy.approval_gates?.require_code_review ?? true;
  if (skipReviewer || !requireReview) {
    return false;
  }
  const minRisk = String(policy.approval_gates?.review_min_risk_level || 'high').toLowerCase();
  const minRank = RISK_LEVEL_RANK[minRisk] || RISK_LEVEL_RANK.high;
  const taskRisk = task.post_patch_risk_level
    ? (RISK_LEVEL_RANK[String(task.post_patch_risk_level).toLowerCase()] >= RISK_LEVEL_RANK[resolveEffectiveRisk(task)]
        ? String(task.post_patch_risk_level).toLowerCase()
        : resolveEffectiveRisk(task))
    : resolveEffectiveRisk(task);
  const taskRank = RISK_LEVEL_RANK[taskRisk] || RISK_LEVEL_RANK.low;
  return taskRank >= minRank;
}

export function resolveTaskMode(task, policy = {}) {
  const explicitMode = (task.mode || '').toLowerCase();
  if (explicitMode === 'direct' || explicitMode === 'quick' || explicitMode === 'standard' || explicitMode === 'consult') {
    return explicitMode;
  }
  const smallThreshold = policy.approval_gates?.small_task_threshold_files ?? 3;
  const scopeLen = Array.isArray(task.scope) ? task.scope.length : 0;
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  const effectiveRisk = resolveEffectiveRisk(task);

  if (scopeLen <= smallThreshold && effectiveRisk === 'low' && !allowExpansion) {
    return 'quick';
  }
  return 'standard';
}

export function resolveApiKey(teamCfg = {}) {
  const p = teamCfg?.providers?.local_9router || teamCfg?.team?.providers?.local_9router || {};
  const envKeyName = p.api_key_env || 'NINE_ROUTER_API_KEY';
  return process.env[envKeyName] || p.default_key || 'sk-default';
}

export function validateConfig(teamCfg = {}, policyCfg = {}, projectCfg = null) {
  const errors = [];
  const p = teamCfg?.providers?.local_9router || teamCfg?.team?.providers?.local_9router;
  if (!p?.base_url) {
    errors.push('team.yaml: missing providers.local_9router.base_url');
  }
  if (!teamCfg?.roles?.writer?.model) {
    errors.push('team.yaml: missing roles.writer.model');
  }
  if (projectCfg && projectCfg.project) {
    if (projectCfg.project.allowed_dirs !== undefined && !Array.isArray(projectCfg.project.allowed_dirs)) {
      errors.push('project.yaml: project.allowed_dirs must be an array');
    }
    if (projectCfg.project.protected_files !== undefined && !Array.isArray(projectCfg.project.protected_files)) {
      errors.push('project.yaml: project.protected_files must be an array');
    }
  }
  const scopeCfg = policyCfg?.policy?.scope_control || policyCfg?.scope_control;
  if (scopeCfg?.max_files_per_task !== undefined && (typeof scopeCfg.max_files_per_task !== 'number' || scopeCfg.max_files_per_task <= 0)) {
    errors.push('policy.yaml: policy.scope_control.max_files_per_task must be a positive number');
  }
  if (scopeCfg?.allowed_dirs !== undefined && !Array.isArray(scopeCfg.allowed_dirs)) {
    errors.push('policy.yaml: policy.scope_control.allowed_dirs must be an array');
  }
  if (scopeCfg?.protected_files !== undefined && !Array.isArray(scopeCfg.protected_files)) {
    errors.push('policy.yaml: policy.scope_control.protected_files must be an array');
  }
  const retryCfg = policyCfg?.policy?.retry_and_escalation || policyCfg?.retry_and_escalation;
  if (retryCfg?.max_retries_per_task !== undefined && (typeof retryCfg.max_retries_per_task !== 'number' || retryCfg.max_retries_per_task < 0)) {
    errors.push('policy.yaml: policy.retry_and_escalation.max_retries_per_task must be a non-negative number');
  }
  return { ok: errors.length === 0, errors };
}

const REASONING_EFFORT_SUFFIX_RE = /-(?:high|medium|low|minimal|thinking)$/;

function normalizeModelSlug(raw = '') {
  return String(raw || '').toLowerCase().split('/').pop().replace(/[._-]+/g, '-').trim();
}

function stripReasoningEffortSuffix(slug = '') {
  let cur = String(slug || '').trim();
  while (REASONING_EFFORT_SUFFIX_RE.test(cur)) {
    cur = cur.replace(REASONING_EFFORT_SUFFIX_RE, '');
  }
  return cur;
}

export function verifyResponseModel(requestedModel = '', responseModel = 'unknown', options = {}) {
  const reqRaw = String(requestedModel || '').trim();
  const resRaw = String(responseModel || '').trim();
  if (!resRaw || resRaw === 'unknown') {
    return {
      match: false,
      reason: `Upstream response omitted data.model (got "unknown" for requested "${reqRaw}")`
    };
  }

  const reqLower = reqRaw.toLowerCase();
  const resLower = resRaw.toLowerCase();
  const reqSlug = normalizeModelSlug(reqRaw);
  const resSlug = normalizeModelSlug(resRaw);

  if (reqLower === resLower || (reqSlug && resSlug && reqSlug === resSlug)) {
    return { match: true, reason: null, match_kind: 'exact' };
  }

  const reqBase = stripReasoningEffortSuffix(reqSlug);
  const resBase = stripReasoningEffortSuffix(resSlug);
  if (reqBase && resBase && reqBase === resBase) {
    return { match: true, reason: null, match_kind: 'reasoning_suffix' };
  }

  const aliasTable = options.modelAliases !== undefined
    ? options.modelAliases
    : (options.policyConfig?.policy?.execution_guardrails?.model_aliases
      ?? options.policyConfig?.execution_guardrails?.model_aliases
      ?? DEFAULT_POLICY_CONFIG.execution_guardrails.model_aliases
      ?? {});

  if (aliasTable && typeof aliasTable === 'object') {
    const aliasTargets = [];
    for (const [k, v] of Object.entries(aliasTable)) {
      const kLower = String(k || '').trim().toLowerCase();
      const kSlug = normalizeModelSlug(k);
      if (kLower === reqLower || (reqSlug && kSlug === reqSlug)) {
        if (Array.isArray(v)) aliasTargets.push(...v);
        else if (v !== undefined && v !== null) aliasTargets.push(v);
      }
    }
    for (const target of aliasTargets) {
      const tRaw = String(target || '').trim().toLowerCase();
      const tSlug = normalizeModelSlug(target);
      const tBase = stripReasoningEffortSuffix(tSlug);
      if (tRaw === resLower || (tSlug && tSlug === resSlug) || (tBase && tBase === resBase)) {
        return { match: true, reason: null, match_kind: 'alias_table' };
      }
    }
  }

  return {
    match: false,
    warning: 'model_alias_mismatch',
    reason: `Requested model "${reqRaw}" but upstream responded with "${resRaw}" (model_alias_mismatch)`
  };
}

export const DEFAULT_FRONTEND_PATTERNS = [
  '**/*.html',
  '**/*.htm',
  '**/*.css',
  '**/*.scss',
  '**/*.sass',
  '**/*.less',
  '**/*.tsx',
  '**/*.jsx',
  '**/*.vue',
  '**/*.svelte',
  '**/ui/**',
  '**/web/**',
  '**/frontend/**',
  '**/client/**',
  '**/components/**',
  '**/views/**',
  '**/pages/**'
];

export const DEFAULT_TEST_PATTERNS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.*',
  '**/test-*.*'
];

// Unicode-safe boundary regex (supports NFC Vietnamese diacritics & English UI keywords)
export const UI_INTENT_REGEX = /(?<![\p{L}\p{N}_])(ui|ux|layout|css|style|theme|dark\s*mode|light\s*mode|responsive|modal|button|dialog|animation|visual|giao\s*diện|bố\s*cục|màu\s*sắc|hiển\s*thị|màn\s*hình|bấm|nút|treo)(?![\p{L}\p{N}_])/iu;

// Matches creation/redesign signals indicating NEW UI work (as opposed to fixing/removing/tidying existing UI)
export const NEW_UI_CREATION_REGEX = /(?<![\p{L}\p{N}_])(tạo|thêm|thiết\s*kế|xây\s*dựng|bổ\s*sung|hoàn\s*thiện|dựng|triển\s*khai|phát\s*triển|hiện\s*thực|tích\s*hợp|làm\s+giao\s*diện|mới|add|create|build|design|redesign|implement|develop|scaffold|introduce|new)(?![\p{L}\p{N}_])/iu;

export const VALID_TASK_KINDS = Object.freeze(['feature', 'bugfix', 'refactor', 'remove', 'test', 'docs']);

/**
 * Strips feature/module/control noun phrases containing "xóa/delete/remove" before fallback regex
 * inference so goals mentioning a feature name (e.g. "tab Xóa phụ đề") never falsely infer kind="remove".
 */
function stripFeatureNounPhrasesForKindInference(text = '') {
  return String(text || '').normalize('NFC')
    .replace(
      /(?<![\p{L}\p{N}_])(?:tab|chế\s*độ|tính\s*năng|chức\s*năng|công\s*cụ|trình|nhóm|mục)\s+(?:xóa|xoá|gỡ|delete|remove)(?:\s+(?:phụ\s*đề|watermark|logo|chữ|nền|vùng|khung|roi|sub|hard-?sub|video|nhanh|hàng\s*loạt|dữ\s*liệu|cache|lịch\s*sử|bộ\s*nhớ))?/giu,
      ' __FEATURE_NAME__ '
    )
    .replace(
      /(?<![\p{L}\p{N}_])(?:nút|button|icon|btn|khung|vùng|lịch\s*sử)\s+(?:xóa|xoá|delete|remove)(?:\s+(?:lịch\s*sử|tất\s*cả|chọn|vùng|khung|nhanh|phụ\s*đề))?/giu,
      ' __UI_CONTROL__ '
    )
    .replace(
      /(?<![\p{L}\p{N}_])(?:xóa|xoá)\s+(?:phụ\s*đề|watermark|logo|chữ|nền|roi|hard-?sub|video)(?![\p{L}\p{N}_])/giu,
      ' __FEATURE_NOUN__ '
    );
}

export function inferTaskKindFallback({ goalText = '', scope = [], isPureTestScope = false } = {}) {
  const cleanScope = (Array.isArray(scope) ? scope : [])
    .map(s => String(s || '').trim().replace(/\\/g, '/'))
    .filter(Boolean);
  if (cleanScope.length > 0 && cleanScope.every(f => /\.md$/i.test(f) || /^docs\//i.test(f))) {
    return 'docs';
  }
  if (isPureTestScope) {
    return 'test';
  }
  const masked = stripFeatureNounPhrasesForKindInference(goalText);
  if (/(?<![\p{L}\p{N}_])(?:fix|bug|khắc\s*phục(?:\s+lỗi)?|sửa\s+lỗi|vá\s+lỗi|crash)(?![\p{L}\p{N}_])/iu.test(masked)) {
    return 'bugfix';
  }
  if (/(?<![\p{L}\p{N}_])(?:refactor|tái\s*cấu\s*trúc|đơn\s*giản\s*hóa|tối\s*ưu\s+cấu\s*trúc|simplify|cleanup|clean\s+up)(?![\p{L}\p{N}_])/iu.test(masked)) {
    return 'refactor';
  }
  if (
    /(?<![\p{L}\p{N}_])(?:loại\s*bỏ|gỡ\s*bỏ|xóa\s*bỏ|xoá\s*bỏ|remove|delete|drop|deprecate)(?![\p{L}\p{N}_])/iu.test(masked) ||
    /(?<![\p{L}\p{N}_])(?:xóa|xoá)\s+(?:hàm|class|lớp|biến|cụm|listener|đoạn|dòng|file|module|chế\s*độ|tính\s*năng|nút|button|thanh|slider|panel|endpoint|api|code|thừa|cũ|bộ\s*lọc)(?![\p{L}\p{N}_])/iu.test(masked)
  ) {
    return 'remove';
  }
  if (/(?<![\p{L}\p{N}_])(?:thêm\s+test|viết\s+test|bổ\s+sung\s+kiểm\s*thử|unit\s+test)(?![\p{L}\p{N}_])/iu.test(masked)) {
    return 'test';
  }
  return 'feature';
}

/**
 * Matches a normalized POSIX relative path against a domain glob pattern.
 * Handles root files (e.g. "index.html"), nested directories (e.g. "ui/x.py", "src/ui/Modal.tsx"),
 * and Windows backslash normalization.
 */
export function matchesDomainPattern(filePath = '', pattern = '') {
  const cleanFile = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanPat = String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanFile || !cleanPat) return false;

  // Use safe token placeholders before escaping regex metacharacters
  let regexStr = cleanPat
    .replace(/^\*\*\//, '__GLOB_PREFIX__')
    .replace(/\/\*\*$/, '__GLOB_SUFFIX__')
    .replace(/\/\*\*\//g, '__GLOB_MID_DIRS__')
    .replace(/\*\*/g, '__GLOB_ALL__')
    .replace(/\*/g, '__GLOB_ONE__')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/__GLOB_PREFIX__/g, '(?:^|.*/)')
    .replace(/__GLOB_SUFFIX__/g, '(?:/.*|$)')
    .replace(/__GLOB_MID_DIRS__/g, '/(?:.*/)?')
    .replace(/__GLOB_ALL__/g, '.*')
    .replace(/__GLOB_ONE__/g, '[^/]*');

  try {
    const re = new RegExp(`^${regexStr}$`, 'i');
    return re.test(cleanFile);
  } catch {
    return false;
  }
}

/**
 * 1. Partitions task.scope into project-agnostic domain buckets (deduplicated):
 *    - testScope: files matching test patterns (kept strictly out of backendScope)
 *    - frontendScope: UI, markup, styles, components
 *    - backendScope: non-test implementation logic, API, services, CLI
 */
export function partitionScopeByDomain(scope = [], policyConfig = {}) {
  const policy = policyConfig?.policy || policyConfig || {};
  const customFrontend = policy.domain_patterns?.frontend;
  const customTests = policy.domain_patterns?.test;

  const frontendPatterns = Array.isArray(customFrontend) && customFrontend.length > 0
    ? customFrontend
    : DEFAULT_FRONTEND_PATTERNS;
  const testPatterns = Array.isArray(customTests) && customTests.length > 0
    ? customTests
    : DEFAULT_TEST_PATTERNS;

  const frontendScope = [];
  const backendScope = [];
  const testScope = [];
  const seenFiles = new Set();

  for (const rawFile of (Array.isArray(scope) ? scope : [])) {
    const file = String(rawFile || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);

    const isTest = testPatterns.some(pat => matchesDomainPattern(file, pat));
    if (isTest) {
      testScope.push(file);
      continue;
    }

    const isFrontend = frontendPatterns.some(pat => matchesDomainPattern(file, pat));
    if (isFrontend) {
      frontendScope.push(file);
    } else {
      backendScope.push(file);
    }
  }

  return { backendScope, frontendScope, testScope };
}

/**
 * 2. Analyzes task demand deterministically (0-Token, project-agnostic).
 *    Enforces max(declared, computed) for both riskLevel and mode.
 */
export function analyzeTaskDemand(task = {}, policyConfig = {}) {
  const policy = policyConfig?.policy || policyConfig || {};
  const { backendScope, frontendScope, testScope } = partitionScopeByDomain(task.scope || [], policy);
  const hasBackendImpl = backendScope.length > 0;
  const hasBackend = hasBackendImpl;
  const hasFrontend = frontendScope.length > 0;
  const hasTests = testScope.length > 0;
  const isPureTestScope = hasTests && !hasBackendImpl && !hasFrontend;
  const isCrossDomain = hasBackendImpl && hasFrontend;

  const riskLevel = resolveEffectiveRisk(task);

  const rawMode = String(task.mode || '').toLowerCase();
  const computedMode = resolveTaskMode(task, policy);
  const mode = rawMode === 'consult'
    ? 'consult'
    : ((rawMode === 'standard' || computedMode === 'standard' || isCrossDomain || riskLevel === 'high' || riskLevel === 'critical')
        ? 'standard'
        : 'quick');

  const hasVisualInput = (Array.isArray(task.attachments) && task.attachments.length > 0)
    || (Array.isArray(task.images) && task.images.length > 0);
  const goalText = `${task.title || ''} ${task.goal || ''}`.normalize('NFC');
  const uiKeywordHint = UI_INTENT_REGEX.test(goalText);
  // hasUiIntent is evaluated ONLY in standard mode (quick + low + no images never triggers UI spec)
  const hasUiIntent = mode === 'standard' && uiKeywordHint;

  // Optional Feature Flag (`solo_first_for_clear_tasks: false` by default per engineering review):
  // Only skips pre-code Spec when explicitly enabled AND task kind is remove/refactor/bugfix with clear AC,
  // low/medium risk, and no new cross-domain contract requirement.
  const soloFirstEnabled = Boolean(
    task.solo_first === true || policy.workflow_optimization?.solo_first_for_clear_tasks === true
  );
  const rawDeclaredKind = typeof task.kind === 'string' ? task.kind.trim().toLowerCase() : '';
  const hasExplicitKind = VALID_TASK_KINDS.includes(rawDeclaredKind) && String(task.kind_source || '').toLowerCase() !== 'heuristic';
  const taskKind = hasExplicitKind
    ? rawDeclaredKind
    : inferTaskKindFallback({ goalText, scope: task.scope || [], isPureTestScope });
  const kindSource = hasExplicitKind
    ? (String(task.kind_source || '').trim().toLowerCase() || 'explicit')
    : 'heuristic';
  const hasClearAcceptanceCriteria = Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length >= 2;
  const requiresNewContract = Boolean(task.requires_new_contract)
    || /(?:thêm api|new api|new endpoint|new rpc|hợp đồng mới|new contract)/i.test(goalText);
  const canSkipSpecsViaSoloFirst = soloFirstEnabled
    && (taskKind === 'remove' || taskKind === 'refactor' || taskKind === 'bugfix')
    && hasClearAcceptanceCriteria
    && !requiresNewContract
    && !hasVisualInput
    && riskLevel !== 'high'
    && riskLevel !== 'critical';

  const isQuickLowNoVisual = mode === 'quick' && riskLevel === 'low' && !hasVisualInput;
  const isNewUi = hasFrontend
    && mode === 'standard'
    && taskKind === 'feature'
    && (task.is_new_ui === false
      ? false
      : (Boolean(task.is_new_ui || task.new_ui) || (hasUiIntent && NEW_UI_CREATION_REGEX.test(goalText))));

  // Designer runs ONLY when images/attachments exist OR (standard + new UI)
  const needsDesignSpec = mode !== 'consult' && !canSkipSpecsViaSoloFirst && !isPureTestScope && !isQuickLowNoVisual && (
    hasVisualInput ||
    (mode === 'standard' && isNewUi)
  );

  const needsTechSpec = mode !== 'consult' && !canSkipSpecsViaSoloFirst && !isPureTestScope && !isQuickLowNoVisual && hasBackendImpl && (
    mode === 'standard' ||
    isCrossDomain ||
    riskLevel === 'high' ||
    riskLevel === 'critical'
  );

  const minReviewRisk = String(policy.approval_gates?.review_min_risk_level || 'high').toLowerCase();
  const minRank = RISK_LEVEL_RANK[minReviewRisk] || RISK_LEVEL_RANK.high;
  const taskRank = RISK_LEVEL_RANK[riskLevel] || RISK_LEVEL_RANK.low;
  const meetsRiskThreshold = taskRank >= minRank;
  const needsCodeReview = mode !== 'consult' && (
    Boolean(task.force_ai_review) ||
    mode === 'standard' ||
    meetsRiskThreshold
  );

  return {
    kind: taskKind,
    kindSource,
    mode,
    riskLevel,
    backendScope,
    frontendScope,
    testScope,
    hasBackendImpl,
    hasBackend,
    hasFrontend,
    hasTests,
    isPureTestScope,
    isCrossDomain,
    hasVisualInput,
    hasUiIntent,
    uiKeywordHint,
    isNewUi,
    needsDesignSpec,
    needsTechSpec,
    needsCodeReview
  };
}

/**
 * 3. Extracts available squad roles & models from team.yaml.
 */
function resolveDisabledSetFromEntries(entries = []) {
  const disabled = new Set();
  for (const item of (Array.isArray(entries) ? entries : [])) {
    if (typeof item === 'string' && item.trim()) {
      disabled.add(item.trim());
    } else if (item && typeof item === 'object' && item.disabled !== false) {
      const id = String(item.id || item.model || '').trim();
      if (id) disabled.add(id);
    }
  }
  return disabled;
}

export function getRoleDisabledModelSet(teamConfig = {}, roleName = 'writer') {
  const globalDisabled = resolveDisabledSetFromEntries(teamConfig?.disabled_models);
  const roleCfg = teamConfig?.roles?.[roleName] || {};
  const roleDisabled = resolveDisabledSetFromEntries(roleCfg.disabled_models);
  if (Array.isArray(roleCfg.models)) {
    for (const m of roleCfg.models) {
      if (m && typeof m === 'object' && m.disabled === true) {
        const id = String(m.id || m.model || '').trim();
        if (id) roleDisabled.add(id);
      }
    }
  }
  return new Set([...globalDisabled, ...roleDisabled]);
}

export function isModelDisabledInConfig(modelId, teamConfig = {}, roleName = 'writer') {
  const clean = String(modelId || '').trim();
  if (!clean) return false;
  return getRoleDisabledModelSet(teamConfig, roleName).has(clean);
}

export function getRoleCandidateModels(teamConfig = {}, roleName = 'writer') {
  const roleCfg = teamConfig?.roles?.[roleName];
  if (!roleCfg || roleCfg.enabled === false) return [];
  const disabledSet = getRoleDisabledModelSet(teamConfig, roleName);
  const ordered = [];
  const pushUnique = (raw) => {
    const id = typeof raw === 'string' ? raw.trim() : String(raw?.id || raw?.model || '').trim();
    if (!id || ordered.includes(id)) return;
    ordered.push(id);
  };
  if (Array.isArray(roleCfg.models) && roleCfg.models.length > 0) {
    for (const m of roleCfg.models) {
      if (m && typeof m === 'object' && m.disabled === true) continue;
      pushUnique(m);
    }
  }
  for (const raw of [roleCfg.default_model, roleCfg.model, roleCfg.fallback_model]) {
    if (typeof raw === 'string' && raw.trim()) pushUnique(raw);
  }
  return ordered.filter(id => !disabledSet.has(id));
}

export function getAllDisabledModelSet(teamConfig = {}) {
  const disabled = resolveDisabledSetFromEntries(teamConfig?.disabled_models);
  const roles = teamConfig?.roles || {};
  for (const roleName of Object.keys(roles)) {
    for (const id of getRoleDisabledModelSet(teamConfig, roleName)) {
      disabled.add(id);
    }
  }
  return disabled;
}

export function getAllActiveRosterModels(teamConfig = {}) {
  const globalDisabled = resolveDisabledSetFromEntries(teamConfig?.disabled_models);
  const roles = teamConfig?.roles || {};
  const active = [];
  for (const [roleName, roleCfg] of Object.entries(roles)) {
    if (!roleCfg || roleCfg.enabled === false) continue;
    const roleDisabled = new Set([...globalDisabled, ...getRoleDisabledModelSet(teamConfig, roleName)]);
    const candidates = [];
    for (const raw of [roleCfg.model, roleCfg.default_model, roleCfg.fallback_model]) {
      if (typeof raw === 'string' && raw.trim()) candidates.push(raw.trim());
    }
    if (Array.isArray(roleCfg.models)) {
      for (const m of roleCfg.models) {
        if (typeof m === 'string' && m.trim()) {
          candidates.push(m.trim());
        } else if (m && typeof m === 'object' && m.disabled !== true) {
          const id = String(m.id || m.model || '').trim();
          if (id) candidates.push(id);
        }
      }
    }
    for (const id of candidates) {
      if (!roleDisabled.has(id) && !active.includes(id)) {
        active.push(id);
      }
    }
  }
  return active;
}

export function validateRequestedWriterModel(modelId, teamConfig = {}, options = {}) {
  const clean = String(modelId || '').trim();
  if (!clean) {
    return { ok: false, reason: 'empty_model', error: 'Writer model is empty.' };
  }
  const allDisabled = getAllDisabledModelSet(teamConfig);
  if (allDisabled.has(clean)) {
    return {
      ok: false,
      reason: 'model_disabled',
      error: `Writer model "${clean}" is disabled in team.yaml. Blocking task without silent substitution.`
    };
  }
  const activeRoster = getAllActiveRosterModels(teamConfig);
  if (!activeRoster.includes(clean)) {
    return {
      ok: false,
      reason: 'not_in_roster',
      error: `Writer model "${clean}" is not in active team.yaml roster. Blocking task without silent substitution.`
    };
  }
  const preflightFailedSet = options.preflightFailedModels instanceof Set
    ? options.preflightFailedModels
    : new Set(Array.isArray(options.preflightFailedModels) ? options.preflightFailedModels : []);
  if (preflightFailedSet.has(clean)) {
    return {
      ok: false,
      reason: 'preflight_failed',
      error: `Writer model "${clean}" failed preflight check. Blocking task without silent substitution.`
    };
  }
  const isCircuitBroken = typeof options.isCircuitBrokenFn === 'function' ? options.isCircuitBrokenFn : () => false;
  if (isCircuitBroken(clean)) {
    return {
      ok: false,
      reason: 'circuit_breaker',
      error: `Writer model "${clean}" is circuit-broken in this session. Blocking task without silent substitution.`
    };
  }
  return { ok: true, model: clean };
}

export function resolveRoutingRuleModel(task = {}, teamConfig = {}, policyConfig = {}) {
  const routingCfg = teamConfig?.routing || teamConfig?.roles?.writer?.routing || null;
  if (!routingCfg || typeof routingCfg !== 'object') {
    return { matched: false, model: null, ruleName: null };
  }

  const demand = analyzeTaskDemand(task, policyConfig);
  const taskDomain = (demand.hasBackend && demand.hasFrontend)
    ? 'fullstack'
    : (demand.hasFrontend ? 'frontend' : 'backend');
  const taskScope = Array.isArray(task?.scope) ? task.scope : [];

  const rules = Array.isArray(routingCfg.rules) ? routingCfg.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule !== 'object') continue;
    const ruleModel = String(rule.model || '').trim();
    if (!ruleModel) continue;

    if (rule.domain !== undefined) {
      const targetDomain = String(rule.domain).toLowerCase();
      const domainMatch = targetDomain === taskDomain
        || (targetDomain === 'frontend' && demand.hasFrontend && !demand.hasBackend)
        || (targetDomain === 'backend' && demand.hasBackend && !demand.hasFrontend);
      if (!domainMatch) continue;
    }
    if (Array.isArray(rule.domains) && rule.domains.length > 0) {
      const allowed = rule.domains.map(d => String(d).toLowerCase());
      if (!allowed.includes(taskDomain)) continue;
    }
    if (rule.risk_level !== undefined && String(rule.risk_level).toLowerCase() !== String(demand.riskLevel).toLowerCase()) {
      continue;
    }
    if (rule.kind !== undefined && String(rule.kind).toLowerCase() !== String(demand.kind).toLowerCase()) {
      continue;
    }
    if (rule.mode !== undefined && String(rule.mode).toLowerCase() !== String(demand.mode).toLowerCase()) {
      continue;
    }
    const pathPatterns = Array.isArray(rule.path_patterns) ? rule.path_patterns : (Array.isArray(rule.paths) ? rule.paths : null);
    if (pathPatterns && pathPatterns.length > 0) {
      const matchedAnyPath = taskScope.some(f => pathPatterns.some(pat => matchesDomainPattern(f, pat)));
      if (!matchedAnyPath) continue;
    }

    return {
      matched: true,
      model: ruleModel,
      ruleName: String(rule.name || `rule_${i + 1}`)
    };
  }

  const domainMap = routingCfg.by_domain && typeof routingCfg.by_domain === 'object' ? routingCfg.by_domain : routingCfg;
  const mapped = domainMap[taskDomain];
  if (typeof mapped === 'string' && mapped.trim()) {
    return {
      matched: true,
      model: mapped.trim(),
      ruleName: `by_domain:${taskDomain}`
    };
  }

  return { matched: false, model: null, ruleName: null };
}

export function resolveWriterSelection(task = {}, teamConfig = {}, options = {}) {
  const writerRole = teamConfig?.roles?.writer;
  if (writerRole && writerRole.enabled === false) {
    return {
      ok: false,
      selected_by: 'primary',
      requested_model: null,
      actual_model: null,
      fallback_models: [],
      reason: 'writer_role_disabled',
      blocked_reason: 'Writer role is disabled in team.yaml (enabled: false). Stopping execution.'
    };
  }

  const preflightFailedSet = options.preflightFailedModels instanceof Set
    ? options.preflightFailedModels
    : new Set(Array.isArray(options.preflightFailedModels) ? options.preflightFailedModels : []);
  const isCircuitBroken = typeof options.isCircuitBrokenFn === 'function' ? options.isCircuitBrokenFn : () => false;

  const taskOverrideRaw = String(task?.writer_model || task?.model || '').trim();
  if (taskOverrideRaw) {
    const overrideCheck = validateRequestedWriterModel(taskOverrideRaw, teamConfig, {
      preflightFailedModels: preflightFailedSet,
      isCircuitBrokenFn: isCircuitBroken
    });
    if (!overrideCheck.ok) {
      return {
        ok: false,
        selected_by: 'task_override',
        requested_model: taskOverrideRaw,
        actual_model: null,
        fallback_models: [],
        reason: overrideCheck.reason,
        blocked_reason: overrideCheck.error
      };
    }
    return {
      ok: true,
      selected_by: 'task_override',
      requested_model: taskOverrideRaw,
      actual_model: taskOverrideRaw,
      fallback_models: [],
      reason: task?.writer_model ? 'task_writer_model_override' : 'task_model_override',
      blocked_reason: null
    };
  }

  const roleCfg = writerRole || {};
  const primaryRaw = (Array.isArray(roleCfg.models) && roleCfg.models.length > 0
    ? (typeof roleCfg.models[0] === 'string' ? roleCfg.models[0] : (roleCfg.models[0]?.id || roleCfg.models[0]?.model))
    : null)
    || roleCfg.default_model
    || roleCfg.model
    || null;
  const primaryModel = primaryRaw ? String(primaryRaw).trim() : null;

  const rawFallbackPool = [];
  if (Array.isArray(roleCfg.models) && roleCfg.models.length > 1) {
    for (const m of roleCfg.models.slice(1)) {
      const id = typeof m === 'string' ? m.trim() : String(m?.id || m?.model || '').trim();
      if (id && id !== primaryModel && !rawFallbackPool.includes(id)) rawFallbackPool.push(id);
    }
  }
  if (roleCfg.fallback_model && typeof roleCfg.fallback_model === 'string') {
    const fb = roleCfg.fallback_model.trim();
    if (fb && fb !== primaryModel && !rawFallbackPool.includes(fb)) rawFallbackPool.push(fb);
  }

  const isUsable = (modelId) => {
    if (!modelId) return { ok: false, reason: 'missing_model' };
    if (isModelDisabledInConfig(modelId, teamConfig, 'writer')) return { ok: false, reason: 'model_disabled' };
    if (preflightFailedSet.has(modelId)) return { ok: false, reason: 'preflight_failed' };
    if (isCircuitBroken(modelId)) return { ok: false, reason: 'circuit_breaker' };
    return { ok: true, reason: null };
  };

  const usableFallbacks = rawFallbackPool.filter(m => isUsable(m).ok);

  // Priority 2: routing (optional rule from team.routing.yaml or team.yaml)
  const routingMatch = resolveRoutingRuleModel(task, teamConfig, options.policyConfig || {});
  if (routingMatch.matched && routingMatch.model) {
    const routedModel = routingMatch.model;
    const rosterCheck = validateRequestedWriterModel(routedModel, teamConfig, {
      preflightFailedModels: preflightFailedSet,
      isCircuitBrokenFn: isCircuitBroken
    });
    const orderedCandidates = [
      ...(primaryModel ? [primaryModel] : []),
      ...usableFallbacks
    ].filter((m, idx, arr) => m && m !== routedModel && isUsable(m).ok && arr.indexOf(m) === idx);

    if (rosterCheck.ok) {
      return {
        ok: true,
        selected_by: 'routing_rule',
        requested_model: routedModel,
        actual_model: routedModel,
        fallback_models: orderedCandidates,
        reason: `routing_rule:${routingMatch.ruleName}`,
        blocked_reason: null
      };
    }

    if (orderedCandidates.length > 0) {
      return {
        ok: true,
        selected_by: 'fallback',
        requested_model: routedModel,
        actual_model: orderedCandidates[0],
        fallback_models: orderedCandidates.slice(1),
        reason: `${rosterCheck.reason || 'routing_unavailable'} (from routing_rule:${routingMatch.ruleName})`,
        blocked_reason: null
      };
    }
  }

  if (!primaryModel) {
    return {
      ok: false,
      selected_by: 'primary',
      requested_model: null,
      actual_model: null,
      fallback_models: [],
      reason: 'missing_writer_model',
      blocked_reason: 'Writer role has no model specified in task or team.yaml'
    };
  }

  const primaryCheck = isUsable(primaryModel);
  if (primaryCheck.ok) {
    return {
      ok: true,
      selected_by: 'primary',
      requested_model: primaryModel,
      actual_model: primaryModel,
      fallback_models: usableFallbacks,
      reason: 'default_primary',
      blocked_reason: null
    };
  }

  // Primary failed preflight / disabled / circuit_breaker -> promote first healthy fallback
  if (usableFallbacks.length > 0) {
    const chosenFallback = usableFallbacks[0];
    return {
      ok: true,
      selected_by: 'fallback',
      requested_model: primaryModel,
      actual_model: chosenFallback,
      fallback_models: usableFallbacks.slice(1),
      reason: primaryCheck.reason,
      blocked_reason: null
    };
  }

  return {
    ok: false,
    selected_by: 'primary',
    requested_model: primaryModel,
    actual_model: null,
    fallback_models: [],
    reason: primaryCheck.reason,
    blocked_reason: `Primary writer model "${primaryModel}" is unavailable (${primaryCheck.reason}) and no usable fallback exists.`
  };
}

export function resolveRuntimeWriterFallback({
  selection = null,
  failureStage = 'provider',
  providerError = null,
  teamConfig = {},
  preflightFailedModels = null,
  isCircuitBrokenFn = null
} = {}) {
  const errText = String(providerError?.message || providerError?.error || providerError || '');
  const isBudgetErr = failureStage === 'budget' || Boolean(
    providerError && (
      providerError.isBudgetExceeded === true ||
      providerError.name === 'BudgetExceededError' ||
      providerError.code === 'LOCAL_BUDGET_STOP' ||
      providerError.budget_exceeded === true ||
      /local budget stop|BudgetExceededError/i.test(errText)
    )
  );
  if (isBudgetErr) {
    return {
      ok: false,
      selected_by: selection?.selected_by || 'primary',
      requested_model: selection?.requested_model || null,
      actual_model: selection?.actual_model || null,
      reason: 'budget_exceeded_disallows_fallback'
    };
  }
  if (failureStage === 'validate' || failureStage === 'apply' || !providerError) {
    return {
      ok: false,
      selected_by: selection?.selected_by || 'primary',
      requested_model: selection?.requested_model || null,
      actual_model: selection?.actual_model || null,
      reason: 'fallback_not_permitted_for_stage'
    };
  }
  if (selection?.selected_by === 'task_override') {
    return {
      ok: false,
      selected_by: 'task_override',
      requested_model: selection.requested_model,
      actual_model: selection.actual_model,
      reason: 'task_override_disallows_fallback'
    };
  }

  const preflightSet = preflightFailedModels instanceof Set
    ? preflightFailedModels
    : new Set(Array.isArray(preflightFailedModels) ? preflightFailedModels : []);
  const checkCB = typeof isCircuitBrokenFn === 'function' ? isCircuitBrokenFn : () => false;

  const candidates = Array.isArray(selection?.fallback_models) ? selection.fallback_models : [];
  const nextModel = candidates.find(m =>
    m &&
    m !== selection?.actual_model &&
    !isModelDisabledInConfig(m, teamConfig, 'writer') &&
    !preflightSet.has(m) &&
    !checkCB(m)
  );

  if (!nextModel) {
    return {
      ok: false,
      selected_by: selection?.selected_by || 'primary',
      requested_model: selection?.requested_model || null,
      actual_model: selection?.actual_model || null,
      reason: 'no_usable_fallback_available'
    };
  }

  return {
    ok: true,
    selected_by: 'fallback',
    requested_model: selection?.requested_model || selection?.actual_model || nextModel,
    actual_model: nextModel,
    reason: `provider_error: ${String(providerError).slice(0, 140)}`
  };
}

/**
 * Resolves the model for a `consult` task without ever permitting an empty model:
 * 1) Explicit non-empty task.model (if not disabled for that role)
 * 2) Configured active model on task.role (default_model, model, or models[])
 * 3) Cheap role `router` model from team.yaml (when consult role has no model configured; NEVER expensive reviewer)
 * Otherwise fails with a clear error requiring explicit model declaration in team.yaml.
 */
export function resolveConsultModelSelection(task = {}, teamConfig = {}) {
  const roles = teamConfig?.roles || {};
  const consultRole = String(task?.role || task?.owner || 'designer').trim() || 'designer';
  const roleCfg = roles[consultRole] || {};

  if (roleCfg.enabled === false) {
    return {
      ok: false,
      model: null,
      role: consultRole,
      source: null,
      error: `Consultation role "${consultRole}" is disabled in team.yaml (enabled: false). Stopping execution.`
    };
  }

  const pickActiveFromRole = (cfg, roleName) => {
    if (!cfg || cfg.enabled === false) return null;
    const ordered = [
      cfg.default_model,
      cfg.model,
      ...getRoleCandidateModels(teamConfig, roleName)
    ];
    for (const raw of ordered) {
      const clean = String(raw || '').trim();
      if (clean && !isModelDisabledInConfig(clean, teamConfig, roleName)) {
        return clean;
      }
    }
    return null;
  };

  const explicitTaskModel = String(task?.model || '').trim();
  if (explicitTaskModel) {
    if (isModelDisabledInConfig(explicitTaskModel, teamConfig, consultRole)) {
      return {
        ok: false,
        model: null,
        role: consultRole,
        source: task?.model_source || 'task',
        error: `Consultation model "${explicitTaskModel}" is disabled in team.yaml for role "${consultRole}". Stopping execution.`
      };
    }
    return {
      ok: true,
      model: explicitTaskModel,
      role: consultRole,
      source: task?.model_source || 'task',
      error: null
    };
  }

  const roleModel = pickActiveFromRole(roleCfg, consultRole);
  if (roleModel) {
    return {
      ok: true,
      model: roleModel,
      role: consultRole,
      source: 'role_config',
      error: null
    };
  }

  const routerCfg = roles.router;
  if (routerCfg && routerCfg.enabled !== false) {
    const routerModel = pickActiveFromRole(routerCfg, 'router');
    if (routerModel) {
      return {
        ok: true,
        model: routerModel,
        role: consultRole,
        source: 'router_fallback',
        error: null
      };
    }
  }

  return {
    ok: false,
    model: null,
    role: consultRole,
    source: null,
    error: `Consultation task (role="${consultRole}") has no model configured in team.yaml and no active router model is available. Vui lòng khai báo model cho role "${consultRole}" hoặc role "router" trong team.yaml.`
  };
}

export function resolveSpecModelByRisk(teamConfig = {}, task = {}, policyConfig = {}) {
  const roles = teamConfig?.roles || {};
  const riskLevel = resolveEffectiveRisk(task);
  const isHighRisk = riskLevel === 'high' || riskLevel === 'critical';
  const disabledAll = getAllDisabledModelSet(teamConfig);

  const getRoleModel = (roleCfg, roleName) => {
    if (!roleCfg || roleCfg.enabled === false) return null;
    const roleDisabled = getRoleDisabledModelSet(teamConfig, roleName);
    const candidate = roleCfg.default_model
      || roleCfg.model
      || (Array.isArray(roleCfg.models) && roleCfg.models.length > 0 ? roleCfg.models[0] : null);
    const clean = typeof candidate === 'string' ? candidate.trim() : String(candidate?.id || candidate?.model || '').trim();
    if (!clean || disabledAll.has(clean) || roleDisabled.has(clean)) return null;
    return clean;
  };

  const specByRisk = teamConfig?.spec_models
    || teamConfig?.team?.spec_models
    || roles.architect?.models_by_risk
    || roles.techlead?.models_by_risk
    || policyConfig?.policy?.approval_gates?.spec_models_by_risk
    || null;

  if (specByRisk && typeof specByRisk === 'object') {
    const tierOrder = riskLevel === 'critical'
      ? ['critical', 'high']
      : (riskLevel === 'high'
          ? ['high', 'critical']
          : (riskLevel === 'medium' ? ['medium', 'low'] : ['low', 'medium']));
    for (const tier of tierOrder) {
      const candidate = typeof specByRisk[tier] === 'string' ? specByRisk[tier].trim() : '';
      if (candidate && !disabledAll.has(candidate)) {
        const chosenRole = (roles.architect && roles.architect.enabled !== false)
          ? 'architect'
          : ((roles.techlead && roles.techlead.enabled !== false) ? 'techlead' : 'architect');
        return { role: chosenRole, model: candidate, riskLevel, source: 'config_spec_models' };
      }
    }
  }

  for (const candidateRole of ['architect', 'techlead']) {
    const m = getRoleModel(roles[candidateRole], candidateRole);
    if (m) {
      return { role: candidateRole, model: m, riskLevel, source: `role_${candidateRole}` };
    }
  }

  if (isHighRisk) {
    for (const candidateRole of ['reviewer', 'router']) {
      const m = getRoleModel(roles[candidateRole], candidateRole);
      if (m) {
        return { role: candidateRole, model: m, riskLevel, source: `high_risk_${candidateRole}` };
      }
    }
  } else {
    // Never default low/medium spec drafting to the expensive Reviewer role
    const routerModel = getRoleModel(roles.router, 'router');
    if (routerModel) {
      return { role: 'router', model: routerModel, riskLevel, source: 'low_medium_router' };
    }
  }

  return { role: null, model: null, riskLevel, source: null };
}

export function resolveSquadRoster(teamConfig = {}, task = {}, policyConfig = {}) {
  const roles = teamConfig?.roles || {};
  const riskLevel = resolveEffectiveRisk(task);
  const getRoleModel = (roleCfg) => {
    if (!roleCfg || roleCfg.enabled === false) return null;
    return roleCfg.default_model
      || roleCfg.model
      || (Array.isArray(roleCfg.models) && roleCfg.models.length > 0 ? roleCfg.models[0] : null);
  };

  const taskOverrideModel = task.writer_model || task.model || null;
  const routingMatch = !taskOverrideModel ? resolveRoutingRuleModel(task, teamConfig, policyConfig) : { matched: false, model: null };
  const routedModel = (routingMatch.matched && routingMatch.model && validateRequestedWriterModel(routingMatch.model, teamConfig).ok)
    ? routingMatch.model
    : null;
  const primaryWriterModel = taskOverrideModel || routedModel || getRoleModel(roles.backend_writer) || getRoleModel(roles.writer);

  // Phương án 1: models[0] / default_model là writer chính cho mọi bucket; models[1..] chỉ dùng dự phòng.
  // Giữ roles.frontend_writer làm đường ghi đè tùy chọn khi được cấu hình tường minh.
  const explicitFrontendModel = (!taskOverrideModel && !routedModel && roles.frontend_writer?.enabled !== false)
    ? getRoleModel(roles.frontend_writer)
    : null;
  const frontendWriterRole = explicitFrontendModel ? 'frontend_writer' : 'writer';
  const frontendWriterModel = taskOverrideModel || routedModel || explicitFrontendModel || primaryWriterModel;

  const designerRiskModel = roles.designer?.enabled !== false && roles.designer?.models_by_risk && typeof roles.designer.models_by_risk[riskLevel] === 'string'
    ? roles.designer.models_by_risk[riskLevel].trim()
    : null;
  const designerModel = designerRiskModel || getRoleModel(roles.designer);

  const specSelection = resolveSpecModelByRisk(teamConfig, task, policyConfig);
  const techSpecRole = specSelection.role;
  const techSpecModel = specSelection.model;

  // TechLead for Post-Code Diff Review (only reviewer or techlead)
  let reviewerRole = null;
  let reviewerModel = null;
  for (const candidate of ['reviewer', 'techlead']) {
    const m = getRoleModel(roles[candidate]);
    if (m) {
      reviewerRole = candidate;
      reviewerModel = m;
      break;
    }
  }

  return {
    backendWriterModel: primaryWriterModel,
    frontendWriterModel,
    frontendWriterRole,
    designerModel,
    techSpecRole,
    techSpecModel,
    reviewerRole,
    reviewerModel
  };
}

/**
 * 4. Resolves Writer Hub workflow deterministically based on (TaskDemand × SquadRoster)
 *    with 4 Routing Invariants (Domain Relevance, Anti-Self-Spec, Anti-Self-Review, Auto-Collapse).
 */
/**
 * Resolves a gitignored draft_spec artifact path inside agent-team/state/runs/<task_id>/
 * so pre-code specs never create an untracked artifacts/ directory at repo root.
 */
export function resolveSpecArtifactPath(taskId = 'task', suffix = 'tech_spec.md', declaredArtifact = null) {
  const safeId = String(taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (declaredArtifact && typeof declaredArtifact === 'string' && declaredArtifact.trim()) {
    const norm = declaredArtifact.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.startsWith('agent-team/state/runs/')) {
      return norm;
    }
    const baseName = path.posix.basename(norm) || `${safeId}_${suffix}`;
    return `agent-team/state/runs/${safeId}/${baseName}`;
  }
  return `agent-team/state/runs/${safeId}/${safeId}_${suffix}`;
}

export function resolveWriterHubWorkflow(task = {}, teamConfig = {}, policyConfig = {}, preset = 'auto') {
  if (Array.isArray(task.writer_hub_workflow) && task.writer_hub_workflow.length > 0 && task.manual_workflow_override) {
    return task.writer_hub_workflow;
  }

  const demand = analyzeTaskDemand(task, policyConfig);
  if (demand.mode === 'consult') return [];

  const roster = resolveSquadRoster(teamConfig, task, policyConfig);
  if (!roster.backendWriterModel) return [];

  const dedupScope = (arr = []) => [...new Set(
    (Array.isArray(arr) ? arr : [])
      .map(s => String(s || '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(Boolean)
  )];

  // Test-only scope -> always single Writer ([]), never draft_spec
  if (demand.isPureTestScope) {
    return [];
  }

  const workflow = [];
  let stepCounter = 1;
  const generatedSpecArtifacts = [];

  const activeWriterModels = new Set([
    ...(demand.hasBackendImpl || !demand.hasFrontend ? [roster.backendWriterModel] : []),
    ...(demand.hasFrontend ? [roster.frontendWriterModel] : [])
  ]);
  const isSameAsAllWriters = (modelId) => Boolean(modelId && activeWriterModels.size === 1 && activeWriterModels.has(modelId));

  // --- STEP 1: PRE-CODE SPECIFICATIONS (TECH SPEC / DESIGN SPEC) ---
  if (preset !== 'fast') {
    // TechSpec only runs when backend implementation files exist (hasBackendImpl === true).
    const wantTechSpec = demand.hasBackendImpl && (preset === 'architect' || demand.needsTechSpec);
    const wantDesignSpec = demand.needsDesignSpec;

    const canRunTechSpec = Boolean(wantTechSpec && roster.techSpecModel && !isSameAsAllWriters(roster.techSpecModel));
    const canRunDesignSpec = Boolean(wantDesignSpec && roster.designerModel && !isSameAsAllWriters(roster.designerModel));

    if (canRunTechSpec && canRunDesignSpec) {
      if (roster.techSpecModel === roster.designerModel) {
        // Auto-Collapse: TechLead and Designer share the exact same model -> 1 unified spec call
        const combinedArtifact = resolveSpecArtifactPath(task.task_id, 'unified_spec.md');
        workflow.push({
          step: stepCounter++,
          role: roster.techSpecRole,
          model: roster.techSpecModel,
          action: 'draft_spec',
          spec_focus: 'unified_tech_and_ui',
          output_artifact: combinedArtifact,
          allow_skip_spec: preset !== 'architect' && !demand.hasVisualInput
        });
        generatedSpecArtifacts.push(combinedArtifact);
      } else {
        // Sequential Spec Handoff: TechLead locks data/API contract -> Designer receives techArtifact via inputs
        let techArtifact = null;
        if (demand.hasBackendImpl || demand.needsTechSpec) {
          techArtifact = resolveSpecArtifactPath(task.task_id, 'tech_spec.md');
          workflow.push({
            step: stepCounter++,
            role: roster.techSpecRole,
            model: roster.techSpecModel,
            action: 'draft_spec',
            spec_focus: 'architecture_and_contracts',
            sub_scope: dedupScope(demand.hasBackendImpl ? [...demand.backendScope, ...demand.testScope] : (task.scope || [])),
            bridge_skeleton_scope: dedupScope(demand.hasFrontend ? demand.frontendScope : []),
            output_artifact: techArtifact,
            allow_skip_spec: preset !== 'architect'
          });
          generatedSpecArtifacts.push(techArtifact);
        }
        const designArtifact = resolveSpecArtifactPath(task.task_id, 'design_spec.md');
        workflow.push({
          step: stepCounter++,
          role: 'designer',
          model: roster.designerModel,
          action: 'draft_spec',
          spec_focus: 'ui_ux_and_visual_audit',
          sub_scope: dedupScope(demand.hasFrontend ? demand.frontendScope : (task.scope || [])),
          bridge_skeleton_scope: dedupScope(demand.hasBackendImpl ? demand.backendScope : []),
          inputs: techArtifact ? [techArtifact] : [],
          output_artifact: designArtifact,
          allow_skip_spec: !demand.hasVisualInput
        });
        generatedSpecArtifacts.push(designArtifact);
      }
    } else if (canRunDesignSpec) {
      const designArtifact = resolveSpecArtifactPath(task.task_id, 'design_spec.md');
      workflow.push({
        step: stepCounter++,
        role: 'designer',
        model: roster.designerModel,
        action: 'draft_spec',
        spec_focus: 'ui_ux_and_visual_audit',
        sub_scope: dedupScope(demand.hasFrontend ? demand.frontendScope : (task.scope || [])),
        bridge_skeleton_scope: dedupScope(demand.hasBackendImpl ? demand.backendScope : []),
        output_artifact: designArtifact,
        allow_skip_spec: !demand.hasVisualInput
      });
      generatedSpecArtifacts.push(designArtifact);
    } else if (canRunTechSpec) {
      const techArtifact = resolveSpecArtifactPath(task.task_id, 'tech_spec.md');
      workflow.push({
        step: stepCounter++,
        role: roster.techSpecRole,
        model: roster.techSpecModel,
        action: 'draft_spec',
        spec_focus: 'architecture_and_contracts',
        sub_scope: dedupScope(demand.hasBackendImpl ? [...demand.backendScope, ...demand.testScope] : (task.scope || [])),
        bridge_skeleton_scope: dedupScope(demand.hasFrontend ? demand.frontendScope : []),
        output_artifact: techArtifact,
        allow_skip_spec: preset !== 'architect'
      });
      generatedSpecArtifacts.push(techArtifact);
    }
  }

  // --- STEP 2: CODE GENERATION BUCKETS (APPLY_PATCH) ---
  const canMergePatch = !demand.hasBackendImpl || !demand.hasFrontend || (roster.backendWriterModel === roster.frontendWriterModel);

  if (canMergePatch) {
    const isPureFrontend = demand.hasFrontend && !demand.hasBackendImpl;
    const chosenModel = isPureFrontend ? roster.frontendWriterModel : roster.backendWriterModel;
    const chosenRole = isPureFrontend ? roster.frontendWriterRole : 'writer';

    // Auto-Collapse Rule: If no upstream spec step was needed AND the patch uses the default primary writer
    // on the full scope, collapse to [] (1-step direct Writer execution in orchestrator).
    if (workflow.length === 0 && chosenModel === roster.backendWriterModel && chosenRole === 'writer') {
      return [];
    }

    workflow.push({
      step: stepCounter++,
      role: chosenRole,
      model: chosenModel,
      domain: isPureFrontend ? 'frontend' : (demand.isCrossDomain ? 'fullstack' : 'backend'),
      action: 'apply_patch',
      sub_scope: dedupScope(task.scope || []),
      inputs: [...generatedSpecArtifacts]
    });
  } else {
    // Mixed Backend + Frontend task with 2 distinct specialist Writer models:
    // Step 2A: Backend Writer patches backendScope first
    workflow.push({
      step: stepCounter++,
      role: 'writer',
      model: roster.backendWriterModel,
      domain: 'backend',
      action: 'apply_patch',
      sub_scope: dedupScope(demand.backendScope),
      inputs: [...generatedSpecArtifacts]
    });
    // Step 2B: Frontend Writer patches frontendScope (+ tests) next (with live AST signatures from backendScope)
    workflow.push({
      step: stepCounter++,
      role: roster.frontendWriterRole,
      model: roster.frontendWriterModel,
      domain: 'frontend',
      action: 'apply_patch',
      sub_scope: dedupScope([...demand.frontendScope, ...demand.testScope]),
      inject_updated_repo_map_from: dedupScope(demand.backendScope),
      inputs: [...generatedSpecArtifacts]
    });
  }

  return workflow;
}

/**
 * Estimates SEARCH/REPLACE patch completion output tokens for a source file based
 * on its smart-windowed context footprint.
 */
export function estimateFilePatchOutputTokens(bytes = 0) {
  const numericBytes = Math.max(0, Number(bytes) || 0);
  if (numericBytes === 0) return 200;
  const effectiveWindowBytes = Math.min(numericBytes, 24 * 1024);
  return Math.min(8000, Math.round((effectiveWindowBytes * 0.6) / 3.5) + 320);
}

/**
 * 5. Splits or merges apply_patch buckets by Output Budget so a single model completion
 *    stays safely below <60% of maxOutputTokens without wasting extra turns on tiny files.
 *    - Merges same-domain files when combined estimated output < 60% of maxOutputTokens
 *      (and <= 1 large >35KB file per bucket, keeping <=8KB companions together).
 *    - Keeps implementation domains (backend -> frontend) and tests cleanly ordered with
 *      live AST bridge handoff (`inject_updated_repo_map_from`) and emits `bucket_grouping_reason`.
 */
export function splitPatchStepsByOutputBudget(patchSteps = [], repoRoot = process.cwd(), maxBucketBytesOrOptions = 55 * 1024) {
  if (!Array.isArray(patchSteps) || patchSteps.length === 0) return [];
  const opts = (typeof maxBucketBytesOrOptions === 'object' && maxBucketBytesOrOptions !== null)
    ? maxBucketBytesOrOptions
    : { maxBucketBytes: maxBucketBytesOrOptions };
  const maxBucketBytes = Number(opts.maxBucketBytes) > 0 ? Number(opts.maxBucketBytes) : 55 * 1024;
  const maxOutputTokens = Number(opts.maxOutputTokens) > 0 ? Number(opts.maxOutputTokens) : 16384;
  const mergeOutputThresholdRatio = Number(opts.mergeOutputThresholdRatio) > 0 ? Number(opts.mergeOutputThresholdRatio) : 0.45;
  const thresholdPctLabel = Math.round(mergeOutputThresholdRatio * 100);

  const outputMergeCeiling = Math.floor(maxOutputTokens * mergeOutputThresholdRatio);
  const largeFileBytesThreshold = Math.min(35 * 1024, Math.floor(maxBucketBytes * 0.65));
  const smallCompanionBytesMax = Math.min(8 * 1024, Math.floor(maxBucketBytes * 0.15));

  const measureFile = (relFile) => {
    const cleanRel = String(relFile || '').trim().replace(/\\/g, '/');
    const absPath = path.resolve(repoRoot, cleanRel);
    let bytes = 0;
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        bytes = fs.statSync(absPath).size;
      }
    } catch {}
    const part = partitionScopeByDomain([cleanRel]);
    const isTest = part.testScope.length > 0;
    const isFrontend = part.frontendScope.length > 0;
    const domainGroup = isTest ? 'test' : (isFrontend ? 'frontend' : 'backend');
    return {
      file: cleanRel,
      bytes,
      estTokens: estimateFilePatchOutputTokens(bytes),
      isTest,
      isFrontend,
      domainGroup,
      isLarge: bytes > largeFileBytesThreshold,
      isTinyCompanion: bytes <= smallCompanionBytesMax
    };
  };

  const expanded = [];
  let stepCounter = 1;

  for (const rawStep of patchSteps) {
    const dedupedSub = Array.isArray(rawStep.sub_scope)
      ? [...new Set(rawStep.sub_scope.map(f => String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))]
      : rawStep.sub_scope;
    const step = Array.isArray(dedupedSub) ? { ...rawStep, sub_scope: dedupedSub } : rawStep;
    if (step.action !== 'apply_patch' || !Array.isArray(step.sub_scope) || step.sub_scope.length <= 1) {
      const singleStats = Array.isArray(step.sub_scope) ? step.sub_scope.map(measureFile) : [];
      const singleEst = singleStats.reduce((sum, f) => sum + f.estTokens, 0) || 200;
      const pct = ((singleEst / maxOutputTokens) * 100).toFixed(1);
      expanded.push({
        ...step,
        step: stepCounter++,
        estimated_output_tokens: singleEst,
        output_token_limit: maxOutputTokens,
        step_total_estimated_output_tokens: singleEst,
        bucket_grouping_reason: `single_file_bucket (est ${singleEst}/${maxOutputTokens} tok = ${pct}% < ${thresholdPctLabel}% ceiling)`
      });
      continue;
    }

    const fileStats = step.sub_scope.map(measureFile);
    const totalBytes = fileStats.reduce((sum, f) => sum + f.bytes, 0);
    const totalEstTokens = fileStats.reduce((sum, f) => sum + f.estTokens, 0);
    const largeCountTotal = fileStats.filter(f => f.isLarge).length;

    if (totalBytes <= maxBucketBytes && totalEstTokens <= outputMergeCeiling && largeCountTotal <= 1) {
      const pct = ((totalEstTokens / maxOutputTokens) * 100).toFixed(1);
      expanded.push({
        ...step,
        step: stepCounter++,
        estimated_output_tokens: totalEstTokens,
        output_token_limit: maxOutputTokens,
        step_total_estimated_output_tokens: totalEstTokens,
        bucket_grouping_reason: `merged_all_under_budget (est ${totalEstTokens}/${maxOutputTokens} tok = ${pct}% < ${thresholdPctLabel}% threshold; ${totalBytes}B <= ${maxBucketBytes}B)`
      });
      continue;
    }

    // Order files sequentially by dependency direction: backend impl -> frontend impl -> test files
    const backendFiles = fileStats.filter(f => f.domainGroup === 'backend');
    const frontendFiles = fileStats.filter(f => f.domainGroup === 'frontend');
    const testFiles = fileStats.filter(f => f.domainGroup === 'test');
    const orderedGroups = [...backendFiles, ...frontendFiles, ...testFiles];

    const subBuckets = [];
    let currentItems = [];

    const canMergeIntoCurrent = (items, candidate) => {
      if (items.length === 0) return true;
      const curDomain = items[0].domainGroup;
      if (curDomain !== candidate.domainGroup) return false;

      const curEst = items.reduce((s, f) => s + f.estTokens, 0);
      if (curEst + candidate.estTokens > outputMergeCeiling) return false;

      const curLargeCount = items.filter(f => f.isLarge).length;
      if (curLargeCount + (candidate.isLarge ? 1 : 0) > 1) return false;

      const curBytes = items.reduce((s, f) => s + f.bytes, 0);
      if (curBytes + candidate.bytes <= maxBucketBytes) return true;

      // Companion merge exception: if raw bytes exceed maxBucketBytes only because one large file (>35KB)
      // is paired with tiny same-domain companion file(s) (<=8KB, combined <=16KB), keep them merged under <60% output ceiling.
      const combinedNonLarge = items.filter(f => !f.isLarge).concat(candidate.isLarge ? [] : [candidate]);
      const allCompanionsTiny = combinedNonLarge.every(f => f.isTinyCompanion);
      const companionBytes = combinedNonLarge.reduce((s, f) => s + f.bytes, 0);
      return allCompanionsTiny && companionBytes <= smallCompanionBytesMax * 2;
    };

    for (const item of orderedGroups) {
      if (canMergeIntoCurrent(currentItems, item)) {
        currentItems.push(item);
      } else {
        subBuckets.push(currentItems);
        currentItems = [item];
      }
    }
    if (currentItems.length > 0) {
      subBuckets.push(currentItems);
    }

    const priorModifiedScope = Array.isArray(step.inject_updated_repo_map_from)
      ? [...step.inject_updated_repo_map_from]
      : [];

    for (let idx = 0; idx < subBuckets.length; idx++) {
      const items = subBuckets[idx];
      const subScope = items.map(f => f.file);
      const bucketEst = items.reduce((s, f) => s + f.estTokens, 0);
      const bucketPct = ((bucketEst / maxOutputTokens) * 100).toFixed(1);
      const totalPct = ((totalEstTokens / maxOutputTokens) * 100).toFixed(1);
      const bucketDomain = items[0]?.domainGroup || step.domain || 'fullstack';
      const reasonDetail = items.length > 1
        ? `merged ${items.length} ${bucketDomain} files (est ${bucketEst}/${maxOutputTokens} tok = ${bucketPct}% < ${thresholdPctLabel}%; step total ${totalEstTokens} tok = ${totalPct}%)`
        : `split_${bucketDomain}_bucket (est ${bucketEst}/${maxOutputTokens} tok = ${bucketPct}%; step total ${totalEstTokens}/${maxOutputTokens} tok = ${totalPct}%)`;

      expanded.push({
        ...step,
        domain: subBuckets.length > 1 && bucketDomain === 'frontend' ? 'frontend' : (subBuckets.length > 1 && bucketDomain === 'backend' ? 'backend' : step.domain),
        step: stepCounter++,
        sub_scope: subScope,
        inject_updated_repo_map_from: priorModifiedScope.length > 0 ? [...priorModifiedScope] : step.inject_updated_repo_map_from,
        estimated_output_tokens: bucketEst,
        output_token_limit: maxOutputTokens,
        step_total_estimated_output_tokens: totalEstTokens,
        bucket_grouping_reason: reasonDetail
      });
      for (const f of subScope) {
        if (!priorModifiedScope.includes(f)) priorModifiedScope.push(f);
      }
    }
  }

  return expanded;
}

/**
 * 6. Dynamic Cognitive Budgeting (Adaptive Token Budget per Task):
 *    Computes task token ceiling dynamically based on active workflow step count and task complexity:
 *      Task Budget = Agent Steps Count * Base Budget Per Agent * Difficulty Multiplier
 *    Prevents premature truncation on rich multi-agent collaboration pipelines.
 */
export function computeDynamicTaskTokenBudget(task = {}, workflowSteps = [], policyConfig = {}) {
  const escalation = policyConfig.policy?.retry_and_escalation || {};
  // Calibrated from measured multi-step runs (~280k tokens for a 4-file cross-domain task with 1 retry):
  // Set per-step base to 60k so a 4-5 step task lands around ~360k-450k tokens (~1.5x-2x p90 actuals)
  // instead of an inflated 1,125,000 token ceiling.
  const baseBudgetPerAgent = escalation.base_token_budget_per_agent || 60000;

  // 1. Calculate active agent execution steps (Spec steps + Patch steps + Reviewer)
  const specCount = Array.isArray(workflowSteps)
    ? workflowSteps.filter(s => s && s.action === 'draft_spec').length
    : 0;
  const patchCount = Array.isArray(workflowSteps)
    ? Math.max(1, workflowSteps.filter(s => s && s.action === 'apply_patch').length)
    : 1;
  const hasReviewer = task.mode !== 'quick' && policyConfig.policy?.approval_gates?.require_code_review !== false;
  const agentCount = specCount + patchCount + (hasReviewer ? 1 : 0);

  // 2. Difficulty multiplier according to risk level and scope size
  const scopeFiles = Array.isArray(task.scope) ? task.scope.length : 1;
  const risk = String(task.risk_level || 'low').toLowerCase();

  let difficultyMultiplier = 1.0;
  if (risk === 'critical') {
    difficultyMultiplier = 1.6;
  } else if (risk === 'high') {
    difficultyMultiplier = 1.4;
  } else if (risk === 'medium' || scopeFiles >= 3) {
    difficultyMultiplier = 1.25;
  }

  // Large scope file count booster
  if (scopeFiles >= 6 && difficultyMultiplier < 1.5) {
    difficultyMultiplier = 1.5;
  } else if (scopeFiles >= 4 && difficultyMultiplier < 1.25) {
    difficultyMultiplier = 1.25;
  }

  // Quick mode cap
  if (task.mode === 'quick') {
    difficultyMultiplier = Math.min(difficultyMultiplier, 1.0);
  }

  const rawDynamicBudget = Math.round(agentCount * baseBudgetPerAgent * difficultyMultiplier);
  const minFloor = escalation.token_budget_per_task || 150000;
  const baseCeiling = (risk === 'critical' || risk === 'high') ? 600000 : 480000;
  const bucketBonus = Math.max(0, patchCount - 1) * 160000;
  const defaultMaxCeiling = Math.min(1200000, baseCeiling + bucketBonus);
  const maxCeiling = escalation.max_token_budget_per_task || defaultMaxCeiling;

  return Math.min(maxCeiling, Math.max(rawDynamicBudget, minFloor));
}

export const CURRENT_ROUTING_VERSION = 2;

export function checkAndRefreshTaskRouting(task = {}, teamConfig = {}, policyConfig = {}) {
  const rawVersion = task?.routing_version;
  const parsedVersion = (
    rawVersion !== null &&
    rawVersion !== undefined &&
    rawVersion !== '' &&
    Number.isFinite(Number(rawVersion))
  ) ? Math.trunc(Number(rawVersion)) : 0;

  if (parsedVersion >= CURRENT_ROUTING_VERSION) {
    return {
      stale: false,
      routingVersion: parsedVersion,
      currentVersion: CURRENT_ROUTING_VERSION,
      recomputed: false,
      warnings: [],
      mode: task.mode || 'quick',
      risk_level: task.risk_level || 'low',
      kind: task.kind,
      kind_source: task.kind_source,
      workflow: Array.isArray(task.writer_hub_workflow) ? task.writer_hub_workflow : []
    };
  }

  const versionLabel = (rawVersion === undefined || rawVersion === null || rawVersion === '')
    ? 'missing'
    : String(rawVersion);

  if (task.manual_workflow_override) {
    return {
      stale: true,
      routingVersion: parsedVersion,
      currentVersion: CURRENT_ROUTING_VERSION,
      recomputed: false,
      warnings: [
        `Task "${task.task_id || '<unknown>'}" has stale routing_version (${versionLabel} < v${CURRENT_ROUTING_VERSION}) with manual_workflow_override=true; keeping manual workflow.`
      ],
      mode: task.mode || 'quick',
      risk_level: task.risk_level || 'low',
      kind: task.kind,
      kind_source: task.kind_source,
      workflow: Array.isArray(task.writer_hub_workflow) ? task.writer_hub_workflow : []
    };
  }

  const preservedKind = task.declared_kind
    ?? (task.kind_source && task.kind_source !== 'heuristic' ? task.kind : undefined);
  const preservedKindSource = task.declared_kind
    ? (task.kind_source === 'user' ? 'user' : 'router')
    : (task.kind_source && task.kind_source !== 'heuristic' ? task.kind_source : undefined);

  const refreshSeed = {
    ...task,
    mode: task.declared_mode || task.mode || 'quick',
    risk_level: task.declared_risk_level || task.risk_level || 'low',
    ...(preservedKind ? { kind: preservedKind, kind_source: preservedKindSource } : { kind: undefined, kind_source: undefined }),
    manual_workflow_override: false,
    writer_hub_workflow: []
  };

  const demand = analyzeTaskDemand(refreshSeed, policyConfig);
  const workflow = resolveWriterHubWorkflow(
    {
      ...refreshSeed,
      mode: demand.mode,
      risk_level: demand.riskLevel,
      kind: demand.kind,
      kind_source: demand.kindSource
    },
    teamConfig,
    policyConfig,
    task.preset || 'auto'
  );

  return {
    stale: true,
    routingVersion: parsedVersion,
    currentVersion: CURRENT_ROUTING_VERSION,
    recomputed: true,
    warnings: [
      `Task "${task.task_id || '<unknown>'}" has stale routing_version (${versionLabel} < v${CURRENT_ROUTING_VERSION}); recomputed mode="${demand.mode}", risk="${demand.riskLevel}", workflow_steps=${workflow.length}.`
    ],
    demand,
    mode: demand.mode,
    risk_level: demand.riskLevel,
    kind: demand.kind,
    kind_source: demand.kindSource,
    workflow
  };
}

/**
 * Resolves bounded Writer tool turn limit:
 * - Specs dossier already locks contracts -> max 2 turns
 * - Sliced smart window / OMITTED LINES -> max 5 turns (even in quick mode)
 * - Quick mode on full files -> 3 turns; Standard -> max 5 turns
 * Never inflates to 8-10 turns; token budget brake (`writerBucketBudget`) remains the primary limiter.
 */
export function resolveCoderMaxTurns({
  hasSpecsDossier = false,
  mode = 'quick',
  windowMode = 'full',
  hasOmittedLines = false
} = {}) {
  if (hasSpecsDossier) return 2;
  if (String(windowMode || '').toLowerCase() === 'smart' || Boolean(hasOmittedLines)) {
    return 5;
  }
  return String(mode || '').toLowerCase() === 'quick' ? 3 : 5;
}
