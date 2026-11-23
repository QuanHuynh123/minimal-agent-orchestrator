#!/usr/bin/env node
/**
 * Batch 168 Item 5: Writer/Designer (runAgent) Real Bucket Cache & Prefix-Invariance Measurement.
 * Replays a real repo bucket through `runAgent` (using Gemini Flash by default, <= 8k Turn-1 prompt),
 * captures every outbound HTTP payload + per-turn `cached_tokens`, runs `inspectPayloadPrefixInvariance`,
 * reports concrete break points (`stripOldInlineThinking`, synthesis `tools: null`), and estimates savings
 * WITHOUT altering `stripOldInlineThinking` or `tools: null`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runAgent } from '../runtime/index.mjs';
import { readInstalled9RouterVersion } from './lib/client-9router.mjs';
import { buildScopedFilesContext } from './lib/context-builders.mjs';
import { inspectPayloadPrefixInvariance } from './lib/prefix-invariant.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

function jsonBytes(val) {
  return Buffer.byteLength(JSON.stringify(val ?? null), 'utf8');
}

function estimateTokensFromBytes(bytes) {
  return Math.max(0, Math.ceil(Number(bytes || 0) / 4));
}

/**
 * Estimates break-level prefix invalidation & potential fresh-token savings from prefix invariance breaks.
 * Keeps measured turn usages strictly separate from analytical KV-cache savings estimates.
 */
