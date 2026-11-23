#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = path.resolve(TEAM_DIR, '..');

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.gemini', '.agents', '.pytest_cache', '.mypy_cache', '.idea', '.vscode'
]);

const DEFAULT_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.htm', '.css', '.scss', '.yaml', '.yml', '.md', '.json'
]);

function normalizeRel(p = '') {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectCandidateFiles(repoRoot, extensions = DEFAULT_EXTENSIONS) {
  let relFiles = [];
  if (fs.existsSync(path.join(repoRoot, '.git'))) {
    try {
      const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 10 * 1024 * 1024
      });
      relFiles = out.split(/\r?\n/).map(normalizeRel).filter(Boolean);
    } catch {}
  }

  if (relFiles.length === 0) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          relFiles.push(normalizeRel(path.relative(repoRoot, path.join(dir, entry.name))));
        }
      }
    };
    walk(repoRoot);
  }

  return relFiles.filter(rel => {
    const ext = path.extname(rel).toLowerCase();
    if (!extensions.has(ext)) return false;
    if (rel === 'package-lock.json' || rel.endsWith('package-lock.json')) return false;
    if (rel.startsWith('agent-team/state/') || rel.startsWith('agent-team/tasks/')) return false;
    return true;
  });
}

function unwrapTaskRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.task && typeof raw.task === 'object' ? raw.task : raw;
  const id = String(t.task_id || t.id || '').trim();
  if (!id) return null;
  return { ...t, task_id: id };
}

export function loadDefaultRepoTaskRecords(repoRoot = DEFAULT_REPO_ROOT) {
  const byId = new Map();
  const ingest = (raw) => {
    const t = unwrapTaskRecord(raw);
    if (!t) return;
    const prev = byId.get(t.task_id);
    if (!prev) {
      byId.set(t.task_id, t);
      return;
    }
    const prevSteps = Array.isArray(prev.steps) ? prev.steps.length : 0;
    const nextSteps = Array.isArray(t.steps) ? t.steps.length : 0;
    if (nextSteps > prevSteps) {
      byId.set(t.task_id, t);
    }
  };

  const teamDir = path.join(repoRoot, 'agent-team');
  const suitePath = path.join(teamDir, 'benchmarks', 'suite-v1.json');
  if (fs.existsSync(suitePath)) {
    try {
      const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
      for (const item of (suite.tasks || [])) ingest(item);
    } catch {}
  }

  const scanYamlDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      try {
        ingest(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {}
    }
  };
  scanYamlDir(path.join(teamDir, 'benchmarks', 'fixtures'));
  scanYamlDir(path.join(teamDir, 'tasks', 'active'));
  scanYamlDir(path.join(teamDir, 'tasks', 'archive'));

  const statePath = path.join(teamDir, 'state', 'task-state.json');
  if (fs.existsSync(statePath)) {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      for (const arr of [st.active_tasks, st.completed_tasks, st.blocked_tasks]) {
        for (const item of (Array.isArray(arr) ? arr : [])) ingest(item);
      }
    } catch {}
  }

  return Array.from(byId.values());
}

function aggregateScopeAndStepMetrics(tasks = []) {
  const deduped = new Map();
  for (const raw of (Array.isArray(tasks) ? tasks : [])) {
    const t = unwrapTaskRecord(raw) || (raw && typeof raw === 'object' ? { ...raw, task_id: raw.task_id || `anon-${deduped.size}` } : null);
    if (!t) continue;
    const prev = deduped.get(t.task_id);
    if (!prev || ((Array.isArray(t.steps) ? t.steps.length : 0) > (Array.isArray(prev.steps) ? prev.steps.length : 0))) {
      deduped.set(t.task_id, t);
    }
  }

  const scopeCountByFile = new Map();
  const stepTokensByFile = new Map();
  let tasksWithStepsCount = 0;

  for (const task of deduped.values()) {
    const taskScope = [...new Set((Array.isArray(task.scope) ? task.scope : []).map(normalizeRel).filter(Boolean))];
    for (const f of taskScope) {
      scopeCountByFile.set(f, (scopeCountByFile.get(f) || 0) + 1);
    }

    if (Array.isArray(task.steps) && task.steps.length > 0) {
      tasksWithStepsCount++;
      for (const st of task.steps) {
        if (!st || typeof st !== 'object') continue;
        const tok = Number(
          st.total_tokens ?? ((Number(st.prompt_tokens) || 0) + (Number(st.completion_tokens) || 0))
        ) || 0;
        if (tok <= 0) continue;
        const targetScope = (Array.isArray(st.scope) && st.scope.length > 0)
          ? [...new Set(st.scope.map(normalizeRel).filter(Boolean))]
          : taskScope;
        for (const f of targetScope) {
          stepTokensByFile.set(f, (stepTokensByFile.get(f) || 0) + tok);
        }
      }
    }
  }

  return {
    scopeCountByFile,
    stepTokensByFile,
    totalTasksScanned: deduped.size,
    tasksWithStepsCount
  };
}

export function generateFileSizeReport({
  repoRoot = DEFAULT_REPO_ROOT,
  top = 20,
  tasks = null,
  extensions = DEFAULT_EXTENSIONS
} = {}) {
  const absRoot = path.resolve(repoRoot);
  const files = collectCandidateFiles(absRoot, extensions);
  const taskRecords = Array.isArray(tasks) ? tasks : loadDefaultRepoTaskRecords(absRoot);
  const metrics = aggregateScopeAndStepMetrics(taskRecords);

  const rows = [];
  for (const rel of files) {
    const full = path.join(absRoot, rel);
    if (!fs.existsSync(full)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let lines = 0;
    try {
      const content = fs.readFileSync(full, 'utf8');
      lines = content.length === 0 ? 0 : content.replace(/\r\n/g, '\n').split('\n').length - (content.endsWith('\n') ? 1 : 0);
    } catch {
      continue;
    }
    rows.push({
      path: rel,
      bytes: stat.size,
      kb: Number((stat.size / 1024).toFixed(2)),
      lines,
      scope_count: metrics.scopeCountByFile.get(rel) || 0,
      step_tokens: metrics.stepTokensByFile.get(rel) || 0
    });
  }

  rows.sort((a, b) => (b.bytes - a.bytes) || (b.lines - a.lines) || a.path.localeCompare(b.path));
  const topN = Math.max(1, Number(top) || 20);
  return {
    repo_root: absRoot,
    total_files_scanned: rows.length,
    total_tasks_scanned: metrics.totalTasksScanned,
    tasks_with_steps_count: metrics.tasksWithStepsCount,
    top_files: rows.slice(0, topN),
    all_files: rows
  };
}

export function formatFileSizeMarkdownTable(report) {
  const lines = [
    `Top ${report.top_files.length} Files by Size (scanned=${report.total_files_scanned} files, tasks=${report.total_tasks_scanned}, tasks_with_steps=${report.tasks_with_steps_count}):`,
    '',
    '| # | File | KB | Lines | Scope Hits | steps[] Tokens |',
    '| ---: | :--- | ---: | ---: | ---: | ---: |'
  ];
  report.top_files.forEach((row, idx) => {
    lines.push(
      `| ${idx + 1} | \`${row.path}\` | ${row.kb.toFixed(2)} | ${row.lines} | ${row.scope_count} | ${row.step_tokens.toLocaleString()} |`
    );
  });
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let top = 20;
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top' && args[i + 1]) top = Number(args[++i]);
    else if (args[i] === '--json') jsonOut = true;
  }
  const report = generateFileSizeReport({ top });
  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatFileSizeMarkdownTable(report));
  }
}
