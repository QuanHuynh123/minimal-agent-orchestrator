import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepoRoot } from '../applier.mjs';
import {
  collectEnvironmentFingerprint,
  compareEnvironmentFingerprints,
  hashString,
  runSingleValidationCheck,
  validateStageChecks
} from '../validator.mjs';
import { resolveEffectiveRisk, RISK_LEVEL_RANK } from './risk-policy.mjs';
import { computeScopeHash } from './task-persistence.mjs';
import {
  DEFAULT_ENOBUFS_CONSECUTIVE_LIMIT,
  DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD,
  evaluateEnobufsQualification,
  isEnobufsFailure,
  isHumanOwnerName
} from './enobufs-diagnostics.mjs';

export const DEFAULT_MAX_BASELINE_FAILURES = 3;
export const BASELINE_RETRY_ROUNDS = 2;
export const DEFAULT_BASELINE_MAX_RUNTIME_SEC = 300;

export function normalizeRelPath(p = '') {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function stableJsonStringify(val) {
  if (val === null || val === undefined || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(v => stableJsonStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(val).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJsonStringify(val[k])}`).join(',')}}`;
}

/**
 * Produces a canonical SHA-256 cache key for env_fingerprint while stripping volatile `checked_at`.
 */
export function canonicalizeFingerprintKey(envFp = null) {
  if (!envFp || typeof envFp !== 'object') return 'no-fp';
  const ort = envFp.onnxruntime || {};
  const normalizedModels = [...(envFp.onnx_models || [])]
    .map(m => ({
      name: m.name || '',
      exists: Boolean(m.exists),
      size_bytes: m.size_bytes ?? null,
      sha256: m.sha256 || null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const canonical = {
    python_path: envFp.python_path || null,
    is_admin: Boolean(envFp.is_admin),
    loopback_bindable: Boolean(envFp.loopback_bindable),
    pip_freeze_hash: envFp.pip_freeze_hash || null,
    platform: envFp.platform || null,
    node_version: envFp.node_version || null,
    onnxruntime: {
      installed: Boolean(ort.installed),
      import_ok: Boolean(ort.import_ok),
      version: ort.version || null,
      providers: Array.isArray(ort.providers) ? [...ort.providers].sort() : []
    },
    onnx_models: normalizedModels
  };
  return crypto.createHash('sha256').update(stableJsonStringify(canonical)).digest('hex');
}

export function resolveConfiguredMaxBaselineFailures(policyConfig = {}) {
  const raw = policyConfig?.policy?.validation?.max_baseline_failures
    ?? policyConfig?.validation?.max_baseline_failures;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_BASELINE_FAILURES;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 0 ? num : DEFAULT_MAX_BASELINE_FAILURES;
}

export function resolveConfiguredEnobufsThreshold(policyConfig = {}) {
  const raw = policyConfig?.policy?.validation?.enobufs_external_socket_threshold
    ?? policyConfig?.validation?.enobufs_external_socket_threshold;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD;
}

export function resolveBaselineMaxRuntimeSec(policyConfig = {}) {
  const raw = policyConfig?.policy?.validation?.max_baseline_runtime_sec
    ?? policyConfig?.validation?.max_baseline_runtime_sec;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_BASELINE_MAX_RUNTIME_SEC;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_BASELINE_MAX_RUNTIME_SEC;
}

/**
 * Evaluates task execution elapsed runtime strictly AFTER baseline preflight finishes,
 * so baseline runtime never consumes `task_modes.<mode>.max_runtime_sec`.
 */
export function evaluateTaskExecutionRuntime({
  executionStartMs,
  nowMs = Date.now(),
  maxRuntimeSec = 180,
  baselineDurationMs = 0
} = {}) {
  const executionElapsedSec = Math.max(0, (Number(nowMs) - Number(executionStartMs)) / 1000);
  const baselineSec = Math.max(0, Number(baselineDurationMs || 0) / 1000);
  const limitSec = Number(maxRuntimeSec || 180);
  return {
    exceeded: executionElapsedSec > limitSec,
    execution_elapsed_sec: Number(executionElapsedSec.toFixed(1)),
    baseline_elapsed_sec: Number(baselineSec.toFixed(1)),
    total_elapsed_sec: Number((executionElapsedSec + baselineSec).toFixed(1)),
    max_runtime_sec: limitSec
  };
}

function collectPolicyStageChecks(policyConfig = {}) {
  const validationCfg = policyConfig?.policy?.validation || policyConfig?.validation || policyConfig?.project?.validation || {};
  const fastChecks = (Array.isArray(validationCfg.fast_checks) ? validationCfg.fast_checks : [])
    .map(c => ({ ...c, stage: 'fast_checks' }));
  const suiteChecks = (Array.isArray(validationCfg.suite_checks) ? validationCfg.suite_checks : [])
    .map(c => ({ ...c, stage: 'suite_checks' }));
  return [...fastChecks, ...suiteChecks];
}

export function inferTestFileFromDottedId(dottedId = '') {
  const clean = String(dottedId || '').split(/\s+\[[^\]]+\]/)[0].trim();
  const parts = clean.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === 'tests' && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}.py`;
  }
  if (parts[0].startsWith('test_')) {
    return `tests/${parts[0]}.py`;
  }
  return null;
}

export function inferTestFileFromCommand(command = '') {
  const cmd = String(command || '');
  const pyMatch = cmd.match(/([\w./\\-]*tests?[\\/][\w./\\-]+\.py)\b/i)
    || cmd.match(/\b(test_[\w]+\.py)\b/i);
  if (pyMatch) return normalizeRelPath(pyMatch[1]);
  const jsMatch = cmd.match(/([\w./\\-]*test-[\w.-]+\.(?:mjs|js|ts))\b/i);
  if (jsMatch) return normalizeRelPath(jsMatch[1]);
  return null;
}

function parseSubtestTargetFile(paramText = '') {
  if (!paramText) return null;
  const m = String(paramText).match(/\bfile\s*=\s*(?:'([^']+)'|"([^"]+)"|([^,\s)\]]+))/);
  if (!m) return null;
  return normalizeRelPath(m[1] || m[2] || m[3] || '');
}

function buildPythonDottedBaseId(methodName = '', rawContext = '') {
  const ctx = String(rawContext || '').trim();
  if (!ctx) return methodName;
  return ctx.endsWith(`.${methodName}`) ? ctx : `${ctx}.${methodName}`;
}

function isRepoWideScannerTest(dottedBaseId = '', command = '', checkName = '') {
  return /test_indentation|tab_indentation/i.test(`${dottedBaseId} ${command} ${checkName}`);
}

/**
 * Extracts normalized `(check_name, test_id)` identities from a validation check output.
 * Repo-wide checks emit granular per-file `subTest` / violation items so failures on one
 * file never mask a new failure on another file. Never keys by `error_hash`.
 */
export function extractCheckFailureIdentities(checkRes = {}) {
  if (!checkRes || checkRes.ok !== false) return [];
  const checkName = String(checkRes.checkName || checkRes.check_name || 'unnamed_check');
  const command = String(checkRes.command || '');
  const combined = String(checkRes.errorCombined || '');
  const fallbackCmdTestFile = inferTestFileFromCommand(command);

  const items = [];
  const seenKeys = new Set();
  const pushItem = (entry) => {
    const testId = String(entry.test_id || '__check__').trim();
    const key = `${checkName}::${testId}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    items.push({
      check_name: checkName,
      test_id: testId,
      failure_key: key,
      test_file: entry.test_file ? normalizeRelPath(entry.test_file) : fallbackCmdTestFile,
      target_file: entry.target_file ? normalizeRelPath(entry.target_file) : null,
      stage: checkRes.stage || null,
      command: command || null,
      ...(combined ? { error_excerpt: combined.slice(0, 600) } : {}),
      ...(checkRes.socket_diagnostics ? { socket_diagnostics: checkRes.socket_diagnostics } : {})
    });
  };

  // Split Python unittest detailed failure/error sections:
  // `FAIL: test_method (tests.mod.Class.test_method) (file='core/foo.py')`
  // or `FAIL: test_method (tests.mod.Class) [file=core/foo.py]`
  const headerRegex = /^(FAIL|ERROR):\s+([^\s(]+)\s+\(([^)]+)\)(?:\s+\(([^)]+)\)|\s+\[([^\]]+)\])?\s*$/gm;
  const matches = [...combined.matchAll(headerRegex)];

  if (matches.length > 0) {
    for (let idx = 0; idx < matches.length; idx++) {
      const m = matches[idx];
      const methodName = m[2];
      const rawCtx = m[3];
      const paramStr = m[4] || m[5] || '';
      const dottedBase = buildPythonDottedBaseId(methodName, rawCtx);
      const testFile = inferTestFileFromDottedId(dottedBase) || fallbackCmdTestFile;
      const targetFile = parseSubtestTargetFile(paramStr);

      if (targetFile) {
        pushItem({
          test_id: `${dottedBase} [file=${targetFile}]`,
          test_file: testFile,
          target_file: targetFile
        });
        continue;
      }

      // Repo-wide fallback: extract per-file violation lines inside this block if subTest param was omitted
      const blockStart = m.index + m[0].length;
      const blockEnd = idx + 1 < matches.length ? matches[idx + 1].index : combined.length;
      const blockBody = combined.slice(blockStart, blockEnd);
      if (isRepoWideScannerTest(dottedBase, command, checkName)) {
        const vioMatches = [...blockBody.matchAll(/^\s*([\w./\\-]+\.py):\d+:/gm)]
          .map(vm => normalizeRelPath(vm[1]))
          .filter(Boolean);
        const uniqueVios = [...new Set(vioMatches)];
        if (uniqueVios.length > 0) {
          for (const vf of uniqueVios) {
            pushItem({
              test_id: `${dottedBase} [violation=${vf}]`,
              test_file: testFile,
              target_file: vf
            });
          }
          continue;
        }
      }

      pushItem({
        test_id: dottedBase,
        test_file: testFile,
        target_file: null
      });
    }
    return items;
  }

  // Node.js / JS explicit failure lines (`not ok 1 - ...` or `FAIL <id>`)
  const nodeNotOkMatches = [...combined.matchAll(/^not ok \d+\s*-\s*(.+)$/gm)];
  if (nodeNotOkMatches.length > 0) {
    for (const nm of nodeNotOkMatches) {
      pushItem({
        test_id: nm[1].trim(),
        test_file: fallbackCmdTestFile,
        target_file: null
      });
    }
    return items;
  }

  pushItem({
    test_id: '__check__',
    test_file: fallbackCmdTestFile,
    target_file: null
  });
  return items;
}

