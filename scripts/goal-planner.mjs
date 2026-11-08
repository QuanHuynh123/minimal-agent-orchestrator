#!/usr/bin/env node
/**
 * AI Architect Goal Planner & Task Decomposer
 * Part of Agent Squad v3.0 (agent-team/scripts/goal-planner.mjs)
 * 
 * Takes a high-level user goal in natural language, invokes the Router Agent
 * (Claude Sonnet 4.5 Thinking via Agent Runtime v3.0) with real file inspection tools
 * (list_files, search_code, read_file), and atomically creates 1-3 draft Task YAMLs
 * with status: "draft_review" awaiting human-in-the-loop approval.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveRepoRoot } from './applier.mjs';
import { buildRouterContext } from './orchestrator.mjs';
import { runAgent } from '../runtime/index.mjs';
import { analyzeTaskDemand, resolveWriterHubWorkflow } from './lib/risk-policy.mjs';

/**
 * 0-Token Deterministic Scope Verification:
 * Checks whether planned scope files exist on disk (or have valid parent directories for new files)
 * and warns if task goal expresses UI/UX intent without any frontend file in scope.
 */
export function verifyPlannedScope(scope = [], repoRoot = process.cwd(), demand = {}) {
  const warnings = [];
  const existingFiles = [];
  const missingFiles = [];

  for (const rel of (Array.isArray(scope) ? scope : [])) {
    const full = path.resolve(repoRoot, rel);
    if (fs.existsSync(full)) {
      existingFiles.push(rel);
    } else {
      missingFiles.push(rel);
    }
  }

  if (scope.length === 0 && demand.mode !== 'consult') {
    warnings.push('Task scope is empty for a non-consult task.');
  }
  if (demand.hasUiIntent && !demand.hasFrontend && demand.mode !== 'consult') {
    warnings.push('Goal mentions UI/UX keywords, but no frontend/UI file was included in task.scope.');
  }
  if (missingFiles.length > 0) {
    warnings.push(`New or non-existent files in scope: ${missingFiles.join(', ')}`);
  }

  return {
    ok: warnings.length === 0,
    existingFiles,
    missingFiles,
    warnings
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const ACTIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const POLICY_LOCAL_CONFIG_FILE = path.resolve(TEAM_DIR, 'config', 'policy.local.yaml');
const POLICY_CONFIG_FILE = path.resolve(TEAM_DIR, 'config', 'policy.yaml');

function loadYamlSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return YAML.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function slugify(text = '', maxLen = 30) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

export function extractJsonPayload(text = '') {
  if (!text || typeof text !== 'string') return null;
  // Try extracting from fenced markdown json blocks first
  const matchFenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (matchFenced && matchFenced[1]) {
    try {
      return JSON.parse(matchFenced[1].trim());
    } catch {}
  }
  // Try finding raw object / array boundaries
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

/**
 * Decomposes a user goal into atomic, verified task specifications.
 * 
 * @param {string} goal - User's high level request
 * @param {Object} options
 * @param {string} options.repoRoot - Workspace repository root
 * @param {boolean} options.dryRun - If true, do not save YAML files to disk
 * @param {Array<string>} options.images - Optional design image paths
 * @returns {Promise<{ ok: boolean, tasks?: Array, error?: string, rawOutput?: string }>}
 */
export async function decomposeGoal(goal, options = {}) {
  const cleanGoal = String(goal || '').trim();
  if (!cleanGoal) {
    return { ok: false, error: 'User goal cannot be empty' };
  }

  const policyConfig = loadYamlSafe(path.resolve(TEAM_DIR, 'config', 'policy.local.yaml'))
    || loadYamlSafe(POLICY_CONFIG_FILE)
    || {};
  const projectId = policyConfig.policy?.project_id || 'my-workspace';
  const repoRoot = options.repoRoot || resolveRepoRoot(policyConfig);
  const maxFilesPerTask = policyConfig.policy?.scope_control?.max_files_per_task || 5;

  // Use configured allowed_dirs from policy.yaml or auto-detect
  let allowedDirs = policyConfig.policy?.scope_control?.allowed_dirs
    || policyConfig.policy?.allowed_dirs
    || [];
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    try {
      const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
      allowedDirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'agent-team')
        .map(e => e.name);
    } catch {}
  }
  if (allowedDirs.length === 0) allowedDirs = ['*'];

  // Deterministic intent classification (Zero-LLM Heuristic Guard)
  const isConsultIntent = /(tư vấn|khảo sát|nghiên cứu|đánh giá|hỏi ý kiến|thảo luận|so sánh|consult|research|advisory|evaluate)/i.test(cleanGoal);

  const teamConfig = loadYamlSafe(path.resolve(TEAM_DIR, 'config', 'team.yaml')) || {};
  const roles = teamConfig.roles || {};
  const availableModelsList = [];
  for (const [rKey, rCfg] of Object.entries(roles)) {
    if (rCfg?.model && !availableModelsList.includes(rCfg.model)) {
      availableModelsList.push(rCfg.model);
    }
    if (rCfg?.fallback_model && !availableModelsList.includes(rCfg.fallback_model)) {
      availableModelsList.push(rCfg.fallback_model);
    }
    if (Array.isArray(rCfg?.models)) {
      for (const m of rCfg.models) {
        if (m && !availableModelsList.includes(m)) availableModelsList.push(m);
      }
    }
  }

  if (availableModelsList.length === 0) {
    return {
      ok: false,
      error: 'Đội ngũ AI chưa có model nào được cấu hình trong team.yaml! Vui lòng bấm biểu tượng Cài đặt (góc trên bên phải) để thêm model vào đội ngũ trước khi phân tích mục tiêu.'
    };
  }

  const userPromptParts = [
    `USER GOAL:`,
    `"${cleanGoal}"`
  ];

  if (isConsultIntent) {
    userPromptParts.push(
      `DIRECTIVE: User intent is architectural consultation / research. You MUST set "mode": "consult" (read-only advisory, no file mutation).`
    );
  }

  userPromptParts.push(
    `ALLOWED DIRECTORIES: [${allowedDirs.join(', ')}]`,
    `AVAILABLE SQUAD MODELS: [${availableModelsList.join(', ')}]. If user asked for a model, match to this exact list; otherwise leave "model": null.`,
    `INSTRUCTION: Inspect the repository using your available tools (list_files, search_code, read_file, get_repo_map) if needed, then output strict JSON matching the schema in your system instructions.`
  );

  const prompt = userPromptParts.join('\n\n');

  try {
    const sessionSafeId = `planner-${Date.now().toString(36)}`;
    const agentRes = await runAgent({
      role: 'router',
      prompt,
      sessionId: sessionSafeId,
      images: options.images || [],
      scope: [],
      maxTurns: 3,
      timeoutMs: 90000,
      repoRoot
    });

    if (!agentRes.ok) {
      return { ok: false, error: `Router agent error: ${agentRes.error}` };
    }

    const parsed = extractJsonPayload(agentRes.content);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      return {
        ok: false,
        error: 'Router did not produce a valid JSON array of tasks',
        rawOutput: agentRes.content
      };
    }

    const timestampPrefix = new Date().toISOString().slice(0, 10);
    const createdTasks = [];

    for (let idx = 0; idx < parsed.tasks.length; idx++) {
      const rawTask = parsed.tasks[idx];
      const title = String(rawTask.title || `Task ${idx + 1}`).trim();
      const slug = slugify(title) || `subtask-${idx + 1}`;
      const taskId = `T-${timestampPrefix}-${Date.now().toString().slice(-4)}-${idx + 1}-${slug}`.slice(0, 50);

      const rawScope = Array.isArray(rawTask.scope) ? rawTask.scope : [];
      // Clean and clamp scope
      const validScope = rawScope
        .map(s => String(s || '').trim().replace(/\\/g, '/'))
        .filter(s => s.length > 0 && !s.startsWith('/') && !s.includes('..'))
        .slice(0, maxFilesPerTask);

      const validModes = ['quick', 'standard', 'consult'];
      const rawMode = String(rawTask.mode || '').toLowerCase();
      let declaredMode = validModes.includes(rawMode) ? rawMode : 'quick';
      if (rawMode === 'full') declaredMode = 'standard';
      if (isConsultIntent) declaredMode = 'consult';

      const draftSeed = {
        task_id: taskId,
        title,
        goal: String(rawTask.goal || title).trim(),
        mode: declaredMode,
        risk_level: ['low', 'medium', 'high', 'critical'].includes(rawTask.risk_level) ? rawTask.risk_level : 'low',
        scope: validScope,
        attachments: options.images || []
      };

      // Enforce max(declared, computed) for risk_level and mode via analyzeTaskDemand
      const demand = analyzeTaskDemand(draftSeed, policyConfig);
      const effectiveMode = demand.mode;
      const effectiveRisk = demand.riskLevel;
      const scopeVerification = verifyPlannedScope(validScope, repoRoot, demand);

      const taskRole = effectiveMode === 'consult'
        ? (rawTask.role || (String(rawTask.model || '').toLowerCase().includes('opus') ? 'reviewer' : 'designer'))
        : 'writer';

      const canonicalTask = {
        task: {
          task_id: taskId,
          project_id: projectId,
          title,
          goal: draftSeed.goal,
          mode: effectiveMode,
          risk_level: effectiveRisk,
          owner: taskRole,
          status: 'draft_review', // Human-in-the-loop gate: awaits approval before running
          scope: validScope,
          ...(scopeVerification.warnings.length > 0 ? { scope_warnings: scopeVerification.warnings } : {}),
          constraints: Array.isArray(rawTask.constraints) ? rawTask.constraints : [],
          acceptance_criteria: Array.isArray(rawTask.acceptance_criteria) && rawTask.acceptance_criteria.length > 0
            ? rawTask.acceptance_criteria
            : (effectiveMode === 'consult' ? ['Cung cấp báo cáo tư vấn kiến trúc rõ ràng', 'Đánh giá các giải pháp tham khảo'] : [`Code changes pass tests and validator fast`])
        }
      };

      if (effectiveMode === 'consult') {
        canonicalTask.task.role = taskRole;
      }

      if (rawTask.model && typeof rawTask.model === 'string' && rawTask.model.trim()) {
        canonicalTask.task.model = rawTask.model.trim();
      } else if (effectiveMode === 'consult' && (taskRole === 'reviewer' || /opus/i.test(cleanGoal))) {
        canonicalTask.task.model = 'ag/claude-opus-5-5-high';
      }

      if (rawTask.manual_workflow_override && Array.isArray(rawTask.writer_hub_workflow) && rawTask.writer_hub_workflow.length > 0) {
        canonicalTask.task.writer_hub_workflow = rawTask.writer_hub_workflow;
      } else {
        const computedWf = resolveWriterHubWorkflow(canonicalTask.task, teamConfig, policyConfig, options.preset || 'auto');
        if (computedWf.length > 0) {
          canonicalTask.task.writer_hub_workflow = computedWf;
        }
      }

      if (!options.dryRun) {
        fs.mkdirSync(ACTIVE_TASKS_DIR, { recursive: true });
        const filePath = path.resolve(ACTIVE_TASKS_DIR, `${taskId}.yaml`);
        const yamlStr = YAML.stringify(canonicalTask);
        fs.writeFileSync(filePath, yamlStr, 'utf8');
      }

      createdTasks.push({
        ...canonicalTask.task,
        file_path: path.resolve(ACTIVE_TASKS_DIR, `${taskId}.yaml`)
      });
    }

    return {
      ok: true,
      tasks: createdTasks,
      total_created: createdTasks.length,
      rawOutput: agentRes.content
    };
  } catch (err) {
    return { ok: false, error: `Goal decomposition exception: ${err.message}` };
  }
}

