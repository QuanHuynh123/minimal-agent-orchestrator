#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decomposeGoal } from './goal-planner.mjs';
import { loadMergedPolicy, loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import { resolveSquadRoster, resolveWriterHubWorkflow } from './lib/risk-policy.mjs';
import { loadTaskYaml } from './lib/task-persistence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = path.resolve(TEAM_DIR, '..');

export function summarizeWorkflowSteps(workflow = [], defaultWriterModel = null) {
  const steps = Array.isArray(workflow) ? workflow : [];
  if (steps.length === 0) {
    return {
      steps: [{ step: 1, role: 'writer', action: 'apply_patch', model: defaultWriterModel || 'primary-writer', note: 'auto-collapsed 1-step Writer' }],
      spec_steps: 0,
      writer_steps: 1,
      is_single_writer_no_spec: true
    };
  }
  const specSteps = steps.filter(s => s?.action === 'draft_spec');
  const writerSteps = steps.filter(s => s?.action === 'apply_patch');
  return {
    steps: steps.map(s => ({
      step: s.step,
      role: s.role,
      action: s.action,
      model: s.model,
      sub_scope: Array.isArray(s.sub_scope) ? s.sub_scope : []
    })),
    spec_steps: specSteps.length,
    writer_steps: writerSteps.length,
    is_single_writer_no_spec: specSteps.length === 0 && writerSteps.length === 1
  };
}

export async function runDryRunRoutingReplay(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const configDir = options.configDir ? path.resolve(options.configDir) : resolveConfigDir();
  const teamConfig = loadMergedTeamConfig({ configDir });
  const policyConfig = loadMergedPolicy({ configDir });

  let beforeTask = options.beforeTask || null;
  if (!beforeTask && options.taskFile) {
    const loaded = loadTaskYaml(path.resolve(options.taskFile));
    beforeTask = loaded?.task && typeof loaded.task === 'object' ? loaded.task : loaded;
  }

  const goal = String(options.goal || beforeTask?.goal || '').trim();
  if (!goal) {
    return { ok: false, error: 'Missing goal or taskFile for dryRun routing replay.' };
  }

  const roster = resolveSquadRoster(teamConfig, beforeTask || { goal }, policyConfig);
  const beforeRawWf = beforeTask?.writer_hub_workflow || [];
  const beforeSummary = summarizeWorkflowSteps(beforeRawWf, roster.backendWriterModel);

  const tmpSessions = options.sessionsDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'td-dryrun-replay-'));
  try {
    const planRes = await decomposeGoal(goal, {
      dryRun: true,
      oneTurnMode: options.oneTurnMode ?? true,
      repoRoot,
      configDir,
      sessionsDir: options.sessionsDir || tmpSessions,
      ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {})
    });

    if (!planRes.ok || !Array.isArray(planRes.tasks) || planRes.tasks.length === 0) {
      return {
        ok: false,
        error: planRes.error || 'decomposeGoal dryRun failed',
        planRes
      };
    }

    const firstTask = planRes.tasks[0];
    const recomputedWf = Array.isArray(firstTask.writer_hub_workflow)
      ? firstTask.writer_hub_workflow
      : resolveWriterHubWorkflow(firstTask, teamConfig, policyConfig);
    const afterRoster = resolveSquadRoster(teamConfig, firstTask, policyConfig);
    const afterSummary = summarizeWorkflowSteps(recomputedWf, afterRoster.backendWriterModel);

    return {
      ok: true,
      goal,
      router_mode: planRes.router_mode || null,
      model_used: planRes.model_used || null,
      usage: planRes.usage || null,
      before: {
        task_id: beforeTask?.task_id || null,
        kind: beforeTask?.kind || null,
        declared_mode: beforeTask?.declared_mode || null,
        mode: beforeTask?.mode || null,
        risk_level: beforeTask?.risk_level || null,
        scope: beforeTask?.scope || [],
        writer_hub_workflow: beforeRawWf,
        ...beforeSummary
      },
      after: {
        task_id: firstTask.task_id,
        kind: firstTask.kind,
        kind_source: firstTask.kind_source,
        declared_mode: firstTask.declared_mode,
        mode: firstTask.mode,
        risk_level: firstTask.risk_level,
        scope: firstTask.scope,
        writer_hub_workflow: recomputedWf,
        ...afterSummary
      }
    };
  } finally {
    if (tmpSessions) {
      fs.rmSync(tmpSessions, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let taskFile = null;
  let goal = null;
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task-file' && args[i + 1]) { taskFile = args[++i]; }
    else if (args[i] === '--goal' && args[i + 1]) { goal = args[++i]; }
    else if (args[i] === '--json') { jsonOut = true; }
  }
  if (!taskFile && !goal) {
    taskFile = path.resolve(TEAM_DIR, 'benchmarks', 'fixtures', 'preset-pills-task.yaml');
  }

  runDryRunRoutingReplay({ taskFile, goal }).then(res => {
    if (jsonOut) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok) {
      console.error('[Replay ERROR]', res.error);
      process.exit(1);
    } else {
      console.log('=== dryRun Routing Replay: BEFORE vs AFTER ===');
      console.log(`Goal: ${res.goal.slice(0, 120)}${res.goal.length > 120 ? '...' : ''}`);
      console.log(`Router pass: mode=${res.router_mode}, model=${res.model_used || 'n/a'}`);
      console.log(`BEFORE: mode=${res.before.mode} | kind=${res.before.kind} | spec_steps=${res.before.spec_steps} | writer_steps=${res.before.writer_steps}`);
      for (const s of res.before.steps) {
        console.log(`  - step ${s.step}: [${s.role}] ${s.action} (${s.model})`);
      }
      console.log(`AFTER : mode=${res.after.mode} | kind=${res.after.kind} (${res.after.kind_source}) | spec_steps=${res.after.spec_steps} | writer_steps=${res.after.writer_steps} | single_writer_no_spec=${res.after.is_single_writer_no_spec}`);
      for (const s of res.after.steps) {
        console.log(`  - step ${s.step}: [${s.role}] ${s.action} (${s.model})${s.note ? ` [${s.note}]` : ''}`);
      }
    }
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