function stripTestSubtestSuffix(testId = '') {
  return String(testId || '').replace(/\s+\[(?:file|violation)=[^\]]+\]$/, '').trim();
}

export function buildTargetedUnittestCommand(rawCmd = '', targetTestIds = []) {
  if (!Array.isArray(targetTestIds) || targetTestIds.length === 0) return null;
  if (!/-m\s+unittest\s+discover\b/i.test(rawCmd)) return null;
  const startMatch = rawCmd.match(/(?:^|\s)-s\s+['"]?([a-zA-Z_][\w./\\-]*)['"]?/);
  const startPkg = startMatch
    ? startMatch[1].replace(/[/\\]+/g, '.').replace(/^\.+|\.+$/g, '')
    : '';
  const cleanBases = [...new Set(
    targetTestIds
      .map(stripTestSubtestSuffix)
      .filter(id => /^[a-zA-Z_][\w.]*$/.test(id))
      .map(id => (startPkg && !id.startsWith(`${startPkg}.`) ? `${startPkg}.${id}` : id))
  )];
  if (cleanBases.length === 0) return null;
  const idx = rawCmd.search(/-m\s+unittest\s+discover\b/i);
  const pyPrefix = rawCmd.slice(0, idx).trim();
  return `${pyPrefix} -m unittest -v ${cleanBases.join(' ')}`;
}

function resolvePythonModuleToRelPath(moduleName, currentDirRel, repoRoot) {
  const leadingDotsMatch = String(moduleName || '').match(/^(\.+)(.*)$/);
  let candidates = [];
  if (leadingDotsMatch) {
    const upLevels = leadingDotsMatch[1].length - 1;
    let baseParts = currentDirRel ? currentDirRel.split('/').filter(Boolean) : [];
    if (upLevels > 0) baseParts = baseParts.slice(0, Math.max(0, baseParts.length - upLevels));
    const modParts = leadingDotsMatch[2] ? leadingDotsMatch[2].split('.').filter(Boolean) : [];
    const combined = [...baseParts, ...modParts].join('/');
    if (combined) {
      candidates.push(`${combined}.py`, `${combined}/__init__.py`);
    }
  } else {
    const slashPath = String(moduleName || '').replace(/\./g, '/');
    if (slashPath) {
      candidates.push(`${slashPath}.py`, `${slashPath}/__init__.py`);
    }
  }
  for (const rel of candidates) {
    const norm = normalizeRelPath(rel);
    if (fs.existsSync(path.join(repoRoot, norm))) {
      return norm;
    }
  }
  return null;
}

export function extractDirectStaticImports(fileRelPath, repoRoot) {
  const absPath = path.join(repoRoot, fileRelPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return [];
  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const currentDir = normalizeRelPath(path.posix.dirname(normalizeRelPath(fileRelPath)));
  const resolved = new Set();

  if (fileRelPath.endsWith('.py')) {
    for (const line of content.split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith('#')) continue;
      const fromMatch = stripped.match(/^from\s+(\.+[\w.]*|[\w.]+)\s+import\s+(.+)$/);
      if (fromMatch) {
        const modTarget = resolvePythonModuleToRelPath(fromMatch[1], currentDir, repoRoot);
        if (modTarget) resolved.add(modTarget);
        const importedNames = fromMatch[2].replace(/[()]/g, '').split(',');
        for (const rawSym of importedNames) {
          const sym = rawSym.trim().split(/\s+as\s+/)[0].trim();
          if (!sym || sym === '*') continue;
          const subMod = fromMatch[1].endsWith('.') ? `${fromMatch[1]}${sym}` : `${fromMatch[1]}.${sym}`;
          const subTarget = resolvePythonModuleToRelPath(subMod, currentDir, repoRoot);
          if (subTarget) resolved.add(subTarget);
        }
        continue;
      }
      const impMatch = stripped.match(/^import\s+(.+)$/);
      if (impMatch) {
        for (const rawMod of impMatch[1].split(',')) {
          const mod = rawMod.trim().split(/\s+as\s+/)[0].trim();
          if (!mod) continue;
          const modTarget = resolvePythonModuleToRelPath(mod, currentDir, repoRoot);
          if (modTarget) resolved.add(modTarget);
        }
      }
    }
  } else if (/\.(?:mjs|js|ts)$/.test(fileRelPath)) {
    const jsRe = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
    for (const m of content.matchAll(jsRe)) {
      const joined = normalizeRelPath(path.posix.join(currentDir === '.' ? '' : currentDir, m[1]));
      for (const cand of [joined, `${joined}.mjs`, `${joined}.js`, `${joined}/index.mjs`]) {
        if (fs.existsSync(path.join(repoRoot, cand))) {
          resolved.add(cand);
          break;
        }
      }
    }
  }

  return [...resolved];
}

function findNamingConventionTargets(testFileRel, repoRoot) {
  const targets = new Set();
  const normTest = normalizeRelPath(testFileRel);
  const pyMatch = normTest.match(/(?:^|\/)test_([\w]+)\.py$/);
  if (pyMatch) {
    const stem = pyMatch[1];
    for (const dir of ['src', 'app', 'lib', 'core', 'api', '']) {
      const rel = dir ? `${dir}/${stem}.py` : `${stem}.py`;
      if (fs.existsSync(path.join(repoRoot, rel))) {
        targets.add(rel);
      }
    }
  }
  const jsMatch = normTest.match(/(?:^|\/)test-([\w.-]+)\.(mjs|js)$/);
  if (jsMatch) {
    const stem = jsMatch[1];
    const ext = jsMatch[2];
    const dir = path.posix.dirname(normTest);
    for (const rel of [`${dir}/${stem}.${ext}`, `${dir}/lib/${stem}.${ext}`]) {
      const clean = normalizeRelPath(rel);
      if (fs.existsSync(path.join(repoRoot, clean))) {
        targets.add(clean);
      }
    }
  }
  return [...targets];
}

function pathMatchesScope(relPath, scopeList = []) {
  const norm = normalizeRelPath(relPath);
  if (!norm) return false;
  for (const rawScope of scopeList) {
    const s = normalizeRelPath(rawScope);
    if (!s) continue;
    if (s.endsWith('/')) {
      if (norm.startsWith(s) || norm === s.slice(0, -1)) return true;
    } else if (norm === s || norm.startsWith(`${s}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Maps a failing check/test `(check_name, test_id)` to `task.scope` via:
 *  1) Granular subTest / violation `target_file` (for repo-wide checks like test_indentation)
 *  2) Naming convention (`tests/test_x.py` <-> `core/x.py`, `ui/x.py`, ...)
 *  3) Transitive static import graph (`test_x.py` -> `core/pipeline.py` -> `core/shared_helper.py`)
 * Missing/unresolvable mapping ALWAYS defaults to `in_scope: true` (fail-safe: NEVER preexisting).
 */
export function mapFailureToScope(failureItem = {}, taskScope = [], repoRoot = resolveRepoRoot()) {
  const scopeList = Array.isArray(taskScope) ? taskScope : [];
  const resolvedRoot = repoRoot || resolveRepoRoot();
  const testFile = failureItem.test_file
    ? normalizeRelPath(failureItem.test_file)
    : inferTestFileFromDottedId(failureItem.test_id);

  if (testFile && pathMatchesScope(testFile, scopeList)) {
    return {
      in_scope: true,
      mapping_status: 'test_file_in_scope',
      mapped_targets: [testFile]
    };
  }

  if (failureItem.target_file) {
    const targetNorm = normalizeRelPath(failureItem.target_file);
    const matches = pathMatchesScope(targetNorm, scopeList);
    return {
      in_scope: matches,
      mapping_status: matches ? 'subtest_target_in_scope' : 'subtest_target_out_of_scope',
      mapped_targets: [targetNorm]
    };
  }

  if (!testFile || !fs.existsSync(path.join(resolvedRoot, testFile))) {
    return {
      in_scope: true,
      mapping_status: 'unmapped_in_scope',
      mapped_targets: []
    };
  }

  const mappedTargets = new Set(findNamingConventionTargets(testFile, resolvedRoot));
  const queue = [testFile];
  const visited = new Set([testFile]);
  while (queue.length > 0) {
    const current = queue.shift();
    const deps = extractDirectStaticImports(current, resolvedRoot);
    for (const dep of deps) {
      mappedTargets.add(dep);
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  if (mappedTargets.size === 0) {
    return {
      in_scope: true,
      mapping_status: 'unmapped_in_scope',
      mapped_targets: []
    };
  }

  const targetArr = [...mappedTargets];
  const overlap = targetArr.some(t => pathMatchesScope(t, scopeList));
  return {
    in_scope: overlap,
    mapping_status: overlap ? 'mapped_in_scope' : 'mapped_out_of_scope',
    mapped_targets: targetArr
  };
}

function matchKnownFailureRule(item = {}, rule = {}) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.failure_key && item.failure_key === rule.failure_key) return true;
  if (rule.check_name && rule.check_name !== '*' && rule.check_name !== item.check_name) return false;
  if (rule.test_id && rule.test_id !== item.test_id) return false;
  if (rule.test_id_contains && !String(item.test_id || '').includes(rule.test_id_contains)) return false;
  if (rule.target_file && normalizeRelPath(rule.target_file) !== normalizeRelPath(item.target_file || '')) return false;
  if (rule.error_pattern) {
    const haystack = `${item.error_excerpt || ''}\n${item.test_id || ''}\n${item.id || ''}`;
    try {
      const re = new RegExp(rule.error_pattern, 'i');
      if (!re.test(haystack)) return false;
    } catch {
      if (!haystack.toLowerCase().includes(String(rule.error_pattern).toLowerCase())) return false;
    }
  }
  return Boolean(
    rule.failure_key ||
    rule.test_id ||
    rule.test_id_contains ||
    rule.target_file ||
    rule.error_pattern ||
    (rule.check_name && rule.check_name !== '*')
  );
}

function collectConfiguredFlakyRules(task = {}, policyConfig = {}) {
  return [
    ...(Array.isArray(task?.flaky_baseline_failures) ? task.flaky_baseline_failures : []),
    ...(Array.isArray(policyConfig?.policy?.validation?.flaky_baseline_failures) ? policyConfig.policy.validation.flaky_baseline_failures : []),
    ...(Array.isArray(policyConfig?.validation?.flaky_baseline_failures) ? policyConfig.validation.flaky_baseline_failures : [])
  ].filter(r => r && typeof r === 'object');
}

function findMatchingRule(item = {}, rules = []) {
  for (const rule of rules) {
    if (matchKnownFailureRule(item, rule)) return rule;
  }
  return null;
}

/**
 * Looks up EXPLICIT `owner` + `due_at` from task/policy `known_failures` and `flaky_baseline_failures`.
 * Returns null unless non-empty `owner` AND `due_at` were genuinely provided (never fabricates Gate 5 metadata).
 */
export function resolveConfiguredKnownFailureMeta(item = {}, task = {}, policyConfig = {}) {
  const candidates = [
    ...(Array.isArray(task?.known_failures) ? task.known_failures : []),
    ...(Array.isArray(policyConfig?.policy?.validation?.known_failures) ? policyConfig.policy.validation.known_failures : []),
    ...(Array.isArray(policyConfig?.validation?.known_failures) ? policyConfig.validation.known_failures : []),
    ...collectConfiguredFlakyRules(task, policyConfig)
  ];
  const rule = findMatchingRule(item, candidates);
  if (rule) {
    const owner = typeof rule.owner === 'string' ? rule.owner.trim() : '';
    const dueAt = typeof rule.due_at === 'string' ? rule.due_at.trim() : '';
    if (owner && dueAt) {
      return { owner, due_at: dueAt };
    }
    return { owner: owner || null, due_at: dueAt || null };
  }
  const directOwner = typeof item.owner === 'string' ? item.owner.trim() : '';
  const directDue = typeof item.due_at === 'string' ? item.due_at.trim() : '';
  if (directOwner && directDue) {
    return { owner: directOwner, due_at: directDue };
  }
  return { owner: directOwner || null, due_at: directDue || null };
}

function computeDefaultFlakyDueDate(slaDays = 7) {
  return new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildFlakyEntry(item, failCount, task = {}, policyConfig = {}) {
  const configured = resolveConfiguredKnownFailureMeta(item, task, policyConfig);
  const valCfg = policyConfig?.policy?.validation || policyConfig?.validation || {};
  const fallbackOwner = typeof valCfg.default_flaky_owner === 'string' && valCfg.default_flaky_owner.trim()
    ? valCfg.default_flaky_owner.trim()
    : 'triage-needed';
  const fallbackDue = typeof valCfg.default_flaky_due_at === 'string' && valCfg.default_flaky_due_at.trim()
    ? valCfg.default_flaky_due_at.trim()
    : computeDefaultFlakyDueDate(7);
  return {
    ...item,
    fail_count: failCount,
    total_runs: 1 + BASELINE_RETRY_ROUNDS,
    owner: configured.owner || fallbackOwner,
    due_at: configured.due_at || fallbackDue,
    owner_assigned: Boolean(configured.owner && configured.due_at)
  };
}

function mergeConfiguredFlakyWatches(runtimeFlaky = [], task = {}, policyConfig = {}) {
  const rules = collectConfiguredFlakyRules(task, policyConfig);
  if (rules.length === 0) return runtimeFlaky;
  const merged = [...runtimeFlaky];
  for (const rule of rules) {
    const alreadyPresent = merged.some(item => matchKnownFailureRule(item, rule));
    if (alreadyPresent) continue;
    const owner = typeof rule.owner === 'string' && rule.owner.trim() ? rule.owner.trim() : 'triage-needed';
    const dueAt = typeof rule.due_at === 'string' && rule.due_at.trim() ? rule.due_at.trim() : computeDefaultFlakyDueDate(7);
    merged.push({
      id: rule.id || rule.test_id || 'flaky_watch',
      check_name: rule.check_name || '*',
      test_id: rule.test_id || rule.error_pattern || rule.id || 'flaky_watch',
      ...(rule.error_pattern ? { error_pattern: rule.error_pattern } : {}),
      fail_count: Number.isInteger(rule.fail_count) ? rule.fail_count : 0,
      total_runs: 1 + BASELINE_RETRY_ROUNDS,
      owner,
      due_at: dueAt,
      owner_assigned: Boolean(rule.owner && rule.due_at),
      ...(rule.note ? { note: rule.note } : {})
    });
  }
  return merged;
}

export function formatFlakyBaselineReport(flakyList = []) {
  if (!Array.isArray(flakyList) || flakyList.length === 0) {
    return '[Validator] Flaky baseline tests: none.';
  }
  const items = flakyList.map(
    f => `${f.check_name}::${f.test_id} (${f.fail_count}/${f.total_runs} red | owner: ${f.owner}, due_at: ${f.due_at})`
  );
  return `[Validator] Flaky baseline tests detected (${flakyList.length}): ${items.join('; ')}`;
}

function readGitHeadShaSafe(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim() || null;
  } catch {
    return null;
  }
}

function readBaselineCacheSafe(cacheFile) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return { entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {}
  return { entries: {} };
}

function writeBaselineCacheSafe(cacheFile, cacheObj) {
  if (!cacheFile) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const keys = Object.keys(cacheObj.entries || {});
    if (keys.length > 20) {
      const sorted = keys.sort((a, b) => String(cacheObj.entries[b]?.cached_at || '').localeCompare(String(cacheObj.entries[a]?.cached_at || '')));
      for (const staleKey of sorted.slice(20)) {
        delete cacheObj.entries[staleKey];
      }
    }
    const tmp = `${cacheFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cacheObj, null, 2), 'utf8');
    fs.renameSync(tmp, cacheFile);
  } catch {}
}

function computeChecksSignature(checks = []) {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify(checks.map(c => ({ name: c.name, run: c.run, stage: c.stage }))))
    .digest('hex');
}

const BASELINE_DEPS_EXCLUDED_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  '.env',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.agents',
  'agent-team',
  'docs',
  'artifacts',
  'patches'
]);

