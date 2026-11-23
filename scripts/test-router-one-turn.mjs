#!/usr/bin/env node
/**
 * TDD Suite for Batch 167 Item 5:
 *  1) ~10-line embedded code snippets in Turn-1 Router prompt
 *  2) Single-turn Router instruction + 1-turn completion without changing model
 *  3) Post-plan scope validation via reverse dependency dependents
 *  4) 3-goal comparison harness + hard Claude fresh-token budget guard
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGoalPreprocessCandidates, buildRouterContextParts } from './lib/context-builders.mjs';
import { materializeGitCommitSnapshot } from './lib/hermetic-fixture.mjs';
import { checkScopeWithDependents, decomposeGoal } from './goal-planner.mjs';
import { compareRouterOneTurnVsCurrent } from './measure-router-loop.mjs';

const SNAPSHOT_FILES = [
  'ui_web/index.html',
  'core/eraser.py',
  'core/providers/__init__.py',
  'core/providers/service.py',
  'core/providers/store.py',
  'ui_bridge/__init__.py',
  'ui_bridge/js_api.py',
  'tests/test_dom_contract.py',
  'tests/test_eraser.py',
  'tests/test_providers.py',
  'tests/test_ui_bridge.py'
];

function makeSseCompletion(model, content, usage = { prompt_tokens: 1500, completion_tokens: 120, total_tokens: 1620 }) {
  const c1 = {
    id: 'chatcmpl-1turn',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
  };
  const c2 = {
    id: 'chatcmpl-1turn',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage
  };
  return new Response(
    `data: ${JSON.stringify(c1)}\n\n` +
    `data: ${JSON.stringify(c2)}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function testEmbedded10LineSnippets(snapRepo) {
  const goal =
    'Sửa #eraser-presets cùng applyEraserMode trong ui_web/index.html và cập nhật tests/test_dom_contract.py.';
  const ctxParts = buildRouterContextParts(['ui_web', 'tests', 'core'], snapRepo, 200, goal, [], {
    includeConventions: false,
    staticRepoMap: true,
    snippetContextLines: 10
  });

  assert.ok(ctxParts.dynamicText.includes('EMBEDDED CODE SNIPPETS'), 'oneTurn snippets must label EMBEDDED CODE SNIPPETS');
  assert.ok(
    /---\s+ui_web\/index\.html:\d+-\d+/.test(ctxParts.dynamicText),
    'Embedded snippet block must include file:start-end header'
  );
  // Expect multi-line code snippet window (~10 lines around match) with numbered lines
  const snippetBlocks = ctxParts.dynamicText.split(/\n---\s+/).slice(1);
  assert.ok(snippetBlocks.length >= 1, 'Expected at least 1 embedded code snippet block');
  const firstSnippetLines = snippetBlocks[0].trim().split('\n').slice(1);
  assert.ok(
    firstSnippetLines.length >= 5 && firstSnippetLines.length <= 22,
    `Expected ~10-line context window (merged <= 22), got ${firstSnippetLines.length} lines`
  );
  assert.ok(ctxParts.dynamicText.length <= 13000, `Embedded snippets exceeded safe byte cap: ${ctxParts.dynamicText.length}`);

  const direct = buildGoalPreprocessCandidates(
    'probe_roi_banner_box detect_banner_box core/eraser.py',
    ['core/eraser.py', 'tests/test_eraser.py'],
    snapRepo,
    { snippetContextLines: 10, maxChars: 8000 }
  );
  assert.ok(direct.includes('probe_roi_banner_box'), 'Embedded snippet must include target symbol body');
  console.log('[OK] ~10-line embedded code snippet extraction passed');
}

function testCheckScopeWithDependents(snapRepo, cfgDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-deps-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'ui_bridge'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });

    fs.writeFileSync(path.join(tmpRoot, 'core', 'alpha.py'), 'def fn_alpha():\n\treturn 1\n\ndef fn_beta():\n\treturn 2\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'ui_bridge', 'api.py'), 'from core.alpha import fn_alpha\n\ndef call_site():\n\treturn fn_alpha()\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'ui_bridge', 'beta_only.py'), 'from core.alpha import fn_beta\n\ndef other_call():\n\treturn fn_beta()\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'tests', 'test_alpha.py'), 'from core.alpha import fn_alpha\n', 'utf8');

    const candidateFiles = ['core/alpha.py', 'ui_bridge/api.py', 'ui_bridge/beta_only.py', 'tests/test_alpha.py'];

    const partial = checkScopeWithDependents(['core/alpha.py'], tmpRoot, {
      candidateFiles,
      goal: 'Modify fn_alpha behavior in core/alpha.py'
    });
    assert.ok(partial.all_dependents.includes('ui_bridge/api.py'));
    assert.ok(partial.all_dependents.includes('tests/test_alpha.py'));
    assert.deepEqual(partial.missing_code_dependents, ['ui_bridge/api.py'], 'Only caller referencing changed fn_alpha should warn');
    assert.ok(!partial.missing_code_dependents.includes('ui_bridge/beta_only.py'), 'Caller referencing only untouched fn_beta must not warn');
    assert.ok(Array.isArray(partial.verification_commands) && partial.verification_commands.some(c => c.includes('tests.test_alpha')), 'Test dependent must map to verification_commands, not scope');
    assert.ok(partial.warnings.some(w => w.includes('ui_bridge/api.py')), 'Missing code dependent referencing changed symbol must warn');

    const complete = checkScopeWithDependents(
      ['core/alpha.py', 'ui_bridge/api.py'],
      tmpRoot,
      { candidateFiles, goal: 'Modify fn_alpha behavior in core/alpha.py' }
    );
    assert.deepEqual(complete.missing_code_dependents, []);
    assert.equal(complete.warnings.length, 0);
    assert.ok(complete.verification_commands.some(c => c.includes('tests.test_alpha')));

    // Snapshot repo check: Goal 2 must NOT warn on ui_bridge/__init__.py; Goal 3 must emit tests.test_ui_bridge verification command
    const realGoal2Deps = checkScopeWithDependents(
      ['core/eraser.py', 'ui_bridge/js_api.py', 'tests/test_eraser.py'],
      snapRepo,
      {
        configDir: cfgDir,
        goal: 'Sửa hàm probe_roi_banner_box và detect_banner_box trong core/eraser.py để xử lý vùng ROI rỗng an toàn, kiểm tra kết nối qua eraser_probe trong ui_bridge/js_api.py và bổ sung unit test trong tests/test_eraser.py.'
      }
    );
    assert.ok(
      !realGoal2Deps.missing_code_dependents.includes('ui_bridge/__init__.py'),
      `Goal 2 must NOT warn ui_bridge/__init__.py via Tree-sitter symbol check, got: ${JSON.stringify(realGoal2Deps.missing_code_dependents)}`
    );
    assert.deepEqual(realGoal2Deps.warnings, []);

    const realGoal3Deps = checkScopeWithDependents(
      ['core/providers/service.py', 'ui_bridge/js_api.py', 'tests/test_providers.py'],
      snapRepo,
      {
        configDir: cfgDir,
        goal: 'Kiểm tra và sửa lỗi xử lý danh sách model mặc định trong ProviderService (core/providers/service.py) và hàm provider_list_presets trong ui_bridge/js_api.py kèm test trong tests/test_providers.py.'
      }
    );
    assert.ok(
      realGoal3Deps.test_dependents.includes('tests/test_ui_bridge.py'),
      'Goal 3 must still detect tests/test_ui_bridge.py as test dependent'
    );
    assert.ok(
      Array.isArray(realGoal3Deps.verification_commands) &&
      realGoal3Deps.verification_commands.some(cmd => cmd.includes('tests.test_ui_bridge')),
      `Goal 3 must include tests.test_ui_bridge in verification_commands, got: ${JSON.stringify(realGoal3Deps.verification_commands)}`
    );
    console.log('[OK] scope dependents check passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testOneTurnDecomposeAndComparisonHarness(snapRepo, cfgDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-1turn-'));
  try {
    const capturedPrompts = [];
    const fakeFetch = async (_url, init = {}) => {
      const payload = JSON.parse(String(init.body || '{}'));
      capturedPrompts.push(payload);
      assert.equal(payload.model, 'ag/gemini-3.8-flash-medium', 'Default Router model must be ag/gemini-3.8-flash-medium');
      const planJson = JSON.stringify({
        tasks: [{
          title: 'Clean up #eraser-presets and fix #eraser-mode-pills',
          goal: 'Remove #eraser-presets and update applyEraserMode in ui_web/index.html + tests/test_dom_contract.py',
          mode: 'standard',
          risk_level: 'low',
          scope: ['ui_web/index.html', 'tests/test_dom_contract.py'],
          acceptance_criteria: ['Remove presets', 'Verify DOM contract']
        }]
      });
      return makeSseCompletion(payload.model, planJson, {
        prompt_tokens: 9000,
        completion_tokens: 180,
        total_tokens: 9180,
        cache_read_input_tokens: 3000
      });
    };

    // Calling decomposeGoal WITHOUT explicit oneTurnMode must now default to 1-turn when snippets suffice & no code dependents missing
    const res = await decomposeGoal(
      'Dọn dẹp #eraser-presets và sửa applyEraserMode trong ui_web/index.html, cập nhật tests/test_dom_contract.py.',
      {
        dryRun: true,
        repoRoot: snapRepo,
        configDir: cfgDir,
        sessionsDir: path.join(tmpRoot, 's1-default'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: fakeFetch
      }
    );

    assert.equal(res.ok, true, res.error);
    assert.equal(res.turns_executed, 1, 'Default router mode must complete in 1 turn when context & dependents check pass');
    assert.equal(res.fallback_to_tools, false);
    assert.equal(capturedPrompts.length, 1);
    assert.equal(capturedPrompts[0].tools, undefined, 'Pure 1-turn Router MUST NOT send tools at Turn 1');
    assert.equal(capturedPrompts[0].tool_choice, undefined, 'Pure 1-turn Router MUST NOT set tool_choice when tools are omitted');
    const userText = typeof capturedPrompts[0].messages[1].content === 'string'
      ? capturedPrompts[0].messages[1].content
      : JSON.stringify(capturedPrompts[0].messages[1].content);
    assert.ok(userText.includes('EMBEDDED CODE SNIPPETS'), 'Turn-1 prompt must embed ~10-line code snippets by default');
    assert.ok(/not\s+call\s+any\s+tools|khong\s+can\s+goi\s+tool|do\s+not\s+call\s+tools/i.test(userText));
    assert.ok(res.tasks[0]?.scope_dependents, 'Created/dry-run task must include scope_dependents report');
    assert.ok(
      res.tasks[0].scope_dependents.all_dependents.includes('tests/test_dom_contract.py'),
      'scope_dependents must list reverse dependents for planned scope'
    );

    // 3-goal comparison + budget guard stop check
    const cmpRes = await compareRouterOneTurnVsCurrent({
      repoRoot: snapRepo,
      sessionsDir: path.join(tmpRoot, 'cmp'),
      startingFreshTokens: 10060,
      maxFreshClaudeTokens: 200000,
      nineRouterVersion: '0.5.119',
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: fakeFetch
    });
    assert.equal(cmpRes.goals.length, 3);
    assert.equal(cmpRes.budget.stopped_early, false);
    assert.ok(cmpRes.goals.every(g => g.one_turn?.ok && g.five_turn?.ok && g.diff));

    const budgetStopRes = await compareRouterOneTurnVsCurrent({
      repoRoot: snapRepo,
      sessionsDir: path.join(tmpRoot, 'cmp-budget'),
      modelOverride: 'ag/claude-sonnet-5-5',
      startingFreshTokens: 199500,
      maxFreshClaudeTokens: 200000,
      nineRouterVersion: '0.5.119',
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: async (url, init = {}) => {
        const p = JSON.parse(String(init.body || '{}'));
        assert.equal(p.model, 'ag/claude-sonnet-5-5');
        return makeSseCompletion(p.model, JSON.stringify({
          tasks: [{
            title: 'Budget stop check',
            goal: 'Verify Claude budget stop guard',
            mode: 'quick',
            risk_level: 'low',
            scope: ['ui_web/index.html']
          }]
        }), { prompt_tokens: 9000, completion_tokens: 180, total_tokens: 9180, cache_read_input_tokens: 3000 });
      }
    });
    assert.equal(budgetStopRes.budget.stopped_early, true, 'Must stop before exceeding 200k Claude fresh-token ceiling');
    console.log('[OK] default 1-turn decomposeGoal & 3-goal comparison + budget guard passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testDefaultOneTurnFallbackBranches(snapRepo, cfgDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-fallback-'));
  try {
    // Branch 1: No keyword hits in pre-lookup -> immediately fall back to multi-turn tool loop (5 turns)
    const noHitCalls = [];
    const noHitFetch = async (_url, init = {}) => {
      const payload = JSON.parse(String(init.body || '{}'));
      noHitCalls.push(payload);
      if (noHitCalls.length === 1) {
        const c1 = {
          id: 'c-nh-1',
          model: payload.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'tc_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"core"}' } }]
            },
            finish_reason: null
          }]
        };
        const c2 = { id: 'c-nh-1', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2500, completion_tokens: 40, total_tokens: 2540 } };
        return new Response(`data: ${JSON.stringify(c1)}\n\ndata: ${JSON.stringify(c2)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return makeSseCompletion(payload.model, JSON.stringify({
        tasks: [{
          title: 'Fallback tool-loop plan (no keyword hits)',
          goal: 'Inspect unknown area via tools',
          mode: 'quick',
          risk_level: 'low',
          scope: ['ui_web/index.html', 'tests/test_dom_contract.py'],
          acceptance_criteria: ['AC1', 'AC2']
        }]
      }));
    };

    const resNoHit = await decomposeGoal('zzqxzyunknownsymbol998811 behavior check', {
      dryRun: true,
      repoRoot: snapRepo,
      sessionsDir: path.join(tmpRoot, 'no-hit'),
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: noHitFetch
    });
    assert.equal(resNoHit.ok, true, resNoHit.error);
    assert.equal(resNoHit.fallback_to_tools, true, 'Missing pre-lookup hits must fall back to tool loop');
    assert.equal(resNoHit.fallback_reason, 'no_keyword_hits');
    assert.equal(resNoHit.turns_executed, 2, 'Must run multi-turn tool loop (>1 turn) on no-keyword-hit fallback');
    assert.equal(noHitCalls.length, 2);
    assert.ok(Array.isArray(noHitCalls[0].tools) && noHitCalls[0].tools.length > 0, 'no_keyword_hits fallback Turn 1 must send tools');
    assert.equal(noHitCalls[0].messages.length, 2, 'no_keyword_hits fallback must start fresh with [system, user]');

    // Branch 2 (Batch 170 Item 2): Turn-1 plan omits source-code dependents -> DO NOT fall back to 5-turn;
    // record code dependents in plan.warnings + post_patch_checks ("kiểm tra sau patch") while staying 1-turn
    const depCalls = [];
    const depNoFallbackFetch = async (_url, init = {}) => {
      const payload = JSON.parse(String(init.body || '{}'));
      depCalls.push(payload);
      return makeSseCompletion(payload.model, JSON.stringify({
        tasks: [{
          title: 'Turn-1 under-scoped eraser fix',
          goal: 'Modify core/eraser.py probe_roi_banner_box',
          mode: 'quick',
          risk_level: 'low',
          scope: ['core/eraser.py'],
          acceptance_criteria: ['AC1', 'AC2']
        }]
      }));
    };

    const resDepNoFallback = await decomposeGoal(
      'Sửa hàm probe_roi_banner_box và detect_banner_box trong core/eraser.py.',
      {
        dryRun: true,
        repoRoot: snapRepo,
        configDir: cfgDir,
        sessionsDir: path.join(tmpRoot, 'dep-no-fallback'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: depNoFallbackFetch
      }
    );
    assert.equal(resDepNoFallback.ok, true, resDepNoFallback.error);
    assert.equal(resDepNoFallback.fallback_to_tools, false, 'Out-of-scope code dependents must NOT trigger 5-turn fallback anymore');
    assert.equal(resDepNoFallback.turns_executed, 1, 'Must complete in 1 turn without 5-turn dependent fallback');
    assert.equal(depCalls.length, 1, 'Only 1 HTTP call expected when code_dependents_out_of_scope only warns & defers to post-patch check');
    assert.ok(
      Array.isArray(resDepNoFallback.warnings) && resDepNoFallback.warnings.some(w => w.includes('ui_bridge/js_api.py')),
      `plan.warnings must list out-of-scope code dependent ui_bridge/js_api.py, got: ${JSON.stringify(resDepNoFallback.warnings)}`
    );
    assert.ok(
      Array.isArray(resDepNoFallback.post_patch_checks?.signature_check_dependents) &&
      resDepNoFallback.post_patch_checks.signature_check_dependents.includes('ui_bridge/js_api.py'),
      `plan.post_patch_checks must record signature_check_dependents, got: ${JSON.stringify(resDepNoFallback.post_patch_checks)}`
    );
    assert.ok(
      Array.isArray(resDepNoFallback.tasks[0]?.post_patch_checks?.signature_check_dependents) &&
      resDepNoFallback.tasks[0].post_patch_checks.signature_check_dependents.includes('ui_bridge/js_api.py'),
      'Task post_patch_checks ("kiểm tra sau patch") must include out-of-scope source dependents'
    );
    assert.ok(!resDepNoFallback.tasks[0].scope.includes('ui_bridge/js_api.py'), 'Plan scope stays clean without auto-expanding');

    // Goal 3 via decomposeGoal: keeps scope clean (Writer doesn't edit tests/test_ui_bridge.py) while attaching verification_commands
    const goal3Calls = [];
    const goal3Res = await decomposeGoal(
      'Kiểm tra và sửa lỗi xử lý danh sách model mặc định trong ProviderService (core/providers/service.py) và hàm provider_list_presets trong ui_bridge/js_api.py kèm test trong tests/test_providers.py.',
      {
        dryRun: true,
        repoRoot: snapRepo,
        sessionsDir: path.join(tmpRoot, 'goal3-verif'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_url, init = {}) => {
          const p = JSON.parse(String(init.body || '{}'));
          goal3Calls.push(p);
          return makeSseCompletion(p.model, JSON.stringify({
            tasks: [{
              title: 'ProviderService default model list & provider_list_presets fix',
              goal: 'Update ProviderService and JsApi.provider_list_presets',
              mode: 'quick',
              risk_level: 'medium',
              scope: ['core/providers/service.py', 'ui_bridge/js_api.py', 'tests/test_providers.py'],
              acceptance_criteria: ['AC1', 'AC2']
            }]
          }));
        }
      }
    );
    assert.equal(goal3Res.ok, true, goal3Res.error);
    assert.equal(goal3Res.fallback_to_tools, false, 'Goal 3 barrel core/providers/__init__.py must NOT falsely trigger fallback');
    assert.equal(goal3Res.turns_executed, 1);
    assert.ok(!goal3Res.tasks[0].scope.includes('tests/test_ui_bridge.py'), 'Test dependent must NOT be pushed into task.scope');
    assert.ok(
      Array.isArray(goal3Res.tasks[0].verification_commands) &&
      goal3Res.tasks[0].verification_commands.some(c => c.includes('tests.test_ui_bridge')),
      'Task verification_commands must include tests/test_ui_bridge.py command'
    );
    console.log('[OK] default 1-turn fallback branches & Item 3 dependent classification passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testNoKeywordHitsMax3ToolTurnsWithWarning(snapRepo, cfgDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cap3-'));
  try {
    let callCount = 0;
    const turnPromptsSeen = [];
    const cap3Fetch = async (_url, init = {}) => {
      const payload = JSON.parse(String(init.body || '{}'));
      callCount++;
      turnPromptsSeen.push(payload);
      const lastMsg = payload.messages?.[payload.messages.length - 1];
      const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '');
      // Synthesis user prompt disables tool calls and forces JSON plan output from partial findings
      if (lastMsg?.role === 'user' && /All tool investigations are complete/i.test(lastText)) {
        return makeSseCompletion(payload.model, JSON.stringify({
          tasks: [{
            title: 'Synthesized plan after 3 tool turns',
            goal: 'Update ui_web/index.html from collected context',
            mode: 'quick',
            risk_level: 'low',
            scope: ['ui_web/index.html'],
            acceptance_criteria: ['AC1']
          }]
        }));
      }
      // Keep requesting tools on every tool-loop turn to prove cap stops at Turn 3
      const c1 = {
        id: `c-cap3-${callCount}`,
        model: payload.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `tc_cap_${callCount}`, type: 'function', function: { name: 'list_files', arguments: '{"dir":"core"}' } }]
          },
          finish_reason: null
        }]
      };
      const c2 = {
        id: `c-cap3-${callCount}`,
        model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 2500, completion_tokens: 40, total_tokens: 2540 }
      };
      return new Response(`data: ${JSON.stringify(c1)}\n\ndata: ${JSON.stringify(c2)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    const res = await decomposeGoal('zzqxzyunknownsymbol_cap3_test', {
      dryRun: true,
      repoRoot: snapRepo,
      sessionsDir: path.join(tmpRoot, 'cap3'),
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: cap3Fetch
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.fallback_to_tools, true);
    assert.equal(res.fallback_reason, 'no_keyword_hits');
    const toolTurns = (res.turn_usages || []).filter(t => t.stage === 'tool_loop');
    const synthTurns = (res.turn_usages || []).filter(t => t.stage === 'synthesis');
    assert.equal(toolTurns.length, 3, `no_keyword_hits fallback MUST cap at 3 tool turns, got ${toolTurns.length}`);
    assert.equal(synthTurns.length, 1, 'Must enter synthesis once after reaching 3-turn tool cap');
    assert.equal(callCount, 4, `Total calls must be 3 tool turns + 1 synthesis = 4, got ${callCount}`);
    assert.ok(
      Array.isArray(res.warnings) && res.warnings.some(w => /no_keyword_hits/i.test(w) && /3/.test(w)),
      `Plan warnings must include 3-turn cap notice, got: ${JSON.stringify(res.warnings)}`
    );
    console.log('[OK] no_keyword_hits max 3 tool turns + synthesis warning passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function buildSyntheticSnapshotRepo() {
  const snapRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-1turn-snap-'));
  const files = {
    'ui_web/index.html': [
      '<!DOCTYPE html>',
      '<html><body>',
      '<div id="eraser-presets"><button data-preset="bottom-default">Bottom</button></div>',
      '<div id="eraser-mode-pills" class="grid gap-2">',
      '  <button data-mode="smart_fill">Smart Fill</button>',
      '</div>',
      '<script>',
      'function applyEraserMode(mode) {',
      '  const box = document.getElementById("eraser-mode-pills");',
      '  return box ? mode : "";',
      '}',
      'function renderPresets() {',
      '  return document.getElementById("eraser-presets");',
      '}',
      '</script>',
      '</body></html>'
    ].join('\n'),
    'core/eraser.py': [
      'def probe_roi_banner_box(video_path: str):',
      '\tif not video_path:',
      '\t\treturn None',
      '\treturn detect_banner_box(video_path)',
      '',
      'def detect_banner_box(video_path: str):',
      '\treturn (0, 0, 100, 50)',
      ''
    ].join('\n'),
    'core/providers/__init__.py': 'from core.providers.service import ProviderService\n',
    'core/providers/service.py': [
      'from core.providers.store import ProviderStore',
      '',
      'class ProviderService:',
      '\tdef __init__(self, store=None):',
      '\t\tself.store = store or ProviderStore()',
      '\tdef list_presets(self):',
      '\t\treturn self.store.load()',
      ''
    ].join('\n'),
    'core/providers/store.py': 'class ProviderStore:\n\tdef load(self):\n\t\treturn []\n',
    'ui_bridge/__init__.py': '"""Bridge package."""\n',
    'ui_bridge/js_api.py': [
      'from core.eraser import probe_roi_banner_box',
      'from core.providers.service import ProviderService',
      '',
      'class JsApi:',
      '\tdef eraser_probe(self, path: str):',
      '\t\treturn probe_roi_banner_box(path)',
      '\tdef provider_list_presets(self):',
      '\t\treturn ProviderService().list_presets()',
      ''
    ].join('\n'),
    'tests/test_dom_contract.py': [
      'import unittest',
      'class DomTests(unittest.TestCase):',
      '\tdef test_eraser_presets(self):',
      '\t\tassert "ui_web/index.html" and "eraser-presets" and "applyEraserMode"',
      ''
    ].join('\n'),
    'tests/test_eraser.py': 'from core.eraser import probe_roi_banner_box, detect_banner_box\n',
    'tests/test_providers.py': 'from core.providers.service import ProviderService\n',
    'tests/test_ui_bridge.py': 'from ui_bridge.js_api import JsApi\n'
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(snapRepo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const cfgDir = path.join(snapRepo, '.snap-config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const realCfgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
  fs.copyFileSync(path.join(realCfgDir, 'team.yaml'), path.join(cfgDir, 'team.yaml'));
  const rawPol = fs.readFileSync(path.join(realCfgDir, 'policy.yaml'), 'utf8');
  const snapPol = rawPol.replace(
    /allowed_dirs:\s*\n(?:\s*-\s*[^\n]+\n)+/,
    'allowed_dirs:\n      - "core/"\n      - "ui_bridge/"\n      - "ui_web/"\n      - "tests/"\n'
  );
  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), snapPol, 'utf8');
  return { snapRepo, cfgDir };
}

async function main() {
  const { snapRepo, cfgDir } = buildSyntheticSnapshotRepo();
  try {
    testEmbedded10LineSnippets(snapRepo);
    testCheckScopeWithDependents(snapRepo, cfgDir);
    await testOneTurnDecomposeAndComparisonHarness(snapRepo, cfgDir);
    await testDefaultOneTurnFallbackBranches(snapRepo, cfgDir);
    await testNoKeywordHitsMax3ToolTurnsWithWarning(snapRepo, cfgDir);
    console.log('[PASS] test-router-one-turn');
  } finally {
    fs.rmSync(snapRepo, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('[FAIL] test-router-one-turn:', err);
  process.exit(1);
});
