import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { callModelEndpoint, normalizeUsage } from '../../runtime/provider-gateway.mjs';
import { getAvailableToolSchemas } from '../../runtime/tool-runtime.mjs';
import { readInstalled9RouterVersion } from './client-9router.mjs';
import { resolveApiKey } from './risk-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '../..');

export const DEFAULT_CACHE_BENCHMARK_MODELS = [
  'ag/claude-sonnet-5-5',
  'ag/gemini-3.8-flash-medium'
];

const STATIC_REFERENCE_BLOCK = [
  'Minimal Agent Orchestrator Architecture & Invariant Reference Manual:',
  '1. Execution Layer Boundary: Frontend view components delegate backend commands over structured RPC/API bridges into backend services, which schedule background worker threads and return asynchronous updates via an event bus.',
  '2. Project Formatting Standard: Every modified module MUST preserve the repository indentation convention (tabs or spaces) and pass configured fast validation checks.',
  '3. Security & Secret Hygiene: Credentials and webhook secrets are stored strictly in OS keyring/vault storage, never written to plaintext JSON configs and never exposed to client views.',
  '4. Bounded Network & Process Execution: All subprocess invocations and HTTP requests specify explicit timeouts, and shell diagnostics use bounded non-interactive flags.',
  '5. Prompt Prefix Invariance Protocol: Prefix tokens [0..N] sent on Turn N MUST remain byte-for-byte immutable on Turn N+1 across messages and tool declarations so upstream provider KV caches stay warm across multi-turn reasoning loops.',
  '6. Telemetry Integrity Rules: Provider usage objects are preserved verbatim as raw_usage alongside requested_model and actual_model; cached_tokens remains null whenever the upstream provider omits cache telemetry fields.'
].join('\n');

/**
 * Builds a deterministic >= 1200-token system prefix + short user prompt
 * so both Anthropic ephemeral breakpoints (>= 1024 tokens) and Gemini implicit
 * prefix caching can trigger on the second identical call.
 *
 * @param {string} [nonce]
 * @returns {{ systemPrompt: string, userMessage: string }}
 */
export function buildDeterministicCachePrompt(nonce = '') {
  const sections = [];
  if (nonce) {
    sections.push(`Benchmark Session Nonce: ${nonce}`);
  }
  for (let i = 1; i <= 6; i++) {
    sections.push(`[Section ${i}]\n${STATIC_REFERENCE_BLOCK}`);
  }
  return {
    systemPrompt: sections.join('\n\n'),
    userMessage: 'Reply with strictly one word: OK.'
  };
}

/**
 * Builds controlled A/B prompt pair whose prefixes diverge from byte 0 while
 * maintaining identical UTF-8 byte lengths and >= 4000-char cacheable prefix length.
 *
 * @param {string} [nonce]
 * @returns {{ A: { systemPrompt: string, userMessage: string }, B: { systemPrompt: string, userMessage: string } }}
 */
export function buildControlledCachePrompts(nonce = '') {
  const nonceLabel = nonce || 'none';
  const aSections = [`ALPHA-01 Nonce: ${nonceLabel}`];
  const bSections = [`BRAVO-02 Nonce: ${nonceLabel}`];
  for (let i = 1; i <= 6; i++) {
    aSections.push(`[ALPHA-${i}]\n${STATIC_REFERENCE_BLOCK}`);
    bSections.push(`[BRAVO-${7 - i}]\n${STATIC_REFERENCE_BLOCK}`);
  }
  return {
    A: {
      systemPrompt: aSections.join('\n\n'),
      userMessage: 'Reply with strictly one word: OK.'
    },
    B: {
      systemPrompt: bSections.join('\n\n'),
      userMessage: 'Reply with strictly one word: OK.'
    }
  };
}

