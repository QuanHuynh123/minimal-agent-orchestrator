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
  buildReviewerPrompt,
  buildRouterContext,
  buildScopedFilesContext,
  DEFAULT_POLICY_CONFIG,
  extractTaskKeywords,
  formatValidationErrorForRetry,
  mergePolicyWithDefaults,
  normalizeTask,
  releaseLock,
  resolveEffectiveRisk,
  resolveTaskMode,
  sanitizeTaskState,
  shouldRunReviewerGate,
  sliceContentByKeywords,
  validateConfig,
  verifyResponseModel,
  resolveWriterHubWorkflow,
  computeDynamicTaskTokenBudget,
  transitionTaskState,
  recordTaskStep,
  reconcileTaskTokens,
  estimateStepCostUsd,
  redactSecretsFromText
} from './orchestrator.mjs';
import { computeMedianAndRange } from './benchmark-replay.mjs';
import {
  auditGitScope,
  checkCommandGuardrails,
  hashString,
  normalizeErrorForHash,
  validateFast,
  verifyTestDiffIntegrity
} from './validator.mjs';
import { buildTaskId, slugify, extractJsonPayload } from './goal-planner.mjs';

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
assert.strictEqual(normalizeOrThrow(REPO_ROOT, 'agent-team/package.json'), 'agent-team/package.json');
console.log('✓ Path traversal checks passed');

// Test 3: Forbidden Files rejection
const forbiddenRes = applyEdits('### FILE: .env\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['.env'],
  allow_scope_expansion: false
}, {
  protectedFiles: ['**/.env*'],
  allowedDirs: ['agent-team/']
});
assert.strictEqual(forbiddenRes.ok, false);
assert.strictEqual(forbiddenRes.security, true);
assert.strictEqual(forbiddenRes.noRetry, true);
assert.match(forbiddenRes.error, /Forbidden file edit attempted/);
console.log('✓ Forbidden file rejection passed');

// Test 4: Strict Scope & Exact Relative Path Matching (No loose suffix bypass)
assert.strictEqual(isFileInScope('src/web/index.html', ['index.html']), false);
assert.strictEqual(isFileInScope('src/web/index.html', ['src/web/index.html']), true);
assert.strictEqual(isFileInScope('src/web/index.html', ['**/index.html']), true);

const outOfScopeRes = applyEdits('### FILE: agent-team/roles/reviewer.md\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['agent-team/roles/writer.md'],
  allow_scope_expansion: false
}, {
  allowedDirs: ['agent-team/']
});
assert.strictEqual(outOfScopeRes.ok, false);
assert.match(outOfScopeRes.error, /Out-of-scope edit attempted/);
console.log('✓ Strict scope rejection & exact path matching passed');

// Test 5: Scope Expansion with limit & High-Risk Escalation Block
const expansionOkRes = applyEdits('### FILE: agent-team/roles/writer.md\n<<<<<<< SEARCH\nnonexistent_line_xyz\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['agent-team/roles/router.md'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['agent-team/'],
  maxScopeIncrease: 1
});
// Fails because SEARCH block not found on disk, but passed scope check!
assert.match(expansionOkRes.error, /SEARCH block 1 not found/);

