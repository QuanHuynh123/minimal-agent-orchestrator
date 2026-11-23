#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runtimeMod from '../runtime/index.mjs';
import { TOOL_SCHEMAS } from '../runtime/tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Item 2: Retry Files-Already-Read inheritance & single-turn parallel read_file...\n');

  assert.equal(typeof runtimeMod.mergeReadRanges, 'function', 'runtime/index.mjs must export mergeReadRanges');
  assert.equal(typeof runtimeMod.formatPriorReadContext, 'function', 'runtime/index.mjs must export formatPriorReadContext');
  assert.match(
    TOOL_SCHEMAS.read_file.function.description,
    /parallel|multiple|cùng\s+một\s+lượt/i,
    'read_file schema description must mention parallel/multiple calls in one turn'
  );

  // 1. Test mergeReadRanges & formatPriorReadContext directly (merge overlapping, preserve disjoint)
  const merged = runtimeMod.mergeReadRanges(
    [
      { path: 'web/view.html', start_line: 100, end_line: 120, content: '[Showing lines 100-120 of 800]\n100: alpha\n120: beta' },
      { path: 'web/view.html', start_line: 400, end_line: 420, content: '[Showing lines 400-420 of 800]\n400: gamma\n420: delta' }
    ],
    [
      { path: 'web/view.html', start_line: 115, end_line: 140, content: '[Showing lines 115-140 of 800]\n115: mid\n140: end140' }
    ]
  );
  assert.equal(merged.length, 2, 'Overlapping [100..120]+[115..140] must merge, keeping disjoint [400..420]');
  const range1 = merged.find(r => r.start_line === 100);
  assert.equal(range1.end_line, 140);

  const formatted = runtimeMod.formatPriorReadContext(merged, 8000);
  assert.match(formatted, /Files Already Read/i);
  assert.match(formatted, /web\/view\.html:100-140/);
  assert.match(formatted, /web\/view\.html:400-420/);
  assert.match(formatted, /gamma/);

  // 2. Test runAgent executing 2 parallel read_file calls in a SINGLE turn + returning read_ranges
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-parallel-read-'));
  try {
    const cfgDir = path.join(tmpDir, 'cfg');
    const sessDir = path.join(tmpDir, 'sess');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'web'), { recursive: true });

    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "parallel-read-test"',
      '  scope_control:',
      '    allowed_dirs: ["web/"]'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'roles:',
      '  writer:',
      '    enabled: true',
      '    model: "mock/writer-main"',
      '    allowed_tools: ["read_file", "search_code"]'
    ].join('\n'), 'utf8');

    const fileLines = Array.from({ length: 600 }, (_, i) => `line_${i + 1}: const val_${i + 1} = ${i + 1};`);
    fileLines[99] = '// REGION_A_START';
    fileLines[104] = 'const handlerA = () => 100;';
    fileLines[449] = '// REGION_B_START';
    fileLines[454] = 'const handlerB = () => 450;';
    fs.writeFileSync(path.join(repoDir, 'web', 'big.js'), fileLines.join('\n'), 'utf8');

    let turnIdx = 0;
    const capturedRequests = [];
    const mockFetch = async (_url, init) => {
      turnIdx++;
      const reqBody = JSON.parse(String(init.body));
      capturedRequests.push(reqBody);

      if (turnIdx === 1) {
        return new Response(JSON.stringify({
          id: 'r1',
          model: 'mock/writer-main',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_read_a',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/big.js', start_line: 100, end_line: 110 }) }
                },
                {
                  id: 'call_read_b',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/big.js', start_line: 450, end_line: 460 }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        id: 'r2',
        model: 'mock/writer-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'DONE_WITH_BOTH_REGIONS' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res1 = await runtimeMod.runAgent({
      role: 'writer',
      prompt: 'Inspect region A and region B in web/big.js',
      sessionId: 'parallel-att-1',
      scope: ['web/big.js'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir: sessDir,
      maxTurns: 4,
      fetchFn: mockFetch
    });

    assert.equal(res1.ok, true, `runAgent parallel read failed: ${res1.error}`);
    assert.equal(res1.turns_executed, 2, 'Two parallel read_file calls in 1 turn must take only 1 tool turn + 1 final turn');
    assert.equal(capturedRequests.length, 2);

    const turn2ToolMsgs = capturedRequests[1].messages.filter(m => m.role === 'tool');
    assert.equal(turn2ToolMsgs.length, 2, 'Turn 2 must include both tool results from parallel read_file');
    assert.equal(turn2ToolMsgs[0].tool_call_id, 'call_read_a');
    assert.equal(turn2ToolMsgs[1].tool_call_id, 'call_read_b');
    assert.match(turn2ToolMsgs[0].content, /REGION_A_START/);
    assert.match(turn2ToolMsgs[1].content, /REGION_B_START/);

    assert.ok(Array.isArray(res1.read_ranges) && res1.read_ranges.length === 2, 'runAgent must return captured read_ranges');
    assert.deepEqual(
      res1.read_ranges.map(r => `${r.path}:${r.start_line}-${r.end_line}`),
      ['web/big.js:100-110', 'web/big.js:450-460']
    );

    // 3. Attempt 2 inherits res1.read_ranges cleanly via formatPriorReadContext without re-reading
    const retryInherited = runtimeMod.formatPriorReadContext(res1.read_ranges);
    assert.match(retryInherited, /web\/big\.js:100-110/);
    assert.match(retryInherited, /web\/big\.js:450-460/);
    assert.match(retryInherited, /handlerA/);
    assert.match(retryInherited, /handlerB/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. Verify orchestrator.mjs persists & injects Files Already Read across retries
  const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.match(orchSrc, /formatPriorReadContext/, 'orchestrator.mjs must inject Files Already Read on retry');
  assert.match(orchSrc, /mergeReadRanges/, 'orchestrator.mjs must accumulate read_ranges across retry attempts');

  console.log('✓ All Item 2 retry read-range inheritance & parallel read_file tests passed.');
}

runTests().catch(err => {
  console.error('Item 2 test failed:', err);
  process.exit(1);
});
