#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as orchestratorMod from './orchestrator.mjs';
import { computeCanonicalQueueState } from './lib/queue-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-contract-conflict-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeAndCommit(dir, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore' });
}

// 1. Check architect.md, draft_spec builder prompt & disabled reuse_spec
{
  const archDoc = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'architect.md'), 'utf8');
  assert.match(archDoc, /Bảng hợp đồng/i, 'architect.md must require Contract Table (Bảng hợp đồng)');
  assert.match(archDoc, /Input\s*[-–>]+\s*Output|Input\s*\|/i, 'architect.md must mention Input -> Output & Error/Fallback Cases');
  assert.match(archDoc, /Error\/Fallback|Error \/ Fallback/i, 'architect.md must mention Error/Fallback Cases');
  assert.match(archDoc, /acceptance_criteria.*thắng Spec|acceptance_criteria.*always wins/i, 'architect.md must state acceptance_criteria always wins over Spec');
  assert.match(archDoc, /\[ASSUMPTION\]/, 'architect.md must require marking Spec-added fallbacks with [ASSUMPTION]');

  assert.equal(
    typeof orchestratorMod.buildDraftSpecPrompts,
    'function',
    'orchestrator.mjs must export buildDraftSpecPrompts()'
  );
  assert.equal(
    orchestratorMod.SPEC_REUSE_ON_RETRY_ENABLED,
    false,
    'reuse_spec on retry must be disabled (SPEC_REUSE_ON_RETRY_ENABLED === false)'
  );

  const built = orchestratorMod.buildDraftSpecPrompts({
    wfStep: { step: 1, role: 'architect', spec_focus: 'architecture_and_contracts' },
    task: {
      task_id: 'T-CONFLICT-SPEC-1',
      goal: 'Fix open_file_location fallback contract',
      scope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
      constraints: ['100% TAB'],
      acceptance_criteria: ['Missing file returns ok=False unless parent dir fallback specified']
    },
    specScope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
    specScopedContext: '=== FILE: ui_bridge/js_api.py ===\nclass JsApi: pass'
  });
  assert.match(built.userMessage, /\[ASSUMPTION\]/, 'draft_spec user prompt must enforce [ASSUMPTION] tag rule');
  assert.match(built.userMessage, /acceptance_criteria/i, 'draft_spec user prompt must reinforce acceptance_criteria precedence');
  assert.match(built.userMessage, /Error\s*\/\s*Fallback|Contract Table|Bảng hợp đồng/i);

  assert.equal(
    typeof orchestratorMod.evaluateContractConflictGate,
    'function',
    'orchestrator.mjs must export evaluateContractConflictGate()'
  );
}