const BASELINE_DEPS_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.txt'
]);

export function computeBaselineDepsHash(repoRoot, allChecks = [], policyConfig = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(`checks:${computeChecksSignature(allChecks)}\n`);
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    hash.update('missing-root\n');
    return hash.digest('hex');
  }

  const rawExcludes = policyConfig?.policy?.scope_control?.context_exclude
    || policyConfig?.scope_control?.context_exclude
    || [];
  const customExcludes = (Array.isArray(rawExcludes) ? rawExcludes : [])
    .map(p => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);

  const collectedFiles = new Set();
  const MAX_DEP_FILE_BYTES = 2 * 1024 * 1024;
  const isExcludedRel = (rel) => {
    const firstSeg = rel.split('/')[0];
    if (BASELINE_DEPS_EXCLUDED_DIRS.has(firstSeg)) return true;
    return customExcludes.some(ex => rel === ex || rel.startsWith(`${ex}/`));
  };

  const walk = (absDir, relPrefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (isExcludedRel(rel)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (BASELINE_DEPS_EXCLUDED_DIRS.has(ent.name)) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!BASELINE_DEPS_EXTENSIONS.has(ext)) continue;
        try {
          const st = fs.statSync(abs);
          if (st.size <= MAX_DEP_FILE_BYTES) {
            collectedFiles.add(rel);
          }
        } catch {}
      }
    }
  };
  walk(repoRoot, '');

  // Also trace static imports starting from any discovered test files (bounded BFS)
  const queue = [...collectedFiles].filter(f => f.startsWith('tests/') && f.endsWith('.py'));
  const visited = new Set(queue);
  while (queue.length > 0 && visited.size < 500) {
    const cur = queue.shift();
    for (const dep of extractDirectStaticImports(cur, repoRoot)) {
      const normDep = String(dep || '').replace(/\\/g, '/');
      if (!normDep || isExcludedRel(normDep)) continue;
      collectedFiles.add(normDep);
      if (!visited.has(normDep)) {
        visited.add(normDep);
        queue.push(normDep);
      }
    }
  }

  const sortedFiles = Array.from(collectedFiles).sort();
  for (const rel of sortedFiles) {
    const abs = path.join(repoRoot, rel);
    try {
      const contentBuf = fs.readFileSync(abs);
      const fileDigest = crypto.createHash('sha256').update(contentBuf).digest('hex');
      hash.update(`${rel}\0${fileDigest}\n`);
    } catch {}
  }
  return hash.digest('hex');
}