export function estimatePrefixBreakSavings(capturedPayloads = [], turnUsages = [], prefixReport = null) {
  const report = prefixReport || inspectPayloadPrefixInvariance(capturedPayloads);
  const breaks = Array.isArray(report?.breaks) ? report.breaks : [];
  const payloads = Array.isArray(capturedPayloads) ? capturedPayloads : [];
  const turns = Array.isArray(turnUsages) ? turnUsages : [];

  const breaksByToTurn = new Map();
  for (const b of breaks) {
    const key = Number(b.to_turn);
    if (!breaksByToTurn.has(key)) breaksByToTurn.set(key, []);
    breaksByToTurn.get(key).push(b);
  }

  let totalStrictInvalidatedBytes = 0;
  let totalObservedCacheDropTokens = 0;
  let totalSaveableFreshTokensEst = 0;
  const perBreakDetails = [];
  const byKind = {
    inline_thinking_stripped: { count: 0, invalidated_bytes: 0, estimated_tokens_saveable: 0 },
    tools_dropped: { count: 0, invalidated_bytes: 0, estimated_tokens_saveable: 0 },
    other: { count: 0, invalidated_bytes: 0, estimated_tokens_saveable: 0 }
  };

  for (const [toTurn, turnBreaks] of [...breaksByToTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const prevPayload = payloads[toTurn - 2]?.payload || payloads[toTurn - 2] || {};
    const prevMessages = Array.isArray(prevPayload.messages) ? prevPayload.messages : [];
    const prevTools = prevPayload.tools ?? null;
    const prevTu = turns[toTurn - 2] || null;
    const currTu = turns[toTurn - 1] || null;

    let earliestMsgBreak = Infinity;
    let hasToolsBreak = false;
    let earliestKind = 'other';

    for (const b of turnBreaks) {
      if (b.kind === 'tools_dropped' || b.kind === 'tools_changed') {
        hasToolsBreak = true;
        earliestKind = b.kind === 'tools_dropped' ? 'tools_dropped' : 'other';
      } else if (typeof b.message_index === 'number' && b.message_index < earliestMsgBreak) {
        earliestMsgBreak = b.message_index;
        if (!hasToolsBreak) {
          earliestKind = b.kind === 'inline_thinking_stripped' ? 'inline_thinking_stripped' : 'other';
        }
      }
    }

    let invalidatedBytes = 0;
    if (hasToolsBreak) {
      invalidatedBytes = jsonBytes(prevTools) + jsonBytes(prevMessages);
    } else if (Number.isFinite(earliestMsgBreak) && earliestMsgBreak < prevMessages.length) {
      invalidatedBytes = jsonBytes(prevMessages.slice(earliestMsgBreak));
    }

    const estInvalidatedTokens = estimateTokensFromBytes(invalidatedBytes);
    const prevPromptAdj = prevTu ? Number(prevTu.prompt_tokens_adjusted ?? prevTu.prompt_tokens ?? 0) : 0;
    const prevCached = (prevTu?.cache_reported && typeof prevTu.reported_cached_tokens === 'number')
      ? prevTu.reported_cached_tokens
      : null;
    const currCached = (currTu?.cache_reported && typeof currTu.reported_cached_tokens === 'number')
      ? currTu.reported_cached_tokens
      : null;

    const observedCacheDrop = (prevCached !== null && currCached !== null)
      ? Math.max(0, prevCached - currCached)
      : 0;
    const uncachedPriorGap = (currCached !== null && prevPromptAdj > 0)
      ? Math.max(0, prevPromptAdj - currCached)
      : estInvalidatedTokens;
    const turnSaveableTokens = prevPromptAdj > 0
      ? Math.min(estInvalidatedTokens, currCached !== null ? Math.max(uncachedPriorGap, observedCacheDrop) : estInvalidatedTokens)
      : estInvalidatedTokens;

    totalStrictInvalidatedBytes += invalidatedBytes;
    totalObservedCacheDropTokens += observedCacheDrop;
    totalSaveableFreshTokensEst += turnSaveableTokens;

    const bucketKey = byKind[earliestKind] ? earliestKind : 'other';
    byKind[bucketKey].count += turnBreaks.length;
    byKind[bucketKey].invalidated_bytes += invalidatedBytes;
    byKind[bucketKey].estimated_tokens_saveable += turnSaveableTokens;

    perBreakDetails.push({
      from_turn: toTurn - 1,
      to_turn: toTurn,
      stage: currTu?.stage || 'unknown',
      break_kinds: turnBreaks.map(b => b.kind),
      earliest_message_index: Number.isFinite(earliestMsgBreak) ? earliestMsgBreak : null,
      invalidated_prefix_bytes: invalidatedBytes,
      estimated_invalidated_tokens: estInvalidatedTokens,
      prev_turn_prompt_adjusted: prevPromptAdj,
      prev_turn_cached: prevCached,
      curr_turn_cached: currCached,
      observed_cache_drop_vs_prev_turn: observedCacheDrop,
      estimated_tokens_saveable: turnSaveableTokens
    });
  }

  const totalAdjustedPrompt = turns.reduce((s, t) => s + Number(t.prompt_tokens_adjusted ?? t.prompt_tokens ?? 0), 0);
  const totalFreshAdjusted = turns.reduce((s, t) => s + Number(t.fresh_tokens ?? 0), 0);

  return {
    methodology: 'analytical_estimate_assuming_kv_prefix_hit',
    broken_turns_count: breaksByToTurn.size,
    total_breaks_detected: breaks.length,
    recomputed_prefix_bytes: totalStrictInvalidatedBytes,
    estimated_invalidated_prefix_tokens: estimateTokensFromBytes(totalStrictInvalidatedBytes),
    observed_cache_drop_tokens: totalObservedCacheDropTokens,
    estimated_tokens_saveable_per_run: totalSaveableFreshTokensEst,
    estimated_fresh_reduction_pct: totalFreshAdjusted > 0
      ? Math.round((totalSaveableFreshTokensEst / totalFreshAdjusted) * 10000) / 100
      : 0,
    estimated_total_prompt_reduction_pct: totalAdjustedPrompt > 0
      ? Math.round((totalSaveableFreshTokensEst / totalAdjustedPrompt) * 10000) / 100
      : 0,
    by_kind: byKind,
    per_broken_turn: perBreakDetails
  };
}

/**
 * Replays a real compact repository bucket through `runAgent` (role=writer by default),
 * capturing every outbound payload and per-turn cache telemetry.
 */
export async function measureWriterBucketReplayCache(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const role = options.role || 'writer';
  const modelOverride = options.modelOverride || 'ag/gemini-3.8-flash-medium';
  const scope = Array.isArray(options.scope) && options.scope.length > 0
    ? options.scope
    : ['core/inpaint_models.py'];
  const maxTurns = Number(options.maxTurns ?? 3);
  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  const tmpSessions = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-writer-cache-'));
  const ownsTmpDir = !options.sessionsDir;

  const taskSeed = {
    task_id: options.taskId || 'T-2026-11-01-010-cache-replay',
    title: 'Inspect LamaInpainter callers and verify SHA-256 metadata in core/inpaint_models.py',
    goal:
      'Execute 3 sequential read-only verification steps across separate turns (Turn 1: read_file on tests/test_inpaint_models.py lines 1-45; Turn 2: search_code for "LamaInpainter" in core/; Turn 3: read_file on core/eraser.py lines 1-40) before outputting a brief SEARCH/REPLACE block for core/inpaint_models.py.',
    constraints: [
      'Run only ONE tool call per turn so Turns 1, 2, and 3 each verify one target sequentially before final output',
      'Keep thinking brief (<50 words) and do NOT modify workspace files'
    ],
    acceptance_criteria: [
      'Verified tests/test_inpaint_models.py, search_code core/, and core/eraser.py imports',
      'Output concise SEARCH/REPLACE proposal'
    ],
    scope
  };

  const scopedContext = buildScopedFilesContext(scope, repoRoot, taskSeed, {
    tokenBudgetPerTask: Number(options.tokenBudgetPerTask ?? 30000)
  });

  const prompt = [
    `CURRENT SCOPED FILE CONTENTS:\n${scopedContext}`,
    `GOAL: ${taskSeed.goal}`,
    `CONSTRAINTS: ${taskSeed.constraints.join('; ')}`,
    `ACCEPTANCE CRITERIA: ${taskSeed.acceptance_criteria.join('; ')}`,
    `Please verify step-by-step (ONE tool call per turn: first read_file on tests/test_inpaint_models.py lines 1-45, next search_code for LamaInpainter in core/, then read_file on core/eraser.py lines 1-40) before outputting a minimal SEARCH/REPLACE block for [${scope.join(', ')}].`
  ].join('\n\n');

  const capturedPayloads = [];
  const baseFetch = options.fetchFn || globalThis.fetch;
  const fetchSpy = async (url, init = {}) => {
    const rawBody = typeof init.body === 'string' ? init.body : '';
    let parsedPayload = {};
    try { parsedPayload = JSON.parse(rawBody); } catch {}
    capturedPayloads.push({
      turnIndex: capturedPayloads.length + 1,
      url: String(url),
      payloadBytes: Buffer.byteLength(rawBody, 'utf8'),
      payload: parsedPayload
    });
    return baseFetch(url, init);
  };

  const startedMs = performance.now();
  try {
    const res = await runAgent({
      role,
      prompt,
      scope,
      modelOverride,
      maxTurns,
      maxThinkingTokens: options.maxThinkingTokens ?? 1024,
      timeoutMs: Number(options.timeoutMs ?? 120000),
      repoRoot,
      sessionsDir: tmpSessions,
      sessionId: `writer-cache-replay-${Date.now().toString(36)}`,
      nineRouterVersion: resolved9RouterVersion,
      stream: true,
      ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
      fetchFn: fetchSpy
    });

    const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;
    const prefixReport = inspectPayloadPrefixInvariance(capturedPayloads);
    const turnUsages = Array.isArray(res.turn_usages) ? res.turn_usages : [];
    const savingsEstimate = estimatePrefixBreakSavings(capturedPayloads, turnUsages, prefixReport);

    const turns = turnUsages.map((tu, idx) => {
      const cap = capturedPayloads[idx];
      const msgCount = Array.isArray(cap?.payload?.messages) ? cap.payload.messages.length : null;
      const toolsCount = Array.isArray(cap?.payload?.tools) ? cap.payload.tools.length : 0;
      const rawPrompt = Number(tu.prompt_tokens_raw ?? tu.prompt_tokens ?? 0);
      const adjPrompt = Number(tu.prompt_tokens_adjusted ?? rawPrompt);
      const cachedTok = tu.cache_reported ? (tu.reported_cached_tokens ?? null) : null;
      return {
        turn: tu.turn ?? (idx + 1),
        stage: tu.stage || 'tool_loop',
        requested_model: tu.requested_model || modelOverride,
        actual_model: tu.actual_model || res.actual_model || null,
        payload_bytes: cap?.payloadBytes ?? null,
        messages_count: msgCount,
        tools_count: toolsCount,
        prompt_tokens_raw: rawPrompt,
        prompt_tokens_adjusted: adjPrompt,
        usage_adjusted_buffer: Number(tu.usage_adjusted_buffer || 0),
        cached_tokens: cachedTok,
        cache_hit_ratio: tu.cache_reported ? (tu.cache_hit_ratio ?? null) : null,
        fresh_tokens: Number(tu.fresh_tokens ?? Math.max(0, adjPrompt - (cachedTok ?? 0))),
        completion_tokens: Number(tu.completion_tokens || 0),
        reasoning_tokens: Number(tu.reasoning_tokens || 0),
        had_inline_think_tag: /<think>[\s\S]*?<\/think>/i.test(String(cap?.payload?.messages?.at(-2)?.content || cap?.payload?.messages?.at(-1)?.content || ''))
      };
    });

    const estTurn1Tokens = capturedPayloads[0]
      ? Math.ceil(capturedPayloads[0].payloadBytes / 4)
      : Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);

    return {
      experiment: 'writer_bucket_cache_and_prefix_invariance',
      checked_at: new Date().toISOString(),
      nine_router_version: resolved9RouterVersion,
      ok: Boolean(res.ok),
      error: res.ok ? null : (res.error || 'unknown error'),
      role,
      model: modelOverride,
      actual_model: res.actual_model || null,
      scope,
      max_turns: maxTurns,
      latency_ms: latencyMs,
      estimated_turn1_tokens: estTurn1Tokens,
      captured_turns: capturedPayloads.length,
      turns,
      prefix_invariance: prefixReport,
      savings_estimate: savingsEstimate
    };
  } finally {
    if (ownsTmpDir) {
      try { fs.rmSync(tmpSessions, { recursive: true, force: true }); } catch {}
    }
  }
}

