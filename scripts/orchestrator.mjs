#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { applyEdits } from './applier.mjs';
import { commitDone, isCleanWorktree, rollback, snapshot } from './git-guard.mjs';
import { hashString, validateFast, validateSuite } from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

const LOCK_FILE = path.resolve(TEAM_DIR, '.orchestrator.lock');
const STATE_FILE = path.resolve(TEAM_DIR, 'state', 'task-state.json');
const REPORT_FILE = path.resolve(TEAM_DIR, 'state', 'morning-report.md');
const ACTIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const ARCHIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');

// 1. Lock File Management (Opus Feedback)
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      console.warn(`[Orchestrator] Lock file exists (PID: ${lockData.pid}, Started: ${lockData.started_at}).`);
      // Optional check if process is still alive could be added here
      return false;
    } catch {
      // Corrupt lock file, overwrite
    }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
  return true;
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
}

// 2. Atomic State Management (Opus Feedback)
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      version: '2.0',
      active_tasks: [],
      completed_tasks: [],
      blocked_tasks: [],
      metrics: { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: '2.0', active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
  }
}

function saveStateAtomic(state) {
  const tmpPath = `${STATE_FILE}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, STATE_FILE);
}

// 3. Load Configurations
function loadYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

const teamConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'team.yaml')) || {};
const projectConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'project.yaml')) || {};
const policyConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'policy.yaml')) || {};

// 4. Local 9Router API Helper
async function call9Router(model, systemPrompt, userMessage, maxTokens = 4096) {
  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = process.env.NINE_ROUTER_API_KEY || teamConfig.providers?.local_9router?.default_key || 'sk-default';

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature: 0.1
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${errText}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    return { ok: true, content, usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 5. Morning Report Generator
function writeMorningReport(state) {
  const lines = [
    `# Minimal Agent Orchestration — Execution Report`,
    `Generated at: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    `- Completed Tasks: ${state.completed_tasks.length}`,
    `- Blocked Tasks: ${state.blocked_tasks.length}`,
    `- Active Tasks Remaining: ${state.active_tasks.length}`,
    `- Total Tokens Used: In: ${state.metrics.total_input_tokens || 0} | Out: ${state.metrics.total_output_tokens || 0}`,
    `- Estimated Cost: $${(state.metrics.total_cost_est_usd || 0).toFixed(4)}`,
    ``,
    `## Completed Tasks`
  ];

  if (state.completed_tasks.length === 0) {
    lines.push(`_No tasks completed yet._`);
  } else {
    for (const t of state.completed_tasks) {
      lines.push(`- **${t.id}**: ${t.title || 'Untitled'} (Commit: \`${t.commit_hash || 'none'}\`, Retries: ${t.retries || 0})`);
    }
  }

  lines.push(``, `## Blocked Tasks`);
  if (state.blocked_tasks.length === 0) {
    lines.push(`_No blocked tasks! 100% smooth flow._`);
  } else {
    for (const t of state.blocked_tasks) {
      lines.push(`- **${t.id}**: ${t.title} — Reason: \`${t.block_reason || 'Unknown error'}\``);
    }
  }

  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');
}

