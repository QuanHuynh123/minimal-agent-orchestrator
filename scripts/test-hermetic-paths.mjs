#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = fs.existsSync(path.join(TEAM_DIR, '.git')) ? TEAM_DIR : path.resolve(TEAM_DIR, '..');
const SCRIPTS_DIR = __dirname;

function splitArgsRespectingQuotes(argStr) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (quote) {
      if (ch === '\\' && i + 1 < argStr.length) {
        cur += ch + argStr[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      cur += ch;
    } else {
      if (ch === '\'' || ch === '"' || ch === '`') {
        quote = ch;
        cur += ch;
      } else if (ch === ',') {
        parts.push(cur.trim());
        cur = '';
      } else if (ch === '(' || ch === '[') {
        // Track nested parens/brackets so commas inside calls don't split top-level args
        const closeChar = ch === '(' ? ')' : ']';
        let depth = 1;
        cur += ch;
        i++;
        while (i < argStr.length && depth > 0) {
          const c = argStr[i];
          if (c === ch) depth++;
          else if (c === closeChar) depth--;
          cur += c;
          i++;
        }
        i--;
      } else {
        cur += ch;
      }
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function unquoteLiteral(expr) {
  const s = expr.trim();
  if ((s.startsWith('\'') && s.endsWith('\'')) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/\\\\/g, '\\');
  }
  if (s.startsWith('`') && s.endsWith('`') && !s.includes('${')) {
    return s.slice(1, -1);
  }
  return null;
}

function collectRepoAnchors(src) {
  // Base map of variable -> posix repo-relative directory (empty string '' means REPO_ROOT)
  const anchors = new Map([
    ['__dirname', 'agent-team/scripts'],
    ['__filename', 'agent-team/scripts/test.mjs']
  ]);

  // Multi-pass resolution for derived constants like:
  // const TEAM_DIR = path.resolve(__dirname, '..');
  // const REPO_ROOT = path.resolve(TEAM_DIR, '..');
  // const ACTIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(resolve|join)\(([^;\n]+)\)/g;
  const assigns = [];
  let m;
  while ((m = assignRe.exec(src)) !== null) {
    assigns.push({ varName: m[1], argsRaw: m[3], index: m.index });
  }

  for (let pass = 0; pass < 4; pass++) {
    for (const a of assigns) {
      const args = splitArgsRespectingQuotes(a.argsRaw);
      if (args.length === 0 || !anchors.has(args[0])) continue;
      const baseRel = anchors.get(args[0]);
      const literals = [];
      let allLiteral = true;
      for (const arg of args.slice(1)) {
        const lit = unquoteLiteral(arg);
        if (lit === null) {
          allLiteral = false;
          break;
        }
        literals.push(lit);
      }
      if (literals.length > 0 && (allLiteral || args.length > 1)) {
        const resolvedPosix = path.posix.normalize(
          baseRel ? path.posix.join(baseRel, ...literals.map(s => s.replace(/\\/g, '/'))) : path.posix.join(...literals.map(s => s.replace(/\\/g, '/')))
        );
        anchors.set(a.varName, resolvedPosix === '.' ? '' : resolvedPosix);
      }
    }
  }
  return anchors;
}

function extractRepoPathReferences(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const anchors = collectRepoAnchors(src);
  const refs = [];
  const lineAtOffset = (idx) => src.slice(0, idx).split(/\r?\n/).length;

  // 1. Check path.resolve(...) / path.join(...) (including multiline calls) anchored on repo/agent-team directory variables
  const callRe = /path\.(?:resolve|join)\(([^)]+)\)/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const lineNum = lineAtOffset(m.index);
    const args = splitArgsRespectingQuotes(m[1]);
    if (args.length === 0 || !anchors.has(args[0])) continue;
    const baseRel = anchors.get(args[0]);
    const segs = [];
    for (const arg of args.slice(1)) {
      const lit = unquoteLiteral(arg);
      if (lit !== null) {
        segs.push(lit.replace(/\\/g, '/'));
      } else {
        const tplMatch = /^`([^`]*\$\{[^}]+\}([^`]*))`$/.exec(arg.trim());
        if (tplMatch) {
          segs.push(tplMatch[1].replace(/\$\{[^}]+\}/g, 'sample-id'));
        } else {
          break;
        }
      }
    }
    if (segs.length === 0 && !baseRel) continue;
    const joined = path.posix.normalize(
      baseRel ? path.posix.join(baseRel, ...segs) : path.posix.join(...segs)
    ).replace(/^\.\//, '');
    if (!joined || joined === '.' || joined.startsWith('..')) continue;
    refs.push({ lineNum, relPath: joined, raw: m[0] });
  }

  // 2. Check explicit fs/loader/constant literals referencing ignored runtime paths
  const lines = src.split(/\r?\n/);
  const ignoredLiteralRe = /['"`]((?:agent-team\/)?(?:tasks\/(?:active|archive|blocked)\/[^'"`\s]+|state\/(?:sessions|runs)\/[^'"`\s]+|state\/(?:task-state\.json|live-status\.json|morning-report\.md|telemetry\/calls\.jsonl)|config\/[^'"`\s]*\.local\.yaml))['"`]/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (/path\.join\(\s*(?:fake\w*|tmp\w*|fx\.?\w*)\s*,/.test(line)) continue;
    if (/assert\.|console\.(log|warn|error)|startsWith\(/.test(line) && !/fs\.|loadTaskYaml|loadYaml/.test(line)) continue;
    while ((m = ignoredLiteralRe.exec(line)) !== null) {
      const rawLit = m[1].replace(/\\/g, '/');
      const normalized = rawLit.startsWith('agent-team/') ? rawLit : `agent-team/${rawLit}`;
      refs.push({ lineNum, relPath: normalized, raw: m[0] });
    }
  }
  return refs;
}