export function formatWriterCacheMarkdown(report) {
  const lines = [
    `# Writer Bucket Cache Replay (${report.model}, 9Router v${report.nine_router_version})`,
    `Status: ok=${report.ok} | actual_model=${report.actual_model} | est_turn1_tokens=${report.estimated_turn1_tokens} | captured_turns=${report.captured_turns} | prefix_ok=${report.prefix_invariance?.ok}`,
    '',
    '| Turn | Stage | Tools | Msgs | Prompt Raw | Buffer | Prompt Adj | Cached | Fresh | Ratio | Completion |',
    '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
  ];
  for (const t of (report.turns || [])) {
    lines.push(
      `| ${t.turn} | ${t.stage} | ${t.tools_count} | ${t.messages_count ?? '-'} | ${t.prompt_tokens_raw} | ${t.usage_adjusted_buffer} | ${t.prompt_tokens_adjusted} | ${t.cached_tokens ?? 'null'} | ${t.fresh_tokens} | ${t.cache_hit_ratio ?? 'null'} | ${t.completion_tokens} |`
    );
  }
  lines.push('', '## Prefix Invariance Breaks');
  if ((report.prefix_invariance?.breaks || []).length === 0) {
    lines.push('- None');
  } else {
    for (const b of report.prefix_invariance.breaks) {
      lines.push(`- Turn ${b.from_turn} -> ${b.to_turn}: \`${b.kind}\` (${b.likely_source}) — ${b.detail}`);
    }
  }
  const sav = report.savings_estimate || {};
  lines.push(
    '',
    '## Savings Estimate (Unfixed vs Invariant Prefix)',
    `- Methodology: \`${sav.methodology}\``,
    `- Broken turns: ${sav.broken_turns_count} | Recomputed prefix bytes: ${sav.recomputed_prefix_bytes}B (~${sav.estimated_invalidated_prefix_tokens} tok)`,
    `- Observed cache drop across break transitions: ${sav.observed_cache_drop_tokens} tok`,
    `- Estimated fresh tokens saveable per run: ${sav.estimated_tokens_saveable_per_run} tok (${sav.estimated_fresh_reduction_pct}% of fresh, ${sav.estimated_total_prompt_reduction_pct}% of adjusted prompt)`
  );
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const args = {
    live: argv.includes('--live'),
    model: 'ag/gemini-3.8-flash-medium',
    maxTurns: 3,
    out: null
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === '--max-turns' && argv[i + 1]) args.maxTurns = Number(argv[++i]);
    else if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.live) {
    console.error('Usage: node agent-team/scripts/measure-writer-cache.mjs --live [--model ag/gemini-3.8-flash-medium] [--max-turns 2] [--out file.json]');
    process.exit(2);
  }
  const report = await measureWriterBucketReplayCache({
    modelOverride: cli.model,
    maxTurns: cli.maxTurns
  });
  if (cli.out) {
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(formatWriterCacheMarkdown(report));
  console.log('\n--- JSON REPORT ---');
  console.log(JSON.stringify(report, null, 2));
}
