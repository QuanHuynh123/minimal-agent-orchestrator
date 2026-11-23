#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

import * as repoMap from '../runtime/repo-map.mjs';
import * as goalPlanner from './goal-planner.mjs';

function createTempSignatureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-sig-gate-'));
  fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'ui_bridge'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'ui_web'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
  const configDir = path.join(repoDir, '.sig-config');
  fs.mkdirSync(configDir, { recursive: true });
  const rawPol = fs.readFileSync(path.join(TEAM_DIR, 'config', 'policy.yaml'), 'utf8');
  const sigPol = rawPol.replace(
    /allowed_dirs:\s*\n(?:\s*-\s*[^\n]+\n)+/,
    'allowed_dirs:\n      - "core/"\n      - "ui_bridge/"\n      - "ui_web/"\n      - "tests/"\n'
  );
  fs.writeFileSync(path.join(configDir, 'policy.yaml'), sigPol, 'utf8');

  const alphaBefore = [
    'def compute_score(alpha, beta=1):',
    '\treturn alpha + beta',
    '',
    'def fn_other(item):',
    '\treturn item',
    ''
  ].join('\n');

  const callerSrc = [
    'from core.alpha import compute_score',
    '',
    'def run_caller():',
    '\treturn compute_score(1, 2)',
    ''
  ].join('\n');

  const otherCallerSrc = [
    'from core.alpha import fn_other',
    '',
    'def run_other_caller():',
    '\treturn fn_other("ok")',
    ''
  ].join('\n');

  const jsHelperBefore = [
    'export function formatBadge(label, tone = "info") {',
    '  return `${tone}:${label}`;',
    '}',
    ''
  ].join('\n');

  const jsViewSrc = [
    'import { formatBadge } from "./helpers.mjs";',
    '',
    'export function renderBanner() {',
    '  return formatBadge("Ready", "ok");',
    '}',
    ''
  ].join('\n');

  const pyTestSrc = [
    'from core.alpha import compute_score',
    '',
    'def test_compute():',
    '\tassert compute_score(2, 3) == 5',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(repoDir, 'core', 'alpha.py'), alphaBefore, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'ui_bridge', 'caller.py'), callerSrc, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'ui_bridge', 'other_caller.py'), otherCallerSrc, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'ui_web', 'helpers.mjs'), jsHelperBefore, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'ui_web', 'view.mjs'), jsViewSrc, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'tests', 'test_alpha.py'), pyTestSrc, 'utf8');

  return { repoDir, configDir, alphaBefore, jsHelperBefore };
}

