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

  if (task.force_ai_review === true) {
    return true;
  }

  // Anti-Self-Review Invariant (SPEC Section 3.6.3 Rule 3):
  // If the Reviewer model is identical to the Writer model that produced the patch, skip redundant self-review.
  const writerModel = activeWriterModel
    || task.model
    || roles?.writer?.default_model
    || roles?.writer?.model
    || (Array.isArray(roles?.writer?.models) ? roles.writer.models[0] : null);

  if (reviewerModel && writerModel && reviewerModel === writerModel) {
    return false;
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
  '**/ui_*/**',
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
  '**/test_*.*'
];

// Unicode-safe boundary regex (supports NFC Vietnamese diacritics & English UI keywords)
export const UI_INTENT_REGEX = /(?<![\p{L}\p{N}_])(ui|ux|layout|css|style|theme|dark\s*mode|light\s*mode|responsive|modal|button|dialog|animation|visual|giao\s*diện|bố\s*cục|màu\s*sắc|hiển\s*thị)(?![\p{L}\p{N}_])/iu;

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
 * 1. Partitions task.scope into project-agnostic domain buckets:
 *    - frontendScope: UI, markup, styles, components
 *    - backendScope: logic, API, services, CLI, tests
 *    - testScope: subset of files matching test patterns
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

  for (const rawFile of (Array.isArray(scope) ? scope : [])) {
    const file = String(rawFile || '').trim().replace(/\\/g, '/');
    if (!file) continue;

    const isTest = testPatterns.some(pat => matchesDomainPattern(file, pat));
    if (isTest) {
      testScope.push(file);
    }

    // Test files belong to backend/verification bucket unless they are pure markup/stylesheets
    const isPureStyleOrMarkup = /\.(html|htm|css|scss|sass|less)$/i.test(file);
    const isFrontend = (!isTest || isPureStyleOrMarkup) && frontendPatterns.some(pat => matchesDomainPattern(file, pat));

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
  const hasBackend = backendScope.length > 0;
  const hasFrontend = frontendScope.length > 0;
  const hasTests = testScope.length > 0;
  const isCrossDomain = hasBackend && hasFrontend;

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
  const hasUiIntent = UI_INTENT_REGEX.test(goalText);

  const needsDesignSpec = mode !== 'consult' && (
    hasVisualInput ||
    (hasFrontend && (mode === 'standard' || hasUiIntent || riskLevel === 'high' || riskLevel === 'critical'))
  );

  const needsTechSpec = mode !== 'consult' && (
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
    mode,
    riskLevel,
    backendScope,
    frontendScope,
    testScope,
    hasBackend,
    hasFrontend,
    hasTests,
    isCrossDomain,
    hasVisualInput,
    hasUiIntent,
    needsDesignSpec,
    needsTechSpec,
    needsCodeReview
  };
}

/**
 * 3. Extracts available squad roles & models from team.yaml.
 */
