import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEdits,
  checkForbidden,
  isFileInScope,
  matchesPattern,
  normalizeOrThrow
} from './applier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

console.log('Testing Applier v2.1 pipeline...');

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

// Test 4: Strict Scope rejection
const outOfScopeRes = applyEdits('### FILE: core/unknown.py\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE', {
  scope: ['core/downloader.py'],
  allow_scope_expansion: false
}, {
  allowedDirs: ['core/']
});
assert.strictEqual(outOfScopeRes.ok, false);
assert.match(outOfScopeRes.error, /Out-of-scope edit attempted/);
console.log('✓ Strict scope rejection passed');

// Test 5: Scope Expansion with limit
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
console.log('✓ Scope expansion limit check passed');

console.log('\n=============================================');
console.log('ALL V2.1 APPLIER TESTS PASSED SUCCESSFULLY! 🎯');
console.log('=============================================');
