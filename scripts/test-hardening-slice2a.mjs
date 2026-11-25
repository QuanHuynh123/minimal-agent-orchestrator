#!/usr/bin/env node
/**
 * SLICE-2a Verification Suite (agent-team/HARDENING_SPEC_V3.2.md §3):
 *   - 100% self-contained synthetic repo in os.tmpdir() (>= 25 modules, NO git show, ZERO project leaks).
 *   - Proves static CODEBASE SKELETON & SYMBOL MAP overflows (+N omitted) while staying 100% identical
 *     across 3 distinct Vietnamese goals (preserving KV-cache prefix invariance).
 *   - Proves GOAL-FOCUSED SYMBOL & IMPORT GRAPH in dynamicSections surfaces the exact 1-hop Python
 *     imported core module (core/storage.py, core/exporter.py, core/scheduler.py) for all 3 Vietnamese
 *     goals even though those core modules contain zero Vietnamese words.
 *   - Proves deduplication vs static skeleton, <= 2500-char cap, prefix-invariant section registration,
 *     and empty dynamicText preservation when a goal has zero keyword matches (no_keyword_hits fallback).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRouterContextParts } from './lib/context-builders.mjs';
import { analyzeTurn1PayloadHashes, splitPromptSectionsForHash } from './lib/prefix-invariant.mjs';

function makeSyntheticOverflowRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-slice2a-repo-'));
  fs.mkdirSync(path.join(repo, 'core'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'bridge'), { recursive: true });

  // Create 8 shared infra modules imported by 20 worker modules (mirroring real codebases where
  // global PageRank puts shared infra at the top of the 3500-char static CODEBASE SKELETON
  // and pushes leaf domain modules like storage/exporter/scheduler into "+N omitted").
  for (let k = 1; k <= 8; k++) {
    const id = String(k).padStart(2, '0');
    const lines = [
      `class SharedInfra${id}:`,
      `\tdef init_subsystem_${id}(self, env, strict=True):`,
      `\t\treturn env`,
      `\tdef read_runtime_flag_${id}(self, key, default=None):`,
      `\t\treturn default`,
      `\tdef emit_diagnostic_${id}(self, level, message):`,
      `\t\treturn (level, message)`,
      ``,
      `def get_infra_client_${id}(name, timeout=10):`,
      `\treturn (name, timeout)`,
      `def format_infra_status_${id}(code, detail=""):`,
      `\treturn f"{code}:{detail}"`,
      ``
    ];
    fs.writeFileSync(path.join(repo, 'core', `infra_${id}.py`), lines.join('\n'), 'utf8');
  }

  const fillerImports = [];
  for (let i = 1; i <= 20; i++) {
    const id = String(i).padStart(2, '0');
    const modName = `worker_${id}`;
    const infraImports = Array.from({ length: 8 }, (_, idx) => {
      const iid = String(idx + 1).padStart(2, '0');
      return `from core.infra_${iid} import SharedInfra${iid}, get_infra_client_${iid}`;
    });
    const lines = [
      ...infraImports,
      '',
      `class PipelineWorker${id}:`,
      `\tdef execute_stage_${id}(self, payload, retries=3):`,
      `\t\treturn payload`,
      ``,
      `def run_worker_${id}(item, flags=None):`,
      `\treturn item`,
      ``
    ];
    fs.writeFileSync(path.join(repo, 'core', `${modName}.py`), lines.join('\n'), 'utf8');
    if (i <= 8) {
      fillerImports.push(`from core.${modName} import run_worker_${id}`);
    }
  }

  // 3 target core business modules: strictly English code, ZERO Vietnamese strings,
  // located 1 Python import hop behind bridge/api.py.
  fs.writeFileSync(
    path.join(repo, 'core', 'storage.py'),
    [
      'class RecordStorage:',
      '\tdef list_records(self, limit=50):',
      '\t\treturn []',
      '\tdef resolve_record_path(self, item_id):',
      '\t\treturn f"/data/{item_id}"',
      '',
      'def purge_entry(item_id, verify_parent=True):',
      '\treturn {"deleted": item_id, "verified": verify_parent}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repo, 'core', 'exporter.py'),
    [
      'class ReportExporter:',
      '\tdef format_summary_csv(self, rows):',
      '\t\treturn "\\n".join(rows)',
      '',
      'def export_report_bundle(report_id, destination):',
      '\treturn {"report_id": report_id, "output": destination}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repo, 'core', 'scheduler.py'),
    [
      'class JobScheduler:',
      '\tdef cancel_scheduled_run(self, job_id):',
      '\t\treturn True',
      '',
      'def schedule_delayed_run(cron_expr, callback_name):',
      '\treturn {"cron": cron_expr, "callback": callback_name}',
      ''
    ].join('\n'),
    'utf8'
  );

  // Bridge layer: matches Vietnamese UI / notification phrases and delegates 1 hop to core/*
  fs.writeFileSync(
    path.join(repo, 'bridge', 'api.py'),
    [
      ...fillerImports,
      'from core.storage import RecordStorage, purge_entry',
      'from core.exporter import ReportExporter, export_report_bundle',
      'from core.scheduler import JobScheduler, schedule_delayed_run',
      '',
      'class BridgeApi:',
      '\tdef remove_saved_record(self, item_id):',
      '\t\t"""UI handler for removing a saved record."""',
      '\t\tlabel = "Lưu Trữ Gần Đây"',
      '\t\tif not item_id:',
      '\t\t\treturn {"ok": False, "section": label, "error": "missing_id"}',
      '\t\tresult = purge_entry(item_id, verify_parent=True)',
      '\t\treturn {"ok": True, "section": label, "result": result}',
      '',
      '\tdef _helper_padding_a(self):',
      '\t\treturn True',
      '',
      '\tdef build_export_archive(self, report_id, destination):',
      '\t\t"""UI handler for exporting a report package."""',
      '\t\tlabel = "Xuất Gói Báo Cáo"',
      '\t\tif not report_id or not destination:',
      '\t\t\treturn {"ok": False, "section": label, "error": "invalid_args"}',
      '\t\tresult = export_report_bundle(report_id, destination)',
      '\t\treturn {"ok": True, "section": label, "result": result}',
      '',
      '\tdef _helper_padding_b(self):',
      '\t\treturn True',
      '',
      '\tdef register_timed_job(self, cron_expr):',
      '\t\t"""UI handler for configuring scheduled execution."""',
      '\t\tlabel = "Đặt Lịch Hẹn Giờ"',
      '\t\tif not cron_expr:',
      '\t\t\treturn {"ok": False, "section": label, "error": "empty_cron"}',
      '\t\tresult = schedule_delayed_run(cron_expr, "daily_sync")',
      '\t\treturn {"ok": True, "section": label, "result": result}',
      ''
    ].join('\n'),
    'utf8'
  );

  return repo;
}

function extractPrintedHeaders(text = '') {
  const out = new Set();
  for (const m of String(text || '').matchAll(/^\[([^\]]+)\]/gm)) {
    const label = m[1].trim();
    if (!label || label.startsWith('... +')) continue;
    out.add(label);
  }
  return out;
}

function extractGoalFocusedSection(dynamicText = '') {
  const secs = splitPromptSectionsForHash(dynamicText);
  return secs.find(s => s.label === 'GOAL-FOCUSED SYMBOL & IMPORT GRAPH') || null;
}

function main() {
  const repo = makeSyntheticOverflowRepo();
  try {
    const cases = [
      {
        name: 'Goal 1 (storage)',
        goal: 'Sửa lỗi xóa mục Lưu Trữ Gần Đây bị báo sai đường dẫn',
        expectedCoreFile: 'core/storage.py',
        expectedSymbol: 'purge_entry'
      },
      {
        name: 'Goal 2 (exporter)',
        goal: 'Sửa lỗi bấm nút Xuất Gói Báo Cáo không sinh tệp đầu ra',
        expectedCoreFile: 'core/exporter.py',
        expectedSymbol: 'export_report_bundle'
      },
      {
        name: 'Goal 3 (scheduler)',
        goal: 'Sửa lỗi chức năng Đặt Lịch Hẹn Giờ không kích hoạt đúng thời điểm',
        expectedCoreFile: 'core/scheduler.py',
        expectedSymbol: 'schedule_delayed_run'
      }
    ];

    const results = [];
    for (const c of cases) {
      const parts = buildRouterContextParts(['bridge', 'core'], repo, 200, c.goal, [], {
        includeConventions: false,
        staticRepoMap: true,
        snippetContextLines: 10
      });

      // 1. Static skeleton MUST overflow (+N omitted) and hide the target core module
      assert.match(
        parts.staticText,
        /additional files omitted to fit context budget/,
        `${c.name}: synthetic repo must overflow static 3500-char CODEBASE SKELETON`
      );
      const staticHeaders = extractPrintedHeaders(parts.staticText);
      assert.equal(
        staticHeaders.has(c.expectedCoreFile),
        false,
        `${c.name}: ${c.expectedCoreFile} should be hidden in static skeleton so test proves dynamic graph recovery`
      );

      // 2. Dynamic GOAL-FOCUSED SYMBOL & IMPORT GRAPH must exist and surface the 1-hop core module
      const focusedSec = extractGoalFocusedSection(parts.dynamicText);
      assert.ok(focusedSec, `${c.name}: dynamicText must contain GOAL-FOCUSED SYMBOL & IMPORT GRAPH section`);
      const focusedBody = focusedSec.text.replace(/^GOAL-FOCUSED SYMBOL & IMPORT GRAPH:\s*/i, '');
      assert.ok(
        focusedBody.length <= 2500,
        `${c.name}: GOAL-FOCUSED SYMBOL & IMPORT GRAPH body must stay <= 2500 chars, got ${focusedBody.length}`
      );
      assert.ok(
        focusedSec.text.includes(`[${c.expectedCoreFile}]`),
        `${c.name}: expected [${c.expectedCoreFile}] in GOAL-FOCUSED SYMBOL & IMPORT GRAPH, got:\n${focusedSec.text}`
      );
      assert.ok(
        focusedSec.text.includes(c.expectedSymbol),
        `${c.name}: expected symbol ${c.expectedSymbol} in GOAL-FOCUSED SYMBOL & IMPORT GRAPH`
      );
      // Verify the goal-specific 1-hop module ranks ABOVE the other 2 sibling modules imported by bridge/api.py
      const targetPos = focusedSec.text.indexOf(`[${c.expectedCoreFile}]`);
      for (const other of cases) {
        if (other.expectedCoreFile === c.expectedCoreFile) continue;
        const otherPos = focusedSec.text.indexOf(`[${other.expectedCoreFile}]`);
        if (otherPos !== -1) {
          assert.ok(
            targetPos < otherPos,
            `${c.name}: expected [${c.expectedCoreFile}] (pos ${targetPos}) to rank ahead of unrelated [${other.expectedCoreFile}] (pos ${otherPos})`
          );
        }
      }

      // 3. No file already printed in static skeleton may be duplicated in GOAL-FOCUSED SYMBOL & IMPORT GRAPH
      const focusedHeaders = extractPrintedHeaders(focusedSec.text);
      for (const h of focusedHeaders) {
        assert.equal(
          staticHeaders.has(h),
          false,
          `${c.name}: [${h}] was already printed in static skeleton and must NOT be duplicated`
        );
      }

      results.push({ ...c, parts });
      console.log(`PASS  SLICE-2a ${c.name}: surfaced [${c.expectedCoreFile}] (${c.expectedSymbol}) across 1-hop import`);
    }

    // 4. Static prefix MUST remain 100% byte-identical across all 3 goals
    assert.equal(results[0].parts.staticText, results[1].parts.staticText, 'staticText must be identical across Goal 1 and Goal 2');
    assert.equal(results[1].parts.staticText, results[2].parts.staticText, 'staticText must be identical across Goal 2 and Goal 3');

    // 5. Prefix-invariance check with exact goal-planner.mjs section layout
    const buildPayload = (goal, parts) => ({
      model: 'mock-router',
      tools: null,
      messages: [
        { role: 'system', content: 'You are the router.' },
        {
          role: 'user',
          content: [
            'ALLOWED DIRECTORIES: [bridge, core]',
            'AVAILABLE SQUAD MODELS: [mock-writer]',
            parts.staticText,
            'INSTRUCTION (1-TURN DIRECT PLAN): Return JSON tasks.',
            parts.dynamicText,
            `USER GOAL:\n"${goal}"`
          ].join('\n\n')
        }
      ]
    });

    const diag = analyzeTurn1PayloadHashes(
      buildPayload(results[0].goal, results[0].parts),
      buildPayload(results[1].goal, results[1].parts)
    );
    assert.equal(diag.volatile_before_static.length, 0, `No volatile section may precede static sections: ${JSON.stringify(diag.volatile_before_static)}`);
    const staticSkel = diag.user_subsections.find(s => s.label === 'CODEBASE SKELETON & SYMBOL MAP');
    const instrSub = diag.user_subsections.find(s => s.label === 'INSTRUCTION');
    const focusedSub = diag.user_subsections.find(s => s.label === 'GOAL-FOCUSED SYMBOL & IMPORT GRAPH');
    assert.equal(staticSkel?.equal, true, 'Static CODEBASE SKELETON & SYMBOL MAP must stay hash-identical');
    assert.equal(instrSub?.equal, true, 'INSTRUCTION must stay hash-identical (GOAL-FOCUSED section must not bleed into INSTRUCTION)');
    assert.ok(focusedSub, 'prefix-invariant must recognize GOAL-FOCUSED SYMBOL & IMPORT GRAPH as a distinct subsection');
    assert.ok(
      focusedSub.volatile_reasons.includes('query_focused_symbol_graph') || focusedSub.equal === true,
      `Unexpected volatile_reasons for GOAL-FOCUSED section: ${JSON.stringify(focusedSub.volatile_reasons)}`
    );

    // 6. Zero-keyword-hit goal must keep dynamicText empty so goal-planner no_keyword_hits fallback still triggers
    const noHitParts = buildRouterContextParts(['bridge', 'core'], repo, 200, '# nonexistent_quantum_token_999', [], {
      includeConventions: false,
      staticRepoMap: true,
      snippetContextLines: 10
    });
    assert.equal(noHitParts.dynamicText, '', 'Zero-keyword-hit goal must keep dynamicText empty for no_keyword_hits fallback');

    console.log('PASS  SLICE-2a prefix invariance, deduplication, 2500-char cap & no_keyword_hits preservation');
    console.log('test-hardening-slice2a.mjs: ALL PASSED');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main();