const LIVE_PRODUCT_PREFIX_RE = /^(?:ui_web|core|ui_bridge)(?:\/|$)/i;
const ROOT_VAR_RE = /\b(?:REPO_ROOT|resolveRepoRoot\(\))\b/;
const GIT_SHOW_SHA_RE = /['"]show['"]\s*,\s*['"][0-9a-f]{7,40}:/i;
const SAFE_INFRA_ONLY_RE = /['"`]agent-team\//;

/**
 * Detects direct reads/scans of live product source directories (`ui_web/`, `core/`, `ui_bridge/`)
 * in test scripts. Committed fixtures (`agent-team/benchmarks/`, `tmp*`) and immutable `git show <sha>:path`
 * reads are explicitly permitted.
 */
export function scanLiveProductCodeViolations(filePath, content = '') {
  const src = String(content || '');
  const violations = [];
  const seen = new Set();
  const pushViolation = (lineNum, reason, target) => {
    const key = `${lineNum}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file: filePath, line: lineNum, reason, target });
  };

  // 1. Resolved repo-relative path references pointing directly to ui_web/, core/, ui_bridge/
  const refs = extractRepoPathReferencesFromSource(src);
  for (const r of refs) {
    if (LIVE_PRODUCT_PREFIX_RE.test(r.relPath)) {
      pushViolation(r.lineNum, 'direct_live_product_path', r.relPath);
    }
  }

  // 2. Helper calls passing live REPO_ROOT / resolveRepoRoot() while targeting product dirs or whole repo allowed_dirs
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const rootHelperCallRe = /\b(?:buildRouterContext|buildRouterContextParts|buildGoalPreprocessCandidates|buildScopedFilesContext(?:WithMeta)?|toolReadFile|checkScopeWithDependents|splitPatchStepsByOutputBudget|generateRepoMap|scanWorkspaceSymbols|decomposeGoal|compareRouterOneTurnVsCurrent|runRouterDryRunLoopBenchmark|fs\.readFile(?:Sync)?|fs\.existsSync)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (GIT_SHOW_SHA_RE.test(line)) continue;
    if (!rootHelperCallRe.test(line)) continue;

    // Extract current call statement up to balanced closing ';' or max 12 lines so multiline calls are checked without bleeding
    const sliceLines = [];
    for (let j = i; j < Math.min(lines.length, i + 12); j++) {
      sliceLines.push(lines[j]);
      if (/;\s*$/.test(lines[j].trim())) break;
    }
    const chunk = sliceLines.join(' ');
    if (!ROOT_VAR_RE.test(chunk)) continue;
    if (/non_existent_|fake|tmpRepo|tmpDir|tmpRoot|snapRepo/i.test(chunk)) continue;

    // Allow generateRepoMap when allowedDirs restricts strictly to 'agent-team...'
    const allowedDirsMatch = chunk.match(/allowedDirs:\s*\[([^\]]*)\]/);
    const onlyAgentTeamDirs = allowedDirsMatch
      ? allowedDirsMatch[1].split(',').map(s => s.trim().replace(/['"`]/g, '')).filter(Boolean).every(d => d.startsWith('agent-team'))
      : false;

    const touchesProductArg = !onlyAgentTeamDirs && (
      /['"`](?:ui_web|core|ui_bridge)(?:\/|['"`])/.test(chunk)
      || /\ballowedDirs\b|\brealPartition\b|\brawPatchBuckets\b|\brealEraserTask\b/.test(chunk)
      || (/\b(?:decomposeGoal|compareRouterOneTurnVsCurrent|runRouterDryRunLoopBenchmark)\b/.test(line) && !SAFE_INFRA_ONLY_RE.test(chunk))
      || /\bgenerateRepoMap\s*\(/.test(line)
    );

    if (touchesProductArg) {
      pushViolation(lineNum, 'live_repo_root_product_scan', trimmed.slice(0, 120));
    }
  }

  return violations;
}