async function defaultExecuteCheck(check, ctx, policyConfig) {
  const effectiveCmd = buildTargetedUnittestCommand(check.run, ctx.targetTestIds) || check.run;
  const checkToRun = effectiveCmd === check.run ? check : { ...check, run: effectiveCmd };
  const fp = ctx.envFingerprint || await collectEnvironmentFingerprint(policyConfig);
  return runSingleValidationCheck(checkToRun, check.stage || 'suite_checks', policyConfig, fp);
}

/**
 * Runs baseline validation protocol:
 *  - Cache lookup by (HEAD sha, env_fingerprint excluding checked_at)
 *  - Run 1: full suite once; Rounds 2 & 3: re-run ONLY initially red checks/tests
 *  - 3/3 red -> baseline_failures; 1-2/3 red -> flaky_baseline_failures (with owner & due_at)
 *  - Fail-closed on environment_mismatch or baseline_failures.length > max_baseline_failures
 */
export async function runBaselinePreflight({
  policyConfig = {},
  repoRoot = resolveRepoRoot(policyConfig),
  task = {},
  stateDir = null,
  cacheFile = null,
  headSha = undefined,
  depsHash = undefined,
  collectFingerprintFn = null,
  runCheckFn = null,
  nowFn = Date.now,
  maxBaselineRuntimeMs = null
} = {}) {
  const getNowMs = typeof nowFn === 'function' ? nowFn : Date.now;
  const baselineStartMs = getNowMs();
  const maxBaselineSec = resolveBaselineMaxRuntimeSec(policyConfig);
  const resolvedMaxBaselineMs = maxBaselineRuntimeMs !== null && Number.isFinite(Number(maxBaselineRuntimeMs))
    ? Math.max(0, Number(maxBaselineRuntimeMs))
    : (maxBaselineSec * 1000);

  const resolvedRoot = repoRoot || resolveRepoRoot(policyConfig);
  const resolvedHeadSha = headSha !== undefined ? headSha : readGitHeadShaSafe(resolvedRoot);
  const resolvedCacheFile = cacheFile || (stateDir ? path.join(stateDir, 'baseline-cache.json') : null);
  const maxBaselineFailures = resolveConfiguredMaxBaselineFailures(policyConfig);
  const allChecks = collectPolicyStageChecks(policyConfig);
  const resolvedDepsHash = depsHash !== undefined ? depsHash : computeBaselineDepsHash(resolvedRoot, allChecks, policyConfig);

  const fpCollector = collectFingerprintFn || (async () => collectEnvironmentFingerprint(policyConfig));
  const currentFp = await fpCollector();

  if (allChecks.length === 0) {
    return {
      ok: true,
      skipped: true,
      blocked: false,
      cacheHit: false,
      duration_ms: Math.max(0, getNowMs() - baselineStartMs),
      head_sha: resolvedHeadSha,
      deps_hash: resolvedDepsHash,
      baseline_fingerprint: currentFp,
      baseline_failures: [],
      flaky_baseline_failures: [],
      max_baseline_failures: maxBaselineFailures
    };
  }

  const fpKey = canonicalizeFingerprintKey(currentFp);
  const checksSig = computeChecksSignature(allChecks);
  const cacheKey = resolvedDepsHash ? `deps-${resolvedDepsHash}::${fpKey}` : null;

  if (resolvedCacheFile && cacheKey) {
    const cache = readBaselineCacheSafe(resolvedCacheFile);
    const hit = cache.entries[cacheKey];
    if (hit && hit.checks_signature === checksSig) {
      const cachedBaseline = (hit.baseline_failures || []).map(item => {
        const meta = resolveConfiguredKnownFailureMeta(item, task, policyConfig);
        return { ...item, owner: meta.owner || item.owner || null, due_at: meta.due_at || item.due_at || null };
      });
      const cachedFlaky = mergeConfiguredFlakyWatches(
        (hit.flaky_baseline_failures || []).map(item => buildFlakyEntry(item, item.fail_count, task, policyConfig)),
        task,
        policyConfig
      );
      if (cachedBaseline.length > maxBaselineFailures) {
        return {
          ok: false,
          blocked: true,
          cacheHit: true,
          duration_ms: Math.max(0, getNowMs() - baselineStartMs),
          reason: 'baseline_limit_exceeded',
          message: `Baseline failures (${cachedBaseline.length}) exceed max_baseline_failures (${maxBaselineFailures}). Fix repo baseline before running tasks.`,
          head_sha: resolvedHeadSha,
          deps_hash: resolvedDepsHash,
          baseline_fingerprint: hit.baseline_fingerprint || currentFp,
          baseline_failures: cachedBaseline,
          flaky_baseline_failures: cachedFlaky,
          max_baseline_failures: maxBaselineFailures
        };
      }
      return {
        ok: true,
        blocked: false,
        cacheHit: true,
        duration_ms: Math.max(0, getNowMs() - baselineStartMs),
        head_sha: resolvedHeadSha,
        deps_hash: resolvedDepsHash,
        baseline_fingerprint: hit.baseline_fingerprint || currentFp,
        baseline_failures: cachedBaseline,
        flaky_baseline_failures: cachedFlaky,
        max_baseline_failures: maxBaselineFailures
      };
    }
  }

  const execCheck = runCheckFn
    ? (check, ctx) => runCheckFn(check, ctx)
    : (check, ctx) => defaultExecuteCheck(check, ctx, policyConfig);

  let baselineFp = currentFp;
  const checkBaselineRuntimeExceeded = (stageLabel) => {
    const elapsedMs = Math.max(0, getNowMs() - baselineStartMs);
    if (elapsedMs > resolvedMaxBaselineMs) {
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const limitSec = (resolvedMaxBaselineMs / 1000).toFixed(1);
      return {
        ok: false,
        blocked: true,
        cacheHit: false,
        reason: 'baseline_timeout',
        duration_ms: elapsedMs,
        max_baseline_runtime_sec: resolvedMaxBaselineMs / 1000,
        message: `Baseline preflight exceeded max_baseline_runtime_sec (${elapsedSec}s > ${limitSec}s) during ${stageLabel}.`,
        head_sha: resolvedHeadSha,
        baseline_fingerprint: baselineFp,
        baseline_failures: [],
        flaky_baseline_failures: [],
        max_baseline_failures: maxBaselineFailures
      };
    }
    return null;
  };
  const roundFailuresByCheck = new Map(); // checkName -> Array<Set<failure_key>>
  const enobufsDiagByCheck = new Map(); // checkName -> last non-null socket_diagnostics
  const enobufsRoundsByCheck = new Map(); // checkName -> Array<boolean>
  const failureRegistry = new Map(); // failure_key -> item metadata
  const initiallyRedChecks = [];

  // Round 1: full run across all fast_checks + suite_checks
  for (const check of allChecks) {
    const preBudgetStop = checkBaselineRuntimeExceeded(`round 1 before "${check.name}"`);
    if (preBudgetStop) return preBudgetStop;
    const res = await execCheck(check, { round: 1, envFingerprint: baselineFp });
    const postBudgetStop = checkBaselineRuntimeExceeded(`round 1 after "${check.name}"`);
    if (postBudgetStop) return postBudgetStop;
    const runFp = res?.env_fingerprint || baselineFp;
    if (runFp && baselineFp) {
      const cmp = compareEnvironmentFingerprints(baselineFp, runFp);
      if (!cmp.matched) {
        return {
          ok: false,
          blocked: true,
          cacheHit: false,
          reason: 'environment_mismatch',
          message: `[Validator] FAIL-CLOSED: Baseline round 1 detected environment_mismatch (${cmp.mismatch_fields.join(', ')})`,
          head_sha: resolvedHeadSha,
          baseline_fingerprint: baselineFp,
          baseline_failures: [],
          flaky_baseline_failures: [],
          max_baseline_failures: maxBaselineFailures
        };
      }
    }
    if (!baselineFp && runFp) baselineFp = runFp;

    if (res?.socket_diagnostics) {
      enobufsDiagByCheck.set(check.name, res.socket_diagnostics);
    }
    const round1Enobufs = res?.ok === false && isEnobufsFailure(res?.errorCombined || '');
    enobufsRoundsByCheck.set(check.name, [round1Enobufs]);

    const extracted = extractCheckFailureIdentities({ ...res, checkName: check.name, command: check.run, stage: check.stage });
    if (extracted.length > 0) {
      initiallyRedChecks.push({ check, targetTestIds: extracted.map(x => x.test_id) });
      for (const item of extracted) {
        failureRegistry.set(item.failure_key, item);
      }
    }
    roundFailuresByCheck.set(check.name, [new Set(extracted.map(x => x.failure_key))]);
  }

  // Rounds 2 & 3: ONLY re-run initially red checks/tests
  if (initiallyRedChecks.length > 0) {
    for (let round = 2; round <= 1 + BASELINE_RETRY_ROUNDS; round++) {
      for (const entry of initiallyRedChecks) {
        const preRetryStop = checkBaselineRuntimeExceeded(`round ${round} before "${entry.check.name}"`);
        if (preRetryStop) return preRetryStop;
        const res = await execCheck(entry.check, {
          round,
          targetTestIds: entry.targetTestIds,
          envFingerprint: baselineFp
        });
        const postRetryStop = checkBaselineRuntimeExceeded(`round ${round} after "${entry.check.name}"`);
        if (postRetryStop) return postRetryStop;
        const runFp = res?.env_fingerprint || null;
        if (runFp && baselineFp) {
          const cmp = compareEnvironmentFingerprints(baselineFp, runFp);
          if (!cmp.matched) {
            return {
              ok: false,
              blocked: true,
              cacheHit: false,
              reason: 'environment_mismatch',
              message: `[Validator] FAIL-CLOSED: Baseline retry round ${round} detected environment_mismatch (${cmp.mismatch_fields.join(', ')})`,
              head_sha: resolvedHeadSha,
              baseline_fingerprint: baselineFp,
              baseline_failures: [],
              flaky_baseline_failures: [],
              max_baseline_failures: maxBaselineFailures
            };
          }
        }
        if (res?.socket_diagnostics && !enobufsDiagByCheck.has(entry.check.name)) {
          enobufsDiagByCheck.set(entry.check.name, res.socket_diagnostics);
        }
        const roundEnobufs = res?.ok === false && isEnobufsFailure(res?.errorCombined || '');
        enobufsRoundsByCheck.get(entry.check.name).push(roundEnobufs);

        const extracted = extractCheckFailureIdentities({ ...res, checkName: entry.check.name, command: entry.check.run, stage: entry.check.stage });
        for (const item of extracted) {
          const prev = failureRegistry.get(item.failure_key);
          failureRegistry.set(item.failure_key, {
            ...item,
            ...(prev?.socket_diagnostics && !item.socket_diagnostics ? { socket_diagnostics: prev.socket_diagnostics } : {})
          });
        }
        roundFailuresByCheck.get(entry.check.name).push(new Set(extracted.map(x => x.failure_key)));
      }
    }
  }

  const baseline_failures = [];
  const flaky_baseline_failures_raw = [];
  const configuredFlakyRules = collectConfiguredFlakyRules(task, policyConfig);
  const enobufsThreshold = resolveConfiguredEnobufsThreshold(policyConfig);

  for (const [failureKey, item] of failureRegistry.entries()) {
    const rounds = roundFailuresByCheck.get(item.check_name) || [];
    let failCount = 0;
    for (const s of rounds) {
      if (s.has(failureKey)) failCount++;
    }

    const enobufsFlags = enobufsRoundsByCheck.get(item.check_name) || [];
    const itemIsEnobufs = enobufsFlags.some(Boolean)
      || isEnobufsFailure(`${item.error_excerpt || ''}\n${item.test_id || ''}`);

    if (itemIsEnobufs) {
      const sockDiag = item.socket_diagnostics || enobufsDiagByCheck.get(item.check_name) || null;
      const isolatedRetryPassed = failCount < (1 + BASELINE_RETRY_ROUNDS);
      const consecutiveEnobufsCount = enobufsFlags.length > 0
        ? enobufsFlags.filter(Boolean).length
        : failCount;
      const qual = evaluateEnobufsQualification({
        isolatedRetryPassed,
        socketDiagnostics: sockDiag,
        threshold: enobufsThreshold,
        testPids: [process.pid],
        consecutiveCount: consecutiveEnobufsCount,
        consecutiveLimit: 1 + BASELINE_RETRY_ROUNDS
      });

      if (qual.blocked) {
        return {
          ok: false,
          blocked: true,
          cacheHit: false,
          reason: qual.reason,
          message: `[Validator] FAIL-CLOSED: ${item.check_name} ENOBUFS blocked (${qual.reason})`,
          head_sha: resolvedHeadSha,
          baseline_fingerprint: baselineFp,
          baseline_failures: [{ ...item, owner: null, due_at: null }],
          flaky_baseline_failures: [],
          max_baseline_failures: maxBaselineFailures
        };
      }

      const flakyEntry = buildFlakyEntry(item, failCount, task, policyConfig);
      flakyEntry.isolated_retry_passed = true;
      flakyEntry.external_socket_pressure = qual.external_pressure;
      flaky_baseline_failures_raw.push(flakyEntry);
      continue;
    }

    const matchesFlakyRule = Boolean(findMatchingRule(item, configuredFlakyRules));
    if (failCount === 1 + BASELINE_RETRY_ROUNDS && !matchesFlakyRule) {
      const meta = resolveConfiguredKnownFailureMeta(item, task, policyConfig);
      baseline_failures.push({
        ...item,
        owner: meta.owner,
        due_at: meta.due_at
      });
    } else if (failCount >= 1) {
      flaky_baseline_failures_raw.push(buildFlakyEntry(item, failCount, task, policyConfig));
    }
  }
  const flaky_baseline_failures = mergeConfiguredFlakyWatches(flaky_baseline_failures_raw, task, policyConfig);

  if (resolvedCacheFile && cacheKey) {
    const cache = readBaselineCacheSafe(resolvedCacheFile);
    cache.entries[cacheKey] = {
      head_sha: resolvedHeadSha,
      deps_hash: resolvedDepsHash,
      fingerprint_key: canonicalizeFingerprintKey(baselineFp),
      checks_signature: checksSig,
      baseline_fingerprint: baselineFp,
      baseline_failures,
      flaky_baseline_failures,
      cached_at: new Date().toISOString()
    };
    writeBaselineCacheSafe(resolvedCacheFile, cache);
  }

  if (baseline_failures.length > maxBaselineFailures) {
    return {
      ok: false,
      blocked: true,
      cacheHit: false,
      duration_ms: Math.max(0, getNowMs() - baselineStartMs),
      reason: 'baseline_limit_exceeded',
      message: `Baseline failures (${baseline_failures.length}) exceed max_baseline_failures (${maxBaselineFailures}). Fix repo baseline before running tasks.`,
      head_sha: resolvedHeadSha,
      deps_hash: resolvedDepsHash,
      baseline_fingerprint: baselineFp,
      baseline_failures,
      flaky_baseline_failures,
      max_baseline_failures: maxBaselineFailures
    };
  }

  return {
    ok: true,
    blocked: false,
    cacheHit: false,
    duration_ms: Math.max(0, getNowMs() - baselineStartMs),
    head_sha: resolvedHeadSha,
    deps_hash: resolvedDepsHash,
    baseline_fingerprint: baselineFp,
    baseline_failures,
    flaky_baseline_failures,
    max_baseline_failures: maxBaselineFailures
  };
}

