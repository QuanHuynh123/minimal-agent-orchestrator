#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverBackendContractFiles,
  extractBackendContractSummary,
  extractBackendRoutesFromCode,
  extractGoalDataSchemaSamples,
  verifyFrontendRouteContract
} from './lib/contract-context.mjs';
import { buildDraftSpecPrompts } from './orchestrator/spec-and-conflict.mjs';
import {
  callModelEndpoint,
  isModelCircuitBroken,
  resetCircuitBreaker
} from '../runtime/provider-gateway.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing v3.2.4 Contract Bridge, Schema Samples, & Stream Silence Watchdog...\n');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-v324-contracts-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'web'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });

    const serverSrc = [
      'export function startServer(app) {',
      "  app.get('/api/health', (req, res) => {",
      "    res.json({ ok: true, status: 'ready' });",
      '  });',
      "  app.post('/api/creator/generate', (req, res) => {",
      '    const { prompt, style } = req.body || {};',
      '    return sendJson(res, 200, { ok: true, project: { id: 1 } });',
      '  });',
      "  app.get('/api/skills/:id', (req, res) => {",
      '    res.json({ ok: true, id: req.params.id });',
      '  });',
      '}'
    ].join('\n');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'server.mjs'), serverSrc, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'web', 'app.js'), 'console.log("ui");\n', 'utf8');

    const policyCfg = {
      policy: {
        scope_control: {
          allowed_dirs: ['src/', 'web/', 'tests/'],
          context_exclude: ['catalog/']
        }
      }
    };

    // 1. CASE-10: discoverBackendContractFiles & extractBackendContractSummary
    const discovered = discoverBackendContractFiles(
      { scope: ['web/app.js'], goal: 'Implement generate button calling backend API' },
      tmpRepo,
      policyCfg,
      { recentFiles: new Set(['src/server.mjs']) }
    );
    assert.deepEqual(discovered, ['src/server.mjs']);

    const summary = extractBackendContractSummary(discovered, tmpRepo, { maxChars: 2400 });
    assert.ok(summary.includes('[GET] /api/health'), 'Summary must include /api/health');
    assert.ok(summary.includes('[POST] /api/creator/generate'), 'Summary must include /api/creator/generate');
    assert.ok(summary.includes('prompt') && summary.includes('style'), 'Summary must surface request body keys');
    assert.ok(summary.includes('startServer'), 'Summary must surface exported symbol');

    // 2. CASE-10: verifyFrontendRouteContract (static match vs mismatch vs template literal vs RPC repo skip)
    const badDiff = [
      'diff --git a/web/app.js b/web/app.js',
      '+++ b/web/app.js',
      "+  await fetch('/api/generate?dry=1', { method: 'POST' });",
      "+  await fetch(`/api/skills/${skillId}`);"
    ].join('\n');
    const badCheck = verifyFrontendRouteContract({
      modifiedFiles: ['web/app.js'],
      diffText: badDiff,
      repoRoot: tmpRepo,
      policyConfig: policyCfg
    });
    assert.equal(badCheck.ok, false, 'Mismatched static /api/generate must fail RouteContractCheck');
    assert.deepEqual(badCheck.mismatches, ['/api/generate']);

    const goodDiff = [
      'diff --git a/web/app.js b/web/app.js',
      '+++ b/web/app.js',
      "+  await fetch('/api/creator/generate', { method: 'POST' });",
      "+  await fetch('/api/skills/demo-123?raw=1');",
      "+  await fetch(`/api/dynamic/${anything}`);"
    ].join('\n');
    const goodCheck = verifyFrontendRouteContract({
      modifiedFiles: ['web/app.js'],
      diffText: goodDiff,
      repoRoot: tmpRepo,
      policyConfig: policyCfg
    });
    assert.equal(goodCheck.ok, true, 'Exact + param + template literal calls must pass RouteContractCheck');

    // Non-HTTP repo skip (0 /api/ backend routes -> zero false positives)
    const rpcRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-v324-rpc-'));
    try {
      fs.mkdirSync(path.join(rpcRepo, 'src'), { recursive: true });
      fs.mkdirSync(path.join(rpcRepo, 'web'), { recursive: true });
      fs.writeFileSync(path.join(rpcRepo, 'src', 'bridge.mjs'), 'export function getItems() { return []; }\n', 'utf8');
      const rpcCheck = verifyFrontendRouteContract({
        modifiedFiles: ['web/app.js'],
        diffText: badDiff,
        repoRoot: rpcRepo,
        policyConfig: { policy: { scope_control: { allowed_dirs: ['src/', 'web/'] } } }
      });
      assert.equal(rpcCheck.ok, true);
      assert.equal(rpcCheck.skipped, true);
      assert.equal(rpcCheck.reason, 'no_backend_http_routes');
    } finally {
      fs.rmSync(rpcRepo, { recursive: true, force: true });
    }

    // Check framework-agnostic route extraction styles
    const multiRoutes = extractBackendRoutesFromCode([
      "router.use('/api/v2/items', itemsRouter);",
      "@app.post('/api/v2/jobs')",
      "if (url.pathname === '/api/v2/ping') {}"
    ].join('\n'));
    assert.ok(multiRoutes.some(r => r.path === '/api/v2/items' && r.isPrefix === true));
    assert.ok(multiRoutes.some(r => r.path === '/api/v2/jobs' && r.method === 'POST'));
    assert.ok(multiRoutes.some(r => r.path === '/api/v2/ping'));

    // 3. CASE-15: extractGoalDataSchemaSamples (bounded lines + bytes, secret & binary rejection, volatile prompt placement)
    const bigLines = Array.from({ length: 60 }, (_, idx) => JSON.stringify({ repo_full_name: `owner/skill-${idx}`, stars: idx + 1 }));
    fs.writeFileSync(path.join(tmpRepo, 'catalog', 'skills.json'), bigLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'catalog', 'secret.json'), '{"api_key":"supersecret"}\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, '.env.json'), '{"token":"abc"}\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'catalog', 'bin.json'), Buffer.from([0x7b, 0x00, 0x7d]));

    const minifiedRow = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ repo_full_name: `u/r${i}`, tag: 'x'.repeat(20) })) });
    fs.writeFileSync(path.join(tmpRepo, 'catalog', 'minified.json'), minifiedRow, 'utf8');

    const schemaRes = extractGoalDataSchemaSamples({
      title: 'Fix gallery parser',
      goal: 'Read catalog/skills.json and catalog/minified.json plus .env.json and catalog/bin.json and ../outside.json',
      scope: ['src/server.mjs']
    }, tmpRepo, { maxFiles: 3, maxLines: 30, maxBytesPerFile: 1024 });

    assert.deepEqual(schemaRes.files, ['catalog/skills.json', 'catalog/minified.json'], 'Must skip .env.json, binary, and path traversal');
    assert.ok(schemaRes.text.includes('repo_full_name'), 'Sample must reveal real JSON key');
    assert.ok(schemaRes.text.includes('truncated minified line'), 'Minified JSON line must be safely capped');

    // Secret keyword inside path must be filtered by isForbiddenAttachment
    const secretOnly = extractGoalDataSchemaSamples({
      goal: 'Check catalog/secret.json fields',
      scope: ['src/server.mjs']
    }, tmpRepo);
    assert.deepEqual(secretOnly.files, []);

    // Verify VOLATILE placement before GOAL in buildDraftSpecPrompts (preserves cacheable prefix before context/tail)
    const { userMessage } = buildDraftSpecPrompts({
      wfStep: { step: 1, role: 'designer', spec_focus: 'ui_ux_and_visual_audit' },
      task: { task_id: 'T-CACHE', goal: 'Update UI using catalog/skills.json', scope: ['web/app.js'] },
      specScope: ['web/app.js'],
      specScopedContext: 'STATIC_FILE_WINDOW_MARKER',
      backendApiContract: summary,
      dataSchemaSamples: schemaRes.text
    });
    const idxStatic = userMessage.indexOf('STATIC_FILE_WINDOW_MARKER');
    const idxContract = userMessage.indexOf('BACKEND API & ROUTE CONTRACT');
    const idxSchema = userMessage.indexOf('REFERENCED DATA SCHEMA SAMPLES');
    const idxGoal = userMessage.indexOf('GOAL:');
    assert.ok(idxStatic >= 0 && idxContract > idxStatic && idxSchema > idxContract && idxGoal > idxSchema, 'Contract and schema samples must sit between file contents and GOAL (volatile tail)');

    // 4. CASE-13: Stream silence watchdog, mock response.text() fallback, & 2-strike CB discipline
    resetCircuitBreaker();
    try {
      // 4a. Stalled stream after partial data cuts at silenceTimeoutMs and falls back without tripping CB on 1st stall
      let primaryStalls = 0;
      const stalledStreamFetch = async (_url, init) => {
        const req = JSON.parse(String(init.body));
        if (req.model === 'stalling-stream-model') {
          primaryStalls += 1;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode('data: {"model":"stalling-stream-model","choices":[{"delta":{"content":"hel"}}]}\n\n'));
              init.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                try { controller.error(err); } catch {}
              }, { once: true });
            }
          });
          return {
            ok: true,
            status: 200,
            body: stream,
            text: async () => ''
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            model: req.model,
            choices: [{ message: { content: 'FALLBACK_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })
        };
      };

      const stall1 = await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'stalling-stream-model',
        fallbackModel: 'fast-fallback',
        stream: true,
        timeoutMs: 5000,
        silenceTimeoutMs: 60,
        firstByteTimeoutMs: 250,
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: stalledStreamFetch
      });
      assert.equal(stall1.ok, true);
      assert.equal(stall1.fallback_activated, true);
      assert.equal(stall1.actual_model, 'fast-fallback');
      assert.ok(stall1.fallback_reason.includes('Stream stalled'), `Expected silence reason, got: ${stall1.fallback_reason}`);
      assert.equal(isModelCircuitBroken('stalling-stream-model'), false, 'Single transient stream stall must NOT trip 10m Circuit Breaker');

      // 2nd consecutive stall trips CB -> 3rd call skips primary directly
      const stall2 = await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'stalling-stream-model',
        fallbackModel: 'fast-fallback',
        stream: true,
        timeoutMs: 5000,
        silenceTimeoutMs: 60,
        firstByteTimeoutMs: 250,
        messages: [{ role: 'user', content: 'hi again' }],
        fetchFn: stalledStreamFetch
      });
      assert.equal(stall2.ok, true);
      assert.equal(isModelCircuitBroken('stalling-stream-model'), true, '2 consecutive stream stalls must trip Circuit Breaker');

      const stall3 = await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'stalling-stream-model',
        fallbackModel: 'fast-fallback',
        stream: true,
        timeoutMs: 5000,
        silenceTimeoutMs: 60,
        messages: [{ role: 'user', content: 'third' }],
        fetchFn: stalledStreamFetch
      });
      assert.equal(stall3.ok, true);
      assert.equal(primaryStalls, 2, '3rd call must bypass circuit-broken stalling primary');

      // 4b. Thinking model slow first byte (> silenceTimeoutMs, < firstByteTimeoutMs) must NOT be cut prematurely
      const thinkingFetch = async () => {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            setTimeout(() => {
              controller.enqueue(enc.encode('data: {"model":"thinking-model","choices":[{"delta":{"content":"THINK_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
              controller.close();
            }, 90);
          }
        });
        return { ok: true, status: 200, body: stream, text: async () => '' };
      };
      const thinkRes = await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'thinking-model',
        stream: true,
        timeoutMs: 5000,
        silenceTimeoutMs: 45,
        firstByteTimeoutMs: 400,
        messages: [{ role: 'user', content: 'think' }],
        fetchFn: thinkingFetch
      });
      assert.equal(thinkRes.ok, true);
      assert.equal(thinkRes.content, 'THINK_OK');
    } finally {
      resetCircuitBreaker();
    }

    // 5. CASE-12, 14, 16, 17: Neutral role prompt checks
    const routerMd = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'router.md'), 'utf8');
    const archMd = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'architect.md'), 'utf8');
    const writerMd = fs.readFileSync(path.join(TEAM_DIR, 'roles', 'writer.md'), 'utf8');
    assert.ok(routerMd.includes('acceptance_criteria') && routerMd.includes('goal'));
    assert.ok(archMd.includes('[SCOPE_GAP]') && archMd.includes('route'));
    assert.ok(writerMd.includes('Schema') && writerMd.includes('thư mục tạm'));

    console.log('✓ All v3.2.4 Contract Bridge, Schema Samples, Watchdog & Prompt Guardrail tests passed!');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('v3.2.4 test failed:', err);
  process.exit(1);
});