const ROUTER_CONTEXT_MODULE_BLOCK = [
  STATIC_REFERENCE_BLOCK,
  'Module Inventory Slice: src/downloader.py | src/worker.py | src/transcriber.py | src/ai_providers.py | src/providers/presets.py | src/providers/store.py | api/bridge.py | api/event_bus.py | web/index.html.',
  'Routing Constraints & Verification Checklist:',
  '- Scope must stay atomic (< 150 lines changed per task YAML) with explicit acceptance_criteria and mode (quick | standard | consult).',
  '- UI preset changes require verifying frontend/backend API bridges, DOM safe rendering (.textContent), and custom event listeners without innerHTML.',
  '- Verification runs the configured fast_checks and suite_checks with indentation and regression tests before marking task complete.'
].join('\n');

function cloneRouterToolsWithPrefixTag(baseTools, tag) {
  return baseTools.map((toolDef, idx) => {
    const cloned = JSON.parse(JSON.stringify(toolDef));
    if (idx === 0 && cloned.function && typeof cloned.function.description === 'string') {
      cloned.function.description = `${tag} ${cloned.function.description}`;
    }
    return cloned;
  });
}

/**
 * Builds a >= 12k-token (~48k+ char) Router-shaped A/B prompt pair including
 * router instructions, tool schemas, workspace index, and pre-lookup excerpts.
 * Variant A and B diverge from byte 0 in tools, system, and user while matching
 * exact UTF-8 byte lengths.
 *
 * @param {string} [nonce]
 * @param {Object} [options]
 */
export function buildRouterSizedCachePrompts(nonce = '', options = {}) {
  const minChars = Number(options.minChars || 49500);
  const nonceLabel = nonce || 'none';

  const routerRolePath = path.resolve(TEAM_DIR, 'roles', 'router.md');
  const routerSpec = fs.existsSync(routerRolePath)
    ? fs.readFileSync(routerRolePath, 'utf8').trim()
    : 'You are the AI Router Agent. Scope tasks atomically into strict JSON.';

  const baseTools = getAvailableToolSchemas(['list_files', 'search_code', 'read_file', 'get_repo_map']);
  const toolsA = cloneRouterToolsWithPrefixTag(baseTools, 'ALPHA-01');
  const toolsB = cloneRouterToolsWithPrefixTag(baseTools, 'BRAVO-02');

  const sectionCount = Math.max(26, Math.ceil(minChars / (ROUTER_CONTEXT_MODULE_BLOCK.length + 24)));
  const sysPartsA = [`ALPHA-01 Router Context Nonce: ${nonceLabel}`, routerSpec];
  const sysPartsB = [`BRAVO-02 Router Context Nonce: ${nonceLabel}`, routerSpec];

  for (let i = 1; i <= sectionCount; i++) {
    const numA = String(i).padStart(2, '0');
    const numB = String(sectionCount + 1 - i).padStart(2, '0');
    sysPartsA.push(`[ALPHA-${numA}] Router Workspace & Pre-Lookup Context\n${ROUTER_CONTEXT_MODULE_BLOCK}`);
    sysPartsB.push(`[BRAVO-${numB}] Router Workspace & Pre-Lookup Context\n${ROUTER_CONTEXT_MODULE_BLOCK}`);
  }

  const userTail = [
    'ALLOWED DIRECTORIES: [src/, api/, web/, tests/, agent-team/]',
    'AVAILABLE SQUAD MODELS: [kr/claude-sonnet-4.5-thinking, ag/claude-sonnet-5-5, ag/gemini-3.8-flash-medium, ag/claude-opus-5-5-medium]',
    'USER GOAL: Clean up filter pills overflow and wire dry-run telemetry diagnostics safely.',
    'INSTRUCTION: Benchmark probe only. Ignore task planning output schema above and reply strictly with one word: OK.'
  ].join('\n\n');

  return {
    A: {
      systemPrompt: sysPartsA.join('\n\n'),
      userMessage: `ALPHA-01 Task Request (${nonceLabel})\n\n${userTail}`,
      tools: toolsA
    },
    B: {
      systemPrompt: sysPartsB.join('\n\n'),
      userMessage: `BRAVO-02 Task Request (${nonceLabel})\n\n${userTail}`,
      tools: toolsB
    }
  };
}

