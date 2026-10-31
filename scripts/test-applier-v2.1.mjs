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
  normalizeOrThrow
} from './applier.mjs';
import {
  acquireLock,
  buildScopedFilesContext,
  normalizeTask,
  releaseLock,
  resolveTaskMode
} from './orchestrator.mjs';
import { hashString, normalizeErrorForHash } from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
const expansionOkRes = applyEdits('### FILE: core/unknown.py\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: true,
  scope_expansions: []
}, {
  allowedDirs: ['core/'],
  maxScopeIncrease: 1
});
// Fails because SEARCH block not found on disk, but passed scope check!
assert.match(expansionOkRes.error, /SEARCH block 1 not found/);

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
console.log('✓ Scope expansion limit & high-risk escalation block passed');

// Test 6: Task Schema Normalization (task_id vs task.id) & Mode Resolution
const legacyTask = normalizeTask({ task: { id: 'T-001', scope: ['core/a.py'] } });
const flatTask = normalizeTask({ task_id: 'T-002', scope: ['core/a.py', 'core/b.py', 'core/c.py', 'core/d.py'] });
assert.strictEqual(legacyTask.task_id, 'T-001');
assert.strictEqual(legacyTask.id, 'T-001');
assert.strictEqual(resolveTaskMode(legacyTask), 'quick');
assert.strictEqual(resolveTaskMode(flatTask), 'standard');
console.log('✓ Task schema normalization & Mode-Based resolution passed');

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

console.log('\n=============================================');
console.log('ALL V2.1 APPLIER & ORCHESTRATOR TESTS PASSED! 🎯');
console.log('=============================================');
