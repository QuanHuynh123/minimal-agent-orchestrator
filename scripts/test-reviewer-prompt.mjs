#!/usr/bin/env node
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRequestPromptTokens } from '../runtime/provider-gateway.mjs';
import { getScopedDiff } from './git-guard.mjs';
import { buildReviewerPrompt } from './lib/context-builders.mjs';
import { readGitCommitFile } from './lib/hermetic-fixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function buildSyntheticLargeApiFile() {
  const methods = [
    'from typing import Any, Dict',
    '',
    'class JsApi:',
    '\tdef _show_winforms_file_dialog(self) -> None:',
    '\t\t"""Unrelated helper far above the modified tail."""',
    '\t\treturn None',
    ''
  ];
  for (let i = 0; i < 450; i++) {
    methods.push(`\tdef helper_method_${i}(self, value: str = "payload_${i}") -> Dict[str, Any]:`);
    methods.push(`\t\t"""Synthetic class body line ${i} to ensure git diff --function-context exceeds 40KB."""`);
    methods.push(`\t\treturn {"ok": True, "index": ${i}, "value": value}`);
    methods.push('');
  }
  return methods.join('\n') + '\n';
}

function buildSyntheticLargeTestFile() {
  const lines = ['import unittest', 'from unittest.mock import MagicMock', '', 'class BridgeTests(unittest.TestCase):'];
  for (let i = 0; i < 120; i++) {
    lines.push(`\tdef test_existing_case_${i}(self) -> None:`);
    lines.push(`\t\tself.assertEqual(${i}, ${i})`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function runTests() {
  const systemPrompt = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'reviewer.md'), 'utf8');
  const jsApiBefore = buildSyntheticLargeApiFile();
  const testUiBefore = buildSyntheticLargeTestFile();

  const sampleSpec = [
    '# Pre-Code Spec: `get_supported_publish_privacies`',
    '',
    '## (a) Bridge contract',
    '- **Python signature (`ui_bridge/js_api.py`, class `JsApi`):** `def get_supported_publish_privacies(self) -> Dict[str, Any]:`',
    '- **Return payload:** `{"ok": True, "privacies": ["private", "unlisted", "public"]}`',
    '- **Mutability:** return a fresh `list` on each call.',
    '',
    '## (b) Unit test (`tests/test_ui_bridge.py`)',
    '- Verify exact dict structure, ordering, and `assertIsNot` on two calls.'
  ].join('\n');

  const task2 = {
    task_id: 'T-2026-11-16-0759-1-bo-sung-get-supported-publish-',
    goal: 'Thêm phương thức get_supported_publish_privacies() vào lớp JsApi trong ui_bridge/js_api.py trả về dict {\'ok\': True, \'privacies\': [\'private\', \'unlisted\', \'public\']} và viết unit test kiểm chứng trong tests/test_ui_bridge.py.',
    constraints: [
      "100% TAB ('\\t') Indentation cho code Python theo quy ước dự án",
      'Đảm bảo tuân thủ JsApi hygiene (phương thức public callable, không leak state nội bộ)'
    ],
    acceptance_criteria: [
      "api.get_supported_publish_privacies() trả về dict {'ok': True, 'privacies': ['private', 'unlisted', 'public']}",
      'Unit test trong tests/test_ui_bridge.py kiểm tra get_supported_publish_privacies trả về đúng cấu trúc và giá trị',
      'Test test_indentation.py và test_ui_bridge.py chạy thành công không có lỗi'
    ]
  };

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rev-prompt-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'ui_bridge'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'ui_bridge', 'js_api.py'), jsApiBefore, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'test_ui_bridge.py'), testUiBefore, 'utf8');

    execSync('git init -q && git config user.email t@t.com && git config user.name t && git add . && git commit -q -m init', { cwd: tmpRepo });

    const addedMethod = [
      '',
      '\tdef get_supported_publish_privacies(self) -> Dict[str, Any]:',
      '\t\t"""Return supported publish privacy options in UI order."""',
      '\t\treturn {"ok": True, "privacies": ["private", "unlisted", "public"]}',
      ''
    ].join('\n');

    const addedTest = [
      '',
      '\tdef test_js_api_get_supported_publish_privacies(self) -> None:',
      '\t\tapi = JsApi(MagicMock(), MagicMock())',
      '\t\tres = api.get_supported_publish_privacies()',
      '\t\tself.assertEqual(res, {"ok": True, "privacies": ["private", "unlisted", "public"]})',
      '\t\tself.assertIsNot(api.get_supported_publish_privacies()["privacies"], res["privacies"])',
      ''
    ].join('\n');

    fs.writeFileSync(path.join(tmpRepo, 'ui_bridge', 'js_api.py'), jsApiBefore + addedMethod, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'test_ui_bridge.py'), testUiBefore + addedTest, 'utf8');

    // 1. Bounded function-context diff must not dump whole classes (~2000 lines)
    const boundedDiff = getScopedDiff(['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'], {
      functionContext: true,
      cwd: tmpRepo
    });
    assert.ok(boundedDiff.includes('get_supported_publish_privacies'), 'Diff must preserve changed function lines');
    assert.ok(!boundedDiff.includes('_show_winforms_file_dialog'), 'Diff must NOT dump unrelated 1500+ lines of ui_bridge/js_api.py');
    assert.ok(boundedDiff.split('\n').length <= 150, `Bounded diff line count too large: ${boundedDiff.split('\n').length}`);

    // 2. buildReviewerPrompt includes spec + acceptance_criteria + diff and stays <= 6,000 est tokens
    const promptFromBounded = buildReviewerPrompt(task2, boundedDiff, [], { specText: sampleSpec });
    assert.match(promptFromBounded, /SPECIFICATION:/);
    assert.match(promptFromBounded, /Bridge contract/);
    assert.match(promptFromBounded, /ACCEPTANCE CRITERIA:/);
    assert.match(promptFromBounded, /get_supported_publish_privacies/);

    const estTokens = estimateRequestPromptTokens({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptFromBounded }
      ]
    });
    assert.ok(estTokens <= 6000, `Expected compact Reviewer prompt <= 6,000 tokens, got ${estTokens}`);

    // 3. Even if caller hands over a bloated raw --function-context diff (>1500 lines), buildReviewerPrompt compacts it <= 6,000 tokens
    const rawBloatedDiff = execSync(
      'git diff --function-context HEAD -- ui_bridge/js_api.py tests/test_ui_bridge.py',
      { cwd: tmpRepo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    assert.ok(rawBloatedDiff.length > 40000, 'Precondition: raw git diff --function-context on Task 2 files exceeds 40KB');

    const compactedPrompt = buildReviewerPrompt(task2, rawBloatedDiff, [], { specText: sampleSpec });
    const estCompactedTokens = estimateRequestPromptTokens({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: compactedPrompt }
      ]
    });
    assert.ok(compactedPrompt.includes('get_supported_publish_privacies'), 'Compacted prompt must retain actual diff changes');
    assert.ok(!compactedPrompt.includes('_show_winforms_file_dialog'), 'Compacted prompt must strip thousands of unchanged lines');
    assert.ok(estCompactedTokens <= 6000, `Expected compacted Reviewer prompt <= 6,000 tokens even from bloated diff, got ${estCompactedTokens}`);

    console.log(`ALL REVIEWER PROMPT COMPACTION TESTS PASSED (bounded=${estTokens} tok, compacted_from_bloated=${estCompactedTokens} tok <= 6000)`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

runTests();