async function runTests() {
  assert.strictEqual(
    typeof repoMap.extractPublicSymbolSignatures,
    'function',
    'repo-map.mjs must export extractPublicSymbolSignatures'
  );
  assert.strictEqual(
    typeof goalPlanner.evaluatePostPatchSignatureGate,
    'function',
    'goal-planner.mjs must export evaluatePostPatchSignatureGate'
  );

  // 1. AST full-param signature extraction (no 4-param truncation, skips _private)
  const pyCode = [
    'def _private_helper(a, b):',
    '\treturn a',
    '',
    'def long_public_fn(a: int, b: str, c: bool = False, d: float = 1.0, e: str = "tail") -> str:',
    '\treturn b',
    '',
    'class Processor:',
    '\tdef process(self, url, quality=720):',
    '\t\treturn url',
    ''
  ].join('\n');
  const extracted = repoMap.extractPublicSymbolSignatures('core/sample.py', pyCode);
  assert.strictEqual(extracted.parser, 'tree-sitter-wasm', 'Must parse via tree-sitter-wasm');
  assert.ok(!extracted.symbols._private_helper, 'Private _function must not be in public symbols');
  assert.ok(extracted.symbols.long_public_fn, 'Public function must be present');
  assert.ok(
    extracted.symbols.long_public_fn.signature.includes('e: str = "tail"'),
    `5th parameter must NOT be truncated; got: ${extracted.symbols.long_public_fn.signature}`
  );
  assert.ok(extracted.symbols['Processor.process'], 'Public class method must be present');

  const tmp = createTempSignatureRepo();
  try {
    // 2. Rename parameter of Python function WITH out-of-scope caller -> BLOCKED
    const alphaParamRenamed = [
      'def compute_score(alpha_renamed, beta=1):',
      '\treturn alpha_renamed + beta',
      '',
      'def fn_other(item):',
      '\treturn item',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(tmp.repoDir, 'core', 'alpha.py'), alphaParamRenamed, 'utf8');

    const resParamRenamed = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/alpha.py'],
      beforeContents: { 'core/alpha.py': tmp.alphaBefore },
      afterContents: { 'core/alpha.py': alphaParamRenamed },
      taskScope: ['core/alpha.py'],
      repoRoot: tmp.repoDir,
      candidateFiles: ['core/alpha.py', 'ui_bridge/caller.py', 'ui_bridge/other_caller.py', 'tests/test_alpha.py']
    });
    assert.strictEqual(resParamRenamed.blocked, true, 'Renaming param with out-of-scope caller must block');
    assert.strictEqual(resParamRenamed.reason, 'signature_change_out_of_scope');
    assert.ok(
      resParamRenamed.blocked_dependents.includes('ui_bridge/caller.py'),
      `Expected ui_bridge/caller.py in blocked_dependents, got: ${JSON.stringify(resParamRenamed.blocked_dependents)}`
    );
    assert.ok(
      !resParamRenamed.blocked_dependents.includes('ui_bridge/other_caller.py'),
      'Unrelated caller (fn_other only) must not be blamed for compute_score signature change'
    );
    assert.ok(
      !resParamRenamed.blocked_dependents.includes('tests/test_alpha.py'),
      'Test files are verification targets, not source-code dependent blockers'
    );

    // 3. Same signature, ONLY body edited -> PASSES
    const alphaBodyOnly = [
      'def compute_score(alpha, beta=1):',
      '\t# edited body only',
      '\treturn (alpha * 2) + beta',
      '',
      'def fn_other(item):',
      '\treturn item',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(tmp.repoDir, 'core', 'alpha.py'), alphaBodyOnly, 'utf8');

    const resBodyOnly = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/alpha.py'],
      beforeContents: { 'core/alpha.py': tmp.alphaBefore },
      afterContents: { 'core/alpha.py': alphaBodyOnly },
      taskScope: ['core/alpha.py'],
      repoRoot: tmp.repoDir,
      candidateFiles: ['core/alpha.py', 'ui_bridge/caller.py', 'ui_bridge/other_caller.py', 'tests/test_alpha.py']
    });
    assert.strictEqual(resBodyOnly.blocked, false, 'Body-only edit keeping signature must pass');
    assert.strictEqual(resBodyOnly.ok, true);
    assert.deepStrictEqual(resBodyOnly.changed_signatures, []);

    // 4. Rename param when ALL source-code callers ARE inside taskScope -> PASSES
    fs.writeFileSync(path.join(tmp.repoDir, 'core', 'alpha.py'), alphaParamRenamed, 'utf8');
    const resCallerInScope = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/alpha.py'],
      beforeContents: { 'core/alpha.py': tmp.alphaBefore },
      afterContents: { 'core/alpha.py': alphaParamRenamed },
      taskScope: ['core/alpha.py', 'ui_bridge/caller.py'],
      repoRoot: tmp.repoDir,
      candidateFiles: ['core/alpha.py', 'ui_bridge/caller.py', 'ui_bridge/other_caller.py', 'tests/test_alpha.py']
    });
    assert.strictEqual(resCallerInScope.blocked, false, 'When caller is inside scope, signature change is allowed');

    // 5. JS/MJS exported function param renamed with out-of-scope caller -> BLOCKED
    const jsParamRenamed = [
      'export function formatBadge(heading, tone = "info") {',
      '  return `${tone}:${heading}`;',
      '}',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(tmp.repoDir, 'ui_web', 'helpers.mjs'), jsParamRenamed, 'utf8');
    const resJsBlocked = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['ui_web/helpers.mjs'],
      beforeContents: { 'ui_web/helpers.mjs': tmp.jsHelperBefore },
      afterContents: { 'ui_web/helpers.mjs': jsParamRenamed },
      taskScope: ['ui_web/helpers.mjs'],
      repoRoot: tmp.repoDir,
      candidateFiles: ['ui_web/helpers.mjs', 'ui_web/view.mjs']
    });
    assert.strictEqual(resJsBlocked.blocked, true, 'JS param rename with out-of-scope caller must block');
    assert.strictEqual(resJsBlocked.reason, 'signature_change_out_of_scope');
    assert.deepStrictEqual(resJsBlocked.blocked_dependents, ['ui_web/view.mjs']);

    // 6. Signature changed when ONLY out-of-scope reference is a test file -> PASSES
    const resTestOnly = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/alpha.py'],
      beforeContents: { 'core/alpha.py': tmp.alphaBefore },
      afterContents: { 'core/alpha.py': alphaParamRenamed },
      taskScope: ['core/alpha.py'],
      repoRoot: tmp.repoDir,
      candidateFiles: ['core/alpha.py', 'ui_bridge/other_caller.py', 'tests/test_alpha.py']
    });
    assert.strictEqual(resTestOnly.blocked, false, 'Only test dependents + unrelated callers -> must pass');

    // 7. Orchestrator wires signature gate before validation
    const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
    assert.ok(orchSrc.includes('evaluatePostPatchSignatureGate'), 'orchestrator.mjs must invoke evaluatePostPatchSignatureGate');
    assert.ok(orchSrc.includes('signature_change_out_of_scope'), 'orchestrator.mjs must handle signature_change_out_of_scope');

    // 8. Batch 171 Item 2: Python JsApi method signature change referenced in ui_web/index.html -> BLOCKED (without Python imports)
    const jsApiBefore = [
      'class JsApi:',
      '\tdef delete_channel_profile(self, profile_id: str):',
      '\t\treturn {"ok": True}',
      '',
      '\tdef orphan_internal_helper(self, flag: bool = False):',
      '\t\treturn flag',
      ''
    ].join('\n');
    const jsApiBreak = [
      'class JsApi:',
      '\tdef delete_channel_profile(self, profile_id: str, confirm_token: str):',
      '\t\treturn {"ok": True}',
      '',
      '\tdef orphan_internal_helper(self, flag: bool = False):',
      '\t\treturn flag',
      ''
    ].join('\n');
    const jsApiOrphanChange = [
      'class JsApi:',
      '\tdef delete_channel_profile(self, profile_id: str):',
      '\t\treturn {"ok": True}',
      '',
      '\tdef orphan_internal_helper(self, strict_mode: bool = True):',
      '\t\treturn strict_mode',
      ''
    ].join('\n');

    fs.writeFileSync(path.join(tmp.repoDir, 'ui_bridge', 'js_api.py'), jsApiBreak, 'utf8');
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'index.html'),
      '<html><body><script>async function onDelete(id){ return window.pywebview.api.delete_channel_profile(id); }</script></body></html>\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge.js'),
      'export function callOther(){ return window.pywebview.api.ping_status(); }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge_caller.mjs'),
      'export function invoke(api, id){ return api.delete_channel_profile.call(api, id); }\n',
      'utf8'
    );

    const resHtmlBlocked = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['ui_bridge/js_api.py'],
      beforeContents: { 'ui_bridge/js_api.py': jsApiBefore },
      afterContents: { 'ui_bridge/js_api.py': jsApiBreak },
      taskScope: ['ui_bridge/js_api.py'],
      repoRoot: tmp.repoDir,
      configDir: tmp.configDir
    });
    assert.strictEqual(resHtmlBlocked.blocked, true, 'Changing JsApi method signature referenced in ui_web/index.html must block');
    assert.strictEqual(resHtmlBlocked.reason, 'signature_change_out_of_scope');
    assert.ok(
      resHtmlBlocked.blocked_dependents.includes('ui_web/index.html'),
      `Expected ui_web/index.html in blocked_dependents, got: ${JSON.stringify(resHtmlBlocked.blocked_dependents)}`
    );
    assert.ok(
      resHtmlBlocked.blocked_dependents.includes('ui_web/bridge_caller.mjs'),
      `Expected ui_web/bridge_caller.mjs in blocked_dependents, got: ${JSON.stringify(resHtmlBlocked.blocked_dependents)}`
    );
    assert.ok(
      !resHtmlBlocked.blocked_dependents.includes('ui_web/bridge.js'),
      'ui_web/bridge.js without method reference must not be flagged'
    );

    // 9. Method signature changed in ui_bridge/js_api.py with NO references in .html/.js/.mjs or Python -> PASSES
    fs.writeFileSync(path.join(tmp.repoDir, 'ui_bridge', 'js_api.py'), jsApiOrphanChange, 'utf8');
    const resUnreferencedPasses = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['ui_bridge/js_api.py'],
      beforeContents: { 'ui_bridge/js_api.py': jsApiBefore },
      afterContents: { 'ui_bridge/js_api.py': jsApiOrphanChange },
      taskScope: ['ui_bridge/js_api.py'],
      repoRoot: tmp.repoDir,
      configDir: tmp.configDir
    });
    assert.strictEqual(
      resUnreferencedPasses.blocked,
      false,
      `Unreferenced method signature change must pass, got: ${JSON.stringify(resUnreferencedPasses)}`
    );

    // 10. Signature changed with ui_web/index.html & ui_web/bridge_caller.mjs INCLUDED in taskScope -> PASSES
    fs.writeFileSync(path.join(tmp.repoDir, 'ui_bridge', 'js_api.py'), jsApiBreak, 'utf8');
    const resUiInScope = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['ui_bridge/js_api.py'],
      beforeContents: { 'ui_bridge/js_api.py': jsApiBefore },
      afterContents: { 'ui_bridge/js_api.py': jsApiBreak },
      taskScope: ['ui_bridge/js_api.py', 'ui_web/index.html', 'ui_web/bridge_caller.mjs'],
      repoRoot: tmp.repoDir,
      configDir: tmp.configDir
    });
    assert.strictEqual(resUiInScope.blocked, false, 'When web callers are inside scope, signature change is allowed');

    // 11. Short symbol names (open, run, start) must NOT false-positive on HTML text, strings, classes, or snake_case names
    const shortBefore = [
      'def open(path):',
      '\treturn path',
      '',
      'def run(cfg):',
      '\treturn cfg',
      '',
      'def start(delay=0):',
      '\treturn delay',
      ''
    ].join('\n');
    const shortChanged = [
      'def open(path, mode="r"):',
      '\treturn path',
      '',
      'def run(cfg, strict=True):',
      '\treturn cfg',
      '',
      'def start(delay=0, force=False):',
      '\treturn delay',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(tmp.repoDir, 'core', 'runner.py'), shortChanged, 'utf8');
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'index.html'),
      [
        '<html><body>',
        '<button class="is-open btn-start" data-run="false">Open and start run</button>',
        '<script>',
        '  const label = "Please open file to start the run";',
        '  function open_file(p){ return p; }',
        '  function reopen(p){ return p; }',
        '  function run_task(){ return true; }',
        '</script></body></html>',
        ''
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge.js'),
      'const state = "start";\nexport const modes = { open: false, run: false };\nexport function start_worker(){ return "open"; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge_caller.mjs'),
      '// Just a comment mentioning open, run, and start without calling them\nexport const ok = true;\n',
      'utf8'
    );

    const resShortNoFalsePositive = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/runner.py'],
      beforeContents: { 'core/runner.py': shortBefore },
      afterContents: { 'core/runner.py': shortChanged },
      taskScope: ['core/runner.py'],
      repoRoot: tmp.repoDir,
      configDir: tmp.configDir
    });
    assert.strictEqual(
      resShortNoFalsePositive.blocked,
      false,
      `Short names open/run/start in HTML prose/strings/snake_case must NOT trigger false positive, got: ${JSON.stringify(resShortNoFalsePositive)}`
    );

    // 12. Real call/member syntax for short names (`open(...)`, `.run`, `.start`) MUST still block when out of scope
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge.js'),
      'export function trigger(api){ return api.run; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp.repoDir, 'ui_web', 'bridge_caller.mjs'),
      'export function boot(cfg){ return open(cfg); }\n',
      'utf8'
    );
    const resShortRealCallers = goalPlanner.evaluatePostPatchSignatureGate({
      modifiedFiles: ['core/runner.py'],
      beforeContents: { 'core/runner.py': shortBefore },
      afterContents: { 'core/runner.py': shortChanged },
      taskScope: ['core/runner.py'],
      repoRoot: tmp.repoDir,
      configDir: tmp.configDir
    });
    assert.strictEqual(resShortRealCallers.blocked, true, 'Real short-name callers (open(...) / .run) must block');
    assert.ok(resShortRealCallers.blocked_dependents.includes('ui_web/bridge.js'));
    assert.ok(resShortRealCallers.blocked_dependents.includes('ui_web/bridge_caller.mjs'));
    assert.ok(!resShortRealCallers.blocked_dependents.includes('ui_web/index.html'));

    console.log('ALL SIGNATURE GATE TESTS PASSED (12/12)');
  } finally {
    fs.rmSync(tmp.repoDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
