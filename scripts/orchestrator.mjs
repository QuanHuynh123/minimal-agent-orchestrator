#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { applyEdits } from './applier.mjs';
import { commitDone, getModifiedFiles, isCleanWorktree, rollback, snapshot } from './git-guard.mjs';
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

// 1. Lock File Management
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      console.warn(`[Orchestrator] Lock file exists (PID: ${lockData.pid}, Started: ${lockData.started_at}).`);
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

// 2. Atomic State Management
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      version: '2.1',
      active_tasks: [],
      completed_tasks: [],
      blocked_tasks: [],
      metrics: { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: '2.1', active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
  }
}

function saveStateAtomic(state) {
  const tmpPath = `${STATE_FILE}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, STATE_FILE);
}

function saveTaskAtomic(taskPath, taskData) {
  const tmpPath = `${taskPath}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const yamlContent = YAML.stringify({ task: taskData });
  fs.writeFileSync(tmpPath, yamlContent, 'utf8');
  fs.renameSync(tmpPath, taskPath);
}

// 3. Load Configurations
function loadYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

const teamConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'team.yaml')) || {};
const projectConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'project.yaml')) || {};
const policyConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'policy.yaml')) || {};

// Helpers for v2.1 Policy & Security
function computeScopeHash(scope = []) {
  const sorted = [...scope].map(s => s.trim().replace(/\\/g, '/')).sort().join('\n');
  return hashString(sorted);
}

function computeDeterministicRisk(scope = []) {
  const sensitivePatterns = [
    'agent-team/',
    '.github/',
    'keyring',
    'auth',
    'secret',
    'migration',
    'infra'
  ];
  const isHigh = scope.some(item => {
    const s = (item || '').toLowerCase().replace(/\\/g, '/');
    return sensitivePatterns.some(p => s.includes(p));
  });
  return isHigh ? 'high' : 'low';
}

