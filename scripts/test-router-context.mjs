#!/usr/bin/env node
/**
 * TDD Reproduction & Regression Suite for Commit (b):
 *  1. Router context file filtering: extension allowlist + .gitignore + size cap + context_exclude
 *  2. toolReadFile truncated flag matches requestedEnd / effectiveEnd (not lines.length when bounded)
 *  3. Deterministic keyword -> file:line pre-lookup injected cleanly for Router
 *  4. Per-turn Router usage schema + model/maxTurns unchanged prior to measurement
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRouterContext, extractTaskKeywords } from './lib/context-builders.mjs';
import { loadMergedPolicy, loadMergedTeamConfig } from './lib/policy-loader.mjs';
import { normalizeUsage } from '../runtime/provider-gateway.mjs';
import { MAX_READ_LINES, toolReadFile } from '../runtime/tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

console.log('Testing Router Context Filtering, toolReadFile truncated & Pre-Lookup (Commit b)...');

// ---------------------------------------------------------------------------
// 1. Repro: buildRouterContext allowlist + .gitignore + size cap + context_exclude
// ---------------------------------------------------------------------------
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ctx-filter-'));
  try {
    fs.writeFileSync(
      path.join(tmpRepo, '.gitignore'),
      [
        '# Temp & ignored dirs',
        'core/ignored_vendor/',
        '*.log',
        'downloads/'
      ].join('\n'),
      'utf8'
    );
    fs.mkdirSync(path.join(tmpRepo, 'core', 'ignored_vendor'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'core', 'propainter_repo', 'frames'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'downloads'), { recursive: true });

    fs.writeFileSync(path.join(tmpRepo, 'core', 'eraser.py'), 'def erase_sub():\n\treturn True\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'core', 'debug.log'), 'noisy log line\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'core', 'frame.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    fs.writeFileSync(path.join(tmpRepo, 'core', 'weights.onnx'), 'binary-weights', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'core', 'ignored_vendor', 'vendor.py'), 'def hidden():\n\tpass\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'core', 'propainter_repo', 'raft.py'), 'def raft_flow():\n\tpass\n', 'utf8');
    for (let i = 0; i < 220; i++) {
      fs.writeFileSync(path.join(tmpRepo, 'core', 'propainter_repo', 'frames', `${String(i).padStart(4, '0')}.jpg`), 'img', 'utf8');
    }
    fs.writeFileSync(path.join(tmpRepo, 'core', 'huge_bundle.json'), 'x'.repeat(20 * 1024), 'utf8');
    fs.writeFileSync(
      path.join(tmpRepo, 'ui_web', 'index.html'),
      '<div id="eraser-presets"></div>\n<div id="eraser-mode-pills"></div>\n<script>function applyEraserMode() {}</script>\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'tests', 'test_dom_contract.py'),
      'def test_contract():\n\tassert "#eraser-presets"\n',
      'utf8'
    );

    const ctx = buildRouterContext(['core/', 'ui_web/', 'tests/'], tmpRepo, 50, '#eraser-presets applyEraserMode', [], {
      includeConventions: false,
      contextExclude: ['core/propainter_repo/'],
      maxFileSizeBytes: 8 * 1024
    });

    assert.ok(ctx.includes('- ui_web/index.html'), 'Allowed ui_web/index.html must not be crowded out');
    assert.ok(ctx.includes('- tests/test_dom_contract.py'), 'Allowed tests/test_dom_contract.py must appear');
    assert.ok(ctx.includes('- core/eraser.py'), 'Allowed core/eraser.py must appear');
    assert.ok(!ctx.includes('.jpg'), 'Binary .jpg files must be filtered by allowlist');
    assert.ok(!ctx.includes('.onnx'), 'Binary .onnx files must be filtered by allowlist');
    assert.ok(!ctx.includes('core/debug.log'), '.gitignore *.log files must be filtered');
    assert.ok(!ctx.includes('core/ignored_vendor/vendor.py'), '.gitignore directory must be filtered');
    assert.ok(!ctx.includes('core/propainter_repo/'), 'context_exclude directory must be excluded from workspace files & skeleton');
    assert.ok(!ctx.includes('core/huge_bundle.json'), 'Files exceeding maxFileSizeBytes must be filtered');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Hermetic fixture filter check + policy.yaml context_exclude check
// ---------------------------------------------------------------------------
{
  const mergedPolicy = loadMergedPolicy();
  const allowedDirs = mergedPolicy.policy.scope_control.allowed_dirs;
  const contextExclude = mergedPolicy.policy.scope_control.context_exclude;
  assert.ok(
    Array.isArray(contextExclude) && contextExclude.some(p => p.includes('core/propainter_repo')),
    'policy.yaml scope_control.context_exclude must exclude core/propainter_repo'
  );

  const tmpSnapRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ctx-snap-'));
  try {
    fs.mkdirSync(path.join(tmpSnapRepo, 'ui_web'), { recursive: true });
    fs.mkdirSync(path.join(tmpSnapRepo, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpSnapRepo, 'core', 'propainter_repo'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSnapRepo, 'ui_web', 'index.html'),
      Array.from({ length: 500 }, (_, i) => `<div>line_${i + 1}</div>`).join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpSnapRepo, 'tests', 'test_dom_contract.py'), 'def test_ok():\n\tassert True\n', 'utf8');
    fs.writeFileSync(path.join(tmpSnapRepo, 'core', 'propainter_repo', 'model.py'), 'x = 1\n', 'utf8');
    fs.writeFileSync(path.join(tmpSnapRepo, 'ui_web', 'thumb.jpg'), 'fakeimg', 'utf8');

    const realCtx = buildRouterContext(allowedDirs, tmpSnapRepo, 200, '', [], {
      includeConventions: false,
      contextExclude
    });
    assert.ok(realCtx.includes('- ui_web/index.html'), 'Workspace list must include ui_web/index.html');
    assert.ok(realCtx.includes('- tests/test_dom_contract.py'), 'Workspace list must include tests/test_dom_contract.py');
    assert.ok(!realCtx.includes('propainter_repo/'), 'Context must exclude propainter_repo');
    assert.ok(!realCtx.includes('.jpg'), 'Context must not include .jpg binary assets');

    // Bounded range well within MAX_READ_LINES and bytes -> truncated MUST be false & NO "To continue reading"
    const boundedRead = toolReadFile(tmpSnapRepo, {
      path: 'ui_web/index.html',
      start_line: 310,
      end_line: 390
    });
    assert.strictEqual(boundedRead.ok, true);
    assert.strictEqual(boundedRead.start_line, 310);
    assert.strictEqual(boundedRead.end_line, 390);
    assert.strictEqual(
      boundedRead.truncated,
      false,
      'Bounded explicit end_line read (310..390) completed in full; truncated MUST be false'
    );
    assert.ok(
      !String(boundedRead.navigation_hint || '').includes('To continue reading'),
      'Completed bounded read must NOT emit continuation hint telling LLM to read_file again'
    );
  } finally {
    fs.rmSync(tmpSnapRepo, { recursive: true, force: true });
  }

  // Oversized end_line > MAX_READ_LINES -> truncated MUST be true + continuation hint
  const clampedRead = toolReadFile(REPO_ROOT, {
    path: 'agent-team/scripts/orchestrator.mjs',
    start_line: 1,
    end_line: 1000
  });
  assert.strictEqual(clampedRead.ok, true);
  assert.strictEqual(clampedRead.end_line, MAX_READ_LINES);
  assert.strictEqual(clampedRead.truncated, true, 'Clamped read at MAX_READ_LINES must keep truncated: true');
  assert.ok(
    clampedRead.navigation_hint.includes(`start_line=${MAX_READ_LINES + 1}`),
    'Clamped read must preserve continuation hint'
  );

  // Omitted end_line on large file -> truncated MUST be true
  const openRead = toolReadFile(REPO_ROOT, {
    path: 'agent-team/scripts/orchestrator.mjs',
    start_line: 1
  });
  assert.strictEqual(openRead.ok, true);
  assert.strictEqual(openRead.end_line, MAX_READ_LINES);
  assert.strictEqual(openRead.truncated, true, 'Open-ended read stopped by MAX_READ_LINES must report truncated: true');
}

// ---------------------------------------------------------------------------
// 4. Repro: Deterministic keyword -> file:line pre-lookup for Router
// ---------------------------------------------------------------------------
{
  // 4a. Hermetic fixture pre-lookup for #panel-presets, applyPanelMode & test_dom_contract.py
  const preTmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-prelookup-'));
  try {
    fs.mkdirSync(path.join(preTmpRepo, 'ui_web'), { recursive: true });
    fs.mkdirSync(path.join(preTmpRepo, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(preTmpRepo, 'ui_web', 'index.html'),
      [
        '<div id="panel-presets"></div>',
        '<div id="panel-mode-pills"></div>',
        '<script>',
        'function applyPanelMode(mode) { return mode; }',
        '</script>'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(preTmpRepo, 'tests', 'test_dom_contract.py'),
      'def test_panel_presets():\n\tassert "panel-presets"\n',
      'utf8'
    );
    const fixtureCtx = buildRouterContext(
      ['ui_web/', 'tests/'],
      preTmpRepo,
      50,
      'Xóa #panel-presets, sửa #panel-mode-pills cùng applyPanelMode trong ui_web/index.html và test_dom_contract.py.',
      [],
      { includeConventions: false }
    );
    assert.ok(
      /ui_web\/index\.html:\d+\s*\|.*panel-presets/i.test(fixtureCtx),
      'Hermetic pre-lookup must pinpoint exact ui_web/index.html:<line> for #panel-presets'
    );
    assert.ok(
      /ui_web\/index\.html:\d+\s*\|.*applyPanelMode/i.test(fixtureCtx),
      'Hermetic pre-lookup must pinpoint exact ui_web/index.html:<line> for applyPanelMode'
    );
  } finally {
    fs.rmSync(preTmpRepo, { recursive: true, force: true });
  }

  // 4b. Real repo pre-lookup using active post-merge UI/test symbols (#eraser-mode-pills & applyEraserMode)
  const presetGoal =
    'Sửa giao diện Hard-sub Eraser trong ui_web/index.html: ' +
    'cập nhật layout grid #eraser-mode-pills, kiểm tra applyEraserMode() ' +
    'và đối chiếu tests/test_dom_contract.py.';

  const mergedPolicy = loadMergedPolicy();
  const routerCtx = buildRouterContext(
    mergedPolicy.policy.scope_control.allowed_dirs,
    REPO_ROOT,
    200,
    presetGoal,
    [],
    {
      includeConventions: false,
      contextExclude: mergedPolicy.policy.scope_control.context_exclude
    }
  );

  assert.ok(
    routerCtx.includes('DETERMINISTIC PRE-LOOKUP CANDIDATES'),
    'buildRouterContext must include DETERMINISTIC PRE-LOOKUP CANDIDATES section when goal keywords match'
  );
  assert.ok(
    /ui_web\/index\.html:\d+\s*\|.*eraser-mode-pills/i.test(routerCtx),
    'Pre-lookup must pinpoint exact ui_web/index.html:<line> for #eraser-mode-pills'
  );
  assert.ok(
    /ui_web\/index\.html:\d+\s*\|.*applyEraserMode/i.test(routerCtx),
    'Pre-lookup must pinpoint exact ui_web/index.html:<line> for applyEraserMode'
  );
  assert.ok(
    /tests\/test_dom_contract\.py:\d+/i.test(routerCtx),
    'Pre-lookup must pinpoint exact tests/test_dom_contract.py:<line> contract matches'
  );
}

// ---------------------------------------------------------------------------
// 5. Telemetry & Constraints: cache_creation_input_tokens + Router model/maxTurns preserved
// ---------------------------------------------------------------------------
{
  const norm = normalizeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 1200,
    output_tokens: 50
  });
  assert.strictEqual(norm.cached_tokens, 800);
  assert.strictEqual(norm.cache_creation_input_tokens, 1200, 'normalizeUsage must expose cache_creation_input_tokens');

  const teamCfg = loadMergedTeamConfig();
  assert.ok(
    typeof teamCfg.roles?.router?.model === 'string' && teamCfg.roles.router.model.length > 0,
    'Router model must remain configured without silent switching before measurements'
  );
  const gpSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'goal-planner.mjs'), 'utf8');
  assert.ok(
    /maxTurns:\s*(?:fallbackReason === 'no_keyword_hits'\s*\?\s*3\s*:\s*5|5)\b/.test(gpSrc),
    'Router fallback maxTurns budget must stay capped at 3 (no_keyword_hits) / 5 (general)'
  );
  const rtSrc = fs.readFileSync(path.join(TEAM_DIR, 'runtime', 'index.mjs'), 'utf8');
  assert.ok(rtSrc.includes('turn_usages: turnUsages'), 'runtime/index must record per-turn turn_usages');
}

// ---------------------------------------------------------------------------
// 6. Unicode Vietnamese Keyword Extraction & Pre-Lookup on General HTML Fixture
// ---------------------------------------------------------------------------
{
  // Test both NFC and NFD Vietnamese diacritics, capitalized 2-4 word phrases, and lowercase phrases
  const vnGoalNfd = 'Ở màn hình Cài Đặt Xuất Video, bấm nút xóa bộ nhớ đệm bị đơ không phản hồi.'.normalize('NFD');
  const kws = extractTaskKeywords({ goal: vnGoalNfd });
  const kwsLower = kws.map(k => k.normalize('NFC').toLowerCase());

  assert.ok(
    kwsLower.some(k => k === 'cài đặt xuất video' || k.includes('cài đặt xuất')),
    `extractTaskKeywords must preserve capitalized Vietnamese 2-4 word phrase (NFC), got: ${JSON.stringify(kws)}`
  );
  assert.ok(
    kwsLower.some(k => k.includes('bộ nhớ đệm') || k.includes('xóa bộ nhớ')),
    `extractTaskKeywords must extract multi-word Vietnamese phrase without ASCII shredding, got: ${JSON.stringify(kws)}`
  );
  // Ensure no shredded ASCII fragments like "nh" or "ch" leak into keywords
  assert.ok(
    !kws.some(k => k.length < 3),
    `extractTaskKeywords must not emit short shredded fragments: ${JSON.stringify(kws)}`
  );

  // Hermetic HTML fixture with Vietnamese UI text (general fixture, not tied to any single app feature)
  const vnTmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'router-vn-prelookup-'));
  try {
    fs.mkdirSync(path.join(vnTmpRepo, 'ui_web'), { recursive: true });
    fs.writeFileSync(
      path.join(vnTmpRepo, 'ui_web', 'panel.html'),
      [
        '<section id="export-panel">',
        '  <h2>Cài Đặt Xuất Video</h2>',
        '  <button id="btn-clear-cache">Xóa bộ nhớ đệm</button>',
        '</section>'
      ].join('\n'),
      'utf8'
    );
    const vnCtx = buildRouterContext(
      ['ui_web/'],
      vnTmpRepo,
      50,
      vnGoalNfd,
      [],
      { includeConventions: false, snippetContextLines: 3 }
    );
    assert.ok(
      vnCtx.includes('EMBEDDED CODE SNIPPETS'),
      `Vietnamese natural goal must produce deterministic pre-lookup hits instead of empty dynamicText, got:\n${vnCtx}`
    );
    assert.ok(
      /ui_web\/panel\.html:/.test(vnCtx) && vnCtx.includes('Cài Đặt Xuất Video'),
      `Pre-lookup must hit Vietnamese UI heading in ui_web/panel.html, got:\n${vnCtx}`
    );
  } finally {
    fs.rmSync(vnTmpRepo, { recursive: true, force: true });
  }
}

console.log('✓ ALL Router Context, truncated, and Deterministic Pre-Lookup tests passed!');