// -------------------------------------------------------------
// Standalone CLI Execution
// -------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const goalArg = process.argv.slice(2).join(' ').trim();
  if (!goalArg) {
    console.error('Usage: node agent-team/scripts/goal-planner.mjs "<user goal description>" [--dry-run]');
    process.exit(1);
  }

  const isDryRun = process.argv.includes('--dry-run');
  const cleanGoal = goalArg.replace('--dry-run', '').trim();

  console.log(`[GoalPlanner] Decomposing goal with Router Agent: "${cleanGoal}"...`);
  decomposeGoal(cleanGoal, { dryRun: isDryRun }).then(res => {
    if (!res.ok) {
      console.error(`[GoalPlanner] Error: ${res.error}`);
      if (res.rawOutput) console.error(`Raw Agent Response:\n${res.rawOutput}`);
      process.exit(1);
    }

    console.log(`\n======================================================`);
    console.log(`✓ DECOMPOSED INTO ${res.total_created} DRAFT TASK(S) (status: draft_review):`);
    console.log(`======================================================`);
    for (const t of res.tasks) {
      console.log(`\n[TASK ID]: ${t.task_id}`);
      console.log(` Title:   ${t.title}`);
      console.log(` Mode:    ${t.mode} | Risk: ${t.risk_level}`);
      console.log(` Scope:   ${t.scope.join(', ')}`);
      console.log(` Criteria:`);
      for (const c of t.acceptance_criteria) {
        console.log(`   - ${c}`);
      }
      console.log(` Status:  ${t.status} (Needs human approval to run)`);
    }
    console.log(`\nRun "node agent-team/scripts/orchestrator.mjs run" after approving tasks.`);
  }).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
