import fs from 'node:fs';
import path from 'node:path';
import { normalizeOrThrow, resolveRepoRoot } from '../applier.mjs';

const REPO_ROOT = resolveRepoRoot();

/**
 * Extracts technical identifiers/symbols from task goal, acceptance_criteria, and last_error
 * to drive smart context window slicing on large files.
 */
export function extractTaskKeywords(task = {}) {
  const corpus = [
    task.title || '',
    task.goal || '',
    ...(task.acceptance_criteria || []),
    task.last_error || ''
  ].join(' ');

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'true', 'false', 'null', 'none',
    'file', 'files', 'code', 'test', 'tests', 'task', 'pass', 'must', 'should', 'return', 'returns',
    'trong', 'cua', 'cho', 'voi', 'cac', 'khi', 'neu', 'phai', 'duoc', 'khong', 'thanh', 'cong', 'kiem', 'tra'
  ]);

  const matches = corpus.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) || [];
  const unique = [];
  const seen = new Set();

  for (const m of matches) {
    const clean = m.replace(/^[.-]+|[.-]+$/g, '');
    const lower = clean.toLowerCase();
    if (clean.length < 3 || stopWords.has(lower)) continue;
    // Prioritize snake_case, camelCase, dot.paths, or identifiers >= 4 chars
    if (clean.includes('_') || clean.includes('-') || clean.includes('.') || /[a-z][A-Z]/.test(clean) || clean.length >= 4) {
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(clean);
      }
    }
  }
  return unique.slice(0, 25);
}

/**
 * Slices a large file around lines matching task keywords (+/- windowLines),
 * merging overlapping windows and preserving exact lines for SEARCH/REPLACE blocks.
 */
export function sliceContentByKeywords(rawContent, keywords = [], maxBytes = 120000, windowLines = 80) {
  const lines = rawContent.split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines <= windowLines * 2 + 60) {
    return rawContent;
  }

  const ranges = [];
  // Always keep top header/imports (first 50 lines)
  ranges.push([0, Math.min(50, totalLines - 1)]);

  const lowerKeywords = keywords.map(k => k.toLowerCase());
  if (lowerKeywords.length > 0) {
    for (let i = 0; i < totalLines; i++) {
      const lineLower = lines[i].toLowerCase();
      if (lowerKeywords.some(k => lineLower.includes(k))) {
        const start = Math.max(0, i - windowLines);
        const end = Math.min(totalLines - 1, i + windowLines);
        ranges.push([start, end]);
      }
    }
  }

  // Always include tail of file (last 35 lines) for appending new functions/exports
  ranges.push([Math.max(0, totalLines - 35), totalLines - 1]);

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + 1) {
      merged.push([...r]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    }
  }

  const chunks = [];
  let usedBytes = 0;
  for (let idx = 0; idx < merged.length; idx++) {
    const [start, end] = merged[idx];
    if (idx > 0) {
      const prevEnd = merged[idx - 1][1];
      chunks.push(`\n/* ... [OMITTED LINES ${prevEnd + 2}..${start} — DO NOT INCLUDE THIS COMMENT IN SEARCH BLOCKS] ... */\n`);
    }
    const segment = lines.slice(start, end + 1).join('\n');
    const segBytes = Buffer.byteLength(segment, 'utf8');
    if (usedBytes + segBytes > maxBytes && idx > 0) {
      const remaining = Math.max(4096, maxBytes - usedBytes);
      chunks.push(segment.slice(0, remaining));
      chunks.push(`\n/* ... [CONTEXT BUDGET REACHED AT ${maxBytes} BYTES] ... */`);
      break;
    }
    chunks.push(segment);
    usedBytes += segBytes;
  }

  return chunks.join('\n');
}

export function expandScopeItem(repoRoot, rawFile, maxFiles = 5) {
  const relPath = normalizeOrThrow(repoRoot, rawFile);
  const absPath = path.resolve(repoRoot, relPath);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .slice(0, maxFiles)
      .map(e => `${relPath.replace(/\/+$/, '')}/${e.name}`);
    return entries.length > 0 ? entries : [relPath];
  }
  return [relPath];
}

