#!/usr/bin/env node
/**
 * Agent Runtime Core Entrypoint (Standalone CLI & Programmatic API)
 * Part of Agent Runtime (agent-team/runtime/index.mjs)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveRepoRoot } from '../scripts/applier.mjs';
import { loadProjectConventions } from '../scripts/lib/context-builders.mjs';
import { loadMergedPolicy, loadMergedTeamConfig, resolveConfigDir } from '../scripts/lib/policy-loader.mjs';
import { buildUserMessage } from './context-adapter.mjs';
import {
  BudgetExceededError,
  assertBudgetBeforeCall,
  callModelEndpoint,
  estimateRequestPromptTokens,
  estimateTextTokens,
  getModelCapabilities,
  isBudgetExceededError,
  shouldRetryFailure
} from './provider-gateway.mjs';

export { BudgetExceededError, assertBudgetBeforeCall, estimateRequestPromptTokens, isBudgetExceededError, shouldRetryFailure };
import {
  archivePriorTaskSessions,
  buildTaskStepSessionId,
  compactMessagesForContext,
  createTaskRunId,
  estimatePayloadTokens,
  loadSession,
  saveSession
} from './session-store.mjs';
export { archivePriorTaskSessions, buildTaskStepSessionId, createTaskRunId };
import { executeTool, getAvailableToolSchemas, MAX_BATCH_READ_BYTES } from './tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');
export const ROLES_DIR = path.resolve(TEAM_DIR, 'roles');
export const CONFIG_FILE = path.resolve(TEAM_DIR, 'config', 'team.yaml');

export const MAX_AGENT_TOOL_TURNS = 12; // Standalone CLI safety ceiling (Orchestrator Writer clamps to 2-5 turns via resolveCoderMaxTurns)

/**
 * Strips verbose inline <think>...</think> tags from older assistant turns,
 * preserving thought_signature for model reasoning continuity while saving 70% context.
 * SPEC Section 3.2.
 */
export function stripOldInlineThinking(messages = [], keepRecentTurns = 1) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const assistantIndices = [];
  for (let idx = 0; idx < messages.length; idx++) {
    if (messages[idx]?.role === 'assistant') {
      assistantIndices.push(idx);
    }
  }
  const cutoffIdx = assistantIndices.length > keepRecentTurns
    ? assistantIndices[assistantIndices.length - keepRecentTurns]
    : -1;

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (msg?.role === 'assistant' && idx < cutoffIdx && typeof msg.content === 'string') {
      if (/<think>[\s\S]*?<\/think>/i.test(msg.content)) {
        msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      }
    }
  }
  return messages;
}

/**
 * Loads team role & provider configuration from team.yaml.
 * Enforces fail-fast role isolation:
 * - Disabled roles (enabled: false) return enabled: false and model: null (never substituted).
 * - Missing models on specialized roles return null (never silently replaced with writer's model).
 * - fallback_model strictly uses roleCfg.fallback_model (never falls back to another role's model).
 */
export function loadRoleConfig(roleName = 'designer', customTeamCfg = null, options = {}) {
  const hasExplicitCfgDir = Boolean(options.configDir || process.env.AGENT_TEAM_CONFIG_DIR);
  const cfgDir = resolveConfigDir(options.configDir);
  const teamCfg = customTeamCfg || loadMergedTeamConfig({
    configDir: cfgDir,
    teamFile: hasExplicitCfgDir ? undefined : CONFIG_FILE
  });

  const providerCfg = teamCfg.providers?.local_9router || {};
  const baseUrl = providerCfg.base_url || 'http://127.0.0.1:20128/v1';
  const envName = providerCfg.api_key_env || 'NINE_ROUTER_API_KEY';
  const apiKey = (process.env[envName] && process.env[envName].trim())
    ? process.env[envName].trim()
    : (providerCfg.default_key || 'sk-default');

  const roles = teamCfg.roles || {};
  const writerCfg = roles.writer || {};
  const isWriterAlias = roleName === 'backend_writer' || roleName === 'frontend_writer';
  const roleCfg = roles[roleName] || (isWriterAlias ? writerCfg : {});

  // Resolve default tools by role archetype:
  // - writer/designer survey codebase via read-only tools, emitting SEARCH/REPLACE blocks for single-gatekeeper Orchestrator Applier.
  // - run_command and apply_patch are excluded from writer to avoid Double-Apply conflicts and preserve Applier guardrails.
  let defaultTools = ['read_file', 'list_files', 'search_code', 'get_repo_map'];
  if (roleName === 'debugger') {
    defaultTools = ['read_file', 'list_files', 'search_code', 'get_repo_map', 'run_validator'];
  }

  const isEnabled = roleCfg.enabled !== false;
  let firstArrayModel = null;
  if (Array.isArray(roleCfg.models)) {
    for (const entry of roleCfg.models) {
      if (typeof entry === 'string' && entry.trim()) {
        firstArrayModel = entry.trim();
        break;
      }
      if (entry && typeof entry === 'object' && entry.disabled !== true) {
        const id = String(entry.id || entry.model || '').trim();
        if (id) {
          firstArrayModel = id;
          break;
        }
      }
    }
  }
  const rawModelCandidate = isEnabled
    ? (roleCfg.model || roleCfg.default_model || firstArrayModel || null)
    : null;
  const resolvedModel = rawModelCandidate ? String(rawModelCandidate).trim() || null : null;

  return {
    name: roleName,
    enabled: isEnabled,
    display_name: roleCfg.display_name || roleName,
    model: resolvedModel,
    fallback_model: isEnabled ? (roleCfg.fallback_model || null) : null,
    allowed_tools: roleCfg.allowed_tools || defaultTools,
    allowed_scope: roleCfg.allowed_scope || [],
    temperature: roleCfg.temperature ?? 0.2,
    base_url: baseUrl,
    api_key: apiKey
  };
}

/**
 * Loads system prompt markdown for role and appends selectively filtered host project conventions
 * (placed inside system prompt to leverage Cache Breakpoint #2).
 */
