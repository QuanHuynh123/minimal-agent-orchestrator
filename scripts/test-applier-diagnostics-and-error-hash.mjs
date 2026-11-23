#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as applier from './applier.mjs';
import { recordTaskStep, transitionTaskState } from './lib/task-persistence.mjs';
import { writeMorningReportFile } from './lib/queue-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Item 3: Applier anti-hallucination (a), actual-content diagnostics (b), strict whitespace-only fuzzy match (c), and SEARCH-scoped error_hash (d)...\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-applier-diag-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'web'), { recursive: true });
    const fileLines = Array.from({ length: 120 }, (_, i) => `\t// line ${i + 1}: const _filler_${i + 1} = ${i + 1};`);
    fileLines[4] = '\tconst headerBanner = document.getElementById("banner-root");';
    fileLines[24] = '\tconst rangeSlider = document.getElementById("slider-x");';
    fileLines[25] = '\tif (rangeSlider) {';
    fileLines[26] = '\t\trangeSlider.value = "50";';
    fileLines[27] = '\t}';
    fileLines[79] = '\tfunction handleResetPanel() {';
    fileLines[80] = '\t\tconst btn = document.getElementById("btn-reset");';
    fileLines[81] = '\t\treturn Boolean(btn);';
    fileLines[82] = '\t}';
    fileLines[94] = '\tconst dupTarget = 42;';
    fileLines[104] = '\tconst dupTarget = 42;';

    const targetPath = path.join(tmpDir, 'web', 'panel.js');
    fs.writeFileSync(targetPath, fileLines.join('\n') + '\n', 'utf8');

    const baseTask = { scope: ['web/panel.js'], allow_scope_expansion: false };
    const baseOpts = { allowedDirs: ['web/'], repoRoot: tmpDir };

    // --- (a) Anti-hallucination: SEARCH outside seen ranges + OMITTED LINES hint ---
    const contextMetaA = {
      windowMode: 'smart',
      byFile: {
        'web/panel.js': {
          windowMode: 'smart',
          totalLines: 121,
          sentRanges: [[1, 35]],
          omittedRanges: [[36, 121]]
        }
      }
    };
    const unseenEditOut = [
      'FILE: web/panel.js',
      '<<<<<<< SEARCH',
      '\tfunction handleResetPanel() {',
      '\t\tconst btn = document.getElementById("btn-reset");',
      '=======',
      '\tfunction handleResetPanel() {',
      '\t\tconst btn = document.getElementById("btn-reset-v2");',
      '>>>>>>> REPLACE'
    ].join('\n');

    const resUnseen = applier.applyEdits(unseenEditOut, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA,
      readRanges: []
    });
    assert.equal(resUnseen.ok, false, '(a) Must reject edit targeting unseen lines outside window & read_ranges');
    assert.match(resUnseen.error, /SEARCH block #1 không nằm trong phần văn bản đã thấy/, `Expected clear anti-hallucination message, got: ${resUnseen.error}`);
    assert.match(resUnseen.error, /OMITTED LINES 36\.\.121/, `Expected OMITTED LINES range hint, got: ${resUnseen.error}`);
    assert.equal(resUnseen.failed_block?.error_code, 'not_in_seen_window');

    // Once read_file covers lines 75..90, the exact same block succeeds!
    const resAfterRead = applier.applyEdits(unseenEditOut, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA,
      readRanges: [{ path: 'web/panel.js', start_line: 75, end_line: 90 }]
    });
    assert.equal(resAfterRead.ok, true, `(a) Edit inside read_file range must succeed: ${resAfterRead.error}`);
    // Restore original content before continuing
    fs.writeFileSync(targetPath, fileLines.join('\n') + '\n', 'utf8');

    // --- (b) Drifted SEARCH inside seen window -> first line + closest line + similarity + ACTUAL FILE CONTENT (<= 30 lines) ---
    const driftedOutput = [
      'FILE: web/panel.js',
      '<<<<<<< SEARCH',
      '\trangeSlider = document.getElementById("slider-x");',
      '\tif (rangeSlider) {',
      '\t\trangeSlider.value = "50";',
      '\t}',
      '=======',
      '\tconst rangeSlider = document.getElementById("slider-y");',
      '>>>>>>> REPLACE'
    ].join('\n');

    const resDrifted = applier.applyEdits(driftedOutput, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA,
      readRanges: []
    });
    assert.equal(resDrifted.ok, false, '(b)/(c) Text difference (missing `const`) must NEVER auto-apply');
    assert.match(resDrifted.error, /First SEARCH line:.*rangeSlider = document\.getElementById/, 'Error must show shortened first SEARCH line');
    assert.match(resDrifted.error, /line 2[456].*\d+%/i, 'Error must report closest line number and similarity %');
    assert.match(resDrifted.error, /ACTUAL FILE CONTENT/i, 'Error must include ACTUAL FILE CONTENT section');
    assert.match(resDrifted.error, /25:\s*\t?const rangeSlider = document\.getElementById\("slider-x"\);/, 'ACTUAL FILE CONTENT must show numbered real file content');
    const actualBlockMatch = resDrifted.error.match(/=== ACTUAL FILE CONTENT[\s\S]*?\n([\s\S]*?)=== END ACTUAL FILE CONTENT ===/);
    assert.ok(actualBlockMatch, 'Must delimit ACTUAL FILE CONTENT block');
    const actualLinesShown = actualBlockMatch[1].trim().split('\n').length;
    assert.ok(actualLinesShown <= 30, `ACTUAL FILE CONTENT must show <= 30 lines, got ${actualLinesShown}`);

    // --- (c) Whitespace-only fuzzy match: auto-apply ONLY when strictly whitespace difference AND unique in file ---
    const wsDiffOutput = [
      'FILE: web/panel.js',
      '<<<<<<< SEARCH',
      '    const   rangeSlider = document.getElementById("slider-x");',
      '    if (rangeSlider) {',
      '        rangeSlider.value = "50";',
      '    }',
      '=======',
      '\tconst rangeSlider = document.getElementById("slider-updated");',
      '\tif (rangeSlider) {',
      '\t\trangeSlider.value = "90";',
      '\t}',
      '>>>>>>> REPLACE'
    ].join('\n');

    const resWsUnique = applier.applyEdits(wsDiffOutput, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA
    });
    assert.equal(resWsUnique.ok, true, `(c) Unique whitespace-only difference must auto-apply cleanly: ${resWsUnique.error}`);
    assert.ok(resWsUnique.fuzzy_whitespace_matches >= 1, 'Result should indicate whitespace fuzzy match was applied');
    assert.match(fs.readFileSync(targetPath, 'utf8'), /slider-updated/);
    fs.writeFileSync(targetPath, fileLines.join('\n') + '\n', 'utf8');

    // Non-unique whitespace difference (dupTarget appears at lines 95 and 105) -> MUST NOT apply
    const nonUniqueWsOutput = [
      'FILE: web/panel.js',
      '<<<<<<< SEARCH',
      '    const dupTarget = 42;',
      '=======',
      '\tconst dupTarget = 99;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resNonUniqueWs = applier.applyEdits(nonUniqueWsOutput, baseTask, baseOpts);
    assert.equal(resNonUniqueWs.ok, false, '(c) Non-unique whitespace match MUST fail instead of editing wrong location');
    assert.match(resNonUniqueWs.error, /multiple/i);
    assert.ok(!fs.readFileSync(targetPath, 'utf8').includes('dupTarget = 99'));

    // --- (d) error_hash includes failing SEARCH block fingerprint + error_code ---
    const driftedOutputB = [
      'FILE: web/panel.js',
      '<<<<<<< SEARCH',
      '\theaderBanner = document.getElementById("banner-root");',
      '=======',
      '\tconst headerBanner = null;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resDriftedB = applier.applyEdits(driftedOutputB, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA
    });
    assert.equal(resDriftedB.ok, false);
    assert.ok(resDrifted.error_hash && resDriftedB.error_hash, 'applyEdits must return structured error_hash on failures');
    assert.notEqual(
      resDrifted.error_hash,
      resDriftedB.error_hash,
      '(d) Different failing SEARCH blocks in same file MUST produce DIFFERENT error_hash'
    );

    // Same SEARCH block + SAME reason (with trivial whitespace differences) -> SAME error_hash
    const driftedOutputSameWs = driftedOutput.replace('\trangeSlider', '    rangeSlider');
    const resDriftedSame = applier.applyEdits(driftedOutputSameWs, baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA
    });
    assert.equal(
      resDrifted.error_hash,
      resDriftedSame.error_hash,
      '(d) Same failing SEARCH block + same failure reason must produce identical error_hash'
    );

    // Same SEARCH block text failing for DIFFERENT reason (unseen window vs not found inside read window) -> DIFFERENT error_hash
    const unseenVsSeenDiffReason = applier.applyEdits(unseenEditOut.replace('btn-reset', 'btn-nonexistent-xyz'), baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA,
      readRanges: []
    });
    const unseenAfterReadMiss = applier.applyEdits(unseenEditOut.replace('btn-reset', 'btn-nonexistent-xyz'), baseTask, {
      ...baseOpts,
      contextMeta: contextMetaA,
      readRanges: [{ path: 'web/panel.js', start_line: 75, end_line: 90 }]
    });
    assert.notEqual(
      unseenVsSeenDiffReason.error_hash,
      unseenAfterReadMiss.error_hash,
      '(d) Same SEARCH block failing with different error_code (not_in_seen_window vs search_not_found) must produce DIFFERENT error_hash'
    );

    // --- (e) String-literal whitespace preservation & Python/YAML indentation-depth fuzzy match + TAB re-indentation ---
    fs.mkdirSync(path.join(tmpDir, 'core'), { recursive: true });
    const pyPath = path.join(tmpDir, 'core', 'worker.py');
    const pyOriginal = [
      'class Worker:',
      '\tdef run(self, enabled):',
      '\t\tprint("a b")',
      '\t\tif enabled:',
      '\t\t\tstep_one()',
      '\t\t\tstep_two()',
      '\t\tfinalize()',
      ''
    ].join('\n');
    fs.writeFileSync(pyPath, pyOriginal, 'utf8');

    const pyTask = { scope: ['core/worker.py'], allow_scope_expansion: false };
    const pyOpts = { allowedDirs: ['core/'], repoRoot: tmpDir };

    // e1. print("a b") vs print("ab") MUST NOT auto-match!
    const stringSpaceMismatch = [
      'FILE: core/worker.py',
      '<<<<<<< SEARCH',
      '\t\tprint("ab")',
      '=======',
      '\t\tprint("changed")',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resStrSpace = applier.applyEdits(stringSpaceMismatch, pyTask, pyOpts);
    assert.equal(resStrSpace.ok, false, 'String-literal whitespace difference print("a b") vs print("ab") MUST NOT fuzzy-match');
    assert.match(resStrSpace.error, /ACTUAL FILE CONTENT/i);
    assert.equal(fs.readFileSync(pyPath, 'utf8'), pyOriginal);

    // e2. Python internal indentation-structure mismatch MUST NOT auto-match!
    const pyBadIndentStructure = [
      'FILE: core/worker.py',
      '<<<<<<< SEARCH',
      '        if enabled:',
      '            step_one()',
      '        step_two()',
      '            finalize()',
      '=======',
      '        if enabled:',
      '            step_one()',
      '            step_three()',
      '        finalize()',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resBadIndent = applier.applyEdits(pyBadIndentStructure, pyTask, pyOpts);
    assert.equal(resBadIndent.ok, false, 'Python SEARCH block with broken internal indentation hierarchy MUST NOT fuzzy-match');
    assert.match(resBadIndent.error, /ACTUAL FILE CONTENT/i);
    assert.equal(fs.readFileSync(pyPath, 'utf8'), pyOriginal);

    // e3. Valid Python 4-space equivalent (shifted depth hierarchy intact) -> matches & re-indents REPLACE with TABs!
    const pySpaceInputValid = [
      'FILE: core/worker.py',
      '<<<<<<< SEARCH',
      '    if enabled:',
      '        step_one()',
      '        step_two()',
      '    finalize()',
      '=======',
      '    if enabled:',
      '        step_one()',
      '        step_two_updated()',
      '    finalize()',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resPyReindent = applier.applyEdits(pySpaceInputValid, pyTask, pyOpts);
    assert.equal(resPyReindent.ok, true, `Valid TAB~space hierarchical Python match must succeed: ${resPyReindent.error}`);
    assert.equal(resPyReindent.fuzzy_whitespace_matches, 1);
    const pyAfter = fs.readFileSync(pyPath, 'utf8');
    assert.match(pyAfter, /\n\t\tif enabled:\n\t\t\tstep_one\(\)\n\t\t\tstep_two_updated\(\)\n\t\tfinalize\(\)\n/, 'REPLACE applied on Python file MUST convert indentation back to original TABs cleanly');
    assert.ok(!/^ +/m.test(pyAfter), 'Applied Python file must contain ZERO leading spaces (strict TAB standard preserved)');

    // --- (f) Original-file coordinate matching, seenRanges against orig coords, overlap rejection & atomic batch ---
    const coordLines = Array.from({ length: 60 }, (_, idx) => `const row_${idx + 1} = ${idx + 1};`);
    const coordRaw = coordLines.join('\n') + '\n';
    const coordPath = path.join(tmpDir, 'web', 'coords.js');
    fs.writeFileSync(coordPath, coordRaw, 'utf8');
    const coordTask = { scope: ['web/coords.js'], allow_scope_expansion: false };
    const coordMeta = {
      windowMode: 'smart',
      byFile: {
        'web/coords.js': {
          windowMode: 'smart',
          totalLines: 61,
          sentRanges: [[1, 30]],
          omittedRanges: [[31, 61]]
        }
      }
    };

    // f1. Block 1 deletes 20 lines inside [1..30], pulling original lines 38..39 up to line 19 in mutated text;
    //     seenRanges check MUST still judge Block 2 at original lines 38..39 (unseen, <3 lines) -> block & keep file unchanged!
    const delBlock = coordLines.slice(4, 24).join('\n'); // orig lines 5..24 (20 lines -> replaced with 1 line = -19 shift)
    const unseenShortBlock = [coordLines[37], coordLines[38]].join('\n'); // orig lines 38..39 (<3 lines!)
    const shiftedUnseenPatch = [
      'FILE: web/coords.js',
      '<<<<<<< SEARCH',
      delBlock,
      '=======',
      'const rows_deleted = true;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      unseenShortBlock,
      '=======',
      'const row_38 = 380;',
      'const row_39 = 390;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resShiftedUnseen = applier.applyEdits(shiftedUnseenPatch, coordTask, {
      ...baseOpts,
      contextMeta: coordMeta,
      readRanges: []
    });
    assert.equal(
      resShiftedUnseen.ok,
      false,
      'f1: seenRanges MUST be evaluated against ORIGINAL line coordinates (38..39), NOT shifted lines after Block 1 deletes 19 lines'
    );
    assert.equal(resShiftedUnseen.failed_block?.error_code, 'not_in_seen_window');
    assert.equal(fs.readFileSync(coordPath, 'utf8'), coordRaw, 'f1: failed atomic batch must leave disk unchanged');

    // f2. Multi-block overlapping SEARCH spans on original file MUST be rejected cleanly without mutating disk
    const overlapPatch = [
      'FILE: web/coords.js',
      '<<<<<<< SEARCH',
      coordLines.slice(9, 15).join('\n'),
      '=======',
      'const replacedA = true;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      coordLines.slice(12, 18).join('\n'),
      '=======',
      'const replacedB = true;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resOverlap = applier.applyEdits(overlapPatch, coordTask, { ...baseOpts });
    assert.equal(resOverlap.ok, false, 'f2: overlapping SEARCH blocks on same original range must fail');
    assert.equal(resOverlap.failed_block?.error_code, 'overlapping_blocks');
    assert.match(resOverlap.error, /overlap/i);
    assert.equal(fs.readFileSync(coordPath, 'utf8'), coordRaw, 'f2: overlap rejection must leave disk unchanged');

    // f3. Multi-block disjoint deletion + later edit in reverse & forward order apply atomically on original coordinates
    const seenTailBlock = coordLines.slice(26, 29).join('\n'); // orig lines 27..29
    const multiAtomicPatch = [
      'FILE: web/coords.js',
      '<<<<<<< SEARCH',
      delBlock,
      '=======',
      'const rows_collapsed = true;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      seenTailBlock,
      '=======',
      'const row_27 = 270;',
      'const row_28 = 280;',
      'const row_29 = 290;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resMultiAtomic = applier.applyEdits(multiAtomicPatch, coordTask, {
      ...baseOpts,
      contextMeta: coordMeta
    });
    assert.equal(resMultiAtomic.ok, true, `f3: disjoint multi-block delete+edit must apply atomically: ${resMultiAtomic.error}`);
    const afterAtomic = fs.readFileSync(coordPath, 'utf8');
    assert.match(afterAtomic, /const rows_collapsed = true;/);
    assert.match(afterAtomic, /const row_27 = 270;/);
    assert.ok(!afterAtomic.includes('const row_10 = 10;'));

    // --- (g) Seen-window gate branches:
    //   1. Exact + unique + >=3 non-empty lines outside seenRanges -> DO NOT block, record unseen_exact_match=true
    //   2. Exact + unique + <3 non-empty lines (even padded with blank lines) -> STILL block with not_in_seen_window
    //   3. Non-exact (drifted/whitespace-only) outside seenRanges -> block with explanatory not_in_seen_window
    //   4. Exact + multiple matches outside seenRanges -> block with multiple_matches
    //   5. Exact + unique + >=3 non-empty lines INSIDE seenRanges -> apply with unseen_exact_match=false
    const gLines = Array.from({ length: 100 }, (_, i) => `\t// g_pad_${i + 1}`);
    gLines[10] = '\tfunction inWindowTarget() {';
    gLines[11] = '\t\tconst x = 1;';
    gLines[12] = '\t\treturn x + 1;';
    gLines[13] = '\t}';
    gLines[69] = '\tfunction hiddenExactFn() {';
    gLines[70] = '\t\tconst a = 10;';
    gLines[71] = '\t\tconst b = 20;';
    gLines[72] = '\t\treturn a + b;';
    gLines[73] = '\t}';
    gLines[80] = '\tconst hiddenPairA = "alpha";';
    gLines[81] = '';
    gLines[82] = '\tconst hiddenPairB = "beta";';
    gLines[88] = '\tconst repeatedHiddenA = 1;';
    gLines[89] = '\tconst repeatedHiddenB = 2;';
    gLines[90] = '\tconst repeatedHiddenC = 3;';
    gLines[93] = '\tconst repeatedHiddenA = 1;';
    gLines[94] = '\tconst repeatedHiddenB = 2;';
    gLines[95] = '\tconst repeatedHiddenC = 3;';

    const gRaw = gLines.join('\n') + '\n';
    const gPath = path.join(tmpDir, 'web', 'seen_gate.js');
    fs.writeFileSync(gPath, gRaw, 'utf8');
    const gTask = { scope: ['web/seen_gate.js'], allow_scope_expansion: false };
    const gMeta = {
      windowMode: 'smart',
      byFile: {
        'web/seen_gate.js': {
          windowMode: 'smart',
          totalLines: 101,
          sentRanges: [[1, 30]],
          omittedRanges: [[31, 101]]
        }
      }
    };

    // g1. Exact + unique + >=3 non-empty lines outside seenRanges -> ALLOWED & unseen_exact_match=true
    const g1Patch = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '\tfunction hiddenExactFn() {',
      '\t\tconst a = 10;',
      '\t\tconst b = 20;',
      '\t\treturn a + b;',
      '\t}',
      '=======',
      '\tfunction hiddenExactFn() {',
      '\t\treturn 42;',
      '\t}',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resG1 = applier.applyEdits(g1Patch, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG1.ok, true, `g1: exact unique >=3 non-empty lines outside seen window must NOT be blocked: ${resG1.error}`);
    assert.equal(resG1.unseen_exact_match, true, 'g1: must flag unseen_exact_match=true');
    assert.match(fs.readFileSync(gPath, 'utf8'), /return 42;/);
    fs.writeFileSync(gPath, gRaw, 'utf8');

    // g2. Exact + unique + <3 non-empty lines (2 non-empty + 1 blank) -> STILL blocked!
    const g2Patch = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '\tconst hiddenPairA = "alpha";',
      '',
      '\tconst hiddenPairB = "beta";',
      '=======',
      '\tconst hiddenPairA = "alpha2";',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resG2 = applier.applyEdits(g2Patch, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG2.ok, false, 'g2: <3 non-empty lines outside seen window MUST still be blocked');
    assert.equal(resG2.failed_block?.error_code, 'not_in_seen_window');

    // g3. Whitespace-only match / non-exact outside seenRanges -> blocked with explanatory not_in_seen_window
    const g3WsUnseen = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '    function   hiddenExactFn() {',
      '        const a = 10;',
      '        const b = 20;',
      '        return a + b;',
      '    }',
      '=======',
      '\tfunction hiddenExactFn() { return 0; }',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resG3 = applier.applyEdits(g3WsUnseen, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG3.ok, false, 'g3: non-exact whitespace-fuzzy block outside seen window must be explained/blocked by not_in_seen_window');
    assert.equal(resG3.failed_block?.error_code, 'not_in_seen_window');

    // g4. Exact + multiple matches (>=3 lines) outside seenRanges -> multiple_matches
    const g4Dup = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '\tconst repeatedHiddenA = 1;',
      '\tconst repeatedHiddenB = 2;',
      '\tconst repeatedHiddenC = 3;',
      '=======',
      '\tconst repeatedHiddenA = 9;',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resG4 = applier.applyEdits(g4Dup, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG4.ok, false, 'g4: non-unique exact match outside seen window must be rejected as multiple_matches');
    assert.equal(resG4.failed_block?.error_code, 'multiple_matches');

    // g5. Exact + unique + >=3 lines INSIDE seenRanges -> ok & unseen_exact_match=false
    const g5Seen = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '\tfunction inWindowTarget() {',
      '\t\tconst x = 1;',
      '\t\treturn x + 1;',
      '\t}',
      '=======',
      '\tfunction inWindowTarget() {',
      '\t\treturn 99;',
      '\t}',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resG5 = applier.applyEdits(g5Seen, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG5.ok, true);
    assert.equal(resG5.unseen_exact_match, false, 'g5: in-window match must report unseen_exact_match=false');

    // g6. steps[] persistence via recordTaskStep & delete-block unseen_exact_matches -> morning-report.md
    const resG1Modify = applier.applyEdits(g1Patch, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resG1Modify.ok, true);
    assert.equal(resG1Modify.unseen_exact_matches?.[0]?.is_delete, false, 'Modify block must mark is_delete=false');
    assert.equal(resG1Modify.unseen_exact_matches?.[0]?.action_kind, 'modify', 'Modify block must set action_kind=modify');
    fs.writeFileSync(gPath, gRaw, 'utf8');

    const gDeletePatch = [
      'FILE: web/seen_gate.js',
      '<<<<<<< SEARCH',
      '\tfunction hiddenExactFn() {',
      '\t\tconst a = 10;',
      '\t\tconst b = 20;',
      '\t\treturn a + b;',
      '\t}',
      '=======',
      '>>>>>>> REPLACE'
    ].join('\n');
    const resGDelete = applier.applyEdits(gDeletePatch, gTask, { ...baseOpts, contextMeta: gMeta, readRanges: [] });
    assert.equal(resGDelete.ok, true, `g6: unseen exact >=3-line delete block must apply cleanly: ${resGDelete.error}`);
    assert.equal(resGDelete.unseen_exact_match, true);
    assert.equal(resGDelete.unseen_exact_matches?.[0]?.is_delete, true, 'Empty REPLACE unseen exact block must mark is_delete=true');
    assert.equal(resGDelete.unseen_exact_matches?.[0]?.action_kind, 'delete', 'Empty REPLACE unseen exact block must set action_kind=delete');
    assert.equal(resGDelete.unseen_exact_matches?.[0]?.start_line, 70);
    assert.equal(resGDelete.unseen_exact_matches?.[0]?.end_line, 74);

    const mockTask = {
      task_id: 'T-UNSEEN-EXACT',
      title: 'Clean up unseen helper',
      mode: 'quick',
      status: 'running',
      steps: []
    };
    const combinedMatches = [
      ...(resG1Modify.unseen_exact_matches || []),
      ...(resGDelete.unseen_exact_matches || [])
    ];
    const rec = recordTaskStep(mockTask, {
      step: '2.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      unseen_exact_match: resGDelete.unseen_exact_match,
      unseen_exact_matches: combinedMatches
    }, { skipJsonl: true });
    assert.equal(rec.unseen_exact_match, true, 'recordTaskStep must persist unseen_exact_match in steps[]');
    assert.equal(rec.unseen_exact_matches?.length, 2, 'recordTaskStep must persist unseen_exact_matches[] details');

    const mockState = { active_tasks: [mockTask], completed_tasks: [], blocked_tasks: [], metrics: {} };
    transitionTaskState(mockTask, mockState, 'done', {
      actualModifiedFiles: ['web/seen_gate.js'],
      validationPassed: true,
      retries: 0,
      maxRetries: 3
    });
    assert.equal(mockTask.last_report?.unseen_exact_match_count, 2, 'last_report must record unseen_exact_match_count');
    assert.equal(mockTask.last_report?.unseen_exact_matches?.length, 2, 'last_report must preserve unseen_exact_matches details');

    const reportPath = path.join(tmpDir, 'morning-report.md');
    writeMorningReportFile(mockState, {
      tasksActiveDir: path.join(tmpDir, 'tasks-active'),
      tasksArchiveDir: path.join(tmpDir, 'tasks-archive'),
      reportFile: reportPath
    });
    const reportMd = fs.readFileSync(reportPath, 'utf8');
    assert.match(reportMd, /Unseen Exact Matches/i, 'morning-report.md must include Unseen Exact Matches summary/section');
    assert.match(reportMd, /2 block\(s\)/, 'morning-report.md must show total unseen_exact_match block count');
    assert.match(reportMd, /web\/seen_gate\.js:70-74/, 'morning-report.md must display file + line range');
    assert.match(reportMd, /\[DELETE\]/, 'morning-report.md must explicitly mark delete blocks with [DELETE]');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify orchestrator.mjs passes seenRanges / contextMeta / readRanges to applyEdits & uses applyRes.error_hash & unseen_exact_match
  const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.match(orchSrc, /contextMeta:\s*stepScopedMeta/, 'orchestrator.mjs must pass stepScopedMeta into applyEdits');
  assert.match(orchSrc, /applyRes\.error_hash/, 'orchestrator.mjs must use applyRes.error_hash for loop breaker');
  assert.match(orchSrc, /unseen_exact_match/, 'orchestrator.mjs must wire unseen_exact_match into steps[]');

  console.log('✓ All Item 3 Applier (a)-(d) diagnostics, strict fuzzy match & error_hash tests passed.');
}

runTests().catch(err => {
  console.error('Item 3 test failed:', err);
  process.exit(1);
});
