import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEdits,
  checkForbidden,
  computeDeterministicRisk,
  isFileInScope,
  matchesPattern,
  normalizeOrThrow,
  resolveRepoRoot
} from './applier.mjs';
import {
  acquireLock,
  buildScopedFilesContext,
  extractTaskKeywords,
  formatValidationErrorForRetry,
  normalizeTask,
  releaseLock,
  resolveEffectiveRisk,
  resolveTaskMode,
  sanitizeTaskState,
  shouldRunReviewerGate,
  sliceContentByKeywords,
  validateConfig,
  verifyResponseModel
} from './orchestrator.mjs';
import {
  auditGitScope,
  checkCommandGuardrails,
  hashString,
  normalizeErrorForHash
} from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = resolveRepoRoot();

console.log('Testing Applier & Orchestrator v2.1 Mode-Based Pipeline...');

// Test 1: Pattern Matching
assert.strictEqual(matchesPattern('.env', '**/.env*'), true);
assert.strictEqual(matchesPattern('config/.env.local', '**/.env*'), true);
assert.strictEqual(matchesPattern('package.json', 'package.json'), true);
assert.strictEqual(matchesPattern('agent-team/scripts/applier.mjs', 'agent-team/scripts/**'), true);
assert.strictEqual(matchesPattern('src/components/Button.tsx', '**/.env*'), false);
console.log('✓ Pattern matching passed');

// Test 2: Path Traversal Normalization
assert.throws(() => normalizeOrThrow(REPO_ROOT, '../outside.txt'), /escapes repository root/);
assert.throws(() => normalizeOrThrow(REPO_ROOT, 'src/../../outside.txt'), /escapes repository root/);
assert.throws(() => normalizeOrThrow(REPO_ROOT, 'foo/\0/bar.txt'), /Null byte/);
assert.throws(() => normalizeOrThrow(REPO_ROOT, 'C:/evil.txt'), /Absolute paths forbidden/);
assert.strictEqual(normalizeOrThrow(REPO_ROOT, 'core/downloader.py'), 'core/downloader.py');
console.log('✓ Path traversal checks passed');

// Test 3: Forbidden Files rejection
const forbiddenRes = applyEdits('### FILE: .env\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['.env'],
  allow_scope_expansion: false
}, {
  protectedFiles: ['**/.env*'],
  allowedDirs: ['core/']
});
assert.strictEqual(forbiddenRes.ok, false);
assert.strictEqual(forbiddenRes.security, true);
assert.strictEqual(forbiddenRes.noRetry, true);
assert.match(forbiddenRes.error, /Forbidden file edit attempted/);
console.log('✓ Forbidden file rejection passed');

// Test 4: Strict Scope & Exact Relative Path Matching (No loose suffix bypass)
assert.strictEqual(isFileInScope('ui_web/index.html', ['index.html']), false);
assert.strictEqual(isFileInScope('ui_web/index.html', ['ui_web/index.html']), true);
assert.strictEqual(isFileInScope('ui_web/index.html', ['**/index.html']), true);

const outOfScopeRes = applyEdits('### FILE: core/unknown.py\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: false
}, {
  allowedDirs: ['core/']
});
assert.strictEqual(outOfScopeRes.ok, false);
assert.match(outOfScopeRes.error, /Out-of-scope edit attempted/);
console.log('✓ Strict scope rejection & exact path matching passed');

// Test 5: Scope Expansion with limit & High-Risk Escalation Block
const expansionOkRes = applyEdits('### FILE: core/downloader.py\n<<<<<<< SEARCH\nnonexistent_line_xyz\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['core/'],
  maxScopeIncrease: 1
});
// Fails because SEARCH block not found on disk, but passed scope check!
assert.match(expansionOkRes.error, /SEARCH block 1 not found/);

const newFileOutScopeRes = applyEdits('### FILE: core/brand_new_unscoped.py\n<<<<<<< SEARCH\n\n=======\nprint(1)\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['core/'],
  maxScopeIncrease: 1,
  newFilesOnlyInScope: true
});
assert.strictEqual(newFileOutScopeRes.ok, false);
assert.match(newFileOutScopeRes.error, /new_files_only_in_scope/);

const disallowNewFileRes = applyEdits('### FILE: core/brand_new_scoped.py\n<<<<<<< SEARCH\n\n=======\nprint(1)\n>>>>>>> REPLACE', {
  scope: ['core/brand_new_scoped.py'],
  allow_scope_expansion: false
}, {
  allowedDirs: ['core/'],
  allowNewFiles: false
});
assert.strictEqual(disallowNewFileRes.ok, false);
assert.match(disallowNewFileRes.error, /allow_new_files: false/);