function extractRepoPathReferencesFromSource(src = '') {
  const anchors = collectRepoAnchors(src);
  const refs = [];
  const lineAtOffset = (idx) => src.slice(0, idx).split(/\r?\n/).length;

  const callRe = /path\.(?:resolve|join)\(([^)]+)\)/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const lineNum = lineAtOffset(m.index);
    const args = splitArgsRespectingQuotes(m[1]);
    if (args.length === 0 || !anchors.has(args[0])) continue;
    const baseRel = anchors.get(args[0]);
    const segs = [];
    for (const arg of args.slice(1)) {
      const lit = unquoteLiteral(arg);
      if (lit !== null) {
        segs.push(lit.replace(/\\/g, '/'));
      } else {
        const tplMatch = /^`([^`]*\$\{[^}]+\}([^`]*))`$/.exec(arg.trim());
        if (tplMatch) {
          segs.push(tplMatch[1].replace(/\$\{[^}]+\}/g, 'sample-id'));
        } else {
          break;
        }
      }
    }
    if (segs.length === 0 && !baseRel) continue;
    const joined = path.posix.normalize(
      baseRel ? path.posix.join(baseRel, ...segs) : path.posix.join(...segs)
    ).replace(/^\.\//, '');
    if (!joined || joined === '.' || joined.startsWith('..')) continue;
    refs.push({ lineNum, relPath: joined, raw: m[0] });
  }

  const lines = src.split(/\r?\n/);
  const ignoredLiteralRe = /['"`]((?:agent-team\/)?(?:tasks\/(?:active|archive|blocked)\/[^'"`\s]+|state\/(?:sessions|runs)\/[^'"`\s]+|state\/(?:task-state\.json|live-status\.json|morning-report\.md|telemetry\/calls\.jsonl)|config\/[^'"`\s]*\.local\.yaml))['"`]/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (/path\.join\(\s*(?:fake\w*|tmp\w*|fx\.?\w*)\s*,/.test(line)) continue;
    if (/assert\.|console\.(log|warn|error)|startsWith\(/.test(line) && !/fs\.|loadTaskYaml|loadYaml/.test(line)) continue;
    while ((m = ignoredLiteralRe.exec(line)) !== null) {
      const rawLit = m[1].replace(/\\/g, '/');
      const normalized = rawLit.startsWith('agent-team/') ? rawLit : `agent-team/${rawLit}`;
      refs.push({ lineNum, relPath: normalized, raw: m[0] });
    }
  }
  return refs;
}

function scanUnsafeTelemetryCalls(fileLabel, src) {
  const findings = [];
  const callRe = /\b(recordTaskStep|appendTelemetryJsonl)\s*\(/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const prefixOnLine = src.slice(lineStart, m.index).trim();
    if (prefixOnLine.startsWith('//') || prefixOnLine.startsWith('*')) continue;
    const lineNum = src.slice(0, m.index).split(/\r?\n/).length;
    let i = m.index + m[0].length;
    let depth = 1;
    let quote = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else {
        if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      i++;
    }
    const callBody = src.slice(m.index + m[0].length, Math.max(m.index + m[0].length, i - 1));
    const fnName = m[1];
    if (fnName === 'recordTaskStep') {
      const hasSafeOpt = /\bskipJsonl\s*:\s*true\b/.test(callBody) || /\bteamDir\s*:/.test(callBody);
      if (!hasSafeOpt) {
        findings.push({
          file: fileLabel,
          line: lineNum,
          reason: 'recordTaskStep without { skipJsonl: true } or isolated { teamDir }',
          target: callBody.replace(/\s+/g, ' ').slice(0, 120)
        });
      }
    } else if (fnName === 'appendTelemetryJsonl') {
      const args = splitArgsRespectingQuotes(callBody);
      if (args.length < 2) {
        findings.push({
          file: fileLabel,
          line: lineNum,
          reason: 'appendTelemetryJsonl without isolated teamDir 2nd argument',
          target: callBody.replace(/\s+/g, ' ').slice(0, 120)
        });
      }
    }
  }
  return findings;
}