export function loadRoleSystemPrompt(roleName, repoRoot = null, options = {}) {
  const roleFile = path.resolve(ROLES_DIR, `${roleName}.md`);
  let basePrompt = `You are a specialized ${roleName} agent operating within a software repository. You have access to tools to inspect files and propose exact modifications.`;
  if (fs.existsSync(roleFile)) {
    try {
      basePrompt = fs.readFileSync(roleFile, 'utf8');
    } catch {}
  }

  if (repoRoot) {
    const conventions = loadProjectConventions(repoRoot, {
      role: roleName,
      projectRulesFiles: options.projectRulesFiles || null
    });
    if (conventions) {
      return `${basePrompt.trim()}\n\n${conventions}`;
    }
  }
  return basePrompt;
}

/**
 * Programmatic API: Runs a complete standalone agent loop with vision, tools, and session memory.
 */
export async function runAgent(options = {}) {
  const {
    role = 'designer',
    sessionId = null,
    prompt = '',
    images = [],
    files = [],
    scope = [],
    model = null,
    modelOverride = null,
    fallbackModel = undefined,
    timeoutMs = 180000,
    repoRoot = resolveRepoRoot(),
    maxTurns = MAX_AGENT_TOOL_TURNS,
    maxTokens = 16384,
    maxThinkingTokens = null,
    disableTools = false,
    maxTokenBudget = null,
    budgetLimit = null,
    systemPromptOverride = null,
    baseUrlOverride = null,
    apiKeyOverride = null,
    sessionsDir = null,
    fetchFn = null,
    stream = undefined,
    silenceTimeoutMs = undefined,
    firstByteTimeoutMs = undefined,
    priorReadRanges = [],
    maxBatchReadBytes = null
  } = options;

  if (!prompt && images.length === 0 && files.length === 0) {
    return { ok: false, error: 'Prompt or attachments are required to run agent' };
  }

  // 1. Resolve Role Config (Fail-fast if role is disabled or lacks a model)
  const roleConfig = loadRoleConfig(role, null, { configDir: options.configDir });
  if (roleConfig.enabled === false) {
    return {
      ok: false,
      error: `Role "${role}" is disabled in team.yaml (enabled: false). Stopping execution instead of falling back.`
    };
  }
  const effectiveBaseUrl = baseUrlOverride || roleConfig.base_url;
  const effectiveApiKey = apiKeyOverride || roleConfig.api_key;
  const activeModel = String(modelOverride || model || roleConfig.model || '').trim();
  const effectiveRuntimeFallback = fallbackModel === undefined ? roleConfig.fallback_model : fallbackModel;
  if (!activeModel) {
    return {
      ok: false,
      error: `Role "${role}" has no model configured in team.yaml. Stopping execution.`
    };
  }
  const capabilities = getModelCapabilities(activeModel);

  // Load scope guardrails (protected_files & allowed_dirs) from merged policy.yaml + policy.local.yaml (fail-closed)
  const mergedPolicy = loadMergedPolicy({ configDir: options.configDir });
  const sc = mergedPolicy.policy.scope_control;
  const policyProtectedFiles = Array.isArray(sc.protected_files) ? sc.protected_files : [];
  const policyAllowedDirs = sc.allowed_dirs;
  const policyContextExclude = Array.isArray(sc.context_exclude) ? sc.context_exclude : [];
  const guardrailsCfg = mergedPolicy.policy.execution_guardrails || {};
  const effectiveSilenceTimeoutMs = silenceTimeoutMs !== undefined
    ? silenceTimeoutMs
    : (Number(guardrailsCfg.max_silence_duration_sec) > 0 ? Number(guardrailsCfg.max_silence_duration_sec) * 1000 : null);
  const circuitBreakerTtlMs = Number(guardrailsCfg.circuit_breaker_ttl_ms) > 0
    ? Number(guardrailsCfg.circuit_breaker_ttl_ms)
    : (Number(guardrailsCfg.circuit_breaker_ttl_sec) > 0 ? Number(guardrailsCfg.circuit_breaker_ttl_sec) * 1000 : 600000);
  const effectiveMaxBatchReadBytes = (Number.isFinite(Number(maxBatchReadBytes)) && Number(maxBatchReadBytes) > 0)
    ? Math.floor(Number(maxBatchReadBytes))
    : (Number(guardrailsCfg.max_batch_read_bytes) > 0 ? Math.floor(Number(guardrailsCfg.max_batch_read_bytes)) : MAX_BATCH_READ_BYTES);

  // 2. Load or Restore Session
  const session = loadSession(sessionId, role, activeModel, { sessionsDir });
  const sessionSafeId = session.session_id;

  // 3. Prepare System Prompt (Role Prompt + Selective Host Project Conventions) & Tool Schemas
  const systemPromptText = systemPromptOverride
    ? `${String(systemPromptOverride).trim()}\n\n${loadProjectConventions(repoRoot, { role })}`.trim()
    : loadRoleSystemPrompt(role, repoRoot);
  const promptVersion = crypto.createHash('sha1').update(systemPromptText).digest('hex').slice(0, 8);
  const toolSchemas = disableTools ? [] : getAvailableToolSchemas(roleConfig.allowed_tools);

  // 4. Build User Message Payload (with Vision / Text File Attachments)
  let userMessage;
  try {
    userMessage = buildUserMessage({
      prompt,
      images,
      files,
      repoRoot,
      modelCapabilities: capabilities
    });
  } catch (attErr) {
    return { ok: false, error: `Context adapter error: ${attErr.message}` };
  }

  // Assemble message history with atomic turn-preserving compaction (using Epoch Watermark to preserve KV Cache)
  const history = compactMessagesForContext(session.messages || [], 2, {
    useEpochWatermark: true,
    tools: toolSchemas
  });
  const messages = [
    { role: 'system', content: systemPromptText },
    ...history,
    userMessage
  ];

  // Token budget estimation & transparency logging (includes tool schemas & normalized vision blocks)
  const estTotalTokens = estimatePayloadTokens(messages, toolSchemas);
  const sysTokens = estimateTextTokens(systemPromptText.length);
  const userTokens = estimatePayloadTokens([userMessage], []);
  const histTokens = estimatePayloadTokens(history, []);
  const toolTokens = estimatePayloadTokens([], toolSchemas);
  console.log(`[Context Budget] Payload: ~${estTotalTokens} est. tokens (System: ${sysTokens} | Tools: ${toolTokens} | History: ${histTokens} | User: ${userTokens}) for role="${role}"`);

  // 5. Bounded Tool Execution Loop
  const runStartMs = Date.now();
  let currentTurn = 0;
  const turnReceipts = [];
  const turnUsages = [];
  const accumulatedPatches = [];
  let capturedReadRanges = mergeReadRanges([], priorReadRanges);
  const newAttemptReadRanges = [];
  let finalContent = '';
  let modelUsed = null;
  let actualModel = null;
  let fallbackActivated = false;
  let fallbackReason = null;
  let finishReason = 'stop';
  let maxTokensSent = 16384;
  let endpointUsed = effectiveBaseUrl;
  let anyCacheReported = false;
  let cacheLost = false;

  const accumulatedUsage = {
    prompt_tokens: 0,
    prompt_tokens_raw: 0,
    prompt_tokens_adjusted: 0,
    usage_adjusted_buffer: 0,
    fresh_tokens: 0,
    uncached_input_tokens: 0,
    cached_tokens: 0,
    cache_reported: false,
    reported_cached_tokens: null,
    completion_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    total_tokens_adjusted: 0,
    cache_hit_ratio: 0
  };

  // Pre-Call Token Brake before Turn 1: refuse to call model if estimated input already exceeds step/task budget
  if (maxTokenBudget != null && maxTokenBudget > 0 && estTotalTokens > maxTokenBudget) {
    return {
      ok: false,
      budget_exceeded: true,
      requested_model: activeModel,
      actual_model: null,
      fallback_activated: false,
      fallback_reason: null,
      prompt_version: promptVersion,
      error: `Pre-call token brake triggered for role="${role}": estimated Turn 1 input (${estTotalTokens} tokens) exceeds remaining step/task budget (${maxTokenBudget} tokens).`,
      session_id: sessionSafeId,
      usage: accumulatedUsage,
      raw_usage: null
    };
  }

  while (currentTurn < maxTurns) {
    currentTurn++;

    // SPEC Section 3.2: Strip verbose inline thinking from older assistant turns before sending
    stripOldInlineThinking(messages, 1);

    // Pre-Call Token Brake on subsequent tool turns: stop looping if another turn would blow past maxTokenBudget
    if (currentTurn > 1 && maxTokenBudget != null && maxTokenBudget > 0) {
      const nextTurnEst = estimatePayloadTokens(messages, toolSchemas);
      const effectiveUsed = accumulatedUsage.total_tokens_adjusted || accumulatedUsage.total_tokens;
      if (effectiveUsed + nextTurnEst > maxTokenBudget) {
        console.warn(`[Token Brake] Role "${role}" turn ${currentTurn} would exceed step budget (${effectiveUsed} + ~${nextTurnEst} > ${maxTokenBudget}). Breaking tool loop early to synthesize.`);
        currentTurn--;
        break;
      }
    }

    const stepUsedTokens = accumulatedUsage.fresh_tokens || accumulatedUsage.total_tokens_adjusted || 0;
    const callRes = await callModelEndpoint({
      model: activeModel,
      fallbackModel: effectiveRuntimeFallback,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : null,
      temperature: roleConfig.temperature,
      maxTokens,
      timeoutMs,
      baseUrl: effectiveBaseUrl,
      apiKey: effectiveApiKey,
      maxThinkingTokens,
      fetchFn,
      circuitBreakerTtlMs,
      ...(budgetLimit != null ? { budgetState: { used: stepUsedTokens, limit: budgetLimit, kind: 'run_agent_budget' } } : {}),
      ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
      ...(stream !== undefined ? { stream } : {}),
      ...(effectiveSilenceTimeoutMs ? { silenceTimeoutMs: effectiveSilenceTimeoutMs } : {}),
      ...(firstByteTimeoutMs ? { firstByteTimeoutMs } : {})
    });

    if (!callRes.ok) {
      return {
        ok: false,
        requested_model: activeModel,
        actual_model: actualModel,
        fallback_activated: Boolean(callRes.fallback_activated || fallbackActivated),
        fallback_reason: callRes.fallback_reason || fallbackReason,
        prompt_version: promptVersion,
        error: `Agent call failed on turn ${currentTurn}: ${callRes.error}`,
        session_id: sessionSafeId,
        usage: accumulatedUsage,
        raw_usage: null
      };
    }

    if (callRes.usage) {
      const turnReqModel = callRes.requested_model || activeModel;
      const turnActModel = callRes.actual_model || callRes.model_responded || callRes.model_used || activeModel;
      if (callRes.usage.cache_reported) anyCacheReported = true;
      turnUsages.push({
        turn: currentTurn,
        stage: 'tool_loop',
        model: turnActModel,
        requested_model: turnReqModel,
        actual_model: turnActModel,
        ...callRes.usage,
        raw_usage: callRes.raw_usage ?? null
      });
      accumulatedUsage.prompt_tokens += callRes.usage.prompt_tokens || 0;
      accumulatedUsage.prompt_tokens_raw += callRes.usage.prompt_tokens_raw ?? callRes.usage.prompt_tokens ?? 0;
      accumulatedUsage.prompt_tokens_adjusted += callRes.usage.prompt_tokens_adjusted ?? callRes.usage.prompt_tokens ?? 0;
      accumulatedUsage.usage_adjusted_buffer += callRes.usage.usage_adjusted_buffer || 0;
      accumulatedUsage.fresh_tokens += callRes.usage.fresh_tokens ?? callRes.usage.uncached_input_tokens ?? 0;
      accumulatedUsage.uncached_input_tokens += callRes.usage.uncached_input_tokens || 0;
      accumulatedUsage.cached_tokens += callRes.usage.cached_tokens || 0;
      accumulatedUsage.completion_tokens += callRes.usage.completion_tokens || 0;
      accumulatedUsage.reasoning_tokens += callRes.usage.reasoning_tokens || 0;
      accumulatedUsage.total_tokens += callRes.usage.total_tokens || 0;
      accumulatedUsage.total_tokens_adjusted += callRes.usage.total_tokens_adjusted ?? callRes.usage.total_tokens ?? 0;
    }

    modelUsed = callRes.model_used;
    actualModel = callRes.actual_model || callRes.model_responded || callRes.model_used;
    if (callRes.fallback_activated) {
      fallbackActivated = true;
      fallbackReason = callRes.fallback_reason || fallbackReason;
    }
    finishReason = callRes.finish_reason || finishReason;
    maxTokensSent = callRes.max_tokens_sent || maxTokensSent;
    endpointUsed = callRes.endpoint || endpointUsed;
    const toolCalls = callRes.tool_calls || [];

    // Push assistant response to conversational trajectory, preserving thought_signature
    const assistantMsg = {
      role: 'assistant',
      content: callRes.content || '',
      ...(callRes.reasoning_content ? { reasoning_content: callRes.reasoning_content } : {}),
      ...(callRes.thought_signature ? { thought_signature: callRes.thought_signature } : {}),
      ...(callRes.thinking_blocks ? { thinking_blocks: callRes.thinking_blocks } : {})
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        },
        ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
        ...(tc.provider_specific_fields ? { provider_specific_fields: tc.provider_specific_fields } : {})
      }));
    }
    messages.push(assistantMsg);

    // If no tool calls, model provided final response
    if (toolCalls.length === 0) {
      finalContent = callRes.content || '';
      break;
    }

    // Execute tool calls: run read-only batches concurrently in the same turn, mutating calls sequentially
    const READ_ONLY_TOOLS = new Set(['read_file', 'search_code', 'list_files']);
    const isAllReadOnly = toolCalls.length > 1 && toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.name));

    const runSingleTool = async (tc, idx) => {
      const toolContext = {
        role,
        sessionId: sessionSafeId,
        repoRoot,
        configDir: options.configDir,
        allowedTools: roleConfig.allowed_tools,
        allowedScope: scope.length > 0 ? scope : roleConfig.allowed_scope,
        protectedFiles: policyProtectedFiles,
        allowedDirs: policyAllowedDirs,
        contextExclude: policyContextExclude
      };
      if (tc.name === 'apply_patch' && tc.arguments?.patch) {
        accumulatedPatches.push(tc.arguments.patch);
      }
      const execResult = await executeTool(tc.name, tc.arguments, toolContext);
      return { tc, idx, execResult };
    };

    const executedBatch = isAllReadOnly
      ? (await Promise.all(toolCalls.map((tc, idx) => runSingleTool(tc, idx)))).sort((a, b) => a.idx - b.idx)
      : await (async () => {
          const seq = [];
          for (let idx = 0; idx < toolCalls.length; idx++) {
            seq.push(await runSingleTool(toolCalls[idx], idx));
          }
          return seq;
        })();

    let batchReadBytesUsed = 0;
    for (const { tc, execResult } of executedBatch) {
      let effectiveExecResult = execResult;
      if (tc.name === 'read_file' && execResult?.ok && execResult.file) {
        const remainingBatchBytes = Math.max(0, effectiveMaxBatchReadBytes - batchReadBytesUsed);
        const capped = capBatchReadResult(execResult, remainingBatchBytes, effectiveMaxBatchReadBytes);
        effectiveExecResult = capped.cappedResult;
        batchReadBytesUsed += capped.consumedBytes;
        if (capped.capturedRange) {
          capturedReadRanges = mergeReadRanges(capturedReadRanges, [capped.capturedRange]);
          newAttemptReadRanges.push(capped.capturedRange);
        }
      }

      const receipt = {
        turn: currentTurn,
        tool: tc.name,
        call_id: tc.id,
        status: effectiveExecResult.ok ? 'ok' : 'error',
        summary: effectiveExecResult.ok
          ? (effectiveExecResult.total || effectiveExecResult.count || `${effectiveExecResult.file || 'done'}:${effectiveExecResult.start_line || ''}-${effectiveExecResult.end_line || ''}`)
          : effectiveExecResult.error
      };
      turnReceipts.push(receipt);
      session.tool_receipts.push(receipt);

      const remainingTurns = maxTurns - currentTurn;
      const turnNotice = remainingTurns > 1
        ? `[Turn ${currentTurn}/${maxTurns} — Còn ${remainingTurns} lượt tool]`
        : remainingTurns === 1
          ? `[Turn ${currentTurn}/${maxTurns} — ⚠️ CÒN 1 LƯỢT TOOL CUỐI CÙNG! Hãy hoàn tất khảo sát để chuẩn bị xuất kết quả]`
          : `[Turn ${currentTurn}/${maxTurns} — 🛑 LƯỢT TOOL CUỐI CÙNG! Lượt kế tiếp BẮT BUỘC xuất kết quả]`;

      const payloadToSend = (effectiveExecResult && typeof effectiveExecResult === 'object')
        ? { ...effectiveExecResult, _turn_notice: turnNotice }
        : { result: effectiveExecResult, _turn_notice: turnNotice };

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(payloadToSend)
      });
    }
  }

  const finalizeUsageStats = () => {
    accumulatedUsage.cache_reported = anyCacheReported;
    accumulatedUsage.reported_cached_tokens = anyCacheReported ? accumulatedUsage.cached_tokens : null;
    if (turnUsages.some(t => t.usage_quality === 'degraded')) {
      accumulatedUsage.usage_quality = 'degraded';
      if (!anyCacheReported) accumulatedUsage.cached_tokens = null;
    } else if (turnUsages.some(t => t.usage_quality === 'full')) {
      accumulatedUsage.usage_quality = 'full';
    }
    const anyAdjusted = turnUsages.some(t => t.usage_adjusted === true);
    accumulatedUsage.usage_adjusted = anyAdjusted;
    const effectiveRatioDenominator = accumulatedUsage.prompt_tokens_adjusted || accumulatedUsage.prompt_tokens;
    if (effectiveRatioDenominator > 0) {
      accumulatedUsage.cache_hit_ratio = Number((((accumulatedUsage.cached_tokens ?? 0)) / effectiveRatioDenominator).toFixed(4));
    }
    const rawUsageSummary = turnUsages.length === 1
      ? (turnUsages[0].raw_usage ?? null)
      : (turnUsages.length > 1
          ? {
              turns: turnUsages.map(t => ({
                turn: t.turn,
                stage: t.stage,
                requested_model: t.requested_model,
                actual_model: t.actual_model,
                usage: t.raw_usage ?? null
              }))
            }
          : null);
    return rawUsageSummary;
  };

  const recordTurnUsage = (resObj, stageLabel, turnNum, extraTurnFields = {}) => {
    if (!resObj) return;
    modelUsed = resObj.model_used || modelUsed;
    actualModel = resObj.actual_model || resObj.model_responded || resObj.model_used || actualModel;
    if (resObj.fallback_activated) {
      fallbackActivated = true;
      fallbackReason = resObj.fallback_reason || fallbackReason;
    }
    finishReason = resObj.finish_reason || finishReason;
    maxTokensSent = resObj.max_tokens_sent || maxTokensSent;
    if (resObj.usage) {
      const reqModel = resObj.requested_model || activeModel;
      const actModel = resObj.actual_model || resObj.model_responded || resObj.model_used || activeModel;
      if (resObj.usage.cache_reported) anyCacheReported = true;
      turnUsages.push({
        turn: turnNum,
        stage: stageLabel,
        model: actModel,
        requested_model: reqModel,
        actual_model: actModel,
        ...resObj.usage,
        ...extraTurnFields,
        raw_usage: resObj.raw_usage ?? null
      });
      accumulatedUsage.prompt_tokens += resObj.usage.prompt_tokens || 0;
      accumulatedUsage.prompt_tokens_raw += resObj.usage.prompt_tokens_raw ?? resObj.usage.prompt_tokens ?? 0;
      accumulatedUsage.prompt_tokens_adjusted += resObj.usage.prompt_tokens_adjusted ?? resObj.usage.prompt_tokens ?? 0;
      accumulatedUsage.usage_adjusted_buffer += resObj.usage.usage_adjusted_buffer || 0;
      accumulatedUsage.fresh_tokens += resObj.usage.fresh_tokens ?? resObj.usage.uncached_input_tokens ?? 0;
      accumulatedUsage.uncached_input_tokens += resObj.usage.uncached_input_tokens || 0;
      accumulatedUsage.cached_tokens += resObj.usage.cached_tokens || 0;
      accumulatedUsage.completion_tokens += resObj.usage.completion_tokens || 0;
      accumulatedUsage.reasoning_tokens += resObj.usage.reasoning_tokens || 0;
      accumulatedUsage.total_tokens += resObj.usage.total_tokens || 0;
      accumulatedUsage.total_tokens_adjusted += resObj.usage.total_tokens_adjusted ?? resObj.usage.total_tokens ?? 0;
    }
  };

  const buildControlledSynthesisFailure = ({ failureReason, errorMessage, unexpectedToolNames = [], budgetExceeded = false, content = '' }) => {
    const rawUsageSummary = finalizeUsageStats();
    return {
      ok: false,
      controlled_failure: true,
      failure_reason: failureReason,
      cache_lost: cacheLost,
      ...(budgetExceeded ? { budget_exceeded: true, nonRetryable: true, error_type: 'BudgetExceededError' } : { nonRetryable: true }),
      ...(unexpectedToolNames.length > 0 ? { unexpected_tool_calls: unexpectedToolNames } : {}),
      error: errorMessage,
      role,
      requested_model: activeModel,
      model_used: modelUsed,
      actual_model: actualModel || modelUsed,
      fallback_activated: fallbackActivated,
      fallback_reason: fallbackReason,
      finish_reason: finishReason,
      max_tokens_sent: maxTokensSent,
      prompt_version: promptVersion,
      endpoint: endpointUsed,
      session_id: sessionSafeId,
      turns_executed: currentTurn,
      duration_ms: Math.max(1, Date.now() - runStartMs),
      tool_receipts: turnReceipts,
      turn_usages: turnUsages,
      read_ranges: capturedReadRanges,
      content,
      usage: accumulatedUsage,
      raw_usage: rawUsageSummary
    };
  };

  // 5b. Final Synthesis Turn: If maxTurns (or token brake) reached through tool calls and finalContent is still empty,
  // KEEP `tools` identical to preserve prompt prefix caching, append a strict user no-tool instruction;
  // if model still calls tools, try ONCE with tools:null (recording cache_lost=true); if it STILL fails -> controlled_failure.
  if (!finalContent && currentTurn >= 1) {
    const synthesisPrompt = (role === 'writer' || role === 'backend_writer' || role === 'frontend_writer')
      ? 'All tool investigations are complete. Based on what you observed from the tools, immediately provide your final response containing the exact <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks to fulfill the task. Do not call any more tools.'
      : (role === 'router')
        ? 'All tool investigations are complete. Based on what you observed from the tools, you MUST now immediately output the final valid JSON array of tasks matching this schema: {"tasks": [...]}. Do not call any tools, do not attempt any tool calls, and do not output any markdown text other than the JSON block.'
        : (role === 'architect' || role === 'designer')
          ? 'All tool investigations are complete. Based on what you observed from the tools, immediately output your concise final Markdown specification matching your role contract (or SKIP_SPEC if allowed and unambiguous). Do not call any tools.'
          : 'All tool investigations are complete. Based on what you observed from the tools, please provide your final response now. Do not call any tools.';

    messages.push({
      role: 'user',
      content: synthesisPrompt
    });

    const dispatchSynthesisCall = async (toolsPayload) => {
      const usedTok = accumulatedUsage.fresh_tokens || accumulatedUsage.total_tokens_adjusted || 0;
      return callModelEndpoint({
        model: activeModel,
        fallbackModel: effectiveRuntimeFallback,
        messages,
        tools: toolsPayload,
        temperature: roleConfig.temperature,
        maxTokens,
        timeoutMs,
        baseUrl: effectiveBaseUrl,
        apiKey: effectiveApiKey,
        maxThinkingTokens,
        fetchFn,
        circuitBreakerTtlMs,
        ...(budgetLimit != null ? { budgetState: { used: usedTok, limit: budgetLimit, kind: 'run_agent_budget' } } : {}),
        ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
        ...(stream !== undefined ? { stream } : {})
      });
    };

    const synthRes = await dispatchSynthesisCall(toolSchemas.length > 0 ? toolSchemas : null);
    if (!synthRes.ok) {
      return buildControlledSynthesisFailure({
        failureReason: synthRes.budget_exceeded ? 'budget_exceeded' : 'synthesis_request_failed',
        errorMessage: synthRes.error || 'Synthesis turn request failed.',
        budgetExceeded: Boolean(synthRes.budget_exceeded)
      });
    }

    recordTurnUsage(synthRes, 'synthesis', currentTurn + 1);
    let resolvedSynthRes = synthRes;
    const unexpectedToolCalls = Array.isArray(synthRes.tool_calls) ? synthRes.tool_calls : [];

    if (unexpectedToolCalls.length > 0) {
      const firstToolNames = unexpectedToolCalls.map(tc => tc.name || tc.function?.name || tc.id || 'unknown');
      if (toolSchemas.length > 0) {
        cacheLost = true;
        console.warn(`[Synthesis] Turn ${currentTurn + 1} returned unexpected tool_calls (${firstToolNames.join(', ')}); retrying ONCE with tools: null (cache_lost=true).`);
        const noToolsRetryRes = await dispatchSynthesisCall(null);
        if (!noToolsRetryRes.ok) {
          return buildControlledSynthesisFailure({
            failureReason: noToolsRetryRes.budget_exceeded ? 'budget_exceeded' : 'synthesis_no_tools_fallback_failed',
            errorMessage: noToolsRetryRes.error || `Synthesis tools:null fallback failed after unexpected tool_calls (${firstToolNames.join(', ')}).`,
            budgetExceeded: Boolean(noToolsRetryRes.budget_exceeded),
            unexpectedToolNames: firstToolNames
          });
        }
        recordTurnUsage(noToolsRetryRes, 'synthesis_no_tools_fallback', currentTurn + 2, { cache_lost: true });
        const retryUnexpected = Array.isArray(noToolsRetryRes.tool_calls) ? noToolsRetryRes.tool_calls : [];
        if (retryUnexpected.length > 0) {
          const retryNames = retryUnexpected.map(tc => tc.name || tc.function?.name || tc.id || 'unknown');
          return buildControlledSynthesisFailure({
            failureReason: 'synthesis_unexpected_tool_call',
            errorMessage: `Synthesis returned unexpected tool_calls (${firstToolNames.join(', ')}) and tools:null retry STILL returned tool_calls (${retryNames.join(', ')}); controlled failure without further retries.`,
            unexpectedToolNames: retryNames,
            content: noToolsRetryRes.content || ''
          });
        }
        resolvedSynthRes = noToolsRetryRes;
      } else {
        return buildControlledSynthesisFailure({
          failureReason: 'synthesis_unexpected_tool_call',
          errorMessage: `Synthesis turn returned ${firstToolNames.length} unexpected tool call(s) (${firstToolNames.join(', ')}) despite no tools supplied; failing controllably.`,
          unexpectedToolNames: firstToolNames,
          content: synthRes.content || ''
        });
      }
    }

    finalContent = resolvedSynthRes.content || '';
    messages.push({
      role: 'assistant',
      content: finalContent
    });
  }

  // Fallback patch preservation: if writer applied patches via apply_patch tool but finalContent lacks search/replace blocks,
  // append the accumulated patches so downstream Orchestrator Applier & Git Guard can inspect and record the diff.
  if ((role === 'writer' || role === 'backend_writer') && accumulatedPatches.length > 0) {
    if (!finalContent.includes('<<<<<<< SEARCH')) {
      finalContent = (finalContent ? `${finalContent}\n\n` : '') + accumulatedPatches.join('\n\n');
    }
  }

  const rawUsageSummary = finalizeUsageStats();
  const durationMs = Math.max(1, Date.now() - runStartMs);

  // 6. Update & Persist Session (Save trajectory + usage telemetry on top of active Epoch Checkpoint)
  const newMessages = messages.slice(1 + history.length);
  session.messages = [...history, ...newMessages];
  session.model = modelUsed;
  session.requested_model = activeModel;
  session.actual_model = actualModel || modelUsed;
  session.fallback_activated = fallbackActivated;
  session.fallback_reason = fallbackReason;
  session.finish_reason = finishReason;
  session.max_tokens_sent = maxTokensSent;
  session.prompt_version = promptVersion;
  session.usage = { ...accumulatedUsage };
  session.raw_usage = rawUsageSummary;
  session.turn_usages = turnUsages;
  session.turns_executed = currentTurn;
  session.cache_lost = cacheLost;
  session.duration_ms = durationMs;
  saveSession(session, { sessionsDir });

  return {
    ok: true,
    role,
    requested_model: activeModel,
    model_used: modelUsed,
    actual_model: actualModel || modelUsed,
    fallback_activated: fallbackActivated,
    fallback_reason: fallbackReason,
    cache_lost: cacheLost,
    finish_reason: finishReason,
    max_tokens_sent: maxTokensSent,
    prompt_version: promptVersion,
    endpoint: endpointUsed,
    session_id: sessionSafeId,
    turns_executed: currentTurn,
    duration_ms: durationMs,
    tool_receipts: turnReceipts,
    turn_usages: turnUsages,
    read_ranges: capturedReadRanges,
    new_read_ranges: newAttemptReadRanges,
    content: finalContent,
    usage: accumulatedUsage,
    raw_usage: rawUsageSummary
  };
}