const highRiskExpansionRes = applyEdits('### FILE: core/auth_secret.py\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['core/'],
  maxScopeIncrease: 1
});
assert.strictEqual(highRiskExpansionRes.ok, false);
assert.strictEqual(highRiskExpansionRes.security, true);
assert.strictEqual(highRiskExpansionRes.noRetry, true);
assert.match(highRiskExpansionRes.error, /high-risk sensitive path is forbidden/);
console.log('✓ Scope expansion limit, new_files_only_in_scope & high-risk escalation block passed');

// Test 6: Task Schema Normalization (task_id vs task.id) & Mode Resolution
const legacyTask = normalizeTask({ task: { id: 'T-001', scope: ['core/a.py'] } });
const flatTask = normalizeTask({ task_id: 'T-002', scope: ['core/a.py', 'core/b.py', 'core/c.py', 'core/d.py'] });
assert.strictEqual(legacyTask.task_id, 'T-001');
assert.strictEqual(legacyTask.id, 'T-001');
assert.strictEqual(resolveTaskMode(legacyTask), 'quick');
assert.strictEqual(resolveTaskMode(flatTask), 'standard');
assert.strictEqual(resolveEffectiveRisk(legacyTask), 'low');
assert.strictEqual(resolveEffectiveRisk(flatTask), 'medium');
assert.strictEqual(shouldRunReviewerGate({ ...legacyTask, mode: 'standard' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), false);
assert.strictEqual(shouldRunReviewerGate({ ...flatTask, mode: 'standard' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), false);
assert.strictEqual(shouldRunReviewerGate({ scope: ['core/auth_secret.py'], mode: 'standard', risk_level: 'high' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), true);
console.log('✓ Task schema normalization, 4-tier risk resolution & Risk-Gated Reviewer passed');

// Test 7: Deterministic Error Hashing (strips volatile test durations)
const errRun1 = 'FAILED (failures=1)\nRan 244 tests in 1.234s\nObject at 0x000001A2B3C4';
const errRun2 = 'FAILED (failures=1)\nRan 244 tests in 4.987s\nObject at 0x000009F8E7D6';
assert.strictEqual(hashString(errRun1), hashString(errRun2));
console.log('✓ Deterministic error hashing (volatile timing stripped) passed');

// Test 8: Stale Lock Recovery & File Context Builder
const tempLock = path.resolve(__dirname, '..', '.test-stale.lock');
fs.writeFileSync(tempLock, JSON.stringify({ pid: 99999999, started_at: '2026-01-01T00:00:00Z' }), 'utf8');
assert.strictEqual(acquireLock(tempLock), true);
releaseLock(tempLock);

const ctx = buildScopedFilesContext(['agent-team/package.json', 'agent-team/nonexistent-new.txt'], REPO_ROOT);
assert.match(ctx, /EXISTING CONTENT/);
assert.match(ctx, /NEW FILE - DOES NOT EXIST ON DISK YET/);
console.log('✓ Stale lock recovery & Writer file context injection passed');

// Test 9: Smart Context-Aware File Loading (Keyword Extraction & Window Slicing)
const kw = extractTaskKeywords({
  title: 'Update start_video_analysis in JsApi',
  goal: 'Ensure start_video_analysis emits analysis_completed on EventBus',
  acceptance_criteria: ['validate_publish_draft returns ok']
});
assert.ok(kw.includes('start_video_analysis'));
assert.ok(kw.includes('analysis_completed'));
assert.ok(kw.includes('validate_publish_draft'));

const bigLines = Array.from({ length: 600 }, (_, idx) => `line_${idx + 1}: noop();`);
bigLines[350] = 'def start_video_analysis(self, payload): return True';
const slicedText = sliceContentByKeywords(bigLines.join('\n'), ['start_video_analysis'], 50000, 20);
assert.match(slicedText, /def start_video_analysis/);
assert.match(slicedText, /OMITTED LINES/);
console.log('✓ Context-aware keyword extraction & smart window slicing passed');

// Test 10: Command Guardrails (HR-1 Unbounded & HR-2 Bare curl alias) & IDE Scope Audit Gate
const unboundedCheck = checkCommandGuardrails('python test.py', 0, { ban_unbounded_commands: true });
assert.strictEqual(unboundedCheck.ok, false);
assert.match(unboundedCheck.error, /Unbounded command/);

if (process.platform === 'win32') {
  const bareCurlCheck = checkCommandGuardrails('curl http://127.0.0.1:20128/v1/models', 5000, { block_powershell_curl_alias: true });
  assert.strictEqual(bareCurlCheck.ok, false);
  assert.match(bareCurlCheck.error, /Bare PowerShell 'curl' alias is forbidden/);

  const curlExeCheck = checkCommandGuardrails('curl.exe --max-time 5 http://127.0.0.1:20128/v1/models', 5000, { block_powershell_curl_alias: true });
  assert.strictEqual(curlExeCheck.ok, true);
}

const auditPass = auditGitScope(['core/downloader.py'], {
  modifiedFiles: ['core/downloader.py'],
  allowedDirs: ['core/'],
  protectedFiles: ['**/.env*']
});
assert.strictEqual(auditPass.ok, true);

const auditFail = auditGitScope(['core/downloader.py'], {
  modifiedFiles: ['core/downloader.py', 'ui/main_window.py'],
  allowedDirs: ['core/', 'ui/'],
  protectedFiles: ['**/.env*']
});
assert.strictEqual(auditFail.ok, false);
assert.match(auditFail.violations[0], /Out-of-scope file modified/);
console.log('✓ Execution guardrails (HR-1/HR-2) & IDE Git Scope Audit Gate passed');

// Test 11: Validation Error Tail Extraction (Strips [SQUAD] banner & keeps Python Traceback)
const noisyUnittestOutput = [
  '=================================================================',
  '[SQUAD] BIET DOI AUTONOMOUS SQUAD - DIEM DANH CHAO SEP [SQUAD]',
  '=================================================================',
  '[1] Claude Opus | Vai tro: Tech Lead',
  '=================================================================',
  '[OK] Toan bo Biet doi dong long: 100% SAN SANG CHIEN DAU!',
  '=================================================================',
  'test_foo (test_core.CoreTests.test_foo) ... ok',
  'test_bar (test_core.CoreTests.test_bar)',
  'Verify bar behavior. ... ok',
  'invalid command name "2477491847488_tick"',
  '    while executing',
  '"2477491847488_tick"',
  '    ("after" script)',
  '======================================================================',
  'FAIL: test_inpaint_sha256 (test_inpaint_models.TestInpaintModels.test_inpaint_sha256)',
  '----------------------------------------------------------------------',
  'Traceback (most recent call last):',
  '  File "d:\\tool-download\\tests\\test_inpaint_models.py", line 42, in test_inpaint_sha256',
  '    self.assertEqual(status["status"], "ready")',
  'AssertionError: "corrupted" != "ready"'
].join('\r\n');

const cleanedErr = formatValidationErrorForRetry(noisyUnittestOutput, 600);
assert.strictEqual(cleanedErr.includes('BIET DOI AUTONOMOUS SQUAD'), false);
assert.strictEqual(cleanedErr.includes('2477491847488_tick'), false);
assert.strictEqual(cleanedErr.includes('test_foo'), false);
assert.match(cleanedErr, /FAIL: test_inpaint_sha256/);
assert.match(cleanedErr, /AssertionError: "corrupted" != "ready"/);
console.log('✓ Validation error tail extraction (strips banner/noise, preserves Traceback) passed');

// Test 12: State Deduplication & Stale Blocked Purge + Config Validation
const dirtyState = {
  completed_tasks: [
    { task_id: 'T-001', title: 'first' },
    { task_id: 'T-001', title: 'updated' },
    { task_id: 'T-002', title: 'second' }
  ],
  blocked_tasks: [
    { task_id: 'T-001', block_reason: 'old failure before fix' },
    { task_id: 'T-003', block_reason: 'still blocked 1' },
    { task_id: 'T-003', block_reason: 'still blocked 2' }
  ]
};
const cleanState = sanitizeTaskState(dirtyState);
assert.strictEqual(cleanState.completed_tasks.length, 2);
assert.strictEqual(cleanState.completed_tasks[0].title, 'updated');
assert.strictEqual(cleanState.blocked_tasks.length, 1);
assert.strictEqual(cleanState.blocked_tasks[0].task_id, 'T-003');
assert.strictEqual(cleanState.blocked_tasks[0].block_reason, 'still blocked 2');

const validCfgRes = validateConfig(
  { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1' } }, roles: { writer: { model: 'deepseek' } } },
  { policy: { scope_control: { max_files_per_task: 5 } } },
  { project: { allowed_dirs: ['core/'] } }
);
assert.strictEqual(validCfgRes.ok, true);

const invalidCfgRes = validateConfig({}, {}, {});
assert.strictEqual(invalidCfgRes.ok, false);
assert.strictEqual(invalidCfgRes.errors.length, 4);

const matchExact = verifyResponseModel(
  'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017',
  'deepseek-ai/deepseek-v4.1-flash-1017'
);
assert.strictEqual(matchExact.match, true);

const matchUnknown = verifyResponseModel('kr/claude-sonnet-4.5', 'unknown');
assert.strictEqual(matchUnknown.match, false);
assert.match(matchUnknown.reason, /omitted data\.model/);

const matchWrong = verifyResponseModel('kr/claude-sonnet-4.5', 'gpt-4o-mini');
assert.strictEqual(matchWrong.match, false);
assert.match(matchWrong.reason, /Requested model "kr\/claude-sonnet-4\.5" but upstream responded with "gpt-4o-mini"/);
console.log('✓ State deduplication, stale blocked purge, validateConfig & verifyResponseModel passed');

console.log('\n=============================================');
console.log('ALL V2.1 APPLIER & ORCHESTRATOR TESTS PASSED! 🎯');
console.log('=============================================');
