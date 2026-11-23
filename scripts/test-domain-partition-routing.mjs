#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  analyzeTaskDemand,
  partitionScopeByDomain,
  resolveWriterHubWorkflow,
  UI_INTENT_REGEX
} from './lib/risk-policy.mjs';
import { loadMergedPolicy } from './lib/policy-loader.mjs';
import { verifyPlannedScope } from './goal-planner.mjs';

const GENERIC_TEAM = {
  roles: {
    router: { enabled: true, model: 'mock/cheap-router', default_model: 'mock/cheap-router' },
    writer: { enabled: true, model: 'mock/primary-writer', default_model: 'mock/primary-writer', models: ['mock/primary-writer', 'mock/fallback-writer'] },
    designer: { enabled: true, model: 'mock/ui-designer', default_model: 'mock/ui-designer' },
    reviewer: { enabled: true, model: 'mock/strong-reviewer', default_model: 'mock/strong-reviewer' }
  }
};

function runTests() {
  console.log('Testing Item 1: partitionScopeByDomain, hasBackendImpl, isCrossDomain & sub_scope dedup...\n');

  // 1. Test files must go ONLY to testScope, never backendScope (including .js/.ts/.py tests)
  const pHtmlPyTest = partitionScopeByDomain(['web/app.html', 'tests/test_view.py']);
  assert.deepEqual(pHtmlPyTest.frontendScope, ['web/app.html']);
  assert.deepEqual(pHtmlPyTest.backendScope, [], 'Test file must NOT enter backendScope');
  assert.deepEqual(pHtmlPyTest.testScope, ['tests/test_view.py']);

  const pJsTests = partitionScopeByDomain([
    'src/calc.test.js',
    'src/widget.spec.js',
    'tests/helpers.js',
    'src/test-utils.js',
    'src/service.js'
  ]);
  assert.deepEqual(pJsTests.backendScope, ['src/service.js'], 'Only non-test JS implementation belongs in backendScope');
  assert.deepEqual(
    pJsTests.testScope,
    ['src/calc.test.js', 'src/widget.spec.js', 'tests/helpers.js', 'src/test-utils.js'],
    'All .js test variants must enter testScope only'
  );

  // 2. [html + test.py]: NOT cross-domain, quick remains quick, workflow collapses to single Writer (no spec)
  const taskHtmlPlusTest = {
    task_id: 'T-GEN-HTML-TEST',
    title: 'Update form markup and contract test',
    goal: 'Update controls in web/app.html and sync tests/test_view.py',
    mode: 'quick',
    risk_level: 'low',
    scope: ['web/app.html', 'tests/test_view.py']
  };
  const demandHtmlTest = analyzeTaskDemand(taskHtmlPlusTest);
  assert.equal(demandHtmlTest.hasBackendImpl, false, '[html + test.py] has NO backend impl');
  assert.equal(demandHtmlTest.hasBackend, false);
  assert.equal(demandHtmlTest.hasFrontend, true);
  assert.equal(demandHtmlTest.hasTests, true);
  assert.equal(demandHtmlTest.isCrossDomain, false, '[html + test.py] MUST NOT be treated as cross-domain');
  assert.equal(demandHtmlTest.mode, 'quick', '[html + test.py] quick mode must stay quick');
  assert.equal(demandHtmlTest.needsTechSpec, false, 'needsTechSpec must be false without hasBackendImpl');
  const wfHtmlTest = resolveWriterHubWorkflow(taskHtmlPlusTest, GENERIC_TEAM);
  assert.deepEqual(wfHtmlTest, [], '[html + test.py] quick/low must collapse to 1-step Writer ([]) without spec');

  // Also verify architect preset or standard mode on [html + test.py] does NOT request TechSpec when hasBackendImpl=false
  const wfHtmlTestArch = resolveWriterHubWorkflow({ ...taskHtmlPlusTest, mode: 'standard' }, GENERIC_TEAM, {}, 'architect');
  assert.equal(
    wfHtmlTestArch.some(s => s.action === 'draft_spec' && s.spec_focus === 'architecture_and_contracts'),
    false,
    'wantTechSpec must remain false when hasBackendImpl is false'
  );

  // 3. [html + core/*.py]: genuine cross-domain -> hasBackendImpl=true, isCrossDomain=true, mode escalates to standard
  const taskHtmlPlusBackend = {
    task_id: 'T-GEN-CROSS',
    title: 'Wire endpoint and page view',
    goal: 'Add handler in core/service.py and bind in web/app.html',
    mode: 'quick',
    risk_level: 'low',
    scope: ['web/app.html', 'core/service.py']
  };
  const demandCross = analyzeTaskDemand(taskHtmlPlusBackend);
  assert.equal(demandCross.hasBackendImpl, true);
  assert.equal(demandCross.hasFrontend, true);
  assert.equal(demandCross.isCrossDomain, true, '[html + core/*.py] must be cross-domain');
  assert.equal(demandCross.mode, 'standard', 'Cross-domain BE+FE must escalate quick -> standard');
  assert.equal(demandCross.needsTechSpec, true);

  // 4. [test-only scope]: Python test-only & JS test-only -> single Writer ([]), NO spec even in standard/high/architect
  for (const testOnlyScope of [
    ['tests/test_alpha.py', 'tests/test_beta.py'],
    ['src/alpha.test.js', 'tests/beta.spec.js']
  ]) {
    const tOnly = {
      task_id: 'T-GEN-TEST-ONLY',
      title: 'Add unit test assertions',
      goal: 'Add edge case assertions in tests',
      mode: 'standard',
      risk_level: 'high',
      scope: testOnlyScope
    };
    const dOnly = analyzeTaskDemand(tOnly);
    assert.equal(dOnly.hasBackendImpl, false);
    assert.equal(dOnly.hasFrontend, false);
    assert.equal(dOnly.hasTests, true);
    assert.equal(dOnly.needsTechSpec, false, 'Test-only scope must not request TechSpec');
    assert.equal(dOnly.needsDesignSpec, false, 'Test-only scope must not request DesignSpec');
    assert.deepEqual(resolveWriterHubWorkflow(tOnly, GENERIC_TEAM), [], 'Test-only scope must collapse to single Writer');
    assert.deepEqual(resolveWriterHubWorkflow(tOnly, GENERIC_TEAM, {}, 'architect'), [], 'Test-only scope must collapse to single Writer even under architect preset');
  }

  // 5. sub_scope deduplication across partition and workflow steps (no duplicate entries)
  const dupPartition = partitionScopeByDomain([
    'core/mod.py',
    'core\\mod.py',
    'tests/test_mod.py',
    'tests\\test_mod.py',
    'web/view.html',
    'web/view.html'
  ]);
  assert.deepEqual(dupPartition.backendScope, ['core/mod.py']);
  assert.deepEqual(dupPartition.testScope, ['tests/test_mod.py']);
  assert.deepEqual(dupPartition.frontendScope, ['web/view.html']);

  const wfDupCheck = resolveWriterHubWorkflow(
    {
      task_id: 'T-GEN-DEDUP',
      title: 'Update core service and tests',
      goal: 'Add handler in core/mod.py and test in tests/test_mod.py',
      mode: 'standard',
      risk_level: 'high',
      scope: ['core/mod.py', 'tests/test_mod.py', 'core/mod.py', 'tests/test_mod.py']
    },
    GENERIC_TEAM
  );
  assert.ok(wfDupCheck.length >= 2);
  for (const step of wfDupCheck) {
    if (Array.isArray(step.sub_scope)) {
      assert.equal(
        new Set(step.sub_scope).size,
        step.sub_scope.length,
        `Step ${step.step} (${step.action}) sub_scope must have no duplicates: ${JSON.stringify(step.sub_scope)}`
      );
    }
  }

  // 6. Project policy.yaml frontend glob excludes legacy ui/ and keeps ui_web/; UI_INTENT_REGEX matches Vietnamese UI interaction words
  const projectPolicy = loadMergedPolicy();
  const legacyPartition = partitionScopeByDomain(
    ['core/history.py', 'ui/history_view.py', 'tests/test_ui_bridge.py'],
    projectPolicy
  );
  assert.deepEqual(
    legacyPartition.frontendScope,
    [],
    `Legacy ui/history_view.py must NOT be classified as frontend under project policy.yaml, got: ${JSON.stringify(legacyPartition.frontendScope)}`
  );
  const liveWebPartition = partitionScopeByDomain(['ui_web/index.html', 'tests/test_dom_contract.py'], projectPolicy);
  assert.deepEqual(liveWebPartition.frontendScope, ['ui_web/index.html'], 'ui_web/index.html must remain frontend');

  for (const phrase of ['màn hình cài đặt', 'bấm nút xóa', 'bị treo trắng']) {
    assert.equal(
      UI_INTENT_REGEX.test(phrase),
      true,
      `UI_INTENT_REGEX must match Vietnamese UI interaction phrase: "${phrase}"`
    );
  }
  const vnUiDemand = analyzeTaskDemand(
    {
      task_id: 'T-VN-UI-WARN',
      title: 'Sửa lỗi bấm nút trên màn hình bị treo',
      goal: 'Ở màn hình chính, bấm nút xóa mục thì ứng dụng bị treo',
      kind: 'bugfix',
      mode: 'quick',
      risk_level: 'low',
      scope: ['core/history.py', 'ui/history_view.py']
    },
    projectPolicy
  );
  assert.equal(vnUiDemand.hasFrontend, false);
  assert.equal(vnUiDemand.uiKeywordHint, true);
  const missingFeCheck = verifyPlannedScope(['core/history.py', 'ui/history_view.py'], process.cwd(), vnUiDemand);
  assert.ok(
    missingFeCheck.warnings.some(w => w.includes('no frontend/UI file was included')),
    `verifyPlannedScope must warn when Vietnamese UI goal has only legacy ui/ file, got: ${JSON.stringify(missingFeCheck.warnings)}`
  );

  console.log('✓ All Item 1 domain-partition & sub_scope deduplication tests passed.');
}

runTests();