/**
 * Parses either a single JSON completion body OR an SSE/multi-line data stream
 * without losing verbatim provider usage fields or chunk model identifiers.
 *
 * @param {string} rawText
 * @returns {{ data: Object|null, wireFormat: string, error?: string }}
 */
export function parseRawCompletionResponse(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    return { data: null, wireFormat: 'empty', error: 'Empty response body' };
  }

  try {
    return { data: JSON.parse(trimmed), wireFormat: 'json' };
  } catch {
    // Fall through to SSE / multi-line JSON parsing
  }

  const lines = trimmed.split(/\r?\n/);
  const chunks = [];
  for (const line of lines) {
    const clean = line.trim();
    if (!clean || clean === 'data: [DONE]' || clean === '[DONE]') continue;
    const jsonCandidate = clean.startsWith('data:') ? clean.slice(5).trim() : clean;
    if (!jsonCandidate.startsWith('{')) continue;
    try {
      chunks.push(JSON.parse(jsonCandidate));
    } catch {
      // Ignore non-JSON commentary/event headers
    }
  }

  if (chunks.length === 0) {
    return {
      data: null,
      wireFormat: 'unparsed',
      error: `Failed to parse response as JSON or SSE: ${trimmed.slice(0, 200)}`
    };
  }

  let actualModel = null;
  let finishReason = null;
  let rawUsage = null;
  const contentParts = [];

  for (const chunk of chunks) {
    if (typeof chunk.model === 'string' && chunk.model.trim()) {
      actualModel = chunk.model.trim();
    }
    if (chunk.message && typeof chunk.message === 'object') {
      if (typeof chunk.message.model === 'string' && chunk.message.model.trim()) {
        actualModel = chunk.message.model.trim();
      }
      if (chunk.message.usage && typeof chunk.message.usage === 'object') {
        rawUsage = rawUsage
          ? { ...rawUsage, ...JSON.parse(JSON.stringify(chunk.message.usage)) }
          : JSON.parse(JSON.stringify(chunk.message.usage));
      }
    }
    const choice = chunk.choices?.[0];
    if (choice) {
      if (typeof choice.delta?.content === 'string') contentParts.push(choice.delta.content);
      if (typeof choice.message?.content === 'string') contentParts.push(choice.message.content);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.delta && typeof chunk.delta === 'object') {
      if (typeof chunk.delta.text === 'string') contentParts.push(chunk.delta.text);
      if (chunk.delta.stop_reason) finishReason = chunk.delta.stop_reason;
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      rawUsage = rawUsage
        ? { ...rawUsage, ...JSON.parse(JSON.stringify(chunk.usage)) }
        : JSON.parse(JSON.stringify(chunk.usage));
    }
  }

  return {
    data: {
      model: actualModel,
      usage: rawUsage,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: contentParts.join('') },
        finish_reason: finishReason || 'stop'
      }]
    },
    wireFormat: chunks.some(c =>
      Boolean(c.choices?.[0]?.delta) ||
      c.type === 'message_start' ||
      c.type === 'content_block_delta' ||
      c.type === 'message_delta'
    ) ? 'sse' : 'ndjson'
  };
}

/**
 * Executes a single completion request and preserves verbatim raw_usage and latency.
 */