function parseModifiedFilesFromDiff(diffText = '', modifiedFiles = []) {
  const touched = new Set((modifiedFiles || []).map(normalizeRelPath).filter(Boolean));
  if (typeof diffText === 'string' && diffText.trim()) {
    for (const m of diffText.matchAll(/^diff --git a\/([^\s]+)\s+b\/([^\s]+)/gm)) {
      touched.add(normalizeRelPath(m[1]));
      touched.add(normalizeRelPath(m[2]));
    }
    for (const m of diffText.matchAll(/^(?:---|\+\+\+)\s+[ab]\/([^\s]+)/gm)) {
      touched.add(normalizeRelPath(m[1]));
    }
  }
  return touched;
}

/**
 * Evaluates post-fix validation results against baseline policy and all 5 `done_with_known_failures` gates.
 * Possible outcomes:
 *  - 'done': 0 current failures and environment matches baseline
 *  - 'done_with_known_failures': all 5 gates strictly pass
 *  - 'blocked' (reason: 'environment_mismatch' | 'preexisting_failure', canRetry: false): fail-closed or immediate 0-retry stop
 *  - 'retry_writer' (canRetry: true): in-scope failure or new regression caused during task
 */
export function evaluateTaskOutcomeWithBaseline({
  task = {},
  checkResults = [],
  baselineResult = null,
  diffText = '',
  modifiedFiles = [],
  policyConfig = {},
  repoRoot = resolveRepoRoot(policyConfig)
} = {}) {
  const resolvedRoot = repoRoot || resolveRepoRoot(policyConfig);
  const baselineFp = baselineResult?.baseline_fingerprint || null;
  const baselineFailures = Array.isArray(baselineResult?.baseline_failures) ? baselineResult.baseline_failures : [];
  const flakyFailures = Array.isArray(baselineResult?.flaky_baseline_failures) ? baselineResult.flaky_baseline_failures : [];

  for (const res of (checkResults || [])) {
    const runFp = res?.env_fingerprint || null;
    if (baselineFp && runFp) {
      const cmp = compareEnvironmentFingerprints(baselineFp, runFp);
      if (!cmp.matched) {
        return {
          outcome: 'blocked',
          final_status: 'blocked',
          reason: 'environment_mismatch',
          trusted: false,
          canRetry: false,
          block_reason: `[Validator] FAIL-CLOSED: Refusing validation result due to environment_mismatch (${cmp.mismatch_fields.join(', ')})`,
          mismatch_fields: cmp.mismatch_fields,
          flaky_baseline_failures: flakyFailures
        };
      }
    }
  }

  const enobufsChecks = (checkResults || []).filter(r => r && r.ok === false && isEnobufsFailure(r.errorCombined || ''));
  if (enobufsChecks.length > 0) {
    const enobufsThreshold = resolveConfiguredEnobufsThreshold(policyConfig);
    const consecutiveCount = Number(task.consecutive_enobufs || 0) + 1;
    const sampleCheck = enobufsChecks[0];
    const qual = evaluateEnobufsQualification({
      isolatedRetryPassed: Boolean(sampleCheck.isolated_retry_passed),
      socketDiagnostics: sampleCheck.socket_diagnostics || null,
      threshold: enobufsThreshold,
      testPids: [process.pid],
      consecutiveCount,
      consecutiveLimit: DEFAULT_ENOBUFS_CONSECUTIVE_LIMIT
    });
    if (qual.reason === 'enobufs_consecutive_blocked') {
      return {
        outcome: 'blocked',
        final_status: 'blocked',
        reason: 'enobufs_consecutive_blocked',
        trusted: false,
        canRetry: false,
        block_reason: `[Validator] BLOCKED: ENOBUFS repeated ${consecutiveCount} consecutive times (${sampleCheck.checkName || 'check'}).`,
        flaky_baseline_failures: flakyFailures
      };
    }
    if (qual.eligible_flaky && (checkResults || []).every(r => !r || r.ok !== false || isEnobufsFailure(r.errorCombined || ''))) {
      const enobufsItem = extractCheckFailureIdentities(sampleCheck)[0] || {
        check_name: sampleCheck.checkName || 'enobufs_check',
        test_id: '__check__',
        failure_key: `${sampleCheck.checkName || 'enobufs_check'}::__check__`
      };
      const flakyEntry = buildFlakyEntry(enobufsItem, 1, task, policyConfig);
      if (isHumanOwnerName(flakyEntry.owner)) {
        flakyEntry.isolated_retry_passed = true;
        flakyEntry.external_socket_pressure = qual.external_pressure;
        return {
          outcome: 'done',
          final_status: 'done',
          trusted: true,
          canRetry: false,
          known_failures: [],
          flaky_baseline_failures: [...flakyFailures, flakyEntry]
        };
      }
    }
  }

  const currentRed = [];
  for (const res of (checkResults || [])) {
    if (res && res.ok === false) {
      currentRed.push(...extractCheckFailureIdentities(res));
    }
  }

  if (currentRed.length === 0) {
    return {
      outcome: 'done',
      final_status: 'done',
      trusted: true,
      canRetry: false,
      known_failures: [],
      flaky_baseline_failures: flakyFailures
    };
  }

  const baselineMap = new Map(baselineFailures.map(item => [item.failure_key || `${item.check_name}::${item.test_id}`, item]));
  const inScopeRed = [];
  const newRed = [];
  const classified = currentRed.map(item => {
    const scopeMap = mapFailureToScope(item, task.scope || [], resolvedRoot);
    const baseEntry = baselineMap.get(item.failure_key);
    const isBaseline = Boolean(baseEntry);
    const enriched = {
      ...item,
      in_scope: scopeMap.in_scope,
      mapping_status: scopeMap.mapping_status,
      mapped_targets: scopeMap.mapped_targets,
      is_in_baseline: isBaseline,
      base_entry: baseEntry || null
    };
    if (scopeMap.in_scope) inScopeRed.push(enriched);
    if (!isBaseline) newRed.push(enriched);
    return enriched;
  });

  // Condition 1 (all scope-mapped / unmapped checks pass) AND Condition 2 (current_red subset of baseline_failures)
  if (inScopeRed.length > 0 || newRed.length > 0) {
    const reasons = [];
    if (inScopeRed.length > 0) {
      reasons.push(`in-scope/unmapped failures (${inScopeRed.map(x => x.failure_key).join(', ')})`);
    }
    if (newRed.length > 0) {
      reasons.push(`new/non-baseline failures (${newRed.map(x => x.failure_key).join(', ')})`);
    }
    const errText = checkResults
      .filter(r => r && r.ok === false && r.errorCombined)
      .map(r => `[${r.checkName || r.check_name}] ${r.errorCombined}`)
      .join('\n\n')
      .trim() || reasons.join('; ');
    return {
      outcome: 'retry_writer',
      final_status: 'retry_writer',
      trusted: false,
      canRetry: true,
      reason: reasons.join('; '),
      in_scope_failures: inScopeRed,
      new_failures: newRed,
      errorCombined: errText,
      errorHash: hashString(errText),
      flaky_baseline_failures: flakyFailures
    };
  }

  // Remaining gates (3, 4, 5) for out-of-scope baseline subset:
  // Either passes all 5 -> done_with_known_failures, or fails a gate -> blocked: preexisting_failure (0 retries!)
  const failedGates = [];

  // Condition 3: diff must NOT touch executable failing test files
  const touchedFiles = parseModifiedFilesFromDiff(diffText, modifiedFiles);
  const touchedFailingTests = [];
  for (const item of classified) {
    const candidates = [item.test_file, item.target_file]
      .filter(Boolean)
      .map(normalizeRelPath)
      .filter(p => /(?:^|\/)tests?\//i.test(p) || /(?:^|\/)test_[^/]+\.(?:py|mjs|js|ts)$/i.test(p) || p === normalizeRelPath(item.test_file || ''));
    for (const c of candidates) {
      if (touchedFiles.has(c)) {
        touchedFailingTests.push(c);
      }
    }
  }
  if (touchedFailingTests.length > 0) {
    failedGates.push(`diff_touches_failing_test_file(${[...new Set(touchedFailingTests)].join(',')})`);
  }

  // Condition 4: risk >= medium requires human approval (with matching scope_hash)
  const effectiveRisk = resolveEffectiveRisk(task);
  if (RISK_LEVEL_RANK[effectiveRisk] >= RISK_LEVEL_RANK.medium) {
    const expectedHash = computeScopeHash(task.scope || []);
    const hasApproval = Boolean(
      task.approval &&
      typeof task.approval.by === 'string' &&
      task.approval.by.trim().length > 0 &&
      task.approval.scope_hash === expectedHash
    );
    if (!hasApproval) {
      failedGates.push(`risk_${effectiveRisk}_requires_human_approval`);
    }
  }

  // Condition 5: every known_failures entry MUST carry explicit non-empty owner + due_at
  const known_failures = [];
  const missingMetaKeys = [];
  for (const item of classified) {
    const meta = resolveConfiguredKnownFailureMeta(item, task, policyConfig);
    const owner = meta.owner || item.base_entry?.owner || null;
    const dueAt = meta.due_at || item.base_entry?.due_at || null;
    if (!owner || !dueAt) {
      missingMetaKeys.push(item.failure_key);
    }
    known_failures.push({
      check_name: item.check_name,
      test_id: item.test_id,
      failure_key: item.failure_key,
      test_file: item.test_file || null,
      target_file: item.target_file || null,
      owner,
      due_at: dueAt
    });
  }
  if (missingMetaKeys.length > 0) {
    failedGates.push(`known_failures_missing_owner_or_due_at(${missingMetaKeys.join(',')})`);
  }

  if (failedGates.length === 0) {
    return {
      outcome: 'done_with_known_failures',
      final_status: 'done_with_known_failures',
      trusted: true,
      canRetry: false,
      known_failures,
      flaky_baseline_failures: flakyFailures
    };
  }

  return {
    outcome: 'blocked',
    final_status: 'blocked',
    reason: 'preexisting_failure',
    trusted: false,
    canRetry: false,
    failed_gates: failedGates,
    block_reason: `preexisting_failure: ${failedGates.join('; ')}`,
    known_failures,
    flaky_baseline_failures: flakyFailures
  };
}

/**
 * Extracts clean dotted unittest targets (e.g. `tests.test_api.PathResolutionTests.test_x`)
 * from check results and raw validator failure output so retries can validate failing tests first.
 */
export function extractFailingTestTargetsForRetry(errSummary = '', checkResults = []) {
  const targets = new Set();

  for (const res of (Array.isArray(checkResults) ? checkResults : [])) {
    if (!res || res.ok !== false) continue;
    for (const item of extractCheckFailureIdentities(res)) {
      if (!item || !item.test_id || item.test_id === '__check__') continue;
      if (isRepoWideScannerTest(item.test_id, item.command || '', item.check_name || '')) continue;
      const cleanId = stripTestSubtestSuffix(item.test_id);
      if (/^[a-zA-Z_][\w.]*$/.test(cleanId)) {
        targets.add(cleanId);
      }
    }
  }

  const rawText = String(errSummary || '');
  const headerRe = /^(?:FAIL|ERROR):\s+([^\s(]+)\s+\(([^)]+)\)(?:\s+\([^)]+\)|\s+\[[^\]]+\])?\s*$/gm;
  let m;
  while ((m = headerRe.exec(rawText)) !== null) {
    const dotted = buildPythonDottedBaseId(m[1], m[2]);
    if (isRepoWideScannerTest(dotted, '', '')) continue;
    if (/^[a-zA-Z_][\w.]*$/.test(dotted)) {
      targets.add(dotted);
    }
  }

  return [...targets];
}

