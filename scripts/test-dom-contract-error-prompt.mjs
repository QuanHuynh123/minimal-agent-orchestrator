#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatValidationErrorForRetry } from './lib/context-builders.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runTests() {
  console.log('Testing Item 2: Concise test_dom_contract failure summary (test name, error message, orphan refs file:line)...\n');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-dom-err-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'web'), { recursive: true });

    const htmlLines = Array.from({ length: 30 }, (_, i) => `<!-- filler_${i + 1} -->`);
    htmlLines[0] = '<html><body>';
    htmlLines[4] = '<div id="kept-box"></div>';
    htmlLines[17] = '<script>';
    htmlLines[19] = "const btn = document.getElementById('orphan-btn-alpha');"; // line 20
    htmlLines[20] = "document.querySelectorAll('#orphan-panel-beta button').forEach(() => {});"; // line 21
    htmlLines[22] = "const kept = document.getElementById('kept-box');"; // line 23 (valid)
    htmlLines[24] = "document.querySelector('#orphan-panel-beta').classList.add('active');"; // line 25
    htmlLines[28] = '</script></body></html>';
    fs.writeFileSync(path.join(tmpRepo, 'web', 'index.html'), htmlLines.join('\n'), 'utf8');

    const extraJsLines = [
      '// Helper UI script',
      'export function bindExtra() {',
      '  const x = 1;',
      "  return document.querySelector('#orphan-btn-alpha .label');", // line 4
      '}'
    ];
    fs.writeFileSync(path.join(tmpRepo, 'web', 'extra.js'), extraJsLines.join('\n'), 'utf8');

    // Construct noisy unittest validation output exceeding 1800 chars, including trailing chatter after the DOM contract assertion
    const passingNoise = Array.from({ length: 45 }, (_, i) => `test_passing_case_${i + 1} (tests.test_other.OtherTests.test_passing_case_${i + 1}) ... ok`).join('\n');
    const trailingNoise = Array.from({ length: 45 }, (_, i) => `[debug_stderr_${i + 1}] tearDown cleanup step ${i + 1}: ${'z'.repeat(35)}`).join('\n');
    const rawUnittestOut = [
      passingNoise,
      '======================================================================',
      'FAIL: test_all_js_referenced_element_ids_exist_in_html (tests.test_dom_contract.TestDomContract.test_all_js_referenced_element_ids_exist_in_html)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "tests/test_dom_contract.py", line 45, in test_all_js_referenced_element_ids_exist_in_html',
      '    self.assertEqual(',
      "AssertionError: Lists differ: ['orphan-btn-alpha', 'orphan-panel-beta'] != []",
      '',
      'First differing element 0:',
      "'orphan-btn-alpha'",
      '[]',
      '',
      "- ['orphan-btn-alpha', 'orphan-panel-beta']",
      '+ []',
      " : JavaScript references DOM elements by ID that DO NOT EXIST in HTML: ['orphan-btn-alpha', 'orphan-panel-beta']",
      '----------------------------------------------------------------------',
      trailingNoise,
      'Ran 46 tests in 2.41s',
      'FAILED (failures=1)'
    ].join('\n');

    const concise = formatValidationErrorForRetry(rawUnittestOut, 1800, {
      repoRoot: tmpRepo,
      scope: ['web/index.html', 'web/extra.js']
    });

    assert.ok(concise.length > 0 && concise.length <= 1800, `Concise prompt error must fit within 1800 chars, got ${concise.length}`);
    assert.match(concise, /test_all_js_referenced_element_ids_exist_in_html/, 'Must include failing DOM contract test name');
    assert.match(
      concise,
      /JavaScript references DOM elements by ID that DO NOT EXIST in HTML:\s*\['orphan-btn-alpha',\s*'orphan-panel-beta'\]/,
      'Must include DOM contract failure message'
    );
    assert.match(concise, /web\/index\.html:20\b/, 'Must pinpoint orphan-btn-alpha ref at web/index.html:20');
    assert.match(concise, /web\/index\.html:21\b/, 'Must pinpoint orphan-panel-beta ref at web/index.html:21');
    assert.match(concise, /web\/index\.html:25\b/, 'Must pinpoint orphan-panel-beta ref at web/index.html:25');
    assert.match(concise, /web\/extra\.js:4\b/, 'Must pinpoint orphan-btn-alpha ref at web/extra.js:4');
    assert.equal(concise.includes('kept-box'), false, 'Must NOT list non-orphan valid DOM references');
    assert.equal(concise.includes('[debug_stderr_1]'), false, 'Must strip trailing debug noise when DOM contract failure fits concisely');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  // Verify orchestrator.mjs passes repoRoot & scope into formatValidationErrorForRetry so retry prompts receive orphan file:line refs
  const readOrchestratorCombinedSource = (scriptsDir) => {
    const subDir = path.join(scriptsDir, 'orchestrator');
    const subFiles = fs.existsSync(subDir)
      ? fs.readdirSync(subDir).filter(f => f.endsWith('.mjs')).sort().map(f => path.join(subDir, f))
      : [];
    return [path.join(scriptsDir, 'orchestrator.mjs'), ...subFiles]
      .map(p => fs.readFileSync(p, 'utf8'))
      .join('\n');
  };
  const orchSrc = readOrchestratorCombinedSource(__dirname);
  assert.match(
    orchSrc,
    /formatValidationErrorForRetry\s*\(\s*errSummary\s*,\s*1800\s*,\s*\{\s*repoRoot\s*:/,
    'orchestrator.mjs handleStageFailure must pass { repoRoot, scope } to formatValidationErrorForRetry'
  );

  console.log('✓ All Item 2 concise test_dom_contract prompt error tests passed.');
}

runTests();
