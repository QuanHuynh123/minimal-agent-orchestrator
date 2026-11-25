#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScopedFilesContextWithMeta,
  measureEditedLinesOutsideWindow,
  sliceContentByKeywords,
  sliceContentByKeywordsWithMeta
} from './lib/context-builders.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';

async function runTests() {
  console.log('Testing Item 1: Reference-aware smart window expansion & steps[] context telemetry...\n');

  assert.equal(typeof sliceContentByKeywordsWithMeta, 'function', 'context-builders must export sliceContentByKeywordsWithMeta');
  assert.equal(typeof buildScopedFilesContextWithMeta, 'function', 'context-builders must export buildScopedFilesContextWithMeta');
  assert.equal(typeof measureEditedLinesOutsideWindow, 'function', 'context-builders must export measureEditedLinesOutsideWindow');

  // 1. Generic large single-file fixture (4,500 lines):
  // - Head / top markup declares id="widget-ctrl-alpha", class="panel-mode-grid", and helper initWidgetAlpha()
  // - Middle filler (lines 120..1800)
  // - Far-away Handler A around line 1950 referencing getElementById('widget-ctrl-alpha') & initWidgetAlpha()
  // - More filler (lines 2000..4050)
  // - Far-away Handler B around line 4150 referencing document.querySelectorAll('#widget-ctrl-alpha .panel-mode-grid')
  // Task keywords ONLY mention "widget-ctrl-alpha" and "panel-mode-grid" (NOT Handler A/B helper names!).
  const totalLines = 4500;
  const lines = Array.from({ length: totalLines }, (_, i) => `/* filler_${i + 1}: const _pad_${i + 1} = "${'x'.repeat(32)}"; */`);

  // Declaration block near top (lines 55..75, outside 30-line header anchor so it's selected as seed window!)
  lines[54] = '<section id="widget-ctrl-alpha" class="panel-mode-grid">';
  lines[55] = '  <input id="widget-alpha-range" type="range" min="0" max="100" value="25" />';
  lines[56] = '  <button data-fn="syncWidgetAlphaState">Apply Alpha</button>';
  lines[57] = '</section>';
  lines[58] = 'function syncWidgetAlphaState(val) { return val * 2; }';

  // Handler A far away around line 1950
  lines[1948] = '// --- Distant Event Setup A ---';
  lines[1949] = "const alphaPanelEl = document.getElementById('widget-ctrl-alpha');";
  lines[1950] = "const alphaRangeEl = document.getElementById('widget-alpha-range');";
  lines[1951] = 'if (alphaRangeEl) syncWidgetAlphaState(alphaRangeEl.value);';

  // Handler B even further near bottom around line 4150
  lines[4148] = '// --- Distant DOM Query B ---';
  lines[4149] = "document.querySelectorAll('#widget-ctrl-alpha button').forEach(btn => {";
  lines[4150] = "  btn.dataset.ready = document.querySelector('#widget-ctrl-alpha .panel-mode-grid') ? '1' : '0';";
  lines[4151] = '});';

  const bigFile = lines.join('\n');
  const sliced = sliceContentByKeywords(bigFile, ['widget-ctrl-alpha', 'panel-mode-grid'], 18000, 20);

  assert.match(sliced, /id="widget-ctrl-alpha"/, 'Seed declaration block must be in initial smart window');
  assert.match(sliced, /alphaPanelEl\s*=\s*document\.getElementById\('widget-ctrl-alpha'\)/, 'First distant handler referencing id="widget-ctrl-alpha" must be pulled into initial smart window');
  assert.match(sliced, /syncWidgetAlphaState\(alphaRangeEl\.value\)/, 'Call to seed function syncWidgetAlphaState must be included in distant handler A');
  assert.match(sliced, /querySelectorAll\('#widget-ctrl-alpha button'\)/, 'Second distant handler B referencing #widget-ctrl-alpha must also be pulled into initial smart window');
  assert.match(sliced, /querySelector\('#widget-ctrl-alpha \.panel-mode-grid'\)/, 'Selector reference in handler B must appear in initial smart window');

  // Verify strict byte budget still respected
  assert.ok(Buffer.byteLength(sliced, 'utf8') <= 19000, `Smart window must respect byte cap, got ${Buffer.byteLength(sliced, 'utf8')}`);

  // 2. Also test when declaration sits directly inside Header Anchor (lines 1..25) + 2 far regions
  const headerDeclLines = Array.from({ length: 4200 }, (_, i) => `/* spacer_${i + 1}: const _s_${i + 1} = 1; */`);
  headerDeclLines[8] = '<div id="toolbar-host-x" class="toolbar-card-list"></div>';
  headerDeclLines[9] = 'function bindToolbarHostX() { return true; }';
  headerDeclLines[1800] = "const hostA = document.getElementById('toolbar-host-x'); bindToolbarHostX();";
  headerDeclLines[3900] = "document.querySelector('#toolbar-host-x .toolbar-card-list')?.classList.add('ready');";

  const slicedMeta = sliceContentByKeywordsWithMeta(headerDeclLines.join('\n'), ['toolbar-host-x'], 16000, 20);
  assert.equal(slicedMeta.windowMode, 'smart');
  assert.ok(slicedMeta.contextLinesSent > 0 && slicedMeta.contextLinesSent < 4200);
  assert.ok(Array.isArray(slicedMeta.sentRanges) && slicedMeta.sentRanges.length >= 3);
  assert.match(slicedMeta.text, /hostA = document\.getElementById\('toolbar-host-x'\)/, 'Distant reference #1 from header declaration must be included');
  assert.match(slicedMeta.text, /querySelector\('#toolbar-host-x \.toolbar-card-list'\)/, 'Distant reference #2 from header declaration must be included');

  // 3. Test buildScopedFilesContextWithMeta + measureEditedLinesOutsideWindow + recordTaskStep fields
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-smart-win-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'web'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'web', 'large.html'), bigFile, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'web', 'small.js'), 'export const ok = true;\n', 'utf8');

    const fullRes = buildScopedFilesContextWithMeta(['web/small.js'], tmpDir, { title: 'Update small js', goal: 'ok' });
    assert.equal(fullRes.windowMode, 'full');
    assert.equal(fullRes.contextLinesSent, 2); // 'export const ok = true;' + trailing newline line

    const smartRes = buildScopedFilesContextWithMeta(['web/large.html'], tmpDir, {
      title: 'Update widget-ctrl-alpha',
      goal: 'Adjust widget-ctrl-alpha and panel-mode-grid'
    });
    assert.equal(smartRes.windowMode, 'smart');
    assert.ok(smartRes.contextLinesSent > 50 && smartRes.contextLinesSent < totalLines);
    assert.ok(smartRes.byFile['web/large.html'].omittedRanges.length > 0);

    // Measure edit lines: one inside sent window (line 55), one completely outside (line 2800..2802)
    const outsideCount = measureEditedLinesOutsideWindow(
      [
        { file: 'web/large.html', search: lines[54] },
        { file: 'web/large.html', search: `${lines[2800]}\n${lines[2801]}\n${lines[2802]}` }
      ],
      { 'web/large.html': bigFile },
      smartRes
    );
    assert.equal(outsideCount, 3, 'Only the 3 edited lines in uncovered line 2801..2803 should count as outside window');

    // Verify recordTaskStep persists the 4 telemetry fields in steps[]
    const mockTask = { task_id: 'T-GEN-WIN-TELEM', steps: [] };
    const stepEntry = recordTaskStep(mockTask, {
      step: '2.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      context_lines_sent: smartRes.contextLinesSent,
      window_mode: smartRes.windowMode,
      edit_lines_outside_window: outsideCount,
      extra_read_calls: 2
    }, { skipJsonl: true });

    assert.equal(stepEntry.context_lines_sent, smartRes.contextLinesSent);
    assert.equal(stepEntry.window_mode, 'smart');
    assert.equal(stepEntry.edit_lines_outside_window, 3);
    assert.equal(stepEntry.extra_read_calls, 2);

    // 4. Generic ~250KB / 5,400-line single-file fixture where secondary JS blocks have higher keyword scores
    //    than an HTML preset-pills declaration block (`id="panel-presets"`) whose distant listener sits at line ~5150:
    //    buildScopedFilesContextWithMeta must NOT drop the preset declaration + distant #id listener within 24KB single-file budget.
    const hugeLines = Array.from({ length: 5400 }, (_, i) => `/* filler_line_${i + 1}: const _slot_${i + 1} = "${'k'.repeat(30)}"; */`);
    // Block A at lines 310..330: preset controls (moderate keywords)
    hugeLines[310] = '<!-- Preset Controls -->';
    hugeLines[311] = '<div id="panel-presets" class="flex gap-2">';
    hugeLines[312] = '  <button data-preset="top">Top Preset</button>';
    hugeLines[313] = '  <button data-preset="bottom">Bottom Preset</button>';
    hugeLines[314] = '</div>';
    // Block B at lines 385..430: mode selector with dense keywords ("mode_alpha", "mode_beta")
    for (let k = 0; k < 28; k++) {
      hugeLines[385 + k] = `<button class="mode_alpha mode_beta option_tile_${k}" data-mode="mode_alpha">Option ${k}</button>`;
    }
    hugeLines[414] = '<div id="panel-mode-pills"></div>';
    // High-scoring middle JS blocks at ~2660 and ~3200 matching multiple keywords
    for (let k = 0; k < 26; k++) {
      hugeLines[2650 + k] = `function syncModeAlphaBeta_${k}() { /* mode_alpha mode_beta preset layout tile ${k} */ return ${k}; }`;
      hugeLines[3190 + k] = `const cfgModeTile_${k} = { mode_alpha: true, mode_beta: true, layout: 'grid', tile: ${k} };`;
    }
    // Distant listener at lines 5150..5155 referencing #panel-presets
    hugeLines[5149] = "document.querySelectorAll('#panel-presets button').forEach(btn => {";
    hugeLines[5150] = "  btn.dataset.bound = '1';";
    hugeLines[5151] = '});';
    hugeLines[5152] = "document.querySelectorAll('#panel-presets button').forEach(b => b.classList.add('active'));";

    const hugeFilePath = path.join(tmpDir, 'web', 'studio_huge.html');
    fs.writeFileSync(hugeFilePath, hugeLines.join('\n'), 'utf8');

    const hugeScoped = buildScopedFilesContextWithMeta(['web/studio_huge.html'], tmpDir, {
      title: 'Clean up preset buttons and mode_alpha mode_beta grid layout',
      goal: 'Remove panel-presets and listener, adjust mode_alpha mode_beta layout tile grid'
    }, { tokenBudgetPerTask: 150000 });

    assert.equal(hugeScoped.windowMode, 'smart');
    assert.match(hugeScoped.text, /id="panel-presets"/, 'Single-file smart window must include HTML declaration id="panel-presets"');
    assert.match(hugeScoped.text, /#panel-presets button/, 'Single-file smart window must pull distant #id listener at line 5150 via ID reference expansion');

    // 5. Symmetric JS -> HTML reference + camelCase cross-form match:
    //    Task mentions camelCase "auditToolbarHandler" (hitting JS around line 3200),
    //    and JS calls document.getElementById('audit-toolbar-box') whose HTML <div id="audit-toolbar-box"> sits at line 450.
    const symLines = Array.from({ length: 4200 }, (_, i) => `/* pad_${i + 1}: var _p${i + 1} = "${'y'.repeat(30)}"; */`);
    symLines[450] = '<div id="audit-toolbar-box" class="toolbar-shell">';
    symLines[451] = '  <button id="audit-export-btn">Export Audit</button>';
    symLines[452] = '</div>';
    symLines[3200] = 'function auditToolbarHandler() {';
    symLines[3201] = "  const host = document.getElementById('audit-toolbar-box');";
    symLines[3202] = "  return host ? host.querySelector('#audit-export-btn') : null;";
    symLines[3203] = '}';
    const symFile = symLines.join('\n');
    const symRes = sliceContentByKeywordsWithMeta(symFile, ['auditToolbarHandler'], 18000, 20, { filePath: 'web/sym.html' });
    assert.match(symRes.text, /function auditToolbarHandler\(\)/);
    assert.match(symRes.text, /<div id="audit-toolbar-box"/, 'Symmetric JS->HTML ref must pull HTML declaration of #audit-toolbar-box');

    // 6. camelCase keyword matching ("manualReviewBanner") -> matches kebab-case id="manual-review-banner" + function renderManualReviewBanner()
    const camelLines = Array.from({ length: 3800 }, (_, i) => `/* filler_${i + 1}: manual review banner note ${'z'.repeat(28)} */`);
    camelLines[620] = '<section id="manual-review-banner">Pending</section>';
    camelLines[2900] = 'function renderManualReviewBanner() {';
    camelLines[2901] = "  return document.getElementById('manual-review-banner');";
    camelLines[2902] = '}';
    const camelRes = sliceContentByKeywordsWithMeta(camelLines.join('\n'), ['manualReviewBanner'], 18000, 20, { filePath: 'web/camel.html' });
    assert.match(camelRes.text, /id="manual-review-banner"/, 'camelCase keyword must pull matching kebab-case DOM id');
    assert.match(camelRes.text, /function renderManualReviewBanner\(\)/, 'camelCase keyword must pull camelCase function');

    // 7. Tree-sitter AST enclosing function boundary in Pass 2 (Python 34-line function instead of truncated +-12 fixed lines)
    const pyLines = Array.from({ length: 3600 }, (_, i) => `# filler line ${i + 1}: ${'p'.repeat(30)}`);
    pyLines[120] = 'def create_widget_cfg(mode):';
    pyLines[121] = '\treturn {"mode": mode}';
    pyLines[2600] = 'def run_widget_pipeline(items, fallback_mode="fast"):';
    for (let k = 1; k <= 29; k++) {
      pyLines[2600 + k] = `\tstep_${k} = len(items) + ${k}`;
    }
    pyLines[2630] = '\tcfg = create_widget_cfg(fallback_mode)';
    pyLines[2631] = '\treturn step_29, cfg';

    fs.writeFileSync(path.join(tmpDir, 'worker_mod.py'), pyLines.join('\n'), 'utf8');
    const pyScoped = buildScopedFilesContextWithMeta(['worker_mod.py'], tmpDir, {
      title: 'Update create_widget_cfg',
      goal: 'Refactor create_widget_cfg signature'
    }, { tokenBudgetPerTask: 150000 });
    assert.equal(pyScoped.windowMode, 'smart');
    assert.match(pyScoped.text, /def create_widget_cfg\(mode\):/);
    assert.match(pyScoped.text, /def run_widget_pipeline\(items, fallback_mode="fast"\):/, 'Tree-sitter enclosing AST boundary must include the full enclosing function header 30 lines above the ref hit');
    assert.match(pyScoped.text, /return step_29, cfg/, 'Enclosing AST boundary must include function return line');
    assert.ok(Buffer.byteLength(pyScoped.text, 'utf8') <= 26000, 'Single-file scoped budget must stay bounded near 24KB');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify orchestrator.mjs passes those 4 step fields when recording writer step telemetry
  const orchSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'orchestrator.mjs'), 'utf8');
  assert.match(orchSrc, /context_lines_sent:/, 'orchestrator.mjs must record context_lines_sent into steps[]');
  assert.match(orchSrc, /window_mode:/, 'orchestrator.mjs must record window_mode into steps[]');
  assert.match(orchSrc, /edit_lines_outside_window:/, 'orchestrator.mjs must record edit_lines_outside_window into steps[]');
  assert.match(orchSrc, /extra_read_calls:/, 'orchestrator.mjs must record extra_read_calls into steps[]');

  console.log('✓ All Item 1 smart window reference expansion & telemetry tests passed.');
}

runTests().catch(err => {
  console.error('Item 1 smart-window test failed:', err);
  process.exit(1);
});