async function executeSingleBenchmarkRequest({
  baseUrl,
  apiKey,
  timeoutMs,
  model,
  systemPrompt,
  userMessage,
  stream = false,
  maxTokens = 32,
  temperature = 0,
  useEphemeralCacheControl = true,
  turn,
  label = null,
  fetchFn = globalThis.fetch
}) {
  const isClaude = String(model).toLowerCase().includes('claude');
  const systemContent = (useEphemeralCacheControl && isClaude && systemPrompt.length >= 800)
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  const reqBody = {
    model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userMessage }
    ],
    max_tokens: maxTokens,
    temperature,
    stream: Boolean(stream)
  };
  if (stream) {
    reqBody.stream_options = { include_usage: true };
  }

  const serializedBody = JSON.stringify(reqBody);
  const payloadBytes = Buffer.byteLength(serializedBody, 'utf8');
  const startedMs = performance.now();

  try {
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: serializedBody,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const rawText = await res.text();
    const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;

    if (!res.ok) {
      return {
        serializedBody,
        payloadBytes,
        record: {
          turn,
          ...(label ? { label } : {}),
          stream: Boolean(stream),
          payload_bytes: payloadBytes,
          ok: false,
          latency_ms: latencyMs,
          requested_model: model,
          actual_model: null,
          raw_usage: null,
          cache_reported: false,
          reported_cached_tokens: null,
          error: `HTTP ${res.status}: ${rawText.slice(0, 300)}`
        }
      };
    }

    const parsed = parseRawCompletionResponse(rawText);
    if (!parsed.data) {
      return {
        serializedBody,
        payloadBytes,
        record: {
          turn,
          ...(label ? { label } : {}),
          stream: Boolean(stream),
          payload_bytes: payloadBytes,
          ok: false,
          latency_ms: latencyMs,
          requested_model: model,
          actual_model: null,
          raw_usage: null,
          cache_reported: false,
          reported_cached_tokens: null,
          error: parsed.error
        }
      };
    }

    const data = parsed.data;
    const rawUsage = data.usage ? JSON.parse(JSON.stringify(data.usage)) : null;
    const norm = normalizeUsage(data.usage || {});
    const actualModel = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : null;
    const content = data.choices?.[0]?.message?.content || '';

    return {
      serializedBody,
      payloadBytes,
      record: {
        turn,
        ...(label ? { label } : {}),
        stream: Boolean(stream),
        payload_bytes: payloadBytes,
        ok: true,
        wire_format: parsed.wireFormat,
        latency_ms: latencyMs,
        requested_model: model,
        actual_model: actualModel,
        finish_reason: data.choices?.[0]?.finish_reason || null,
        raw_usage: rawUsage,
        cache_reported: Boolean(norm.cache_reported),
        reported_cached_tokens: norm.cache_reported ? (norm.reported_cached_tokens ?? null) : null,
        response_preview: String(content).slice(0, 60)
      }
    };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;
    return {
      serializedBody,
      payloadBytes,
      record: {
        turn,
        ...(label ? { label } : {}),
        stream: Boolean(stream),
        payload_bytes: payloadBytes,
        ok: false,
        latency_ms: latencyMs,
        requested_model: model,
        actual_model: null,
        raw_usage: null,
        cache_reported: false,
        reported_cached_tokens: null,
        error: err.message
      }
    };
  }
}

/**
 * Sends two identical requests sequentially to one model and records latency,
 * requested vs actual model, and verbatim raw usage.
 *
 * @param {string} model
 * @param {Object} [options]
 */
export async function measureModelCachePair(model, options = {}) {
  const {
    teamConfig = {},
    policyConfig = {},
    maxTokens = 32,
    temperature = 0,
    nonce = '',
    stream = false,
    useEphemeralCacheControl = true,
    fetchFn = globalThis.fetch
  } = options;

  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;

  const { systemPrompt, userMessage } = buildDeterministicCachePrompt(nonce);
  const capturedBodies = [];
  const turns = [];
  let payloadBytes = 0;

  for (let turn = 1; turn <= 2; turn++) {
    const exec = await executeSingleBenchmarkRequest({
      baseUrl,
      apiKey,
      timeoutMs,
      model,
      systemPrompt,
      userMessage,
      stream,
      maxTokens,
      temperature,
      useEphemeralCacheControl,
      turn,
      fetchFn
    });
    capturedBodies.push(exec.serializedBody);
    payloadBytes = exec.payloadBytes;
    turns.push(exec.record);
  }

  return {
    ok: turns.every(t => t.ok),
    requested_model: model,
    identical_request_payload: capturedBodies.length === 2 && capturedBodies[0] === capturedBodies[1],
    payload_bytes: payloadBytes,
    turns
  };
}

/**
 * Probes 9Router's dashboard usage counter endpoint (read-only).
 * Falls back cleanly with manual_read_required=true if dashboard auth blocks programmatic access.
 *
 * @param {string} baseUrl
 * @param {Object} [options]
 */
