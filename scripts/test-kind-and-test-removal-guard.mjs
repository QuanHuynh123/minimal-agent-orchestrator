#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decomposeGoal } from './goal-planner.mjs';
import { analyzeTaskDemand } from './lib/risk-policy.mjs';
import { verifyTestDiffIntegrity } from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

function makeSseCompletion(model, content) {
  return new Response(
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4000, completion_tokens: 120, total_tokens: 4120 } })}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function runTests() {
  console.log('Testing Item 3: Router kind enum, noun-safe fallback & explicit remove + tree-sitter test deletion guard...\n');

  // 1. Router prompt role doc includes full 6-value kind enum
  const routerMd = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'router.md'), 'utf8');
  for (const k of ['feature', 'bugfix', 'refactor', 'remove', 'test', 'docs']) {
    assert.ok(routerMd.includes(k), `roles/router.md schema must document kind enum value "${k}"`);
  }

  // 2. Noun-safe heuristic fallback: "xóa" used inside feature name/noun MUST NOT infer kind='remove'
  const nounCases = [
    {
      title: 'Thêm nút xuất lịch sử trong tab Xóa phụ đề',
      goal: 'Thêm nút export log vào tab Xóa phụ đề ở web/app.html',
      scope: ['web/app.html'],
      forbiddenKind: 'remove',
      expectedKind: 'feature'
    },
    {
      title: 'Sửa lỗi crash chế độ xóa nền',
      goal: 'Khắc phục lỗi crash khi chạy chức năng xóa watermark và xóa nền',
      scope: ['core/worker.py'],
      forbiddenKind: 'remove',
      expectedKind: 'bugfix'
    },
    {
      title: 'Tối ưu công cụ xóa chữ',
      goal: 'Refactor và tối ưu tốc độ công cụ xóa chữ trong core/worker.py',
      scope: ['core/worker.py'],
      forbiddenKind: 'remove',
      expectedKind: 'refactor'
    }
  ];
  for (const nc of nounCases) {
    const d = analyzeTaskDemand({ title: nc.title, goal: nc.goal, scope: nc.scope, mode: 'quick', risk_level: 'low' });
    assert.notEqual(d.kind, nc.forbiddenKind, `Feature noun containing "xóa" must NOT infer remove: "${nc.goal}"`);
    assert.equal(d.kind, nc.expectedKind, `Expected "${nc.expectedKind}" for "${nc.goal}", got "${d.kind}"`);
    assert.equal(d.kindSource, 'heuristic');
  }

  // Test-only and docs-only scopes infer test / docs cleanly when omitted
  assert.equal(analyzeTaskDemand({ goal: 'Add cases', scope: ['tests/test_alpha.py'] }).kind, 'test');
  assert.equal(analyzeTaskDemand({ goal: 'Update notes', scope: ['docs/guide.md'] }).kind, 'docs');

  // 3. goal-planner preserves Router kind (including 'test'/'docs'), leaves missing kind open to analyzeTaskDemand (never forces 'feature')
  const tmpSess = fs.mkdtempSync(path.join(os.tmpdir(), 'td-kind-planner-'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-kind-repo-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'core'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'test_indentation.py'), 'def test_ok():\n\tassert True\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'core', 'eraser.py'), 'def compute_ratio(x):\n\treturn x\n', 'utf8');

    // 3a. Router emits 'test'
    const resTestKind = await decomposeGoal(
      'Bổ sung kiểm thử đơn vị trong tests/test_indentation.py',
      {
        dryRun: true,
        repoRoot: tmpRepo,
        sessionsDir: tmpSess,
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_u, init) => {
          const payload = JSON.parse(String(init.body || '{}'));
          return makeSseCompletion(payload.model, JSON.stringify({
            tasks: [{
              title: 'Add unit tests',
              goal: 'Add edge case assertions in tests/test_indentation.py',
              kind: 'test',
              mode: 'quick',
              risk_level: 'low',
              scope: ['tests/test_indentation.py'],
              acceptance_criteria: ['Test passes']
            }]
          }));
        }
      }
    );
    assert.equal(resTestKind.ok, true, resTestKind.error);
    assert.equal(resTestKind.tasks[0]?.kind, 'test', 'goal-planner must accept Router kind="test"');
    assert.equal(resTestKind.tasks[0]?.kind_source, 'router');

    // 3b. Router omits kind on a bugfix goal -> goal-planner MUST NOT hardcode 'feature'; lets analyzeTaskDemand infer 'bugfix' with kind_source='heuristic'
    const resOmitted = await decomposeGoal(
      'Khắc phục lỗi chia cho 0 trong core/eraser.py',
      {
        dryRun: true,
        repoRoot: tmpRepo,
        sessionsDir: tmpSess,
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_u, init) => {
          const payload = JSON.parse(String(init.body || '{}'));
          return makeSseCompletion(payload.model, JSON.stringify({
            tasks: [{
              title: 'Fix division zero',
              goal: 'Sửa lỗi chia cho 0 khi tính tỷ lệ khung hình',
              mode: 'quick',
              risk_level: 'low',
              scope: ['core/eraser.py'],
              acceptance_criteria: ['Zero guard added']
            }]
          }));
        }
      }
    );
    assert.equal(resOmitted.ok, true, resOmitted.error);
    assert.equal(resOmitted.tasks[0]?.kind, 'bugfix', 'Missing kind must be inferred by analyzeTaskDemand, never hardcoded to feature');
    assert.equal(resOmitted.tasks[0]?.kind_source, 'heuristic');
  } finally {
    fs.rmSync(tmpSess, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  // 4. Test deletion integrity: allowed ONLY when kind='remove' explicitly AND deleted test references removed code symbol (tree-sitter)
  const validRemoveDiff = [
    'diff --git a/core/worker.py b/core/worker.py',
    '--- a/core/worker.py',
    '+++ b/core/worker.py',
    '@@ -1,6 +1,2 @@',
    '-def legacy_compute(x):',
    '-\treturn x + 1',
    ' def active_compute(x):',
    ' \treturn x * 2',
    'diff --git a/tests/test_worker.py b/tests/test_worker.py',
    '--- a/tests/test_worker.py',
    '+++ b/tests/test_worker.py',
    '@@ -1,6 +1,3 @@',
    '-def test_legacy_compute(self):',
    '-\tself.assertEqual(legacy_compute(2), 3)',
    ' def test_active_compute(self):',
    ' \tself.assertEqual(active_compute(2), 4)'
  ].join('\n');

  // 4a. Blocked if kind is heuristic/regex-inferred (even though goal says "Loại bỏ")
  const blockedHeuristic = verifyTestDiffIntegrity(validRemoveDiff, {
    title: 'Loại bỏ legacy_compute',
    goal: 'Loại bỏ hàm legacy_compute và test liên quan',
    kind: 'remove',
    kind_source: 'heuristic'
  });
  assert.equal(blockedHeuristic.ok, false, 'Regex/heuristic-inferred remove MUST NOT allow deleting tests');

  // 4b. Blocked if kind is missing or non-remove even if goal says "remove"
  const blockedNonExplicit = verifyTestDiffIntegrity(validRemoveDiff, {
    title: 'Remove unused code',
    goal: 'Remove legacy_compute and delete old test',
    kind: 'refactor',
    kind_source: 'router'
  });
  assert.equal(blockedNonExplicit.ok, false, 'Non-remove task must NOT allow deleting tests via goal keywords');

  // 4b-2. Explicitly verify kind='feature' (user or router) NEVER relaxes verifyTestDiffIntegrity
  for (const source of ['router', 'user']) {
    const blockedFeaturePlain = verifyTestDiffIntegrity(validRemoveDiff, {
      title: 'Feature update',
      goal: 'Clean up feature handler',
      kind: 'feature',
      kind_source: source
    });
    assert.equal(blockedFeaturePlain.ok, false, `kind=feature (source=${source}) must block test deletion even when symbol removed`);
  }

  // 4b-3. Bypass regression guard: deleting an existing test while adding an unrelated new test
  // (removedTestFuncs === addedTestFuncs) MUST still be blocked for kind=refactor and kind=feature
  const deletePlusAddDiff = [
    'diff --git a/core/worker.py b/core/worker.py',
    '--- a/core/worker.py',
    '+++ b/core/worker.py',
    '@@ -1,6 +1,4 @@',
    '-def legacy_compute(x):',
    '-\treturn x + 1',
    ' def active_compute(x):',
    ' \treturn x * 2',
    'diff --git a/tests/test_worker.py b/tests/test_worker.py',
    '--- a/tests/test_worker.py',
    '+++ b/tests/test_worker.py',
    '@@ -1,6 +1,6 @@',
    '-def test_legacy_compute(self):',
    '-\tself.assertEqual(legacy_compute(2), 3)',
    '+def test_unrelated_added(self):',
    '+\tself.assertEqual(active_compute(5), 10)',
    ' def test_active_compute(self):',
    ' \tself.assertEqual(active_compute(2), 4)'
  ].join('\n');
  const blockedRefactorSwap = verifyTestDiffIntegrity(deletePlusAddDiff, {
    title: 'Refactor worker',
    goal: 'Refactor worker compute helpers',
    kind: 'refactor',
    kind_source: 'user'
  });
  assert.equal(blockedRefactorSwap.ok, false, 'kind=refactor must block deleting a test even when an unrelated test is added');

  const blockedFeatureSwap = verifyTestDiffIntegrity(deletePlusAddDiff, {
    title: 'Add worker feature',
    goal: 'Add compute option',
    kind: 'feature',
    kind_source: 'router'
  });
  assert.equal(blockedFeatureSwap.ok, false, 'kind=feature must block deleting a test even when an unrelated test is added');

  // 4c. Blocked if explicit kind='remove' BUT deleted test references an active (non-removed) symbol
  const unrelatedDeleteDiff = [
    'diff --git a/core/worker.py b/core/worker.py',
    '--- a/core/worker.py',
    '+++ b/core/worker.py',
    '@@ -1,6 +1,4 @@',
    '-def legacy_compute(x):',
    '-\treturn x + 1',
    ' def active_compute(x):',
    ' \treturn x * 2',
    'diff --git a/tests/test_worker.py b/tests/test_worker.py',
    '--- a/tests/test_worker.py',
    '+++ b/tests/test_worker.py',
    '@@ -1,6 +1,2 @@',
    '-def test_active_regression(self):',
    '-\tself.assertEqual(active_compute(3), 6)'
  ].join('\n');
  const blockedUnrelatedSymbol = verifyTestDiffIntegrity(unrelatedDeleteDiff, {
    title: 'Remove legacy_compute',
    goal: 'Remove legacy_compute',
    kind: 'remove',
    kind_source: 'router'
  });
  assert.equal(blockedUnrelatedSymbol.ok, false, 'Must reject deleting test that does NOT reference removed symbol via tree-sitter');

  // 4d. Allowed ONLY when explicit kind='remove' AND deleted test references symbol removed in code diff
  const allowedExplicitRemove = verifyTestDiffIntegrity(validRemoveDiff, {
    title: 'Remove legacy_compute',
    goal: 'Remove legacy_compute cleanly',
    kind: 'remove',
    kind_source: 'router'
  });
  assert.equal(allowedExplicitRemove.ok, true, `Explicit kind=remove deleting test referencing removed symbol must pass: ${allowedExplicitRemove.violations.join('; ')}`);

  console.log('✓ All Item 3 kind enum, noun-safe fallback & explicit remove + tree-sitter guard tests passed.');
}

runTests().catch(err => {
  console.error('Item 3 test failed:', err);
  process.exit(1);
});