/**
 * Context-Aware File Loader:
 * - Scales byte budget from token_budget_per_task instead of a rigid 64KB cap.
 * - Sends files 100% intact when within budget.
 * - Uses symbol/keyword window slicing (+/- 80 lines) when a file exceeds budget.
 */
export function buildScopedFilesContext(scope = [], repoRoot = REPO_ROOT, task = {}, options = {}) {
  const tokenBudget = options.tokenBudgetPerTask
    || options.policyConfig?.policy?.retry_and_escalation?.token_budget_per_task
    || 150000;
  const maxFiles = options.maxFilesPerTask
    || options.policyConfig?.policy?.scope_control?.max_files_per_task
    || 5;

  // Token Diet: Clamp file context budget between 24KB and 64KB (~6k - 16k tokens)
  const totalContextBudgetBytes = Math.min(Math.max(Math.floor(tokenBudget * 3.2 * 0.12), 24 * 1024), 64 * 1024);
  const expandedFiles = [];
  for (const rawFile of scope) {
    try {
      for (const f of expandScopeItem(repoRoot, rawFile, maxFiles)) {
        if (!expandedFiles.includes(f)) expandedFiles.push(f);
      }
    } catch {
      expandedFiles.push(rawFile);
    }
  }

  const perFileBudgetBytes = Math.min(
    28 * 1024,
    Math.max(14 * 1024, Math.floor(totalContextBudgetBytes / Math.max(1, expandedFiles.length)))
  );
  const keywords = extractTaskKeywords(task);
  const sections = [];

  for (const rawFile of expandedFiles) {
    try {
      const relPath = normalizeOrThrow(repoRoot, rawFile);
      const absPath = path.resolve(repoRoot, relPath);
      if (!fs.existsSync(absPath)) {
        sections.push(`=== FILE: ${relPath} (NEW FILE - DOES NOT EXIST ON DISK YET) ===\n<Empty: Use empty SEARCH block to create this file>`);
        continue;
      }
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        sections.push(`=== DIRECTORY SCOPE: ${relPath} ===`);
        continue;
      }
      const rawContent = fs.readFileSync(absPath, 'utf8');
      const byteLen = Buffer.byteLength(rawContent, 'utf8');
      if (byteLen > perFileBudgetBytes) {
        const sliced = sliceContentByKeywords(rawContent, keywords, perFileBudgetBytes, 80);
        sections.push(`=== FILE: ${relPath} (SMART CONTEXT WINDOW — RELEVANT SECTIONS FOR KEYWORDS: ${keywords.slice(0, 8).join(', ') || 'head/tail'}) ===\n${sliced}`);
      } else {
        sections.push(`=== FILE: ${relPath} (EXISTING CONTENT) ===\n${rawContent}`);
      }
    } catch (err) {
      sections.push(`=== FILE: ${rawFile} (UNREADABLE: ${err.message}) ===`);
    }
  }
  return sections.join('\n\n');
}

/**
 * Strips verbose ASCII greeting banners, passing unit test lines ("... ok"), and Tkinter
 * teardown noise from test output, keeping the tail where FAIL / ERROR / Traceback appear.
 */
export function formatValidationErrorForRetry(errText = '', maxChars = 1800) {
  if (!errText) return '';
  let cleaned = String(errText).replace(/\r\n/g, '\n');

  // 1. Strip the [SQUAD] ASCII banner from test_squad_hello.py
  cleaned = cleaned.replace(
    /={20,}\n\[SQUAD\][\s\S]*?\[OK\][^\n]*\n={20,}\n*/g,
    ''
  );

  // 2. Strip noisy Tkinter background timer teardown warnings
  cleaned = cleaned.replace(
    /invalid command name "[^"]+"\n\s+while executing\n"[^"]+"\n\s+\("after" script\)\n?/g,
    ''
  );

  // 3. Remove standalone passing test lines ("test_xxx (...) ... ok") so tracebacks stand out
  const lines = cleaned.split('\n');
  const filteredLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^test_[A-Za-z0-9_]+\s+\([^)]+\)\s*$/.test(line.trim()) && i + 1 < lines.length && /\.\.\.\s*ok\s*$/.test(lines[i + 1].trim())) {
      i++;
      continue;
    }
    if (/^test_[A-Za-z0-9_]+\s+\([^)]+\)\s*\.\.\.\s*ok\s*$/.test(line.trim())) {
      continue;
    }
    filteredLines.push(line);
  }

  cleaned = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `...[truncated earlier passing output]...\n${cleaned.slice(-maxChars)}`;
}