export async function probe9RouterUsageCounter(baseUrl = 'http://127.0.0.1:20128/v1', options = {}) {
  const { timeoutMs = 5000, apiKey = '', cookie = '', fetchFn = globalThis.fetch } = options;
  let origin = 'http://127.0.0.1:20128';
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    // Keep default origin
  }

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (cookie) headers.Cookie = cookie;

  try {
    const res = await fetchFn(`${origin}/api/usage/stats?period=24h`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        available: false,
        status: res.status,
        manual_read_required: true,
        cached_tokens: null,
        reason: `HTTP ${res.status}: ${text.slice(0, 160)}`
      };
    }

    const data = JSON.parse(text);
    const cachedTokens = data.totalCachedTokens
      ?? data.cachedTokens
      ?? data.cached_tokens
      ?? data.summary?.cachedTokens
      ?? data.totals?.cachedTokens
      ?? null;
    return {
      available: true,
      status: res.status,
      manual_read_required: false,
      cached_tokens: typeof cachedTokens === 'number' ? cachedTokens : null,
      raw_stats: data
    };
  } catch (err) {
    return {
      available: false,
      status: null,
      manual_read_required: true,
      cached_tokens: null,
      reason: err.message
    };
  }
}

/**
 * Executes a controlled A, A, B, A cache sequence for a single model in one streaming mode.
 *
 * @param {string} model
 * @param {Object} [options]
 */
export async function measureControlledCacheSequence(model, options = {}) {
  const {
    teamConfig = {},
    policyConfig = {},
    maxTokens = 32,
    temperature = 0,
    nonce = '',
    stream = false,
    sequence = ['A', 'A', 'B', 'A'],
    useEphemeralCacheControl = true,
    fetchFn = globalThis.fetch
  } = options;

  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;

  const prompts = buildControlledCachePrompts(nonce);
  const turns = [];
  const serializedA = [];
  const bytesByLabel = { A: null, B: null };

  for (let i = 0; i < sequence.length; i++) {
    const label = sequence[i];
    const prompt = prompts[label] || prompts.A;
    const exec = await executeSingleBenchmarkRequest({
      baseUrl,
      apiKey,
      timeoutMs,
      model,
      systemPrompt: prompt.systemPrompt,
      userMessage: prompt.userMessage,
      stream,
      maxTokens,
      temperature,
      useEphemeralCacheControl,
      turn: i + 1,
      label,
      fetchFn
    });
    turns.push(exec.record);
    if (label === 'A') serializedA.push(exec.serializedBody);
    bytesByLabel[label] = exec.payloadBytes;
  }

  return {
    ok: turns.every(t => t.ok),
    requested_model: model,
    stream: Boolean(stream),
    nonce,
    sequence: [...sequence],
    a_payloads_identical: serializedA.length > 1 && serializedA.every(b => b === serializedA[0]),
    b_differs_from_byte_0: prompts.A.systemPrompt[0] !== prompts.B.systemPrompt[0],
    equal_payload_bytes: bytesByLabel.A !== null && bytesByLabel.A === bytesByLabel.B,
    payload_bytes_a: bytesByLabel.A,
    payload_bytes_b: bytesByLabel.B,
    turns
  };
}

/**
 * Runs the controlled A, A, B, A cache experiment across target models
 * with stream=false first, then stream=true (distinct nonces per pass).
 *
 * @param {Object} [options]
 */