const newFileOutScopeRes = applyEdits('### FILE: agent-team/roles/brand_new_unscoped.md\n<<<<<<< SEARCH\n\n=======\n# role\n>>>>>>> REPLACE', {
  scope: ['agent-team/roles/writer.md'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['agent-team/'],
  maxScopeIncrease: 1,
  newFilesOnlyInScope: true
});
assert.strictEqual(newFileOutScopeRes.ok, false);
assert.match(newFileOutScopeRes.error, /new_files_only_in_scope/);

const disallowNewFileRes = applyEdits('### FILE: agent-team/roles/brand_new_scoped.md\n<<<<<<< SEARCH\n\n=======\n# role\n>>>>>>> REPLACE', {
  scope: ['agent-team/roles/brand_new_scoped.md'],
  allow_scope_expansion: false
}, {
  allowedDirs: ['agent-team/'],
  allowNewFiles: false
});
assert.strictEqual(disallowNewFileRes.ok, false);
assert.match(disallowNewFileRes.error, /allow_new_files: false/);

const highRiskExpansionRes = applyEdits('### FILE: agent-team/roles/auth_secret.md\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['agent-team/roles/writer.md'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['agent-team/'],
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
const consultTask = normalizeTask({ task_id: 'T-003', mode: 'consult', role: 'designer', goal: 'Review layout' });
assert.strictEqual(legacyTask.task_id, 'T-001');
assert.strictEqual(legacyTask.id, 'T-001');
assert.strictEqual(resolveTaskMode(legacyTask), 'quick');
assert.strictEqual(resolveTaskMode(flatTask), 'standard');
assert.strictEqual(resolveTaskMode(consultTask), 'consult');
assert.strictEqual(shouldRunReviewerGate(consultTask, { task_modes: { consult: { skip_router_and_reviewer: true } } }, { reviewer: { enabled: true } }), false);
assert.strictEqual(resolveEffectiveRisk(legacyTask), 'low');
assert.strictEqual(resolveEffectiveRisk(flatTask), 'medium');
assert.strictEqual(shouldRunReviewerGate({ ...legacyTask, mode: 'standard' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), false);
assert.strictEqual(shouldRunReviewerGate({ ...flatTask, mode: 'standard' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), false);
assert.strictEqual(shouldRunReviewerGate({ scope: ['core/auth_secret.py'], mode: 'standard', risk_level: 'high' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, { reviewer: { enabled: true } }), true);
assert.strictEqual(shouldRunReviewerGate({ scope: ['core/auth_secret.py'], mode: 'standard', risk_level: 'high' }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, {}), false);
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

// Test 9b: Anti-Domino Merge + idx===0 Byte Cap + Header Anchor + Weighted Knapsack
const dominoLines = Array.from({ length: 5000 }, (_, idx) => {
  if (idx === 10) return 'from dataclasses import dataclass\n@dataclass\nclass BannerBoxResult: pass';
  if (idx === 2850) return 'def export_clean_video(video_path, regions, mode="delogo"): return True';
  // Noise keyword "mode" and "video" every 30 lines that previously Domino-merged all 5000 lines into merged[0]
  return idx % 30 === 0
    ? `line_${idx + 1}: const mode = "video"; // generic noise hit`
    : `line_${idx + 1}: const padding_${idx} = "x".repeat(45);`;
});
const dominoRaw = dominoLines.join('\n');
const dominoSliced = sliceContentByKeywords(dominoRaw, ['mode', 'video', 'export_clean_video'], 14000, 35);
const dominoSlicedBytes = Buffer.byteLength(dominoSliced, 'utf8');
assert.ok(dominoSlicedBytes <= 15000, `Expected strict byte cap <= 15000, got ${dominoSlicedBytes} bytes`);
assert.match(dominoSliced, /class BannerBoxResult/, 'Header Anchor (lines 1..30) must be preserved');
assert.match(dominoSliced, /def export_clean_video/, 'Specific snake_case symbol must win Knapsack selection over generic noise words');
console.log('✓ Context-aware keyword extraction & Weighted Knapsack window slicing passed');

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

const auditPass = auditGitScope(['src/service.js'], {
  modifiedFiles: ['src/service.js'],
  allowedDirs: ['src/'],
  protectedFiles: ['**/.env*']
});
assert.strictEqual(auditPass.ok, true);

const auditFail = auditGitScope(['src/service.js'], {
  modifiedFiles: ['src/service.js', 'ui/view.js'],
  allowedDirs: ['src/', 'ui/'],
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
  'FAIL: test_model_sha256 (test_models.TestModels.test_model_sha256)',
  '----------------------------------------------------------------------',
  'Traceback (most recent call last):',
  '  File "/workspace/app/tests/test_models.py", line 42, in test_model_sha256',
  '    self.assertEqual(status["status"], "ready")',
  'AssertionError: "corrupted" != "ready"'
].join('\r\n');

const cleanedErr = formatValidationErrorForRetry(noisyUnittestOutput, 600);
assert.strictEqual(cleanedErr.includes('BIET DOI AUTONOMOUS SQUAD'), false);
assert.strictEqual(cleanedErr.includes('2477491847488_tick'), false);
assert.strictEqual(cleanedErr.includes('test_foo'), false);
assert.match(cleanedErr, /FAIL: test_model_sha256/);
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
  { project: { allowed_dirs: ['core/'], protected_files: ['tests/test_indentation.py'] } }
);
assert.strictEqual(validCfgRes.ok, true);

const invalidCfgRes = validateConfig({}, {}, {});
assert.strictEqual(invalidCfgRes.ok, false);
assert.ok(invalidCfgRes.errors.length >= 2);

// Test mergePolicyWithDefaults & Framework Invariants
const emptyMerge = mergePolicyWithDefaults({});
assert.strictEqual(emptyMerge.scope_control.max_files_per_task, 5);
assert.strictEqual(emptyMerge.task_modes.consult.mutation_enabled, false);

const customMerge = mergePolicyWithDefaults({
  policy: {
    scope_control: { max_files_per_task: 10 },
    task_modes: {
      quick: { max_runtime_sec: 240 },
      consult: { mutation_enabled: true } // Attempted illegal override
    }
  }
});
assert.strictEqual(customMerge.scope_control.max_files_per_task, 10);
assert.strictEqual(customMerge.scope_control.max_scope_increase, 1); // Preserves default
assert.strictEqual(customMerge.task_modes.quick.max_runtime_sec, 240);
assert.strictEqual(customMerge.task_modes.consult.mutation_enabled, false); // Invariant enforced!

// Test Honest Validation reporting when no checks configured
const skippedVal = await validateFast({ project: { validation: { fast_checks: [] } } });
assert.strictEqual(skippedVal.ok, true);
assert.strictEqual(skippedVal.skipped, true);
assert.match(skippedVal.message, /No fast_checks defined/);

// Test Repo Root resolution priority: projectConfig override vs fallback
const customRepoRoot = resolveRepoRoot({ project: { repo_root: 'core' } });
assert.ok(customRepoRoot.replace(/\\/g, '/').endsWith('/core'));

// Test Goal Planner helpers
assert.strictEqual(slugify('Tích Hợp PDF Export'), 'tich-hop-pdf-export');
assert.strictEqual(
  slugify('sua loi treo ung dung khi xoa muc lich su', 30).endsWith('-'),
  false,
  'slugify must never end with a trailing hyphen after maxLen slicing'
);
const longTaskId = buildTaskId(
  '2026-11-22',
  '1916',
  0,
  'Sửa lỗi treo ứng dụng khi xóa mục lịch sử mà file tải về không còn tồn tại'
);
assert.strictEqual(longTaskId.endsWith('-'), false, `task_id must never end with "-", got: ${longTaskId}`);
assert.ok(longTaskId.length <= 50, `task_id must respect 50-char cap, got len=${longTaskId.length}`);
const jsonExtracted = extractJsonPayload('Here is the plan:\n```json\n{"tasks": [{"title": "Demo", "model": "kr/claude-sonnet-4.5-thinking"}]}\n```');
assert.strictEqual(jsonExtracted.tasks[0].title, 'Demo');
assert.strictEqual(jsonExtracted.tasks[0].model, 'kr/claude-sonnet-4.5-thinking');

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

// 13. Test Role-Specific Context Builders (Router Google Maps + Bounded File List, Reviewer Function-Context + Previous Issues)
const routerCtx = buildRouterContext(['agent-team/scripts/', 'agent-team/runtime/'], resolveRepoRoot(), 50);
assert.match(routerCtx, /AVAILABLE WORKSPACE FILES/);
assert.match(routerCtx, /- agent-team\/scripts\/applier\.mjs/);
assert.doesNotMatch(routerCtx, /__pycache__/);

const revPromptFresh = buildReviewerPrompt(
  {
    task_id: 'T-REV-1',
    goal: 'Fix timeout handling',
    constraints: ['Preserve existing indentation', 'Explicit timeout'],
    acceptance_criteria: ['All unit tests pass']
  },
  'diff --git a/src/service.js b/src/service.js\n+timeout=30',
  []
);
assert.match(revPromptFresh, /CONSTRAINTS:\n- Preserve existing indentation\n- Explicit timeout/);
assert.doesNotMatch(revPromptFresh, /PREVIOUS REVIEW ISSUES TO VERIFY/);
assert.match(revPromptFresh, /GIT DIFF \(WITH FUNCTION CONTEXT\):/);

const revPromptRetry = buildReviewerPrompt(
  {
    task_id: 'T-REV-1',
    goal: 'Fix timeout handling',
    constraints: ['Preserve existing indentation'],
    acceptance_criteria: ['All unit tests pass']
  },
  'diff --git a/src/service.js b/src/service.js\n+timeout=30',
  ['Missing timeout on subprocess.run at line 142']
);
// 14. Test 2-Slot Binding & Auto-Collapse Workflow (SPEC Section 3.6)
const mock1ModelTeam = {
  roles: {
    writer: { model: 'deepseek-chat' }
  }
};
const mockMultiModelTeam = {
  roles: {
    writer: { model: 'deepseek-chat' },
    architect: { model: 'claude-opus' },
    designer: { model: 'claude-sonnet' }
  }
};

// Quick mode auto-collapses to []
const quickWf = resolveWriterHubWorkflow({ mode: 'quick', scope: ['core/a.py'] }, mockMultiModelTeam);
assert.deepStrictEqual(quickWf, []);

// Consult mode auto-collapses to []
const consultWf = resolveWriterHubWorkflow({ mode: 'consult', scope: ['core/a.py'] }, mockMultiModelTeam);
assert.deepStrictEqual(consultWf, []);

// 1-Model setup (specModel === patchModel) auto-collapses to []
const oneModelWf = resolveWriterHubWorkflow({ mode: 'standard', scope: ['core/a.py'] }, mock1ModelTeam);
assert.deepStrictEqual(oneModelWf, []);

// Standard backend task with distinct architect generates 2-step workflow
const standardWf = resolveWriterHubWorkflow({ task_id: 'T-STD-1', mode: 'standard', scope: ['core/a.py'] }, mockMultiModelTeam);
assert.strictEqual(standardWf.length, 2);
assert.strictEqual(standardWf[0].role, 'architect');
assert.strictEqual(standardWf[0].action, 'draft_spec');
assert.strictEqual(standardWf[0].allow_skip_spec, true);
assert.strictEqual(standardWf[1].role, 'writer');
assert.strictEqual(standardWf[1].action, 'apply_patch');

// Standard frontend task binds designer ONLY when image attached OR (standard + new UI)
const uiMaintWf = resolveWriterHubWorkflow({ task_id: 'T-UI-MAINT', mode: 'standard', scope: ['ui_web/index.html'] }, mockMultiModelTeam);
assert.strictEqual(uiMaintWf.length, 0, 'Standard UI task without new UI or image must skip Designer');
const uiWf = resolveWriterHubWorkflow({
  task_id: 'T-UI-1',
  mode: 'standard',
  goal: 'Design new responsive panel UI layout in ui_web/index.html',
  scope: ['ui_web/index.html']
}, mockMultiModelTeam);
assert.strictEqual(uiWf.length, 2);
assert.strictEqual(uiWf[0].role, 'designer');

// 15. Test Dangling/Truncated SEARCH-REPLACE Block Rejection & Universal Dependency Risk
const danglingOutput = [
  'FILE: src/app.js',
  '<<<<<<< SEARCH',
  'const a = 1;',
  '=======',
  'const a = 2;',
  '>>>>>>> REPLACE',
  '<<<<<<< SEARCH',
  'const b = 3;',
  '=======',
  'const b = 4; // cut off mid-stream without closing marker'
].join('\n');
const danglingRes = applyEdits(danglingOutput, { scope: ['src/app.js'] }, { allowedDirs: ['src'] });
assert.strictEqual(danglingRes.ok, false, 'Dangling unclosed block must be rejected');
assert.strictEqual(danglingRes.truncated, true, 'Dangling block must set truncated=true');
assert.ok(danglingRes.error.includes('Truncated/dangling SEARCH-REPLACE block'), 'Error must mention truncated/dangling block');

assert.strictEqual(computeDeterministicRisk(['requirements.txt']), 'high', 'requirements.txt must escalate to high risk');
assert.strictEqual(computeDeterministicRisk(['package.json']), 'high', 'package.json must escalate to high risk');
assert.strictEqual(computeDeterministicRisk(['Cargo.toml']), 'high', 'Cargo.toml must escalate to high risk');
assert.strictEqual(computeDeterministicRisk(['src/utils.js']), 'low', 'Normal source file remains low risk');

console.log('✓ Slot-Binding, Auto-Collapse & Dangling Block / Supply-Chain Risk Guard passed');

// 16. Test Normalized Error Hash Across Files, Single Canonical State Transition, Steps Telemetry & Test Integrity Guard
const truncErrFileA = 'Truncated/dangling SEARCH-REPLACE block detected in "ui_bridge/js_api.py" (unclosed SEARCH block without >>>>>>> REPLACE). Refusing to apply partial output. (raw output saved: agent-team\\state\\runs\\T-1\\attempt-1.txt)';
const truncErrFileB = 'Truncated/dangling SEARCH-REPLACE block detected in "tests/test_eraser.py" (unclosed SEARCH block without >>>>>>> REPLACE). Refusing to apply partial output. (raw output saved: agent-team\\state\\runs\\T-1\\attempt-2.txt)';
assert.strictEqual(
  hashString(truncErrFileA),
  hashString(truncErrFileB),
  'Identical error classes across different files and attempts must produce the exact same error_hash'
);

const searchBlockErrA = 'SEARCH block 1 not found in "ui_bridge/js_api.py". Check exact indentation and whitespace.';
const searchBlockErrB = 'SEARCH block 5 not found in "core/eraser.py". Check exact indentation and whitespace.';
assert.strictEqual(
  hashString(searchBlockErrA),
  hashString(searchBlockErrB),
  'SEARCH block N not found across different files must normalize to the same hash'
);

// Canonical State Transition Invariants:
// 1. Task ID exists in at most ONE list (removed from active_tasks and blocked_tasks when done)
// 2. Stale last_error and block_reason are stripped on done, while error_history is preserved
const mockState = {
  version: '2.1',
  active_tasks: [{ task_id: 'T-CLEAN-1', status: 'ready' }],
  completed_tasks: [],
  blocked_tasks: [{ task_id: 'T-CLEAN-1', status: 'blocked', block_reason: 'Old block' }],
  metrics: { total_input_tokens: 100, total_output_tokens: 20, total_cost_est_usd: 0 }
};
const mockTask = {
  task_id: 'T-CLEAN-1',
  mode: 'standard',
  status: 'writing',
  retries: 1,
  last_error: 'Truncated block on attempt 1',
  block_reason: 'Infinite fix loop detected in apply',
  error_history: [{ attempt: 1, stage: 'apply', error_hash: 'abc', summary: 'Truncated block' }]
};
recordTaskStep(mockTask, {
  step: '1.1',
  attempt: 1,
  role: 'reviewer',
  action: 'draft_spec',
  requested_model: 'ag/claude-opus-5-5-medium',
  actual_model: 'ag/claude-opus-5-5-medium',
  model: 'ag/claude-opus-5-5-medium',
  finish_reason: 'stop',
  max_tokens_sent: 8192,
  scope: ['core/eraser.py'],
  prompt_tokens: 12000,
  cached_tokens: 4000,
  completion_tokens: 500,
  reasoning_tokens: 200,
  duration_ms: 5200,
  status: 'ok'
}, { skipJsonl: true });
transitionTaskState(mockTask, mockState, 'done', {
  actualModifiedFiles: ['core/eraser.py'],
  validationPassed: true,
  retries: 1
});
assert.strictEqual(mockTask.status, 'done');
assert.strictEqual('last_error' in mockTask, false, 'last_error must be deleted when task is done');
assert.strictEqual('block_reason' in mockTask, false, 'block_reason must be deleted when task is done');
assert.strictEqual(mockTask.error_history.length, 1, 'error_history must be preserved when task is done');
assert.strictEqual(mockTask.steps.length, 1, 'steps[] telemetry array must be preserved on task');
assert.strictEqual(mockTask.steps[0].total_tokens, 12500);
assert.strictEqual(mockState.active_tasks.length, 0, 'Done task must be removed from active_tasks');
assert.strictEqual(mockState.blocked_tasks.length, 0, 'Done task must be removed from blocked_tasks');
assert.strictEqual(mockState.completed_tasks.length, 1, 'Done task must exist in completed_tasks');

// Calibrated Dynamic Task Budget (~360k-450k for 4-file standard task, NOT 1,125,000)
const calibratedBudget = computeDynamicTaskTokenBudget(
  { task_id: 'T-BUDGET', mode: 'standard', risk_level: 'medium', scope: ['core/a.py', 'ui_bridge/b.py', 'tests/c.py', 'ui_web/d.html'] },
  [{ action: 'draft_spec' }, { action: 'draft_spec' }, { action: 'apply_patch' }, { action: 'apply_patch' }]
);
assert.ok(calibratedBudget >= 250000 && calibratedBudget <= 480000, `Expected calibrated budget in 250k..480k range, got ${calibratedBudget}`);

// Deterministic 0-Token Test-Suite Preservation Guard
const skipDiff = [
  'diff --git a/tests/test_eraser.py b/tests/test_eraser.py',
  '--- a/tests/test_eraser.py',
  '+++ b/tests/test_eraser.py',
  '@@ -10,3 +10,4 @@',
  '+    @unittest.skip("skip broken test")',
  '     def test_blur_mode(self):'
].join('\n');
const skipIntegrity = verifyTestDiffIntegrity(skipDiff, { title: 'Update blur filter' });
assert.strictEqual(skipIntegrity.ok, false, 'Unconditional @unittest.skip in test diff must be rejected');

const tautologyDiff = [
  'diff --git a/tests/test_eraser.py b/tests/test_eraser.py',
  '--- a/tests/test_eraser.py',
  '+++ b/tests/test_eraser.py',
  '@@ -10,3 +10,3 @@',
  '-        self.assertEqual(res.suggested_mode, "blur")',
  '+        self.assertTrue(True)'
].join('\n');
const tautologyIntegrity = verifyTestDiffIntegrity(tautologyDiff, { title: 'Update blur filter' });
assert.strictEqual(tautologyIntegrity.ok, false, 'Tautological assertTrue(True) must be rejected');

// Feature-Flagged Solo-First: disabled by default, enabled only when flag is true + remove/refactor/bugfix
const defaultRemoveWf = resolveWriterHubWorkflow(
  { task_id: 'T-REM', mode: 'standard', kind: 'remove', scope: ['core/a.py'], acceptance_criteria: ['AC1', 'AC2'] },
  mockMultiModelTeam
);
assert.strictEqual(defaultRemoveWf.some(s => s.action === 'draft_spec'), true, 'Default policy keeps draft_spec enabled until A/B measured');

const soloFirstRemoveWf = resolveWriterHubWorkflow(
  { task_id: 'T-REM-SOLO', mode: 'standard', kind: 'remove', scope: ['core/a.py'], acceptance_criteria: ['AC1', 'AC2'] },
  mockMultiModelTeam,
  { policy: { workflow_optimization: { solo_first_for_clear_tasks: true } } }
);
assert.strictEqual(soloFirstRemoveWf.some(s => s.action === 'draft_spec'), false, 'With solo_first_for_clear_tasks=true, clear remove task skips draft_spec');

console.log('✓ Normalized Error Hash, Canonical State Transition, Steps Telemetry & Test Integrity Guard passed');

// ============================================================================
// 20. Enriched Step Telemetry Schema, Token Reconciliation, Secret Redaction & Median/IQR
// ============================================================================
console.log('\n--- Test 20: Enriched Telemetry Schema, Token Reconciliation, Secret Redaction & Median/IQR ---');

const stepEntry = mockTask.steps[0];
assert.ok(stepEntry.orchestrator_git_sha && stepEntry.orchestrator_git_sha.length >= 4, 'Must record orchestrator_git_sha');
assert.ok(stepEntry.policy_version && stepEntry.policy_version.startsWith('3.1.0'), `Expected policy_version 3.1.0+, got ${stepEntry.policy_version}`);
assert.strictEqual(stepEntry.requested_model, 'ag/claude-opus-5-5-medium');
assert.strictEqual(stepEntry.actual_model, 'ag/claude-opus-5-5-medium');
assert.strictEqual(stepEntry.fallback_activated, false);
assert.strictEqual(stepEntry.finish_reason, 'stop');
assert.strictEqual(stepEntry.max_tokens_sent, 8192);
assert.ok(stepEntry.cost_est_usd > 0, 'Must compute positive USD cost estimate');

// Fallback tracking & reconciliation check
recordTaskStep(mockTask, {
  step: '2.1',
  attempt: 1,
  role: 'writer',
  action: 'apply_patch',
  requested_model: 'deepseek-ai/deepseek-v4.1-flash-1017',
  actual_model: 'ag/gemini-3.8-flash-medium',
  fallback_activated: true,
  fallback_reason: 'HTTP 404: No active credentials for provider: deepseek-ai',
  finish_reason: 'stop',
  max_tokens_sent: 16384,
  scope: ['core/eraser.py'],
  prompt_tokens: 20000,
  cached_tokens: 15000,
  completion_tokens: 1500,
  reasoning_tokens: 0,
  duration_ms: 8400,
  status: 'ok',
  applier_status: 'accepted'
}, { skipJsonl: true });

assert.strictEqual(mockTask.steps[1].fallback_activated, true);
assert.ok(mockTask.steps[1].fallback_reason.includes('No active credentials'));

const reconExact = reconcileTaskTokens(mockTask, 12500 + 21500);
assert.strictEqual(reconExact.ok, true, 'Exact token sum must pass reconciliation with drift=0');
assert.strictEqual(reconExact.drift, 0);
assert.strictEqual(reconExact.steps_total, 34000);

const reconDrifted = reconcileTaskTokens(mockTask, 30000);
assert.strictEqual(reconDrifted.ok, false, 'Mismatched state delta must fail reconciliation and report drift');
assert.strictEqual(reconDrifted.drift, 4000);
assert.ok(reconDrifted.warning && reconDrifted.warning.includes('[Telemetry Drift Warning]'));

// Secret redaction in raw logs
const rawWithSecrets = 'Authorization: Bearer sk-live-9876543210abcdef12345 and api_key="AIzaSyD-1234567890abcdefghijklmnop"';
const redacted = redactSecretsFromText(rawWithSecrets);
assert.strictEqual(redacted.includes('sk-live-9876543210abcdef12345'), false, 'Bearer sk- token must be redacted');
assert.strictEqual(redacted.includes('AIzaSyD-1234567890abcdefghijklmnop'), false, 'Google API key must be redacted');
assert.ok(redacted.includes('[REDACTED_SECRET]'));

// Median & IQR calculation
const stats = computeMedianAndRange([603, 1693, 6630, 14200, 52400]);
assert.strictEqual(stats.median, 6630);
assert.strictEqual(stats.min, 603);
assert.strictEqual(stats.max, 52400);
assert.strictEqual(stats.iqr, 14200 - 1693);

console.log('✓ Enriched Telemetry Schema, Token Reconciliation, Secret Redaction & Median/IQR passed');

console.log('\n=============================================');
console.log('ALL V2.1 APPLIER & ORCHESTRATOR TESTS PASSED! 🎯');
console.log('=============================================');