// 2. Unit test both branches of contract_conflict gate
const repo = makeTempGitRepo();
const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'td-conflict-state-'));
try {
  writeAndCommit(repo, {
    'ui_bridge/js_api.py': [
      'class JsApi:',
      '\tdef open_file_location(self, file_path: str):',
      '\t\treturn {"ok": False, "error": "missing"}'
    ].join('\n') + '\n',
    'tests/test_ui_bridge.py': [
      'import unittest',
      'from ui_bridge.api import JsApi',
      '',
      'class MediaPathResolutionTests(unittest.TestCase):',
      '\tdef test_existing(self):',
      '\t\tself.assertTrue(True)'
    ].join('\n') + '\n'
  }, 'init');

  const specRelPath = 'specs/T-CC-1_tech_spec.md';
  const specAbsPath = path.join(repo, specRelPath);
  fs.mkdirSync(path.dirname(specAbsPath), { recursive: true });
  fs.writeFileSync(specAbsPath, [
    '# Technical Specification',
    '- **`open_file_location(file_path: str) -> Dict[str, Any]`**:',
    '  - If file exists, launches `explorer.exe /select,"<abs_path>"`.',
    '  - [ASSUMPTION] Fallback: if only parent directory exists, opens parent folder and returns `{"ok": True, "path": str(parent)}`.'
  ].join('\n') + '\n', 'utf8');

  const applyAttemptEdits = (testExtraLines = 0) => {
    fs.writeFileSync(path.join(repo, 'ui_bridge/js_api.py'), [
      'class JsApi:',
      '\tdef open_file_location(self, file_path: str):',
      '\t\tparent = "/downloads"',
      '\t\t# Spec fallback: opens parent folder even when target file missing',
      '\t\treturn {"ok": True, "path": parent}'
    ].join('\n') + '\n', 'utf8');

    const padding = Array.from({ length: testExtraLines }, (_, i) => `\t\t# pad_${i}`).join('\n');
    fs.writeFileSync(path.join(repo, 'tests/test_ui_bridge.py'), [
      'import unittest',
      'from ui_bridge.api import JsApi',
      '',
      'class MediaPathResolutionTests(unittest.TestCase):',
      '\tdef test_existing(self):',
      '\t\tself.assertTrue(True)',
      '',
      ...(padding ? [padding] : []),
      '\tdef test_open_file_location_missing_file_reports_error(self):',
      '\t\t"""Added by task: missing file must report error."""',
      '\t\tapi = JsApi()',
      '\t\tres = api.open_file_location("missing.mp4")',
      '\t\tself.assertFalse(res["ok"])',
      '\t\tself.assertIn("error", res)',
      '',
      '\tdef test_resolve_media_path_relative(self):',
      '\t\tself.assertTrue(False)'
    ].join('\n') + '\n', 'utf8');
  };

  const absTest = path.join(repo, 'tests', 'test_ui_bridge.py');
  const absApi = path.join(repo, 'ui_bridge', 'js_api.py');
  const rollbackRepo = () => execFileSync('git', ['checkout', 'HEAD', '--', 'ui_bridge/js_api.py', 'tests/test_ui_bridge.py'], { cwd: repo, stdio: 'ignore' });

  // Branch A: Attempt 1 fails test_A, Attempt 2 fails test_B (DIFFERENT test/assertion) -> MUST continue retry
  {
    const taskA = {
      task_id: 'T-CC-DIFF',
      scope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
      acceptance_criteria: [
        'open_file_location returns error when file does not exist'
      ],
      attempt_test_failures: []
    };

    applyAttemptEdits(0);
    const diff1 = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
    const err1 = [
      '======================================================================',
      'FAIL: test_open_file_location_missing_file_reports_error (tests.test_ui_bridge.MediaPathResolutionTests.test_open_file_location_missing_file_reports_error)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      `  File "${absTest}", line 13, in test_open_file_location_missing_file_reports_error`,
      '    self.assertFalse(res["ok"])',
      'AssertionError: True is not false',
      '',
      'Ran 10 tests in 0.1s',
      'FAILED (failures=1)'
    ].join('\n');

    const gate1 = orchestratorMod.evaluateContractConflictGate({
      task: taskA,
      attemptNum: 1,
      errSummary: err1,
      diffText: diff1,
      specPaths: [specRelPath],
      repoRoot: repo
    });
    assert.equal(gate1.contractConflict, false, 'Attempt 1 alone cannot trigger 2x consecutive conflict');
    rollbackRepo();

    applyAttemptEdits(0);
    const diff2 = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
    const err2Diff = [
      '======================================================================',
      'FAIL: test_resolve_media_path_relative (tests.test_ui_bridge.MediaPathResolutionTests.test_resolve_media_path_relative)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      `  File "${absTest}", line 17, in test_resolve_media_path_relative`,
      '    self.assertTrue(False)',
      'AssertionError: False is not true',
      '',
      'Ran 8 tests in 0.1s',
      'FAILED (failures=1)'
    ].join('\n');

    const gate2Diff = orchestratorMod.evaluateContractConflictGate({
      task: taskA,
      attemptNum: 2,
      errSummary: err2Diff,
      diffText: diff2,
      specPaths: [specRelPath],
      repoRoot: repo
    });
    assert.equal(gate2Diff.contractConflict, false, 'Different failing test between Attempt 1 & Attempt 2 must allow retry');
    assert.notEqual(taskA.failure_class, 'contract_conflict');
    rollbackRepo();
  }

  // Branch B: SAME newly added test + SAME assertion fails 2 consecutive times (even at different line numbers) -> STOP immediately with contract_conflict
  {
    const taskB = {
      task_id: 'T-CC-1',
      status: 'running',
      scope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
      acceptance_criteria: [
        'Thao tác mở thư mục chứa file (location) trỏ chính xác vào file/thư mục tương ứng mà không báo lỗi'
      ],
      attempt_test_failures: []
    };

    applyAttemptEdits(0);
    const diff1 = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
    const errAtt1 = [
      '======================================================================',
      'FAIL: test_open_file_location_missing_file_reports_error (tests.test_ui_bridge.MediaPathResolutionTests.test_open_file_location_missing_file_reports_error)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      `  File "${absTest}", line 13, in test_open_file_location_missing_file_reports_error`,
      '    self.assertFalse(res["ok"])',
      `  File "${absApi}", line 5, in open_file_location`,
      '    return {"ok": True, "path": parent}',
      'AssertionError: True is not false',
      '',
      'Ran 10 tests in 0.1s',
      'FAILED (failures=2)'
    ].join('\n');

    const gateAtt1 = orchestratorMod.evaluateContractConflictGate({
      task: taskB,
      attemptNum: 1,
      errSummary: errAtt1,
      diffText: diff1,
      specPaths: [specRelPath],
      repoRoot: repo
    });
    assert.equal(gateAtt1.contractConflict, false);
    rollbackRepo();

    // Attempt 2 shifts lines by +4 and changes test count, but SAME test + SAME assertion fails again
    applyAttemptEdits(4);
    const diff2 = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
    const errAtt2 = [
      '======================================================================',
      'FAIL: test_open_file_location_missing_file_reports_error (tests.test_ui_bridge.MediaPathResolutionTests.test_open_file_location_missing_file_reports_error)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      `  File "${absTest}", line 17, in test_open_file_location_missing_file_reports_error`,
      '    self.assertFalse(res["ok"])',
      `  File "${absApi}", line 5, in open_file_location`,
      '    return {"ok": True, "path": parent}',
      'AssertionError: True is not false',
      '',
      'Ran 8 tests in 0.1s',
      'FAILED (failures=1)'
    ].join('\n');

    const gateAtt2 = orchestratorMod.evaluateContractConflictGate({
      task: taskB,
      attemptNum: 2,
      errSummary: errAtt2,
      diffText: diff2,
      specPaths: [specRelPath],
      repoRoot: repo
    });

    assert.equal(gateAtt2.contractConflict, true, 'Same new test + same assertion failing 2 consecutive attempts must trigger contract_conflict');
    assert.equal(taskB.status, 'blocked');
    assert.equal(taskB.failure_class, 'contract_conflict');

    const rpt = taskB.contract_conflict_report;
    assert.ok(rpt && typeof rpt === 'object', 'contract_conflict_report object must be populated');
    assert.ok(Array.isArray(rpt.acceptance_criteria) && rpt.acceptance_criteria.some(c => c.includes('Thao tác mở thư mục')), 'Report must quote acceptance_criteria');
    assert.match(rpt.spec_excerpts.join('\n'), /parent directory exists|ASSUMPTION|open_file_location/, 'Report must quote tech_spec.md excerpt');
    assert.match(rpt.failing_test_body, /def test_open_file_location_missing_file_reports_error/, 'Report must include failing test body');
    assert.match(rpt.failing_test_body, /self\.assertFalse\(res\["ok"\]\)/);
    assert.match(rpt.current_code_behavior, /return \{"ok": True, "path": parent\}/, 'Report must include current code behavior');

    // Verify queue-state preserves failure_class and contract_conflict_report across YAML + task-state merge
    const tmpActive = path.join(tmpState, 'active');
    const tmpArchive = path.join(tmpState, 'archive');
    fs.mkdirSync(tmpActive, { recursive: true });
    fs.mkdirSync(tmpArchive, { recursive: true });
    fs.writeFileSync(path.join(tmpActive, 'T-CC-1.yaml'), [
      'task_id: T-CC-1',
      'status: blocked',
      `block_reason: ${JSON.stringify(taskB.block_reason)}`
    ].join('\n') + '\n', 'utf8');

    const canonical = computeCanonicalQueueState({
      tasksActiveDir: tmpActive,
      tasksArchiveDir: tmpArchive,
      taskState: { blocked_tasks: [taskB], completed_tasks: [], active_tasks: [] }
    });
    assert.equal(canonical.blocked.length, 1);
    assert.equal(canonical.blocked[0].failure_class, 'contract_conflict');
    assert.ok(canonical.blocked[0].contract_conflict_report?.failing_test_body);
  }

  console.log('test-contract-conflict-and-architect-spec.mjs: ALL PASSED');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpState, { recursive: true, force: true });
}