export async function runControlledCacheExperiment(options = {}) {
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : DEFAULT_CACHE_BENCHMARK_MODELS;
  const baseNonce = options.nonce || `ctrl-${Date.now()}`;
  const teamConfig = options.teamConfig || {};
  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);

  const usageBefore = await probe9RouterUsageCounter(baseUrl, { apiKey, fetchFn: options.fetchFn });
  const passes = [];

  for (const model of models) {
    const modelTag = model.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    for (const streamMode of [false, true]) {
      const passNonce = `${baseNonce}-${modelTag}-${streamMode ? 'stream' : 'nonstream'}`;
      passes.push(await measureControlledCacheSequence(model, {
        ...options,
        stream: streamMode,
        nonce: passNonce
      }));
    }
  }

  const usageAfter = await probe9RouterUsageCounter(baseUrl, { apiKey, fetchFn: options.fetchFn });
  const deltaCached = (usageBefore.available && usageAfter.available &&
    typeof usageBefore.cached_tokens === 'number' && typeof usageAfter.cached_tokens === 'number')
    ? (usageAfter.cached_tokens - usageBefore.cached_tokens)
    : null;

  return {
    experiment: 'controlled_aaba',
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
    base_nonce: baseNonce,
    models,
    usage_counter: {
      before: usageBefore,
      after: usageAfter,
      delta_cached_tokens: deltaCached,
      manual_read_required: Boolean(usageBefore.manual_read_required || usageAfter.manual_read_required)
    },
    passes
  };
}

/**
 * Runs 2-turn identical cache probes across all target models.
 *
 * @param {Object} [options]
 */
export async function runCacheBenchmark(options = {}) {
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : DEFAULT_CACHE_BENCHMARK_MODELS;
  const results = [];
  for (const model of models) {
    results.push(await measureModelCachePair(model, options));
  }
  return {
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
    results
  };
}

function summarizeSeries(values = []) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const quantile = (q) => {
    const pos = (nums.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (nums[base + 1] !== undefined) {
      return nums[base] + rest * (nums[base + 1] - nums[base]);
    }
    return nums[base];
  };
  const median = Number(quantile(0.5).toFixed(4));
  const p25 = Number(quantile(0.25).toFixed(4));
  const p75 = Number(quantile(0.75).toFixed(4));
  return {
    count: nums.length,
    median,
    min: nums[0],
    max: nums[nums.length - 1],
    p25,
    p75,
    iqr: Number((p75 - p25).toFixed(4))
  };
}

/**
 * Runs a repeated >= 12k-token Router-shaped A, A, A, B, A, A cache experiment
 * over Item A's streaming gateway (`stream: true`) across models and repetitions,
 * computing per-turn medians without inferring cache hits from latency.
 *
 * @param {Object} [options]
 */