/**
 * Builds deduplicated targeted retry check descriptors covering `targetTestIds` from
 * `policy.validation.suite_checks` and `task.verification_commands`.
 */
export function buildTargetedRetryChecks(policyConfig = {}, task = {}, targetTestIds = []) {
  const cleanIds = [...new Set(
    (Array.isArray(targetTestIds) ? targetTestIds : [])
      .map(stripTestSubtestSuffix)
      .filter(id => /^[a-zA-Z_][\w.]*$/.test(id) && !isRepoWideScannerTest(id, '', ''))
  )];
  if (cleanIds.length === 0) return [];

  const suiteChecks = collectPolicyStageChecks(policyConfig).filter(c => c.stage === 'suite_checks');
  const verifChecks = (Array.isArray(task?.verification_commands) ? task.verification_commands : [])
    .filter(cmd => cmd && typeof cmd === 'string')
    .map((cmd, i) => ({
      name: `dependent_test_verification_${i + 1}`,
      run: cmd,
      timeout_sec: 120,
      stage: 'suite_checks'
    }));

  const targeted = [];
  const seenCommands = new Set();

  for (const chk of [...suiteChecks, ...verifChecks]) {
    if (!chk?.run) continue;
    let targetedCmd = buildTargetedUnittestCommand(chk.run, cleanIds);
    if (!targetedCmd) {
      const explicitFileMatch = chk.run.match(/^(.*?)\s+-m\s+unittest\s+(?:(?:-v|--verbose)\s+)?(['"]?[\w./\\-]+\.py['"]?)(?:\s|$)/i);
      if (explicitFileMatch) {
        const pyPrefix = explicitFileMatch[1].trim();
        const modFile = normalizeRelPath(explicitFileMatch[2].replace(/['"]/g, ''));
        const modPrefix = modFile.replace(/\.py$/i, '').replace(/\//g, '.');
        const matchingIds = cleanIds.filter(id => id === modPrefix || id.startsWith(`${modPrefix}.`));
        if (matchingIds.length > 0) {
          targetedCmd = `${pyPrefix} -m unittest -v ${matchingIds.join(' ')}`;
        }
      }
    }
    if (!targetedCmd || seenCommands.has(targetedCmd)) continue;
    seenCommands.add(targetedCmd);
    targeted.push({
      ...chk,
      name: `${chk.name || 'suite_check'}_fast_retry`,
      run: targetedCmd,
      stage: 'fast_retry'
    });
  }

  return targeted;
}

function classifyFastRetryLoaderFallback(combinedErr = '') {
  const text = String(combinedErr || '');
  if (!text || /AssertionError/i.test(text)) return null;
  const headerLines = text.match(/^(?:FAIL|ERROR):.*$/gm) || [];
  const isAttrOrModuleMiss = /AttributeError:.*has no attribute|ModuleNotFoundError: No module named/i.test(text);
  if (headerLines.length === 0) {
    return isAttrOrModuleMiss ? 'renamed_or_missing_test_target' : null;
  }
  const allLoaderFailed = headerLines.every(line => /unittest\.loader\._FailedTest/i.test(line));
  if (!allLoaderFailed) return null;
  return isAttrOrModuleMiss
    ? 'renamed_or_missing_test_target'
    : 'loader_failed_test_fallback_to_module';
}

/**
 * Runs previously failing tests FIRST when `retries > 0`.
 * Returns `shortCircuit: true` immediately on targeted failure so full suite checks are skipped.
 */
export async function runFastRetryTargetedValidation({
  task = {},
  retries = 0,
  policyConfig = {},
  envFingerprint = null,
  runCheckFn = runSingleValidationCheck,
  nowFn = Date.now
} = {}) {
  if (Number(retries) <= 0) {
    return {
      attempted: false,
      ok: true,
      shortCircuit: false,
      fast_retry_validation_ms: 0,
      targeted_tests: [],
      checks: []
    };
  }

  const getNowMs = typeof nowFn === 'function' ? nowFn : Date.now;
  const fromPriorField = Array.isArray(task?.previous_failing_tests) ? task.previous_failing_tests : [];
  const fromLastError = task?.last_error ? extractFailingTestTargetsForRetry(task.last_error, []) : [];
  const targetTestIds = [...new Set([...fromPriorField, ...fromLastError].filter(Boolean))];
  const targetedChecks = buildTargetedRetryChecks(policyConfig, task, targetTestIds);

  if (targetedChecks.length === 0) {
    return {
      attempted: false,
      ok: true,
      shortCircuit: false,
      fast_retry_validation_ms: 0,
      targeted_tests: [],
      checks: []
    };
  }

  const startMs = getNowMs();
  const executedChecks = [];

  for (const chk of targetedChecks) {
    const res = await runCheckFn(chk, 'fast_retry', policyConfig, envFingerprint);
    executedChecks.push(res);
    if (res && res.ok === false) {
      const combinedErr = String(res.errorCombined || '');
      const fallbackReason = classifyFastRetryLoaderFallback(combinedErr);

      const fastRetryMs = Math.max(0, Math.round(getNowMs() - startMs));
      if (task && typeof task === 'object') {
        task.fast_retry_validation_ms = Number(task.fast_retry_validation_ms || 0) + fastRetryMs;
      }

      if (fallbackReason) {
        if (task && typeof task === 'object') {
          task.fast_retry_fallback_reason = fallbackReason;
        }
        return {
          attempted: true,
          ok: true,
          renamedFallback: true,
          fast_retry_fallback_reason: fallbackReason,
          shortCircuit: false,
          fast_retry_validation_ms: fastRetryMs,
          targeted_tests: targetTestIds,
          checks: executedChecks
        };
      }

      return {
        attempted: true,
        ok: false,
        shortCircuit: true,
        fast_retry_validation_ms: fastRetryMs,
        targeted_tests: targetTestIds,
        checks: executedChecks,
        checkName: res.checkName || chk.name,
        command: res.command || chk.run,
        errorCombined: combinedErr,
        errorHash: res.errorHash || hashString(combinedErr)
      };
    }
  }

  const fastRetryMs = Math.max(0, Math.round(getNowMs() - startMs));
  if (task && typeof task === 'object') {
    task.fast_retry_validation_ms = Number(task.fast_retry_validation_ms || 0) + fastRetryMs;
  }

  return {
    attempted: true,
    ok: true,
    shortCircuit: false,
    fast_retry_validation_ms: fastRetryMs,
    targeted_tests: targetTestIds,
    checks: executedChecks
  };
}

/**
 * Coordinates Step D Suite Validation with Fail-Fast Targeted Retry pre-check:
 * 1) On retries > 0 with known failing targets, runs targeted test(s) first.
 * 2) If targeted test fails (and qualifies under baseline policy), short-circuits before full suite.
 * 3) Only proceeds to full `suite_checks` + `task.verification_commands` if targeted check passes.
 */
export async function runSuiteValidationWithFastRetryFirst({
  task = {},
  retries = 0,
  policyConfig = {},
  baselineResult = null,
  envFingerprint = null,
  fastChecks = [],
  diffText = '',
  modifiedFiles = [],
  repoRoot = resolveRepoRoot(policyConfig),
  phaseTracker = null,
  recordStepFn = null,
  runCheckFn = runSingleValidationCheck,
  validateStageChecksFn = validateStageChecks,
  attachEnobufsFn = null,
  nowFn = Date.now
} = {}) {
  const resolvedRoot = repoRoot || resolveRepoRoot(policyConfig);
  const fastRetryResult = await runFastRetryTargetedValidation({
    task,
    retries,
    policyConfig,
    envFingerprint,
    runCheckFn,
    nowFn
  });

  if (fastRetryResult.attempted) {
    if (phaseTracker && typeof phaseTracker.addFastRetryValidationMs === 'function') {
      phaseTracker.addFastRetryValidationMs(fastRetryResult.fast_retry_validation_ms);
    }
    if (typeof recordStepFn === 'function') {
      recordStepFn({
        step: '3.0',
        attempt: Number(retries) + 1,
        role: 'validator',
        action: 'fast_retry_targeted_validation',
        requested_model: '0-token',
        actual_model: '0-token',
        model: '0-token',
        targeted_tests: fastRetryResult.targeted_tests,
        status: fastRetryResult.shortCircuit
          ? 'failed_fast_retry'
          : (fastRetryResult.renamedFallback ? 'fallback_to_verification_modules' : 'ok'),
        ...(fastRetryResult.fast_retry_fallback_reason
          ? { fast_retry_fallback_reason: fastRetryResult.fast_retry_fallback_reason }
          : {}),
        fast_retry_validation_ms: fastRetryResult.fast_retry_validation_ms,
        duration_ms: fastRetryResult.fast_retry_validation_ms
      });
    }
  }

  if (fastRetryResult.shortCircuit) {
    const shortEval = evaluateTaskOutcomeWithBaseline({
      task,
      checkResults: [...(Array.isArray(fastChecks) ? fastChecks : []), ...fastRetryResult.checks],
      baselineResult,
      diffText,
      modifiedFiles,
      policyConfig,
      repoRoot: resolvedRoot
    });
    if (shortEval.outcome === 'retry_writer' || shortEval.outcome === 'blocked') {
      return {
        shortCircuited: true,
        fastRetryResult,
        suiteVal: {
          ok: false,
          skipped: false,
          stage: 'fast_retry',
          checkName: fastRetryResult.checkName,
          command: fastRetryResult.command,
          errorCombined: fastRetryResult.errorCombined,
          errorHash: fastRetryResult.errorHash,
          checks: fastRetryResult.checks
        },
        suiteCheckList: fastRetryResult.checks,
        enrichedSuiteChecks: fastRetryResult.checks,
        baselineEval: shortEval
      };
    }
  }

  const verificationCheckResults = [];
  let ranVerificationFirst = false;
  if (fastRetryResult.renamedFallback && Array.isArray(task?.verification_commands) && task.verification_commands.length > 0) {
    ranVerificationFirst = true;
    for (const extraCmd of task.verification_commands) {
      if (!extraCmd || typeof extraCmd !== 'string') continue;
      const extraRes = await runCheckFn(
        { name: 'dependent_test_verification', run: extraCmd, timeout_sec: 120 },
        'suite_checks',
        policyConfig,
        envFingerprint
      );
      verificationCheckResults.push(extraRes);
    }
    const failedModCheck = verificationCheckResults.find(c => c && c.ok === false);
    if (failedModCheck) {
      const modEval = evaluateTaskOutcomeWithBaseline({
        task,
        checkResults: [...(Array.isArray(fastChecks) ? fastChecks : []), ...verificationCheckResults],
        baselineResult,
        diffText,
        modifiedFiles,
        policyConfig,
        repoRoot: resolvedRoot
      });
      if (modEval.outcome === 'retry_writer' || modEval.outcome === 'blocked') {
        return {
          shortCircuited: true,
          fastRetryResult,
          suiteVal: {
            ok: false,
            skipped: false,
            stage: 'suite_checks',
            checkName: failedModCheck.checkName || 'dependent_test_verification',
            command: failedModCheck.command || '',
            errorCombined: failedModCheck.errorCombined || '',
            errorHash: failedModCheck.errorHash || hashString(String(failedModCheck.errorCombined || '')),
            checks: verificationCheckResults
          },
          suiteCheckList: verificationCheckResults,
          enrichedSuiteChecks: verificationCheckResults,
          baselineEval: modEval
        };
      }
    }
  }

  const suiteVal = await validateStageChecksFn('suite_checks', policyConfig, {
    defaultTimeoutMs: 120000,
    collectAll: true,
    envFingerprint
  });
  const suiteCheckList = Array.isArray(suiteVal?.checks) && suiteVal.checks.length > 0
    ? [...suiteVal.checks]
    : (suiteVal?.skipped ? [] : [suiteVal]);

  if (ranVerificationFirst) {
    suiteCheckList.push(...verificationCheckResults);
  } else if (Array.isArray(task?.verification_commands) && task.verification_commands.length > 0) {
    for (const extraCmd of task.verification_commands) {
      if (!extraCmd || typeof extraCmd !== 'string') continue;
      const extraRes = await runCheckFn(
        { name: 'dependent_test_verification', run: extraCmd, timeout_sec: 120 },
        'suite_checks',
        policyConfig,
        envFingerprint
      );
      suiteCheckList.push(extraRes);
    }
  }

  const enrichedSuiteChecks = (!suiteVal?.ok && typeof attachEnobufsFn === 'function')
    ? await attachEnobufsFn(suiteCheckList, 'suite_checks', policyConfig)
    : suiteCheckList;

  const baselineEval = evaluateTaskOutcomeWithBaseline({
    task,
    checkResults: [...(Array.isArray(fastChecks) ? fastChecks : []), ...enrichedSuiteChecks],
    baselineResult,
    diffText,
    modifiedFiles,
    policyConfig,
    repoRoot: resolvedRoot
  });

  return {
    shortCircuited: false,
    fastRetryResult,
    suiteVal,
    suiteCheckList,
    enrichedSuiteChecks,
    baselineEval
  };
}