function runHermeticSelfTests() {
  const badTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-hermetic-selftest-'));
  try {
    const violatingFile = path.join(badTmpDir, 'test-intentional-violation.mjs');
    const violatingSrc = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const __filename = fileURLToPath(import.meta.url);',
      'const __dirname = path.dirname(__filename);',
      "const TEAM_DIR = path.resolve(__dirname, '..');",
      "const REPO_ROOT = path.resolve(TEAM_DIR, '..');",
      "const badHtml = fs.readFileSync(path.join(REPO_ROOT, 'ui_web', 'index.html'), 'utf8');",
      "const badPy = fs.readFileSync(path.resolve(REPO_ROOT, 'core', 'eraser.py'), 'utf8');",
      "const badApi = buildScopedFilesContext(['ui_bridge/js_api.py'], REPO_ROOT);"
    ].join('\n');
    fs.writeFileSync(violatingFile, violatingSrc, 'utf8');
    const foundBad = scanLiveProductCodeViolations('test-intentional-violation.mjs', violatingSrc);
    assert.ok(
      foundBad.length >= 3,
      `Hermetic scanner self-test must catch intentional live-code violations (>=3), got ${foundBad.length}`
    );

    const cleanSrc = [
      "import { execFileSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "const snapHtml = execFileSync('git', ['show', '210b0bc:ui_web/index.html'], { encoding: 'utf8' });",
      "const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));",
      "fs.mkdirSync(path.join(tmpDir, 'core'), { recursive: true });",
      "fs.writeFileSync(path.join(tmpDir, 'core', 'a.py'), 'x = 1', 'utf8');",
      "const fix = fs.readFileSync(path.join(TEAM_DIR, 'benchmarks', 'sample.json'), 'utf8');"
    ].join('\n');
    const foundClean = scanLiveProductCodeViolations('test-clean-sample.mjs', cleanSrc);
    assert.equal(
      foundClean.length,
      0,
      `Hermetic scanner self-test must allow git show <sha>:path and os.tmpdir(), got: ${JSON.stringify(foundClean)}`
    );

    const unsafeTelemetrySrc = [
      "recordTaskStep(fakeTask, { role: 'writer' });",
      "appendTelemetryJsonl({ task_id: 'T-1' });",
      "recordTaskStep(fakeTask, { role: 'writer' }, { skipJsonl: true });",
      "recordTaskStep(fakeTask, { role: 'writer' }, { teamDir: tmpDir });",
      "appendTelemetryJsonl({ task_id: 'T-2' }, tmpDir);"
    ].join('\n');
    const foundTelemetryBad = scanUnsafeTelemetryCalls('test-telemetry-selftest.mjs', unsafeTelemetrySrc);
    assert.equal(
      foundTelemetryBad.length,
      2,
      `Hermetic telemetry scanner self-test must catch exactly 2 unisolated calls, got: ${JSON.stringify(foundTelemetryBad)}`
    );
  } finally {
    fs.rmSync(badTmpDir, { recursive: true, force: true });
  }
}