export async function runRepeatedRouterCacheExperiment(options = {}) {
  const {
    models = DEFAULT_CACHE_BENCHMARK_MODELS,
    repetitions = 3,
    sequence = ['A', 'A', 'A', 'B', 'A', 'A'],
    teamConfig = {},
    policyConfig = {},
    nonce = `rep-${Date.now()}`,
    maxTokens = 32,
    temperature = 0,
    fetchFn = globalThis.fetch
  } = options;

  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;

  const modelReports = [];
  for (const model of models) {
    const modelTag = String(model).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const repRuns = [];
    const observedActualModels = new Set();

    for (let rep = 1; rep <= repetitions; rep++) {
      const repNonce = `${nonce}-${modelTag}-r${rep}`;
      const prompts = buildRouterSizedCachePrompts(repNonce, { minChars: options.minChars || 49500 });
      const turns = [];

      for (let idx = 0; idx < sequence.length; idx++) {
        const label = sequence[idx];
        const variant = prompts[label] || prompts.A;
        const payloadBytes = Buffer.byteLength(JSON.stringify({
          model,
          messages: [
            { role: 'system', content: variant.systemPrompt },
            { role: 'user', content: variant.userMessage }
          ],
          tools: variant.tools,
          stream: true
        }), 'utf8');

        const startedMs = performance.now();
        const res = await callModelEndpoint({
          baseUrl,
          apiKey,
          model,
          messages: [
            { role: 'system', content: variant.systemPrompt },
            { role: 'user', content: variant.userMessage }
          ],
          tools: variant.tools,
          maxTokens,
          temperature,
          timeoutMs,
          stream: true,
          ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
          fetchFn
        });
        const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;

        if (!res.ok) {
          turns.push({
            turn: idx + 1,
            label,
            ok: false,
            payload_bytes: payloadBytes,
            latency_ms: latencyMs,
            requested_model: model,
            actual_model: null,
            prompt_tokens: null,
            cached_tokens: null,
            cached_ratio: null,
            cache_reported: false,
            usage_quality: null,
            raw_usage: null,
            error: res.error
          });
          continue;
        }

        const actualModel = res.actual_model || res.model_responded || res.model_used || model;
        observedActualModels.add(actualModel);
        const promptTokens = Number(res.usage?.prompt_tokens ?? 0);
        const promptTokensRaw = Number(res.usage?.prompt_tokens_raw ?? promptTokens);
        const promptTokensAdjusted = Number(res.usage?.prompt_tokens_adjusted ?? promptTokensRaw);
        const bufferOffset = Number(res.usage?.usage_adjusted_buffer ?? 0);
        const cacheReported = Boolean(res.usage?.cache_reported);
        const reportedCached = cacheReported ? (res.usage?.reported_cached_tokens ?? null) : null;
        const freshTokens = res.usage?.fresh_tokens ?? Math.max(0, promptTokensAdjusted - (reportedCached ?? 0));
        const cachedRatio = (cacheReported && reportedCached !== null && promptTokensAdjusted > 0)
          ? Number((reportedCached / promptTokensAdjusted).toFixed(4))
          : null;

        turns.push({
          turn: idx + 1,
          label,
          ok: true,
          payload_bytes: payloadBytes,
          latency_ms: latencyMs,
          requested_model: model,
          actual_model: actualModel,
          prompt_tokens: promptTokens,
          prompt_tokens_raw: promptTokensRaw,
          prompt_tokens_adjusted: promptTokensAdjusted,
          usage_adjusted_buffer: bufferOffset,
          fresh_tokens: freshTokens,
          completion_tokens: res.usage?.completion_tokens ?? 0,
          reasoning_tokens: res.usage?.reasoning_tokens ?? 0,
          cached_tokens: reportedCached,
          cached_ratio: cachedRatio,
          cache_reported: cacheReported,
          usage_quality: res.usage?.usage_quality || 'full',
          raw_usage: res.raw_usage ?? null
        });
      }

      repRuns.push({
        repetition: rep,
        nonce: repNonce,
        ok: turns.every(t => t.ok),
        turns
      });
    }

    const turnMedians = [];
    for (let idx = 0; idx < sequence.length; idx++) {
      const label = sequence[idx];
      const turnSamples = repRuns.map(r => r.turns[idx]).filter(Boolean);
      const okSamples = turnSamples.filter(t => t.ok);
      const reportedSamples = okSamples.filter(t => t.cache_reported && t.cached_ratio !== null);

      const ratioStats = summarizeSeries(reportedSamples.map(t => t.cached_ratio));
      const cachedTokStats = summarizeSeries(reportedSamples.map(t => t.cached_tokens));
      const promptStats = summarizeSeries(okSamples.map(t => t.prompt_tokens));
      const latencyStats = summarizeSeries(turnSamples.map(t => t.latency_ms));

      turnMedians.push({
        turn: idx + 1,
        label,
        ok_count: okSamples.length,
        total_reps: turnSamples.length,
        cache_reported_count: reportedSamples.length,
        median_cached_ratio: ratioStats ? ratioStats.median : null,
        cached_ratio_stats: ratioStats,
        median_cached_tokens: cachedTokStats ? cachedTokStats.median : null,
        median_prompt_tokens: promptStats ? promptStats.median : null,
        min_prompt_tokens: promptStats ? promptStats.min : null,
        median_latency_ms: latencyStats ? latencyStats.median : null,
        latency_stats: latencyStats
      });
    }

    const allOkTurns = repRuns.flatMap(r => r.turns).filter(t => t.ok && typeof t.prompt_tokens === 'number');
    const minPromptTokens = allOkTurns.length > 0 ? Math.min(...allOkTurns.map(t => t.prompt_tokens)) : null;

    modelReports.push({
      requested_model: model,
      actual_models: [...observedActualModels],
      min_prompt_tokens: minPromptTokens,
      all_turns_ge_12k_tokens: minPromptTokens !== null && minPromptTokens >= 12000,
      turn_medians: turnMedians,
      repetitions: repRuns
    });
  }

  return {
    experiment: 'repeated_router_aaabaa',
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
    base_nonce: nonce,
    repetitions,
    sequence: [...sequence],
    models: modelReports
  };
}