function sanitizeGoal(str = '') {
  return str.replace(/[\r\n\x1B]/g, ' ').slice(0, 80).trim();
}

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
    `# Minimal Agent Orchestration — Execution Report (v2.1 Standard)`,
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
      lines.push(`- **${t.id}**: ${t.title || ''} — Reason: \`${t.block_reason || 'Unknown error'}\``);
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

  console.log('[Orchestrator] Starting session (v2.1 Engine)...');

  const state = loadState();
  const maxRetries = policyConfig.policy?.retry_and_escalation?.max_retries_per_task || 3;
  const abortOnIdentical = policyConfig.policy?.retry_and_escalation?.abort_on_identical_error_count || 2;
  const tokenBudgetPerTask = policyConfig.policy?.retry_and_escalation?.token_budget_per_task || 150000;
  const maxScopeIncrease = policyConfig.policy?.scope_control?.max_scope_increase ?? 1;
  const allowedDirs = projectConfig.project?.allowed_dirs || [];
  const protectedFiles = projectConfig.project?.protected_files || [];

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

    let retries = 0;
    let lastErrorHash = null;
    let consecutiveIdenticalErrors = 0;
    let taskTokensUsed = 0;
    let isTaskDone = false;
    let blockReason = null;
    let validationPassed = null;
    let actualModifiedFiles = [];

    // Initialize scope_expansions if missing
    if (!Array.isArray(task.scope_expansions)) {
      task.scope_expansions = [];
    }

    try {
      // ==========================================
      // ROUTER VALIDATION (Fail fast before Writer)
      // ==========================================
      if (!task.scope || !Array.isArray(task.scope) || task.scope.length === 0) {
        blockReason = 'Task scope is empty. Explicit scope is required.';
        task.status = 'blocked';
        task.block_reason = blockReason;
        throw new Error(blockReason);
      }

      if (!task.acceptance_criteria || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
        blockReason = 'Task missing acceptance_criteria.';
        task.status = 'blocked';
        task.block_reason = blockReason;
        throw new Error(blockReason);
      }

      // Computed Risk Level & Anti-Self-Approval
      const computedRisk = computeDeterministicRisk(task.scope);
      const effectiveRisk = (task.risk_level === 'high' || computedRisk === 'high') ? 'high' : (task.risk_level || 'low');
      task.risk_level = effectiveRisk;

      // Approval Check for High Risk
      if (effectiveRisk === 'high') {
        const expectedHash = computeScopeHash(task.scope);
        const hasValidApproval = task.approval &&
          typeof task.approval.by === 'string' &&
          task.approval.scope_hash === expectedHash;

        if (!hasValidApproval) {
          blockReason = `Waiting for human approval (risk_level: high, expected scope_hash: "${expectedHash}")`;
          task.status = 'blocked';
          task.block_reason = blockReason;
          throw new Error(blockReason);
        }
      }

      // Scope Expansion Justification Guard
      const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
      if (allowExpansion && (!task.justification || task.justification.trim().length < 10)) {
        blockReason = 'allow_scope_expansion is true but justification is missing or too short (< 10 chars)';
        task.status = 'blocked';
        task.block_reason = blockReason;
        throw new Error(blockReason);
      }

      // ==========================================
      // 3.1 PRE-HOOK (0-Token, Exactly 1 Console Line)
      // ==========================================
      const cleanGoal = sanitizeGoal(task.goal || task.title);
      console.log(`[START] ${task.id} | Goal: ${cleanGoal} | Scope: ${task.scope.join(', ')} | Allow-expansion: ${allowExpansion}`);

      // Snapshot Git state before starting task loop
      snapshot();

      // ==========================================
      // TASK EXECUTION LOOP
      // ==========================================
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
          `ALLOWED SCOPE: ${task.scope.join(', ')}`,
          `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
          `ACCEPTANCE CRITERIA: ${task.acceptance_criteria.join('; ')}`,
          lastErrorHash ? `PREVIOUS VALIDATION FAILED WITH ERROR:\n${task.last_error}` : 'Please generate the exact code modifications to fulfill the goal.'
        ].join('\n\n');

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

        // Step B: 8-Step Applier Pipeline
        const applyRes = applyEdits(writerRes.content, task, {
          allowedDirs,
          protectedFiles,
          maxScopeIncrease,
          repoRoot: REPO_ROOT
        });

        if (!applyRes.ok) {
          console.warn(`[Applier] ${applyRes.error}`);
          task.last_error = applyRes.error;

          // If Security or Forbidden file, do not retry!
          if (applyRes.security || applyRes.noRetry) {
            blockReason = applyRes.error;
            task.status = 'blocked';
            rollback(task.scope);
            break;
          }

          retries++;
          continue;
        }

        task.scope_expansions = applyRes.scope_expansions || task.scope_expansions;
        actualModifiedFiles = getModifiedFiles();

        // Step C: Fast Validation (0-Token)
        const fastVal = await validateFast(projectConfig);
        if (!fastVal.ok) {
          console.warn(`[Validator] Fast check failed: ${fastVal.checkName}`);
          validationPassed = false;
          const currentHash = fastVal.errorHash;
          if (currentHash === lastErrorHash) {
            consecutiveIdenticalErrors++;
          } else {
            lastErrorHash = currentHash;
            consecutiveIdenticalErrors = 1;
          }

          if (consecutiveIdenticalErrors >= abortOnIdentical) {
            blockReason = `Infinite fix loop detected (${consecutiveIdenticalErrors}x identical error: ${currentHash})`;
            console.error(`[Validator] ${blockReason}`);
            rollback(task.scope);
            break;
          }

          task.last_error = fastVal.errorCombined;
          rollback(task.scope);
          retries++;
          continue;
        }

        // Step D: Suite Validation (0-Token)
        const suiteVal = await validateSuite(projectConfig);
        if (!suiteVal.ok) {
          console.warn(`[Validator] Suite check failed: ${suiteVal.checkName}`);
          validationPassed = false;
          task.last_error = suiteVal.errorCombined;
          rollback(task.scope);
          retries++;
          continue;
        }

        validationPassed = true;

        // Step E: Git Commit
        const commitRes = commitDone(task.id, task.title || task.goal || 'complete task');
        if (commitRes.ok) {
          task.commit_hash = commitRes.hash;
        }

        isTaskDone = true;
        break;
      }
    } catch (err) {
      if (!blockReason) blockReason = err.message;
    } finally {
      // ==========================================
      // 3.2 POST-HOOK (0-Token Atomic Post-Report)
      // ==========================================
      const finalStatus = isTaskDone ? 'done' : (task.status === 'blocked' ? 'blocked' : 'failed');
      task.status = finalStatus;
      if (isTaskDone) {
        task.completed_at = new Date().toISOString();
      }

      task.last_report = {
        final_status: finalStatus,
        modified_files: isTaskDone ? actualModifiedFiles : [],
        validation_passed: validationPassed,
        retries_used: retries,
        blocker_reason: blockReason || (isTaskDone ? null : `Exceeded max retries (${maxRetries})`),
        next_action: isTaskDone ? 'none' : (blockReason?.includes('approval') ? 'Need human approval' : 'Review task scope and constraints'),
        reported_at: new Date().toISOString()
      };

      if (isTaskDone) {
        task.retries = retries;
        state.completed_tasks.push(task);

        if (!fs.existsSync(ARCHIVE_TASKS_DIR)) {
          fs.mkdirSync(ARCHIVE_TASKS_DIR, { recursive: true });
        }
        const archivePath = path.resolve(ARCHIVE_TASKS_DIR, tFile);
        saveTaskAtomic(archivePath, task);
        if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
      } else {
        task.block_reason = task.last_report.blocker_reason;
        state.blocked_tasks.push(task);
        saveTaskAtomic(taskPath, task);
      }

      saveStateAtomic(state);
      writeMorningReport(state);

      // Print 1-line post-hook report to console
      const filesSummary = (task.last_report.modified_files || []).join(', ') || 'none';
      console.log(`[REPORT] ${task.id} | Status: ${finalStatus} | Files: ${filesSummary} | Validation: ${validationPassed} | Retries: ${retries}`);
    }
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