/**
 * Enforces a per-turn byte cap across parallel/batched read_file responses while keeping
 * every tool_call_id mapped cleanly to valid JSON and accurately bounding captured read_ranges.
 */
function capBatchReadResult(execResult, remainingBytes, maxBatchBytes) {
  const rawContent = String(execResult?.content || '');
  const contentBytes = Buffer.byteLength(rawContent, 'utf8');
  if (contentBytes <= remainingBytes) {
    return {
      cappedResult: execResult,
      consumedBytes: contentBytes,
      capturedRange: {
        path: execResult.file,
        start_line: execResult.start_line,
        end_line: execResult.end_line,
        file_hash: typeof execResult.file_hash === 'string' ? execResult.file_hash : null,
        content: rawContent
      }
    };
  }

  const hintText = `Batch read_file byte cap (${maxBatchBytes} bytes) reached in this turn; re-issue read_file in the next turn for ${execResult.file}:${execResult.start_line}-${execResult.end_line}.`;
  const shortNotice = '[BATCH READ BYTE CAP EXCEEDED — re-read in next turn]';
  const noticeBudget = Math.min(remainingBytes, Buffer.byteLength(`\n${shortNotice}`, 'utf8'));
  const lineBudget = Math.max(0, remainingBytes - noticeBudget);

  const lines = rawContent.split(/\r?\n/);
  const keptLines = [];
  let keptBytes = 0;
  let keptEndLine = Number(execResult.start_line) - 1;

  for (const ln of lines) {
    const lnBytes = Buffer.byteLength((keptLines.length > 0 ? '\n' : '') + ln, 'utf8');
    if (keptBytes + lnBytes > lineBudget) break;
    keptLines.push(ln);
    keptBytes += lnBytes;
    const m = ln.match(/^(\d+): /);
    if (m) keptEndLine = Number(m[1]);
  }

  const clippedBody = keptLines.join('\n');
  const fitNotice = Buffer.byteLength(`\n${shortNotice}`, 'utf8') <= Math.max(0, remainingBytes - Buffer.byteLength(clippedBody, 'utf8'))
    ? (clippedBody ? `\n${shortNotice}` : shortNotice)
    : Buffer.from(shortNotice, 'utf8').subarray(0, Math.max(0, remainingBytes - Buffer.byteLength(clippedBody, 'utf8'))).toString('utf8');
  const finalContent = clippedBody + fitNotice;
  const consumedBytes = Buffer.byteLength(finalContent, 'utf8');

  const capturedRange = keptEndLine >= Number(execResult.start_line)
    ? {
        path: execResult.file,
        start_line: execResult.start_line,
        end_line: keptEndLine,
        file_hash: typeof execResult.file_hash === 'string' ? execResult.file_hash : null,
        content: clippedBody
      }
    : null;

  return {
    cappedResult: {
      ...execResult,
      end_line: keptEndLine,
      total_bytes: keptBytes,
      truncated: true,
      batch_truncated: true,
      navigation_hint: hintText,
      content: finalContent
    },
    consumedBytes,
    capturedRange
  };
}

