import { computeDeterministicRisk } from '../applier.mjs';

export const RISK_LEVEL_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  ultra: 4
};

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

export function validateConfig(teamCfg = {}, policyCfg = {}, projectCfg = {}) {
  const errors = [];
  if (!teamCfg?.providers?.local_9router?.base_url) {
    errors.push('team.yaml: missing providers.local_9router.base_url');
  }
  if (!teamCfg?.roles?.writer?.model) {
    errors.push('team.yaml: missing roles.writer.model');
  }
  const allowedDirs = projectCfg?.project?.allowed_dirs;
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    errors.push('project.yaml: project.allowed_dirs must be a non-empty array');
  }
  const maxFiles = policyCfg?.policy?.scope_control?.max_files_per_task;
  if (typeof maxFiles !== 'number' || maxFiles <= 0) {
    errors.push('policy.yaml: policy.scope_control.max_files_per_task must be a positive number');
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
