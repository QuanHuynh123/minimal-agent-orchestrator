#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function runTests() {
  console.log('Testing Item 6: File Size, Scope Frequency & steps[] Token Reporter...\n');

  const { generateFileSizeReport, formatFileSizeMarkdownTable } = await import('./report-file-sizes.mjs');
  assert.equal(typeof generateFileSizeReport, 'function', 'report-file-sizes must export generateFileSizeReport');
  assert.equal(typeof formatFileSizeMarkdownTable, 'function', 'report-file-sizes must export formatFileSizeMarkdownTable');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-size-report-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'large.py'), Array.from({ length: 120 }, (_, i) => `def fn_${i}():\n\treturn ${i}`).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'small.js'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'test_large.py'), 'def test_ok():\n\tassert True\n', 'utf8');

    const tasks = [
      {
        task_id: 'T-1',
        scope: ['src/large.py', 'tests/test_large.py'],
        steps: [
          { step: '1', action: 'apply_patch', scope: ['src/large.py'], total_tokens: 12000 },
          { step: '2', action: 'apply_patch', scope: ['tests/test_large.py'], prompt_tokens: 3000, completion_tokens: 500 }
        ]
      },
      {
        task_id: 'T-2',
        scope: ['src/large.py', 'src/small.js']
      },
      // Duplicate task_id T-1 must deduplicate scope_count rather than double-counting
      {
        task_id: 'T-1',
        scope: ['src/large.py', 'tests/test_large.py'],
        steps: [
          { step: '1', action: 'apply_patch', scope: ['src/large.py'], total_tokens: 12000 },
          { step: '2', action: 'apply_patch', scope: ['tests/test_large.py'], prompt_tokens: 3000, completion_tokens: 500 }
        ]
      }
    ];

    const report = generateFileSizeReport({
      repoRoot: tmpRepo,
      top: 2,
      tasks
    });

    assert.equal(report.total_files_scanned, 3);
    assert.equal(report.top_files.length, 2, 'Respects top=N limit');
    assert.equal(report.top_files[0].path, 'src/large.py', 'Largest file must rank first');
    assert.equal(report.top_files[0].lines, 240);
    assert.ok(report.top_files[0].bytes > 1000 && report.top_files[0].kb > 1);
    assert.equal(report.top_files[0].scope_count, 2, 'scope_count must deduplicate task_id and sum T-1 + T-2');
    assert.equal(report.top_files[0].step_tokens, 12000, 'Must sum total_tokens from steps[] matching scope');

    // Verify all_files captures tests/test_large.py step tokens fallback (prompt + completion)
    const testRow = report.all_files.find(f => f.path === 'tests/test_large.py');
    assert.ok(testRow);
    assert.equal(testRow.scope_count, 1);
    assert.equal(testRow.step_tokens, 3500);

    const md = formatFileSizeMarkdownTable(report);
    assert.ok(md.includes('src/large.py') && md.includes('KB') && md.includes('steps[]'));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  console.log('✓ All Item 6 file size, scope & steps[] token reporter tests passed.');
}

runTests().catch(err => {
  console.error('Item 6 test failed:', err);
  process.exit(1);
});