function checkGitIgnoredBatch(repoRoot, relPaths) {
  if (relPaths.length === 0) return new Map();
  const input = relPaths.join('\n') + '\n';
  let out = '';
  try {
    out = execFileSync('git', ['check-ignore', '--no-index', '-v', '--stdin'], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    // git check-ignore exits 1 when NONE of the input paths are ignored
    if (err.status === 1 && !err.stdout) {
      return new Map();
    }
    out = String(err.stdout || '');
    if (!out) throw err;
  }

  const ignored = new Map();
  for (const row of out.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const tabIdx = row.indexOf('\t');
    if (tabIdx === -1) continue;
    const ruleSpec = row.slice(0, tabIdx).trim();
    const matchedPath = row.slice(tabIdx + 1).trim().replace(/\\/g, '/');
    ignored.set(matchedPath, ruleSpec);
  }
  return ignored;
}

function main() {
  runHermeticSelfTests();

  const testFiles = fs.readdirSync(SCRIPTS_DIR)
    .filter(name => /^test-.*\.mjs$/i.test(name) && name !== path.basename(__filename))
    .sort();

  assert.ok(testFiles.length >= 20, `Expected >=20 test-*.mjs files, found ${testFiles.length}`);

  const allFindings = [];
  const liveProductFindings = [];
  const unsafeTelemetryFindings = [];
  for (const fileName of testFiles) {
    const absPath = path.join(SCRIPTS_DIR, fileName);
    const content = fs.readFileSync(absPath, 'utf8');
    const refs = extractRepoPathReferencesFromSource(content);
    for (const v of scanLiveProductCodeViolations(`agent-team/scripts/${fileName}`, content)) {
      liveProductFindings.push(v);
    }
    for (const tv of scanUnsafeTelemetryCalls(`agent-team/scripts/${fileName}`, content)) {
      unsafeTelemetryFindings.push(tv);
    }
    if (refs.length === 0) continue;

    // For directory anchors like `agent-team/tasks/active`, probe both path and a synthetic file inside
    // because rules like `tasks/active/*.yaml` ignore files inside the directory rather than the bare dirname.
    const candidates = new Set();
    const fileProbeMap = new Map();
    for (const r of refs) {
      candidates.add(r.relPath);
      if (!path.posix.basename(r.relPath).includes('.')) {
        const probe = `${r.relPath.replace(/\/+$/, '')}/sample.yaml`;
        candidates.add(probe);
        fileProbeMap.set(r.relPath, probe);
      }
    }

    const ignoredMap = checkGitIgnoredBatch(REPO_ROOT, Array.from(candidates));
    for (const r of refs) {
      const rule = ignoredMap.get(r.relPath) || ignoredMap.get(fileProbeMap.get(r.relPath));
      if (rule) {
        allFindings.push({
          file: `agent-team/scripts/${fileName}`,
          line: r.lineNum,
          relPath: r.relPath,
          rule
        });
      }
    }
  }

  // Direct invariant: preset-pills test (when present) must never point at tasks/active/
  const presetTestPath = path.join(SCRIPTS_DIR, 'test-benchmark-replay-preset-pills.mjs');
  if (fs.existsSync(presetTestPath)) {
    const presetSrc = fs.readFileSync(presetTestPath, 'utf8');
    assert.ok(
      !presetSrc.includes("'tasks', 'active'") && !presetSrc.includes('tasks/active/'),
      'test-benchmark-replay-preset-pills.mjs must use a committed fixture instead of tasks/active/'
    );
  }

  // Verification rule invariant: DECISIONS.md (when present) must record clean-worktree rule & cf5ee70 historical note
  const decisionsPath = path.join(TEAM_DIR, 'DECISIONS.md');
  if (fs.existsSync(decisionsPath)) {
    const decisionsText = fs.readFileSync(decisionsPath, 'utf8');
    assert.ok(
      decisionsText.includes('cf5ee70') && decisionsText.includes('5194d4e') && decisionsText.includes('5531631'),
      'DECISIONS.md must document cf5ee70 alongside 5194d4e and 5531631 without rewriting history'
    );
    assert.match(
      decisionsText,
      /chỉ tin kết quả bản sạch/i,
      'DECISIONS.md must record the "chỉ tin kết quả bản sạch" verification rule'
    );
  }

  // Hermetic default teamDir invariant: task-persistence.mjs must never resolve('agent-team') relative to CWD
  const taskPersistenceSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'task-persistence.mjs'), 'utf8');
  assert.ok(
    !/path\.resolve\(\s*['"]agent-team['"]\s*\)/.test(taskPersistenceSrc),
    'task-persistence.mjs must anchor DEFAULT_TEAM_DIR via import.meta.url instead of CWD-relative path.resolve("agent-team")'
  );
  assert.ok(
    !fs.existsSync(path.join(TEAM_DIR, 'agent-team')),
    'Nested agent-team/agent-team directory must not exist (symptom of CWD-relative telemetry/state leak)'
  );

  if (allFindings.length > 0) {
    const details = allFindings
      .map(f => `- ${f.file}:${f.line} references gitignored "${f.relPath}" (matched ${f.rule})`)
      .join('\n');
    assert.fail(`Found non-hermetic gitignored path references in scripts/test-*.mjs:\n${details}`);
  }

  if (liveProductFindings.length > 0) {
    const prodDetails = liveProductFindings
      .map(f => `- ${f.file}:${f.line} [${f.reason}] -> ${f.target}`)
      .join('\n');
    assert.fail(`Found non-hermetic direct reads of live product code (ui_web/, core/, ui_bridge/) in scripts/test-*.mjs (use committed fixtures or git show <sha>:path):\n${prodDetails}`);
  }

  if (unsafeTelemetryFindings.length > 0) {
    const telemDetails = unsafeTelemetryFindings
      .map(f => `- ${f.file}:${f.line} [${f.reason}] -> ${f.target}`)
      .join('\n');
    assert.fail(`Found unisolated telemetry writes in scripts/test-*.mjs (pass { skipJsonl: true } or isolated { teamDir }):\n${telemDetails}`);
  }

  console.log(`[PASS] test-hermetic-paths (scanned ${testFiles.length} test-*.mjs files, 0 gitignored/live-product/telemetry-leak refs + intentional-violation self-test passed)`);
}

main();