/**
 * Sends a single ultra-short minimal-token probe through the provider gateway
 * so verbatim usage counts (prompt_tokens, completion_tokens, raw_usage) can be
 * compared directly against the 9Router dashboard without guessing overhead.
 *
 * @param {string} [model]
 * @param {Object} [options]
 */
export async function measureMinimalTokenRequest(model = 'ag/claude-sonnet-5-5', options = {}) {
  const {
    teamConfig = {},
    policyConfig = {},
    prompt = 'Reply with strictly one word: OK',
    maxTokens = 1,
    temperature = 0,
    fetchFn = globalThis.fetch
  } = options;

  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;

  let capturedBytes = 0;
  const capturingFetch = async (url, init = {}) => {
    capturedBytes = Buffer.byteLength(String(init?.body || ''), 'utf8');
    return fetchFn(url, init);
  };

  const startedMs = performance.now();
  const res = await callModelEndpoint({
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature,
    timeoutMs,
    stream: options.stream,
    ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
    fetchFn: capturingFetch
  });
  const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;

  if (!res.ok) {
    return {
      experiment: 'minimal_short_gateway_probe',
      checked_at: new Date().toISOString(),
      nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
      ok: false,
      requested_model: model,
      actual_model: null,
      prompt_chars: prompt.length,
      request_bytes: capturedBytes,
      estimated_prompt_tokens: Math.ceil(prompt.length / 4),
      prompt_tokens: null,
      prompt_tokens_raw: null,
      prompt_tokens_adjusted: null,
      usage_adjusted_buffer: 0,
      fresh_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      total_tokens_adjusted: null,
      cached_tokens: null,
      usage_quality: null,
      raw_usage: null,
      content: '',
      latency_ms: latencyMs,
      error: res.error || 'Unknown error'
    };
  }

  const promptTokens = res.usage?.prompt_tokens ?? null;
  const promptTokensRaw = res.usage?.prompt_tokens_raw ?? promptTokens;
  const promptTokensAdjusted = res.usage?.prompt_tokens_adjusted ?? promptTokensRaw;
  const usageAdjustedBuffer = res.usage?.usage_adjusted_buffer ?? 0;
  const completionTokens = res.usage?.completion_tokens ?? null;
  const fallbackTotal = (promptTokens !== null && completionTokens !== null)
    ? (Number(promptTokens) + Number(completionTokens))
    : null;

  return {
    experiment: 'minimal_short_gateway_probe',
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
    ok: true,
    requested_model: model,
    actual_model: res.actual_model || res.model_responded || res.model_used || null,
    prompt_chars: prompt.length,
    request_bytes: capturedBytes,
    estimated_prompt_tokens: Math.ceil(prompt.length / 4),
    prompt_tokens: promptTokens,
    prompt_tokens_raw: promptTokensRaw,
    prompt_tokens_adjusted: promptTokensAdjusted,
    usage_adjusted_buffer: usageAdjustedBuffer,
    fresh_tokens: res.usage?.fresh_tokens ?? promptTokensAdjusted,
    completion_tokens: completionTokens,
    total_tokens: res.raw_usage?.total_tokens ?? fallbackTotal,
    total_tokens_adjusted: res.usage?.total_tokens_adjusted ?? (promptTokensAdjusted !== null && completionTokens !== null ? promptTokensAdjusted + Number(completionTokens) : null),
    cached_tokens: res.usage?.cache_reported ? (res.usage?.reported_cached_tokens ?? null) : null,
    usage_quality: res.usage?.usage_quality || null,
    raw_usage: res.raw_usage ?? null,
    content: res.content ?? '',
    latency_ms: latencyMs
  };
}
