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
  const teamConfig = loadYamlSafe(path.resolve(TEAM_DIR, 'config', 'team.local.yaml'))
    || loadYamlSafe(path.resolve(TEAM_DIR, 'config', 'team.yaml'))
    || {};
  const writerRole = teamConfig.roles?.writer || {};
  const designerRole = teamConfig.roles?.designer || {};
  const backendModel = writerRole.default_model || writerRole.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
  const frontendModel = designerRole.default_model || designerRole.model || 'kr/claude-sonnet-4.5-thinking';
  const modelPool = Array.from(new Set([
    backendModel,
    frontendModel,
    ...(Array.isArray(writerRole.models) ? writerRole.models : []),
    ...(Array.isArray(designerRole.models) ? designerRole.models : [])
  ].filter(Boolean)));

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

  const routerContext = buildRouterContext(allowedDirs, repoRoot, 300);

  const prompt = [
    `USER GOAL:`,
    `"${cleanGoal}"`,
    ``,
    `REPOSITORY ARCHITECTURE CONTEXT:`,
    routerContext,
    ``,
    `AVAILABLE WORKER MODELS:`,
    `- Backend / Logic / Core / Tests: "${backendModel}"`,
    `- Frontend / UI / UX / Styling / Web: "${frontendModel}"`,
    `- Available Model Pool: [${modelPool.map(m => `"${m}"`).join(', ')}]`,
    ``,
    `INSTRUCTIONS:`,
    `1. You are the AI Software Architect & Router. Inspect the codebase thoroughly using tools if needed (list_files, search_code, read_file).`,
    `2. Decompose the goal into 1 to 3 ATOMIC, sequential tasks (< 150 lines modified per task).`,
    `3. Every task MUST define an explicit "scope" of files (relative to repository root) that actually exist or will be created in allowed directories: [${allowedDirs.join(', ')}].`,
    `4. Model Assignment: Assign the exact "model" ID for each task based on its nature or explicit user request:`,
    `   - For backend, database, APIs, core logic, or test files -> designate "${backendModel}".`,
    `   - For UI, frontend, CSS, HTML, icon, layout, or visual styling -> designate "${frontendModel}".`,
    `   - If user request specifically asks for a model (e.g. Gemini, DeepSeek, Claude), designate that matching model from the pool.`,
    `5. Code edits in scope MUST preserve the exact indentation style (tabs or spaces) and coding conventions of the target files.`,
    `6. Frontend/Web files in scope MUST mandate: "Zero-Trust Anti-XSS (chỉ dùng textContent hoặc escapeHtml, không gán raw innerHTML)".`,
    `7. Every task MUST define at least 2 measurable, testable "acceptance_criteria".`,
    `8. Output STRICT JSON conforming to the following schema with NO surrounding chatter:`,
    `{`,
    `  "tasks": [`,
    `    {`,
    `      "title": "Short descriptive title (Vietnamese or English)",`,
    `      "goal": "Precise goal describing what this atomic task achieves",`,
    `      "mode": "quick", // "quick" for single file/light edits, "standard" for complex logic`,
    `      "model": "${backendModel}", // Designate exact model ID: "${backendModel}" for backend or "${frontendModel}" for UI`,
    `      "risk_level": "low", // "low", "medium", or "high"`,
    `      "scope": ["src/example.js", "tests/test_example.js"],`,
    `      "constraints": [`,
    `        "Giữ nguyên chuẩn thụt lề (indentation) của file gốc trong dự án",`,
    `        "Giữ nguyên tính tương thích ngược",`,
    `        "Pass 100% test suite liên quan"`,
    `      ],`,
    `      "acceptance_criteria": [`,
    `        "Cụ thể tiêu chí 1",`,
    `        "Cụ thể tiêu chí 2"`,
    `      ]`,
    `    }`,
    `  ]`,
    `}`
  ].join('\n');

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

      const normalizedMode = rawTask.mode === 'full' ? 'standard' : (['quick', 'standard'].includes(rawTask.mode) ? rawTask.mode : 'quick');
      const canonicalTask = {
        task: {
          task_id: taskId,
          project_id: projectId,
          title,
          goal: String(rawTask.goal || title).trim(),
          mode: normalizedMode,
          risk_level: ['low', 'medium', 'high', 'critical'].includes(rawTask.risk_level) ? rawTask.risk_level : 'low',
          owner: 'writer',
          status: 'draft_review', // Human-in-the-loop gate: awaits approval before running
          scope: validScope,
          constraints: Array.isArray(rawTask.constraints) ? rawTask.constraints : [],
          acceptance_criteria: Array.isArray(rawTask.acceptance_criteria) && rawTask.acceptance_criteria.length > 0
            ? rawTask.acceptance_criteria
            : [`Code changes pass tests and validator fast`]
        }
      };

      if (rawTask.model && typeof rawTask.model === 'string' && rawTask.model.trim()) {
        canonicalTask.task.model = rawTask.model.trim();
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
