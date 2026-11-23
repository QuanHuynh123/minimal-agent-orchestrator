#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildScopedFilesContextWithMeta,
  sliceContentByKeywordsWithMeta
} from './lib/context-builders.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';
import { formatPriorReadContext, mergeReadRanges, runAgent } from '../runtime/index.mjs';
import { estimateTextTokens } from '../runtime/provider-gateway.mjs';
import { executeTool } from '../runtime/tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Item 5: Writer context safety limits (hash-verified prior reads, id>fn>class priority & references_truncated, parallel read_file byte cap)...\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ctx-safety-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const cfgDir = path.join(tmpDir, 'cfg');
    const sessDir = path.join(tmpDir, 'sess');
    fs.mkdirSync(path.join(repoDir, 'web'), { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(sessDir, { recursive: true });

    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "ctx-safety-test"',
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
      '    allowed_tools: ["read_file"]'
    ].join('\n'), 'utf8');

    // =========================================================================
    // 5(a): FILES ALREADY READ safety cap + disk file hash verification
    // =========================================================================
    const fileA = path.join(repoDir, 'web', 'sample.js');
    const originalLines = Array.from({ length: 80 }, (_, i) => `const line_${i + 1} = "${'a'.repeat(40)}";`);
    originalLines[9] = 'const intactMarker = "UNMODIFIED_ON_DISK";';
    const originalRaw = originalLines.join('\n');
    fs.writeFileSync(fileA, originalRaw, 'utf8');
    const expectedHash = crypto.createHash('sha256').update(originalRaw, 'utf8').digest('hex');

    const readRes = await executeTool('read_file', { path: 'web/sample.js', start_line: 1, end_line: 30 }, {
      role: 'writer',
      sessionId: 'hash-test',
      repoRoot: repoDir,
      allowedTools: ['read_file'],
      allowedScope: ['web/sample.js'],
      allowedDirs: ['web/'],
      protectedFiles: []
    });
    assert.equal(readRes.ok, true, 'read_file must succeed');
    assert.equal(readRes.file_hash, expectedHash, 'toolReadFile must return SHA-256 file_hash');

    const validRange = [{
      path: readRes.file,
      start_line: readRes.start_line,
      end_line: readRes.end_line,
      file_hash: readRes.file_hash,
      content: readRes.content
    }];
    const freshCtx = formatPriorReadContext(validRange, { repoRoot: repoDir, maxBytes: 4000, maxTokens: 1500 });
    assert.match(freshCtx, /UNMODIFIED_ON_DISK/, 'Matching disk hash must reuse prior read excerpt');

    // Enforce byte & token safety cap
    const extraBigRange = [{
      path: 'web/sample.js',
      start_line: 1,
      end_line: 80,
      file_hash: expectedHash,
      content: originalLines.map((l, idx) => `${idx + 1}: ${l}`).join('\n')
    }];
    const cappedCtx = formatPriorReadContext(extraBigRange, { repoRoot: repoDir, maxBytes: 900, maxTokens: 320 });
    assert.ok(Buffer.byteLength(cappedCtx, 'utf8') <= 1050, `Expected capped prior-read bytes <= 1050, got ${Buffer.byteLength(cappedCtx, 'utf8')}`);
    assert.ok(estimateTextTokens(cappedCtx) <= 420, `Expected capped prior-read tokens <= 420, got ${estimateTextTokens(cappedCtx)}`);

    // Modify disk file -> stale excerpt MUST NOT be reused!
    const modifiedLines = [...originalLines];
    modifiedLines[9] = 'const intactMarker = "MODIFIED_ON_DISK";';
    fs.writeFileSync(fileA, modifiedLines.join('\n'), 'utf8');

    const staleCtx = formatPriorReadContext(validRange, { repoRoot: repoDir, maxBytes: 4000, maxTokens: 1500 });
    assert.doesNotMatch(staleCtx, /UNMODIFIED_ON_DISK/, 'Modified disk file must invalidate stale prior-read excerpt lines');
    assert.match(staleCtx, /STALE/i, 'Stale prior-read range must emit clear STALE warning instead of outdated lines');

    // =========================================================================
    // 5(b): Smart Window reference priority (id > function/def > class) & references_truncated
    // =========================================================================
    const swLines = Array.from({ length: 1400 }, (_, i) => `// pad_${i + 1} ${'z'.repeat(28)}`);
    // Seed block around lines 60..66 (outside 30-line header anchor)
    swLines[59] = '<div id="alpha-ctrl-target" class="alpha-panel-tile">panelAlphaTarget</div>';
    swLines[60] = 'function handleAlphaAction(v) { return v + 1; }';
    swLines[61] = 'const seedNote = "panelAlphaTarget_seed";';

    // Distant Class ref at lines 350..351 (lowest priority)
    swLines[349] = "// REF_CLASS_REGION";
    swLines[350] = "document.body.classList.add('alpha-panel-tile');";
    // Make multiple hits across nearby block? Keep separate distant anchors so each window has >=35 lines buffer
    // Distant Fn ref at lines 700..701 (middle priority)
    swLines[699] = "// REF_FN_REGION";
    swLines[700] = "const fnOut = handleAlphaAction(42);";
    // Distant ID ref at lines 1050..1051 (highest priority)
    swLines[1049] = "// REF_ID_REGION";
    swLines[1050] = "const idNode = document.getElementById('alpha-ctrl-target');";

    const swText = swLines.join('\n');

    // Case 1: tight budget fitting header/tail + seed + 1 ref window -> ID MUST win over FN and CLASS!
    const tier1 = sliceContentByKeywordsWithMeta(swText, ['panelAlphaTarget'], 5000, 15);
    assert.equal(tier1.windowMode, 'smart');
    assert.equal(tier1.referencesTruncated, true, 'Truncated reference list must set referencesTruncated=true');
    assert.match(tier1.text, /REF_ID_REGION/, 'Highest-priority `id` reference MUST be selected first when budget allows only 1 ref window');
    assert.doesNotMatch(tier1.text, /REF_FN_REGION/, '`function/def` reference must yield to higher-priority `id` reference');
    assert.doesNotMatch(tier1.text, /REF_CLASS_REGION/, 'Lowest-priority `class` reference must be dropped before `id`');

    // Case 2: budget fitting seed + 2 ref windows (too small for all 3) -> ID and FN MUST beat CLASS!
    const tier2 = sliceContentByKeywordsWithMeta(swText, ['panelAlphaTarget'], 6200, 15);
    assert.equal(tier2.windowMode, 'smart');
    assert.equal(tier2.referencesTruncated, true, 'Dropping even the class ref window must set referencesTruncated=true');
    assert.match(tier2.text, /REF_ID_REGION/, '`id` reference must be included');
    assert.match(tier2.text, /REF_FN_REGION/, '`function/def` reference MUST beat `class` reference');
    assert.doesNotMatch(tier2.text, /REF_CLASS_REGION/, '`class` reference must have lowest priority below `function/def`');

    // Case 3: generous budget fitting ALL ref windows -> referencesTruncated=false!
    const tierAll = sliceContentByKeywordsWithMeta(swText, ['panelAlphaTarget'], 16000, 15);
    assert.match(tierAll.text, /REF_ID_REGION/);
    assert.match(tierAll.text, /REF_FN_REGION/);
    assert.match(tierAll.text, /REF_CLASS_REGION/);
    assert.equal(tierAll.referencesTruncated, false, 'When all reference windows fit, referencesTruncated must be false');

    // buildScopedFilesContextWithMeta + recordTaskStep + orchestrator wiring
    const swFilePath = path.join(repoDir, 'web', 'prioritized.html');
    fs.writeFileSync(swFilePath, swText, 'utf8');
    const scopedTight = buildScopedFilesContextWithMeta(['web/prioritized.html'], repoDir, {
      title: 'Update panelAlphaTarget',
      goal: 'Adjust panelAlphaTarget layout'
    }, { perFileBudgetBytes: 5800 });
    assert.equal(scopedTight.referencesTruncated, true, 'buildScopedFilesContextWithMeta must bubble up referencesTruncated');

    const fakeTask = { task_id: 'T-SAFETY-TELEM', steps: [] };
    const stepRec = recordTaskStep(fakeTask, {
      role: 'writer',
      action: 'apply_patch',
      references_truncated: scopedTight.referencesTruncated
    }, { skipJsonl: true });
    assert.equal(stepRec.references_truncated, true, 'recordTaskStep must persist references_truncated in steps[]');

    const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
    assert.match(orchSrc, /references_truncated/, 'orchestrator.mjs must record references_truncated in steps[]');
    assert.match(orchSrc, /formatPriorReadContext\([^)]*repoRoot/, 'orchestrator.mjs must pass repoRoot to formatPriorReadContext for disk hash check');

    // =========================================================================
    // 5(c): Parallel read_file ordering (1-to-1 tool_call_id) + batch total byte cap
    // =========================================================================
    const bigLines = Array.from({ length: 120 }, (_, i) => `const item_${i + 1} = "${'b'.repeat(45)}";`);
    fs.writeFileSync(path.join(repoDir, 'web', 'batch.js'), bigLines.join('\n'), 'utf8');

    let turnIdx = 0;
    const seenRequests = [];
    const batchFetch = async (_url, init) => {
      turnIdx++;
      seenRequests.push(JSON.parse(String(init.body)));
      if (turnIdx === 1) {
        return new Response(JSON.stringify({
          id: 't1',
          model: 'mock/writer-main',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c_batch_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/batch.js', start_line: 1, end_line: 12 }) } },
                { id: 'c_batch_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/batch.js', start_line: 30, end_line: 42 }) } },
                { id: 'c_batch_3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/batch.js', start_line: 70, end_line: 82 }) } }
              ]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 't2',
        model: 'mock/writer-main',
        choices: [{ index: 0, message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const BATCH_CAP = 1400;
    const agentRes = await runAgent({
      role: 'writer',
      prompt: 'Inspect 3 slices of web/batch.js',
      sessionId: 'batch-cap-test',
      scope: ['web/batch.js'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir: sessDir,
      maxTurns: 4,
      maxBatchReadBytes: BATCH_CAP,
      fetchFn: batchFetch
    });

    assert.equal(agentRes.ok, true, `runAgent failed: ${agentRes.error}`);
    assert.equal(seenRequests.length, 2);
    const toolMsgs = seenRequests[1].messages.filter(m => m.role === 'tool');
    assert.deepEqual(
      toolMsgs.map(m => m.tool_call_id),
      ['c_batch_1', 'c_batch_2', 'c_batch_3'],
      'Parallel read_file tool messages MUST preserve exact tool_call_id order 1-to-1'
    );

    const parsedPayloads = toolMsgs.map(m => JSON.parse(m.content));
    const totalBatchContentBytes = parsedPayloads.reduce((acc, p) => acc + Buffer.byteLength(String(p.content || ''), 'utf8'), 0);
    assert.ok(
      totalBatchContentBytes <= BATCH_CAP,
      `Combined read_file content bytes (${totalBatchContentBytes}) across 1-turn batch MUST stay <= maxBatchReadBytes (${BATCH_CAP})`
    );
    assert.equal(parsedPayloads[2].batch_truncated, true, 'Overflowing parallel read_file call must report batch_truncated=true');
    assert.equal(parsedPayloads[0].ok, true);
    assert.equal(parsedPayloads[2].ok, true);

    // Ensure truncated batch call is NOT marked as fully read up to end_line=82
    const overflowRange = (agentRes.read_ranges || []).find(r => r.start_line === 70);
    if (overflowRange) {
      assert.ok(overflowRange.end_line < 82, 'Batch-truncated range must not mark unread tail lines as already read');
    }

    console.log('[PASS] test-writer-context-safety-limits');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('[FAIL] test-writer-context-safety-limits:', err);
  process.exit(1);
});