export function resolveSquadRoster(teamConfig = {}, task = {}) {
  const roles = teamConfig?.roles || {};
  const getRoleModel = (roleCfg) => {
    if (!roleCfg || roleCfg.enabled === false) return null;
    return roleCfg.default_model
      || roleCfg.model
      || (Array.isArray(roleCfg.models) && roleCfg.models.length > 0 ? roleCfg.models[0] : null);
  };

  const primaryWriterModel = task.model || getRoleModel(roles.backend_writer) || getRoleModel(roles.writer);

  let frontendWriterModel = task.model || getRoleModel(roles.frontend_writer) || null;
  const frontendWriterRole = (roles.frontend_writer?.enabled !== false && getRoleModel(roles.frontend_writer))
    ? 'frontend_writer'
    : 'writer';

  if (!frontendWriterModel && Array.isArray(roles.writer?.models) && roles.writer.models.length > 1) {
    const uiCapableCandidate = roles.writer.models.find(
      m => m !== primaryWriterModel && /(gemini|claude|sonnet|gpt-4o|vision|frontend|ui)/i.test(String(m))
    );
    frontendWriterModel = uiCapableCandidate || roles.writer.models.find(m => m !== primaryWriterModel) || roles.writer.models[1];
  }
  if (!frontendWriterModel) {
    frontendWriterModel = primaryWriterModel;
  }

  const designerModel = getRoleModel(roles.designer);

  // TechLead for Pre-Code Spec (priority: architect -> techlead -> reviewer -> router)
  let techSpecRole = null;
  let techSpecModel = null;
  for (const candidate of ['architect', 'techlead', 'reviewer', 'router']) {
    const m = getRoleModel(roles[candidate]);
    if (m) {
      techSpecRole = candidate;
      techSpecModel = m;
      break;
    }
  }

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
export function resolveWriterHubWorkflow(task = {}, teamConfig = {}, policyConfig = {}, preset = 'auto') {
  if (Array.isArray(task.writer_hub_workflow) && task.writer_hub_workflow.length > 0 && task.manual_workflow_override) {
    return task.writer_hub_workflow;
  }

  const demand = analyzeTaskDemand(task, policyConfig);
  if (demand.mode === 'consult') return [];

  const roster = resolveSquadRoster(teamConfig, task);
  if (!roster.backendWriterModel) return [];

  const workflow = [];
  let stepCounter = 1;
  const generatedSpecArtifacts = [];

  const activeWriterModels = new Set([
    ...(demand.hasBackend || !demand.hasFrontend ? [roster.backendWriterModel] : []),
    ...(demand.hasFrontend ? [roster.frontendWriterModel] : [])
  ]);
  const isSameAsAllWriters = (modelId) => Boolean(modelId && activeWriterModels.size === 1 && activeWriterModels.has(modelId));

  // --- STEP 1: PRE-CODE SPECIFICATIONS (TECH SPEC / DESIGN SPEC) ---
  if (preset !== 'fast') {
    // Pure UI tasks with an active Designer only need DesignSpec pre-code;
    // TechSpec pre-code runs when the task has backend scope OR when no Designer is available.
    const wantTechSpec = preset === 'architect' || (demand.needsTechSpec && (demand.hasBackend || ! roster.designerModel));
    const wantDesignSpec = demand.needsDesignSpec;

    const canRunTechSpec = Boolean(wantTechSpec && roster.techSpecModel && !isSameAsAllWriters(roster.techSpecModel));
    const canRunDesignSpec = Boolean(wantDesignSpec && roster.designerModel && !isSameAsAllWriters(roster.designerModel));

    if (canRunTechSpec && canRunDesignSpec) {
      if (roster.techSpecModel === roster.designerModel) {
        // Auto-Collapse: TechLead and Designer share the exact same model -> 1 unified spec call
        const combinedArtifact = `artifacts/${task.task_id || 'task'}_unified_spec.md`;
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
        if (demand.hasBackend || demand.needsTechSpec) {
          techArtifact = `artifacts/${task.task_id || 'task'}_tech_spec.md`;
          workflow.push({
            step: stepCounter++,
            role: roster.techSpecRole,
            model: roster.techSpecModel,
            action: 'draft_spec',
            spec_focus: 'architecture_and_contracts',
            output_artifact: techArtifact,
            allow_skip_spec: preset !== 'architect'
          });
          generatedSpecArtifacts.push(techArtifact);
        }
        const designArtifact = `artifacts/${task.task_id || 'task'}_design_spec.md`;
        workflow.push({
          step: stepCounter++,
          role: 'designer',
          model: roster.designerModel,
          action: 'draft_spec',
          spec_focus: 'ui_ux_and_visual_audit',
          inputs: techArtifact ? [techArtifact] : [],
          output_artifact: designArtifact,
          allow_skip_spec: !demand.hasVisualInput
        });
        generatedSpecArtifacts.push(designArtifact);
      }
    } else if (canRunDesignSpec) {
      const designArtifact = `artifacts/${task.task_id || 'task'}_design_spec.md`;
      workflow.push({
        step: stepCounter++,
        role: 'designer',
        model: roster.designerModel,
        action: 'draft_spec',
        spec_focus: 'ui_ux_and_visual_audit',
        output_artifact: designArtifact,
        allow_skip_spec: !demand.hasVisualInput
      });
      generatedSpecArtifacts.push(designArtifact);
    } else if (canRunTechSpec) {
      const techArtifact = `artifacts/${task.task_id || 'task'}_tech_spec.md`;
      workflow.push({
        step: stepCounter++,
        role: roster.techSpecRole,
        model: roster.techSpecModel,
        action: 'draft_spec',
        spec_focus: 'architecture_and_contracts',
        output_artifact: techArtifact,
        allow_skip_spec: preset !== 'architect'
      });
      generatedSpecArtifacts.push(techArtifact);
    }
  }

  // --- STEP 2: CODE GENERATION BUCKETS (APPLY_PATCH) ---
  const canMergePatch = !demand.hasBackend || !demand.hasFrontend || (roster.backendWriterModel === roster.frontendWriterModel);

  if (canMergePatch) {
    const isPureFrontend = demand.hasFrontend && !demand.hasBackend;
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
      sub_scope: task.scope || [],
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
      sub_scope: demand.backendScope,
      inputs: [...generatedSpecArtifacts]
    });
    // Step 2B: Frontend Writer patches frontendScope next (with live AST signatures from backendScope)
    workflow.push({
      step: stepCounter++,
      role: roster.frontendWriterRole,
      model: roster.frontendWriterModel,
      domain: 'frontend',
      action: 'apply_patch',
      sub_scope: demand.frontendScope,
      inject_updated_repo_map_from: demand.backendScope,
      inputs: [...generatedSpecArtifacts]
    });
  }

  return workflow;
}