/**
 * Router Context Builder (Bounded file list + Codebase Google Maps table, NO file contents)
 */
export function buildRouterContext(allowedDirs = [], repoRoot = REPO_ROOT, maxFiles = 300) {
  const sections = [];

  // 1. Extract Codebase Google Maps table from AGENTS.md if present
  const agentsPath = path.resolve(repoRoot, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    try {
      const agentsContent = fs.readFileSync(agentsPath, 'utf8');
      const mapMatch = agentsContent.match(/###\s*Codebase Google Maps[\s\S]*?(?=\n---\n|\n##\s|$)/i);
      if (mapMatch) {
        sections.push(`CODEBASE GOOGLE MAPS (from AGENTS.md):\n${mapMatch[0].trim()}`);
      }
    } catch {}
  }

  // 2. Collect bounded file paths in allowedDirs (skipping __pycache__, .venv, .git, node_modules, .pyc)
  const IGNORED_DIRS = new Set(['__pycache__', '.venv', 'venv', '.git', 'node_modules', '.pytest_cache', '.mypy_cache']);
  const collected = [];

  function walkDir(relDir) {
    if (collected.length >= maxFiles) return;
    const cleanRel = relDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const absDir = path.resolve(repoRoot, cleanRel);
    if (!fs.existsSync(absDir)) return;
    let stat;
    try {
      stat = fs.statSync(absDir);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (!cleanRel.endsWith('.pyc')) collected.push(cleanRel);
      return;
    }
    if (!stat.isDirectory()) return;

    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const childRel = cleanRel ? `${cleanRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(childRel);
      } else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        collected.push(childRel);
      }
    }
  }

  for (const dir of allowedDirs) {
    if (collected.length >= maxFiles) break;
    walkDir(String(dir || ''));
  }

  if (collected.length > 0) {
    const suffix = collected.length >= maxFiles ? `\n... (truncated at ${maxFiles} files)` : '';
    sections.push(`AVAILABLE WORKSPACE FILES (in allowed_dirs):\n${collected.map(f => `- ${f}`).join('\n')}${suffix}`);
  }

  return sections.join('\n\n');
}

/**
 * Reviewer Prompt Builder (Includes constraints + previous review issues only + function-context diff)
 */
export function buildReviewerPrompt(task, diffText, previousReviewIssues = []) {
  const constraintsList = Array.isArray(task.constraints) && task.constraints.length > 0
    ? task.constraints.map(c => `- ${c}`).join('\n')
    : '(None specified)';

  const prevIssuesBlock = Array.isArray(previousReviewIssues) && previousReviewIssues.length > 0
    ? [
        `PREVIOUS REVIEW ISSUES TO VERIFY (From your prior review of this task):`,
        ...previousReviewIssues.map((iss, idx) => `${idx + 1}. ${iss}`),
        `Verify whether the issues above have been resolved without introducing regressions. Do not shift goalposts with unrelated nitpicks.`
      ].join('\n')
    : null;

  return [
    `TASK ID: ${task.task_id}`,
    `GOAL: ${task.goal || task.title}`,
    `CONSTRAINTS:\n${constraintsList}`,
    `ACCEPTANCE CRITERIA: ${(task.acceptance_criteria || []).join('; ')}`,
    prevIssuesBlock,
    `GIT DIFF (WITH FUNCTION CONTEXT):\n${diffText}`
  ].filter(Boolean).join('\n\n');
}