/**
 * Merges read_file line ranges by normalized path, deduplicating/combining overlapping ranges
 * so retry attempts inherit previously inspected file slices cleanly.
 */
export function mergeReadRanges(existing = [], incoming = []) {
  const combined = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .filter(r => r && r.path && Number(r.start_line) >= 1 && Number(r.end_line) >= Number(r.start_line))
    .map(r => ({
      path: String(r.path).trim().replace(/\\/g, '/').replace(/^\.\//, ''),
      start_line: Number(r.start_line),
      end_line: Number(r.end_line),
      file_hash: typeof r.file_hash === 'string' && r.file_hash ? r.file_hash : null,
      content: typeof r.content === 'string' ? r.content : ''
    }));

  if (combined.length === 0) return [];

  const byPath = new Map();
  for (const item of combined) {
    if (!byPath.has(item.path)) byPath.set(item.path, []);
    const list = byPath.get(item.path);
    // If a newer read brings a different non-null disk hash, invalidate stale prior ranges for that file
    if (item.file_hash && list.some(prev => prev.file_hash && prev.file_hash !== item.file_hash)) {
      byPath.set(item.path, [item]);
    } else {
      list.push(item);
    }
  }

  const mergeContentLines = (prevContent, nextContent) => {
    const lineMap = new Map();
    const fallbackTexts = [];
    for (const raw of [prevContent, nextContent]) {
      if (!raw) continue;
      for (const ln of raw.split(/\r?\n/)) {
        if (/^\[Showing lines \d+-\d+/.test(ln)) continue;
        const m = ln.match(/^(\d+): (.*)$/);
        if (m) {
          lineMap.set(Number(m[1]), m[2]);
        } else if (ln.trim()) {
          fallbackTexts.push(ln);
        }
      }
    }
    if (lineMap.size > 0) {
      return [...lineMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([num, txt]) => `${num}: ${txt}`)
        .join('\n');
    }
    return fallbackTexts.join('\n');
  };

  const mergedAll = [];
  for (const [filePath, list] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
    const mergedForFile = [];
    for (const cur of list) {
      const prev = mergedForFile[mergedForFile.length - 1];
      if (prev && cur.start_line <= prev.end_line + 1) {
        prev.end_line = Math.max(prev.end_line, cur.end_line);
        prev.file_hash = cur.file_hash || prev.file_hash || null;
        prev.content = mergeContentLines(prev.content, cur.content);
      } else {
        mergedForFile.push({
          path: filePath,
          start_line: cur.start_line,
          end_line: cur.end_line,
          file_hash: cur.file_hash || null,
          content: cur.content
        });
      }
    }
    mergedAll.push(...mergedForFile);
  }
  return mergedAll;
}

function getCurrentFileSha256(repoRoot, relPath, cacheMap) {
  if (!repoRoot || !relPath) return undefined;
  if (cacheMap.has(relPath)) return cacheMap.get(relPath);
  let digest = null;
  try {
    const absPath = path.resolve(repoRoot, relPath);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      const diskRaw = fs.readFileSync(absPath, 'utf8');
      digest = crypto.createHash('sha256').update(diskRaw, 'utf8').digest('hex');
    }
  } catch {
    digest = null;
  }
  cacheMap.set(relPath, digest);
  return digest;
}

/**
 * Formats inherited read ranges ("Files Already Read") for retry prompts within strict byte and token caps,
 * verifying each file's disk SHA-256 hash matches the hash captured when read_file ran.
 */
export function formatPriorReadContext(readRanges = [], maxBytesOrOptions = 16000, maybeOptions = {}) {
  const ranges = mergeReadRanges([], readRanges);
  if (ranges.length === 0) return '';

  const opts = (maxBytesOrOptions && typeof maxBytesOrOptions === 'object')
    ? maxBytesOrOptions
    : (maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {});
  const maxBytes = Number.isFinite(Number(opts.maxBytes))
    ? Math.max(512, Number(opts.maxBytes))
    : (Number.isFinite(Number(maxBytesOrOptions)) ? Math.max(512, Number(maxBytesOrOptions)) : 16000);
  const maxTokens = Number.isFinite(Number(opts.maxTokens))
    ? Math.max(128, Number(opts.maxTokens))
    : 4800;
  const repoRoot = opts.repoRoot || null;

  const diskHashCache = new Map();
  const annotated = ranges.map(r => {
    if (!repoRoot || !r.file_hash) {
      return { range: r, stale: false, staleReason: null };
    }
    const diskHash = getCurrentFileSha256(repoRoot, r.path, diskHashCache);
    if (!diskHash) {
      return { range: r, stale: true, staleReason: 'file missing on disk' };
    }
    if (diskHash !== r.file_hash) {
      return { range: r, stale: true, staleReason: 'disk file hash changed since prior read' };
    }
    return { range: r, stale: false, staleReason: null };
  });

  const summaryLines = annotated.map(({ range: r, stale, staleReason }) => (
    stale
      ? `- ${r.path}:${r.start_line}-${r.end_line} [STALE EXCERPT SKIPPED: ${staleReason}; re-read if needed]`
      : `- ${r.path}:${r.start_line}-${r.end_line}`
  ));
  const header = [
    'FILES ALREADY READ FROM PREVIOUS ATTEMPT(S) (reuse these exact lines when valid; do NOT re-read already covered ranges — call multiple `read_file` in parallel in 1 turn ONLY for missing or stale ranges):',
    ...summaryLines
  ].join('\n');

  const chunks = [header];
  let usedBytes = Buffer.byteLength(header, 'utf8');

  for (const { range: r, stale } of annotated) {
    if (stale) continue;
    if (!r.content || !r.content.trim()) continue;
    const block = `\n=== READ EXCERPT: ${r.path}:${r.start_line}-${r.end_line} ===\n${r.content.trim()}`;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    const candidateJoined = `${chunks.join('\n')}\n${block}`;
    const candidateTokens = estimateTextTokens(candidateJoined);

    if (usedBytes + blockBytes <= maxBytes && candidateTokens <= maxTokens) {
      chunks.push(block);
      usedBytes += blockBytes;
    } else if (usedBytes < maxBytes - 180) {
      const marker = '\n/* ... [PRIOR READ EXCERPT TRUNCATED] ... */';
      let lo = 0;
      let hi = Math.min(block.length, Math.max(0, maxBytes - usedBytes - Buffer.byteLength(marker, 'utf8')));
      let best = '';
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const attemptPiece = block.slice(0, mid) + marker;
        const attemptJoined = `${chunks.join('\n')}\n${attemptPiece}`;
        if (usedBytes + Buffer.byteLength(attemptPiece, 'utf8') <= maxBytes && estimateTextTokens(attemptJoined) <= maxTokens) {
          best = attemptPiece;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best) {
        chunks.push(best);
      }
      break;
    } else {
      break;
    }
  }

  return chunks.join('\n');
}

// -------------------------------------------------------------
// CLI Handler
// -------------------------------------------------------------
function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    role: 'designer',
    sessionId: null,
    prompt: '',
    images: [],
    files: [],
    scope: [],
    model: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--role' && args[i + 1]) {
      options.role = args[++i];
    } else if (arg === '--session' && args[i + 1]) {
      options.sessionId = args[++i];
    } else if (arg === '--prompt' && args[i + 1]) {
      options.prompt = args[++i];
    } else if (arg === '--image' && args[i + 1]) {
      options.images.push(args[++i]);
    } else if (arg === '--file' && args[i + 1]) {
      options.files.push(args[++i]);
    } else if (arg === '--scope' && args[i + 1]) {
      options.scope.push(args[++i]);
    } else if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    }
  }

  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cliOptions = parseCliArgs();

  if (!cliOptions.prompt && cliOptions.images.length === 0 && cliOptions.files.length === 0) {
    console.log(`
Usage: node agent-team/runtime/index.mjs [options]

Options:
  --role <name>       Role to invoke (designer | writer | router | reviewer) [default: designer]
  --session <id>      Session identifier for persistent memory [default: auto-generated]
  --prompt <text>     Task prompt or question
  --image <path>      Attach image file for vision (supports multiple)
  --file <path>       Attach text file content (supports multiple)
  --scope <path>      Limit patch scope for writer
  --model <id>        Override model identifier
    `);
    process.exit(0);
  }

  console.log(`[Agent Runtime] Initializing Role: "${cliOptions.role}" (Session: ${cliOptions.sessionId || 'new'})...`);
  runAgent(cliOptions)
    .then(res => {
      if (res.ok) {
        console.log(`\n=== AGENT RESPONSE (${res.model_used} | Turns: ${res.turns_executed} | Session: ${res.session_id}) ===\n`);
        console.log(res.content);
        if (res.tool_receipts && res.tool_receipts.length > 0) {
          console.log(`\n--- Tool Receipts (${res.tool_receipts.length}) ---`);
          res.tool_receipts.forEach(r => console.log(` • [Turn ${r.turn}] ${r.tool} -> ${r.status} (${JSON.stringify(r.summary)})`));
        }
      } else {
        console.error(`\n[Agent Runtime Error]: ${res.error}`);
        process.exit(1);
      }
    })
    .catch(err => {
      console.error(`\n[Fatal Runtime Exception]: ${err.message}`);
      process.exit(1);
    });
}
