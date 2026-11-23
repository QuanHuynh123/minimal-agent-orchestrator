import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX_PATH_PATTERNS = [
  /^\$\.(request\.)?systemInstruction\b/,
  /^\$\.(request\.)?system\b/,
  /^\$\.(request\.)?tools\b/,
  /^\$\.(request\.)?contents\b/,
  /^\$\.messages\b/
];

/**
 * Analyzes prompt_tokens variance across repeated Gemini completions to test whether
 * prompt_tokens variation equals reasoning_tokens (thoughtsTokenCount) added into
 * prompt_tokens while underlying promptTokenCount remains invariant.
 *
 * @param {Array<Object>} usageRecords
 */
export function analyzeGeminiPromptTokenVariance(usageRecords = []) {
  const samples = [];
  for (const item of usageRecords) {
    const u = item?.raw_usage && typeof item.raw_usage === 'object' ? item.raw_usage : item;
    if (!u || typeof u !== 'object') continue;
    const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? NaN);
    if (!Number.isFinite(promptTokens)) continue;
    const reasoningTokens = Number(
      u.completion_tokens_details?.reasoning_tokens
      ?? u.output_tokens_details?.reasoning_tokens
      ?? u.reasoning_tokens
      ?? 0
    );
    const safeReasoning = Number.isFinite(reasoningTokens) ? reasoningTokens : 0;
    samples.push({
      prompt_tokens: promptTokens,
      completion_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? 0),
      reasoning_tokens: safeReasoning,
      inferred_base_prompt_tokens: promptTokens - safeReasoning
    });
  }

  if (samples.length === 0) {
    return {
      sample_count: 0,
      prompt_tokens_varied: false,
      prompt_tokens_min: null,
      prompt_tokens_max: null,
      base_prompt_invariant: false,
      inferred_base_prompt_tokens: null,
      explained_by_thoughts_in_prompt_tokens: false,
      samples
    };
  }

  const promptVals = samples.map(s => s.prompt_tokens);
  const promptMin = Math.min(...promptVals);
  const promptMax = Math.max(...promptVals);
  const uniqueBase = [...new Set(samples.map(s => s.inferred_base_prompt_tokens))];
  const baseInvariant = uniqueBase.length === 1;
  const promptVaried = promptMax > promptMin;

  return {
    sample_count: samples.length,
    prompt_tokens_varied: promptVaried,
    prompt_tokens_min: promptMin,
    prompt_tokens_max: promptMax,
    base_prompt_invariant: baseInvariant,
    inferred_base_prompt_tokens: baseInvariant ? uniqueBase[0] : null,
    explained_by_thoughts_in_prompt_tokens: promptVaried && baseInvariant,
    samples
  };
}

function collectDiffPaths(a, b, currentPath, diffs) {
  if (Object.is(a, b)) return;

  const isObjA = a !== null && typeof a === 'object';
  const isObjB = b !== null && typeof b === 'object';
  if (!isObjA || !isObjB || Array.isArray(a) !== Array.isArray(b)) {
    diffs.push({ path: currentPath, left: a, right: b });
    return;
  }

  if (Array.isArray(a)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      collectDiffPaths(a[i], b[i], `${currentPath}[${i}]`, diffs);
    }
    return;
  }

  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    collectDiffPaths(a[key], b[key], `${currentPath}.${key}`, diffs);
  }
}

/**
 * Recursively diffs two JSON request payloads and classifies whether any mutation
 * occurs in the cacheable prompt prefix vs trailing metadata / request envelope.
 *
 * @param {Object} payloadA
 * @param {Object} payloadB
 */
export function diffJsonPayloads(payloadA, payloadB) {
  const diffs = [];
  collectDiffPaths(payloadA, payloadB, '$', diffs);
  const changedPaths = diffs.map(d => d.path);

  if (changedPaths.length === 0) {
    return {
      identical: true,
      request_prefix_changed: false,
      change_position: 'identical',
      changed_paths: [],
      diffs: []
    };
  }

  const requestPrefixChanged = changedPaths.some(p =>
    PREFIX_PATH_PATTERNS.some(re => re.test(p))
  );

  return {
    identical: false,
    request_prefix_changed: requestPrefixChanged,
    change_position: requestPrefixChanged ? 'prefix_top' : 'envelope_or_end',
    changed_paths: changedPaths,
    diffs
  };
}

/**
 * Resolves default 9Router request log directories without touching auth or DB files.
 */
export function getDefault9RouterLogDirs() {
  const dirs = [];
  if (process.env.NINE_ROUTER_LOG_DIR) {
    dirs.push(process.env.NINE_ROUTER_LOG_DIR);
  }
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, '9router', 'logs'));
  }
  const home = os.homedir();
  if (home) {
    dirs.push(path.join(home, '.9router', 'logs'));
  }
  return [...new Set(dirs.filter(Boolean))];
}

/**
 * Inspects local 9Router request-log directories for `4_req_target.json` captures
 * and diffs the latest two matching upstream payloads if present.
 *
 * @param {string[]} [logDirs]
 */
export function inspectLocal9RouterRequestLogs(logDirs = getDefault9RouterLogDirs()) {
  const scannedDirs = [];
  const foundFiles = [];

  for (const dir of logDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    scannedDirs.push(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const targetFile = path.join(dir, ent.name, '4_req_target.json');
      if (fs.existsSync(targetFile)) {
        foundFiles.push(targetFile);
      }
    }
  }

  foundFiles.sort();
  if (foundFiles.length < 2) {
    return {
      logs_available: false,
      scanned_dirs: scannedDirs,
      upstream_payloads_found: foundFiles.length,
      pair_diff: null
    };
  }

  const fileA = foundFiles[foundFiles.length - 2];
  const fileB = foundFiles[foundFiles.length - 1];
  const rawA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const rawB = JSON.parse(fs.readFileSync(fileB, 'utf8'));
  const bodyA = rawA?.body && typeof rawA.body === 'object' ? rawA.body : rawA;
  const bodyB = rawB?.body && typeof rawB.body === 'object' ? rawB.body : rawB;

  return {
    logs_available: true,
    scanned_dirs: scannedDirs,
    upstream_payloads_found: foundFiles.length,
    compared_files: [fileA, fileB],
    pair_diff: diffJsonPayloads(bodyA, bodyB)
  };
}