// 6. Main Orchestrator Loop
async function runOrchestrator() {
  if (!acquireLock()) {
    console.error('[Orchestrator] Could not acquire lock. Exiting.');
    process.exit(1);
  }

  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log('[Orchestrator] Starting session...');

  const state = loadState();
  const maxRetries = policyConfig.policy?.retry_and_escalation?.max_retries_per_task || 3;
  const abortOnIdentical = policyConfig.policy?.retry_and_escalation?.abort_on_identical_error_count || 2;
  const tokenBudgetPerTask = policyConfig.policy?.retry_and_escalation?.token_budget_per_task || 150000;
  const strictScope = policyConfig.policy?.scope_control?.strict_scope_enforcement !== false;
  const allowedDirs = projectConfig.project?.allowed_dirs || [];

  // Discover active tasks
  if (!fs.existsSync(ACTIVE_TASKS_DIR)) {
    fs.mkdirSync(ACTIVE_TASKS_DIR, { recursive: true });
  }
  const taskFiles = fs.readdirSync(ACTIVE_TASKS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  console.log(`[Orchestrator] Found ${taskFiles.length} task(s) in tasks/active/`);

  for (const tFile of taskFiles) {
    const taskPath = path.resolve(ACTIVE_TASKS_DIR, tFile);
    const parsed = loadYaml(taskPath);
    const task = parsed?.task || parsed;

    if (!task?.id) {
      console.warn(`[Orchestrator] Skipping invalid task file: ${tFile}`);
      continue;
    }

    console.log(`\n======================================================`);
    console.log(`[Orchestrator] Processing Task: ${task.id} - ${task.title || ''}`);
    console.log(`======================================================`);

    let retries = 0;
    let lastErrorHash = null;
    let consecutiveIdenticalErrors = 0;
    let taskTokensUsed = 0;
    let isTaskDone = false;
    let blockReason = null;

    // Snapshot Git state before starting task
    const snap = snapshot();
    console.log(`[GitGuard] Repo snapshot at HEAD: ${snap.head?.slice(0, 7)}`);

    while (retries <= maxRetries && !isTaskDone) {
      if (taskTokensUsed > tokenBudgetPerTask) {
        blockReason = `Exceeded token budget (${taskTokensUsed} > ${tokenBudgetPerTask})`;
        console.error(`[Orchestrator] ${blockReason}`);
        break;
      }

      // Step A: Prepare Writer Prompt
      const writerModel = teamConfig.roles?.writer?.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
      const writerSystemRole = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'))
        ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'), 'utf8')
        : 'You are the backend code writer. Return changes in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.';

      const userMessage = [
        `TASK ID: ${task.id}`,
        `GOAL: ${task.goal || task.title}`,
        `ALLOWED SCOPE: ${(task.scope || []).join(', ')}`,
        `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
        lastErrorHash ? `PREVIOUS VALIDATION FAILED WITH ERROR:\n${task.last_error}` : `Please generate the code modifications to fulfill the goal.`
      ].join('\n\n');

      console.log(`[Writer] Calling model ${writerModel}...`);
      const writerRes = await call9Router(writerModel, writerSystemRole, userMessage);

      if (!writerRes.ok) {
        console.error(`[Writer] API error: ${writerRes.error}`);
        retries++;
        continue;
      }

      const inputTok = writerRes.usage?.prompt_tokens || 0;
      const outputTok = writerRes.usage?.completion_tokens || 0;
      taskTokensUsed += inputTok + outputTok;
      state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + inputTok;
      state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + outputTok;

      console.log(`[Writer] Received response (${outputTok} tokens). Applying edits...`);

      // Step B: Applier (0-Token Direct Write)
      const applyRes = applyEdits(writerRes.content, task.scope, allowedDirs, strictScope);
      if (!applyRes.ok) {
        console.warn(`[Applier] Failed: ${applyRes.error}`);
        task.last_error = applyRes.error;
        retries++;
        continue;
      }

      console.log(`[Applier] Successfully modified ${applyRes.modified.length} file(s).`);

      // Step C: Fast Validation (0-Token Shell)
      console.log(`[Validator] Running fast checks...`);
      const fastVal = await validateFast(projectConfig);

      if (!fastVal.ok) {
        console.warn(`[Validator] Fast check failed on: ${fastVal.checkName}`);
        const currentHash = fastVal.errorHash;
        if (currentHash === lastErrorHash) {
          consecutiveIdenticalErrors++;
        } else {
          lastErrorHash = currentHash;
          consecutiveIdenticalErrors = 1;
        }

        if (consecutiveIdenticalErrors >= abortOnIdentical) {
          blockReason = `Infinite fix loop detected (identical error ${consecutiveIdenticalErrors} times: ${currentHash})`;
          console.error(`[Validator] ${blockReason}`);
          rollback(task.scope);
          break;
        }

        task.last_error = fastVal.errorCombined;
        rollback(task.scope);
        retries++;
        continue;
      }

      // Step D: Suite Validation (0-Token Shell)
      console.log(`[Validator] Fast checks passed. Running full test suite...`);
      const suiteVal = await validateSuite(projectConfig);
      if (!suiteVal.ok) {
        console.warn(`[Validator] Suite check failed on: ${suiteVal.checkName}`);
        task.last_error = suiteVal.errorCombined;
        rollback(task.scope);
        retries++;
        continue;
      }

      console.log(`[Validator] All tests PASS!`);

      // Step E: Git Commit
      const commitRes = commitDone(task.id, task.title || task.goal || 'complete task');
      if (commitRes.ok) {
        console.log(`[GitGuard] Committed changes: ${commitRes.hash?.slice(0, 7)}`);
        task.commit_hash = commitRes.hash;
      }

      isTaskDone = true;
      break;
    }

    if (isTaskDone) {
      task.status = 'done';
      task.completed_at = new Date().toISOString();
      task.retries = retries;
      state.completed_tasks.push(task);

      // Move task file to archive
      if (!fs.existsSync(ARCHIVE_TASKS_DIR)) {
        fs.mkdirSync(ARCHIVE_TASKS_DIR, { recursive: true });
      }
      fs.renameSync(taskPath, path.resolve(ARCHIVE_TASKS_DIR, tFile));
      console.log(`[Orchestrator] Task ${task.id} DONE & archived.`);
    } else {
      task.status = 'blocked';
      task.block_reason = blockReason || `Exceeded maximum retries (${maxRetries})`;
      state.blocked_tasks.push(task);
      console.error(`[Orchestrator] Task ${task.id} BLOCKED: ${task.block_reason}`);
    }

    saveStateAtomic(state);
    writeMorningReport(state);
  }

  releaseLock();
  console.log(`\n[Orchestrator] Session finished. Report written to: state/morning-report.md`);
}

// Direct CLI start
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runOrchestrator().catch(err => {
    console.error('[Orchestrator] Fatal error:', err);
    releaseLock();
    process.exit(1);
  });
}
