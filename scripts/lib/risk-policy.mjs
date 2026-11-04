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
    strict_model_match: true
  }),
  git_hygiene: Object.freeze({
    require_clean_worktree_before_start: true,
    rollback_on_validation_fail: true,
    auto_commit_on_done: true,
    commit_message_prefix: '[AI-Task]'
  }),
  validation: Object.freeze({
    fast_checks: Object.freeze([]),
    suite_checks: Object.freeze([])
  })
});

/**
 * Deep merges user-defined policy overrides onto safe engine defaults.
 * Preserves framework invariants (e.g. consult mode cannot mutate files).
 */
export function mergePolicyWithDefaults(userPolicy = {}) {
  const user = userPolicy?.policy || userPolicy || {};
  const merged = JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG));

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
    Object.assign(merged.execution_guardrails, user.execution_guardrails);
  }

  if (user.git_hygiene && typeof user.git_hygiene === 'object') {
    Object.assign(merged.git_hygiene, user.git_hygiene);
  }

  if (user.validation && typeof user.validation === 'object') {
    merged.validation = user.validation;
  }

  return merged;
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

export function shouldRunReviewerGate(task = {}, policy = {}, roles = {}) {
  if (!roles?.reviewer || roles.reviewer.enabled === false) {
    return false;
  }
  if (task.force_ai_review === true) {
    return true;
  }
  const mode = (task.mode || '').toLowerCase();
  const modeConfig = policy.task_modes?.[mode] || {};
  const skipReviewer = modeConfig.skip_router_and_reviewer ?? (mode === 'quick' || mode === 'direct' || mode === 'consult');
  const requireReview = policy.approval_gates?.require_code_review ?? true;
  if (skipReviewer || !requireReview) {
    return false;
  }
  const minRisk = String(policy.approval_gates?.review_min_risk_level || 'high').toLowerCase();
  const minRank = RISK_LEVEL_RANK[minRisk] || RISK_LEVEL_RANK.high;
  const taskRisk = resolveEffectiveRisk(task);
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
  const envKeyName = teamCfg?.providers?.local_9router?.api_key_env || 'NINE_ROUTER_API_KEY';
  return process.env[envKeyName] || teamCfg?.providers?.local_9router?.default_key || 'sk-default';
}

export function validateConfig(teamCfg = {}, policyCfg = {}, projectCfg = null) {
  const errors = [];
  if (!teamCfg?.providers?.local_9router?.base_url) {
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

export function verifyResponseModel(requestedModel = '', responseModel = 'unknown') {
  const reqRaw = String(requestedModel || '').trim();
  const resRaw = String(responseModel || '').trim();
  if (!resRaw || resRaw === 'unknown') {
    return {
      match: false,
      reason: `Upstream response omitted data.model (got "unknown" for requested "${reqRaw}")`
    };
  }
  const norm = s => s.toLowerCase().split('/').pop().replace(/[._-]+/g, '-').trim();
  const reqSlug = norm(reqRaw);
  const resSlug = norm(resRaw);
  if (
    reqRaw.toLowerCase() === resRaw.toLowerCase() ||
    (reqSlug && resSlug && (reqSlug === resSlug || resSlug.includes(reqSlug) || reqSlug.includes(resSlug)))
  ) {
    return { match: true, reason: null };
  }
  return {
    match: false,
    reason: `Requested model "${reqRaw}" but upstream responded with "${resRaw}"`
  };
}
