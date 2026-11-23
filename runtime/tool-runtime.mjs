#!/usr/bin/env node
/**
 * Tool Execution Runtime ("Đôi Tay" của Agent)
 * Part of Agent Runtime (agent-team/runtime/tool-runtime.mjs)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { applyEdits, checkNoSymlinkEscape, normalizeOrThrow, resolveRepoRoot, TEAM_DIR } from '../scripts/applier.mjs';
import { isIgnoredByRules, parseGitignoreRules } from '../scripts/lib/context-builders.mjs';
import { loadMergedPolicy, resolveConfigDir } from '../scripts/lib/policy-loader.mjs';
import { validateFast, validateSuite } from '../scripts/validator.mjs';
import { isForbiddenAttachment } from './context-adapter.mjs';
import { generateRepoMap } from './repo-map.mjs';

export const MAX_READ_LINES = 300;
export const MAX_READ_BYTES = 32768; // 32 KB hard ceiling per read_file call
export const MAX_BATCH_READ_BYTES = 48 * 1024; // 48 KB combined cap across parallel read_file calls in 1 turn
export const MAX_SINGLE_LINE_CHARS = 4096; // Cắt dòng đơn lẻ quá dài (minified files)
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_PATTERN_CHARS = 200;
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024; // 1 MB hard ceiling per searched file

/**
 * Pre-registered OpenAI Tool Schemas
 */
export const TOOL_SCHEMAS = {
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a workspace directory recursively (skipping node_modules, .git, .venv).',
      parameters: {
        type: 'object',
        properties: {
          dir: {
            type: 'string',
            description: 'Relative directory path from repository root (default: empty for root).'
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of file paths to return (default: 200).'
          }
        }
      }
    }
  },

  search_code: {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for text or regex pattern across workspace files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Text string or regex pattern to search for.'
          },
          dir: {
            type: 'string',
            description: 'Relative directory to restrict search (optional).'
          }
        },
        required: ['pattern']
      }
    }
  },

  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read text file lines (max 300/call). Supports parallel read_file calls in 1 turn.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the file to read.'
          },
          start_line: {
            type: 'number',
            description: '1-based starting line number (default: 1).'
          },
          end_line: {
            type: 'number',
            description: '1-based ending line number (inclusive, default: 300).'
          }
        },
        required: ['path']
      }
    }
  },

  apply_patch: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply exact code edits using SEARCH/REPLACE blocks guarded by Applier.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Complete SEARCH/REPLACE blocks format (FILE: <path>\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE).'
          }
        },
        required: ['patch']
      }
    }
  },

  run_validator: {
    type: 'function',
    function: {
      name: 'run_validator',
      description: 'Run project validators (TAB indentation, syntax checks, test suite).',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['fast', 'suite'],
            description: 'Validation mode: "fast" (TAB indentation & quick lint) or "suite" (full tests).'
          }
        }
      }
    }
  },

  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a strictly whitelisted read-only diagnostic or unit-test command (`node --check`, `python -m unittest`, `npm test`, `git status`, `git diff`). Arbitrary shell commands, file writes, package installations, and git commits are blocked to enforce the Applier security boundary.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The whitelisted diagnostic or test command string to execute.'
          },
          timeout_sec: {
            type: 'number',
            description: 'Timeout in seconds (default: 30, max: 60).'
          }
        },
        required: ['command']
      }
    }
  },

  get_repo_map: {
    type: 'function',
    function: {
      name: 'get_repo_map',
      description: 'Generate a concise structural skeleton map of classes, functions, and cross-file references across workspace files, ranked by relevance keywords.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or symbols to rank relevant files/classes/functions first (e.g. "downloader subtitle", "eraser").'
          },
          dir: {
            type: 'string',
            description: 'Optional directory name to restrict search (e.g. "core", "ui_bridge").'
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters returned (default: 3500, ~800 tokens).'
          }
        }
      }
    }
  }
};

/**
 * Returns formatted tool schemas filtered by role allowed_tools.
 */
export function getAvailableToolSchemas(allowedTools = []) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    return [];
  }
  return allowedTools
    .map(name => TOOL_SCHEMAS[name])
    .filter(Boolean);
}

// -------------------------------------------------------------
// Tool Implementations (Executed safely at local workspace)
// -------------------------------------------------------------

const UNSAFE_NESTED_QUANTIFIER_RE = /\([^)]*(?:\+|\*|\{[0-9,]+\})[^)]*\)\s*(?:\+|\*|\{[0-9,]*,[0-9]*\}|\{[2-9][0-9]*\})/;
const UNSAFE_ALTERNATION_QUANTIFIER_RE = /\([^)]*\|[^)]*\)\s*(?:\+|\*|\{[0-9,]*,[0-9]*\}|\{[2-9][0-9]*\})/;

export function isUnsafeSearchRegex(pattern = '') {
  return UNSAFE_NESTED_QUANTIFIER_RE.test(pattern) || UNSAFE_ALTERNATION_QUANTIFIER_RE.test(pattern);
}

export function toolListFiles(repoRoot, args = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  let relDir = '';
  try {
    relDir = args.dir ? normalizeOrThrow(resolvedRoot, args.dir) : '';
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const maxResults = Math.min(args.max_results || 200, 500);
  const targetDir = path.resolve(resolvedRoot, relDir);

  const symCheck = checkNoSymlinkEscape(resolvedRoot, targetDir);
  if (!symCheck.ok) {
    return { ok: false, error: symCheck.error };
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { ok: false, error: `Directory not found: ${relDir || '.'}` };
  }

  const results = [];
  const IGNORED_DIRS = new Set([
    '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
    '.gemini', '.agents', 'sessions', 'runs', 'archive', '.pytest_cache', '.mypy_cache'
  ]);

  function walk(currentDir) {
    if (results.length >= maxResults) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      if (results.length >= maxResults) break;
      if (ent.isSymbolicLink()) continue;

      const entryPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        const isAgentTeamState = ent.name === 'state' && currentDir.replace(/\\/g, '/').endsWith('agent-team');
        if (!IGNORED_DIRS.has(ent.name) && !isAgentTeamState) {
          const subCheck = checkNoSymlinkEscape(resolvedRoot, entryPath);
          if (subCheck.ok) {
            walk(entryPath);
          }
        }
      } else if (ent.isFile()) {
        const rel = path.relative(resolvedRoot, entryPath).split(path.sep).join('/');
        if (!isForbiddenAttachment(rel)) {
          results.push(rel);
        }
      }
    }
  }

  walk(targetDir);
  return {
    ok: true,
    total: results.length,
    truncated: results.length >= maxResults,
    files: results
  };
}

function matchesContextExclude(relPath = '', excludeList = []) {
  if (!Array.isArray(excludeList) || excludeList.length === 0) return false;
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!norm) return false;
  for (const raw of excludeList) {
    const clean = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!clean) continue;
    if (norm === clean || norm.startsWith(`${clean}/`)) return true;
  }
  return false;
}

export function toolSearchCode(repoRoot, args = {}, context = {}) {
  const pattern = args.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return { ok: false, error: 'Search pattern is required' };
  }
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    return { ok: false, error: `Search pattern exceeds maximum length (${MAX_SEARCH_PATTERN_CHARS} chars)` };
  }

  const resolvedRoot = path.resolve(repoRoot);
  const hasExplicitDir = typeof args.dir === 'string' && args.dir.trim().length > 0;
  const gitignoreRules = parseGitignoreRules(resolvedRoot);

  let fallbackPolicy = null;
  if (!hasExplicitDir && (!Array.isArray(context.allowedDirs) || !Array.isArray(context.contextExclude))) {
    try {
      fallbackPolicy = loadRuntimeScopePolicy({ configDir: context.configDir });
    } catch {
      fallbackPolicy = { allowedDirs: [], contextExclude: [] };
    }
  }
  const effectiveContextExclude = Array.isArray(context.contextExclude)
    ? context.contextExclude
    : (fallbackPolicy?.contextExclude || []);

  let candidateFiles = [];
  if (hasExplicitDir) {
    const listRes = toolListFiles(resolvedRoot, { dir: args.dir, max_results: 500 });
    if (!listRes.ok) return listRes;
    candidateFiles = listRes.files.filter(rel => !isIgnoredByRules(rel, false, gitignoreRules));
  } else {
    const configuredDirs = Array.isArray(context.allowedDirs)
      ? context.allowedDirs
      : (Array.isArray(fallbackPolicy?.allowedDirs) ? fallbackPolicy.allowedDirs : []);
    const cleanAllowedDirs = configuredDirs
      .map(d => String(d || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(d => d && d !== 'agent-team' && !d.startsWith('agent-team/'));

    const existingAllowedDirs = [];
    for (const d of cleanAllowedDirs) {
      const absDir = path.resolve(resolvedRoot, d);
      try {
        if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
          existingAllowedDirs.push(d);
        }
      } catch {}
    }

    const dirsToScan = Array.isArray(context.allowedDirs)
      ? existingAllowedDirs
      : (existingAllowedDirs.length > 0 ? existingAllowedDirs : ['']);

    const seen = new Set();
    for (const dir of dirsToScan) {
      const listRes = toolListFiles(resolvedRoot, { dir, max_results: 500 });
      if (!listRes.ok) continue;
      for (const rel of listRes.files) {
        if (seen.has(rel)) continue;
        if (rel === 'agent-team' || rel.startsWith('agent-team/')) continue;
        if (rel.split('/').some(seg => seg.startsWith('.'))) continue;
        if (isIgnoredByRules(rel, false, gitignoreRules)) continue;
        if (matchesContextExclude(rel, effectiveContextExclude)) continue;
        seen.add(rel);
        candidateFiles.push(rel);
      }
    }
  }

  const matches = [];
  let regex = null;
  if (!isUnsafeSearchRegex(pattern)) {
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = null;
    }
  }
  const patternLower = pattern.toLowerCase();

  for (const relFile of candidateFiles) {
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    const fullPath = path.resolve(resolvedRoot, relFile);
    try {
      const symCheck = checkNoSymlinkEscape(resolvedRoot, fullPath);
      if (!symCheck.ok) continue;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isMatch = regex ? regex.test(line) : line.toLowerCase().includes(patternLower);
        if (isMatch) {
          matches.push({
            file: relFile,
            line: i + 1,
            content: line.trim().slice(0, 160)
          });
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    } catch {
      // Ignore binary or unreadable files
    }
  }

  return {
    ok: true,
    count: matches.length,
    truncated: matches.length >= MAX_SEARCH_RESULTS,
    matches
  };
}

export function toolReadFile(repoRoot, args = {}, context = {}) {
  const relPath = args.path;
  if (!relPath) return { ok: false, error: 'File path is required' };

  try {
    const resolvedRoot = path.resolve(repoRoot);
    const safeRel = normalizeOrThrow(resolvedRoot, relPath);
    if (isForbiddenAttachment(safeRel)) {
      return { ok: false, error: `Access denied to sensitive file: ${safeRel}` };
    }

    const fullPath = path.resolve(resolvedRoot, safeRel);
    const symCheck = checkNoSymlinkEscape(resolvedRoot, fullPath);
    if (!symCheck.ok) {
      return { ok: false, error: symCheck.error };
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return { ok: false, error: `File not found: ${safeRel}` };
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    const fileHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const lines = raw.split(/\r?\n/);
    const startLine = Math.max(1, parseInt(args.start_line, 10) || 1);

    if (startLine > lines.length) {
      return { ok: false, error: `start_line (${startLine}) exceeds total file lines (${lines.length})` };
    }

    // Zero-Error Clamping: clamp end_line to MAX_READ_LINES window without throwing
    const rawEnd = parseInt(args.end_line, 10);
    const hasExplicitEnd = !isNaN(rawEnd);
    const requestedEnd = hasExplicitEnd ? Math.max(startLine, rawEnd) : lines.length;
    const targetEnd = Math.min(lines.length, requestedEnd);
    const effectiveEndLine = Math.min(targetEnd, startLine + MAX_READ_LINES - 1);

    let actualEndLine = startLine - 1;
    let accumulatedBytes = 0;
    const numberedLines = [];

    for (let i = startLine - 1; i < effectiveEndLine; i++) {
      let lineText = lines[i];
      if (lineText.length > MAX_SINGLE_LINE_CHARS) {
        lineText = lineText.slice(0, MAX_SINGLE_LINE_CHARS) + ' [... line truncated ...]';
      }
      const lineEntry = `${i + 1}: ${lineText}`;
      const lineBytes = Buffer.byteLength(lineEntry + '\n', 'utf8');

      if (numberedLines.length > 0 && accumulatedBytes + lineBytes > MAX_READ_BYTES) {
        break;
      }
      numberedLines.push(lineEntry);
      accumulatedBytes += lineBytes;
      actualEndLine = i + 1;
    }

    const truncatedByRange = actualEndLine < targetEnd;
    const isPartialFile = actualEndLine < lines.length || startLine > 1;
    let finalContent = numberedLines.join('\n');
    let navigationHint = null;

    if (numberedLines.length > 0 && (truncatedByRange || isPartialFile)) {
      navigationHint = truncatedByRange
        ? `[Showing lines ${startLine}-${actualEndLine} of ${lines.length} (${accumulatedBytes} bytes). To continue reading, call read_file with start_line=${actualEndLine + 1}]`
        : `[Showing lines ${startLine}-${actualEndLine} of ${lines.length} (${accumulatedBytes} bytes)]`;
      finalContent = `${navigationHint}\n${finalContent}`;
    }

    return {
      ok: true,
      file: safeRel,
      file_hash: fileHash,
      total_lines: lines.length,
      start_line: startLine,
      end_line: actualEndLine,
      total_bytes: accumulatedBytes,
      truncated: truncatedByRange,
      navigation_hint: navigationHint,
      content: finalContent
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function loadRuntimeScopePolicy(options = {}) {
  const merged = loadMergedPolicy({ configDir: resolveConfigDir(options.configDir) });
  const sc = merged.policy.scope_control;
  return {
    allowedDirs: sc.allowed_dirs,
    protectedFiles: Array.isArray(sc.protected_files) ? sc.protected_files : [],
    contextExclude: Array.isArray(sc.context_exclude) ? sc.context_exclude : [],
    allowNewFiles: sc.allow_new_files ?? true,
    newFilesOnlyInScope: sc.new_files_only_in_scope ?? true,
    maxScopeIncrease: sc.max_scope_increase ?? 1
  };
}

export function toolApplyPatch(repoRoot, args = {}, context = {}) {
  const patch = args.patch;
  if (!patch || typeof patch !== 'string') {
    return { ok: false, error: 'Patch content cannot be empty' };
  }

  const allowedScope = context.allowedScope || [];
  const fakeTask = {
    task_id: context.sessionId || 'runtime-task',
    scope: allowedScope.length > 0 ? allowedScope : null,
    forbidden_files: Array.isArray(context.forbiddenFiles) ? context.forbiddenFiles : []
  };

  const needsDefaultPolicy = !Array.isArray(context.allowedDirs)
    || !Array.isArray(context.protectedFiles)
    || context.allowNewFiles === undefined
    || context.newFilesOnlyInScope === undefined
    || context.maxScopeIncrease === undefined;
  const defaultPolicy = needsDefaultPolicy ? loadRuntimeScopePolicy() : {};
  const effectiveAllowedDirs = Array.isArray(context.allowedDirs)
    ? context.allowedDirs
    : defaultPolicy.allowedDirs;
  const effectiveProtectedFiles = Array.isArray(context.protectedFiles)
    ? context.protectedFiles
    : defaultPolicy.protectedFiles;
  const effectiveAllowNewFiles = context.allowNewFiles ?? defaultPolicy.allowNewFiles;
  const effectiveNewFilesOnlyInScope = context.newFilesOnlyInScope ?? defaultPolicy.newFilesOnlyInScope;
  const effectiveMaxScopeIncrease = context.maxScopeIncrease ?? defaultPolicy.maxScopeIncrease;

  try {
    const applyRes = applyEdits(patch, fakeTask, {
      repoRoot,
      allowedDirs: effectiveAllowedDirs,
      protectedFiles: effectiveProtectedFiles,
      allowNewFiles: effectiveAllowNewFiles,
      newFilesOnlyInScope: effectiveNewFilesOnlyInScope,
      maxScopeIncrease: effectiveMaxScopeIncrease
    });
    return applyRes;
  } catch (err) {
    return { ok: false, error: `Applier exception: ${err.message}` };
  }
}

export async function toolRunValidator(args = {}) {
  const mode = args.mode || 'fast';
  try {
    if (mode === 'fast') {
      const res = await validateFast();
      return { ok: res.ok, mode: 'fast', details: res };
    }
    const res = await validateSuite();
    return { ok: res.ok, mode: 'suite', details: res };
  } catch (err) {
    return { ok: false, mode, error: err.message };
  }
}

export const DANGEROUS_COMMAND_PATTERNS = [
  /\bformat\s+[a-z]:/i,
  /^\s*(?:del|erase|rmdir|rd|rm|type|cat|get-content|gc|set-content|sc|add-content|ac|out-file|remove-item|ri|copy-item|move-item|new-item|ni)\b/i,
  /\bshutdown\b/i,
  /\breg\s+(?:delete|add)\b/i,
  /\bnet\s+user\b/i,
  /\bvssadmin\b/i,
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  /\.env\b/i,
  /\bgit\s+(?:commit|push|reset|checkout|clean|rebase|merge|am|apply|stash)\b/i,
  /\bgit\b[\s\S]*(?:--output(?:\s|=|$)|--ext-diff\b|--exec(?:\s|=|$)|(?:^|\s)-c(?:\s|=|$))/i,
  /\bgit\s+branch\b[\s\S]*(?:(?:^|\s)-[a-zA-Z]*[dDmMfFcC][a-zA-Z]*\b|--(?:delete|move|force|copy|edit-description|set-upstream-to|unset-upstream)(?:\s|=|$))/i,
  /\b(?:pip|pip3|npm|pnpm|yarn)\s+(?:install|i|add|remove|uninstall|update)\b/i,
  /\b(?:open\s*\(|writeFileSync|writeFile|appendFile|unlink|rmSync|rmdirSync|child_process|execSync|spawn)\b/i,
  /[;&|><`]|\$\(/
];

export const ALLOWED_DIAGNOSTIC_COMMAND_PATTERNS = [
  /^node\s+--check\s+[\w./\\-]+$/i,
  /^node\s+(?:agent-team\/)?scripts\/(?:test-[\w.-]+|validator\.mjs)(?:\s+[\w-]+)?$/i,
  /^npm\s+(?:test|run\s+test(?::[\w:-]+)?)$/i,
  /^(?:python|python3|\.\\\.venv\\Scripts\\python\.exe)\s+-m\s+(?:unittest|py_compile)\b[\w\s./\\-]*$/i,
  /^git\s+(?:status|diff|log|branch)(?:\s+[\w./\\-]+)*$/i
];

const GIT_SAFE_BRANCH_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
  '-l', '--list', '--show-current', '--merged', '--no-merged',
  '--contains', '--no-contains', '--abbrev', '--no-abbrev',
  '--color', '--no-color', '--column', '--no-column'
]);
const GIT_DANGEROUS_ARG_RE = /^(?:--output(?:=.*)?|--ext-diff|--exec(?:=.*)?|-c|-C)$/i;
const GIT_BRANCH_MUTATING_ARG_RE = /^(?:-[a-zA-Z]*[dDmMfFcC][a-zA-Z]*|--(?:delete|move|force|copy|edit-description|set-upstream-to|unset-upstream)(?:=.*)?)$/;

export function parseDiagnosticCommand(cmd = '', platform = process.platform) {
  const normalized = String(cmd).trim();
  if (!normalized) {
    return { ok: false, error: 'Command cannot be empty' };
  }

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        ok: false,
        error: `SECURITY_BLOCKED: Command was rejected by security guardrails: "${normalized.slice(0, 80)}"`
      };
    }
  }

  const matchesWhitelist = ALLOWED_DIAGNOSTIC_COMMAND_PATTERNS.some(pattern => pattern.test(normalized));
  if (!matchesWhitelist) {
    return {
      ok: false,
      error: `SECURITY_BLOCKED: Command was rejected by security guardrails: "${normalized.slice(0, 80)}"`
    };
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const head = tokens[0].toLowerCase();

  if (head === 'node') {
    if (tokens[1] === '--check') {
      const target = tokens[2] || '';
      if (!target || target.split(/[\\/]/).includes('..')) {
        return {
          ok: false,
          error: `SECURITY_BLOCKED: Invalid path argument for node --check: "${normalized.slice(0, 80)}"`
        };
      }
    }
    return { ok: true, executable: 'node', args: tokens.slice(1) };
  }

  if (head === 'npm') {
    const npmArgs = tokens.slice(1);
    if (platform === 'win32') {
      return {
        ok: true,
        executable: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm.cmd', ...npmArgs]
      };
    }
    return { ok: true, executable: 'npm', args: npmArgs };
  }

  if (head === 'git') {
    const sub = (tokens[1] || '').toLowerCase();
    const gitRest = tokens.slice(2);
    for (const arg of gitRest) {
      if (GIT_DANGEROUS_ARG_RE.test(arg)) {
        return {
          ok: false,
          error: `SECURITY_BLOCKED: Dangerous git flag rejected: "${arg}"`
        };
      }
    }
    if (sub === 'branch') {
      let allowPatternArg = false;
      for (const arg of gitRest) {
        if (GIT_BRANCH_MUTATING_ARG_RE.test(arg)) {
          return {
            ok: false,
            error: `SECURITY_BLOCKED: Mutating git branch flag rejected: "${arg}"`
          };
        }
        if (arg.startsWith('-')) {
          if (!GIT_SAFE_BRANCH_FLAGS.has(arg)) {
            return {
              ok: false,
              error: `SECURITY_BLOCKED: Unsupported git branch flag rejected: "${arg}"`
            };
          }
          if (arg === '-l' || arg === '--list' || arg === '--contains' || arg === '--no-contains' || arg === '--merged' || arg === '--no-merged') {
            allowPatternArg = true;
          }
        } else if (!allowPatternArg) {
          return {
            ok: false,
            error: `SECURITY_BLOCKED: Positional git branch argument rejected: "${arg}"`
          };
        }
      }
    }
    return { ok: true, executable: 'git', args: tokens.slice(1) };
  }

  return { ok: true, executable: tokens[0], args: tokens.slice(1) };
}

export function isDangerousCommand(cmd = '') {
  return !parseDiagnosticCommand(cmd).ok;
}

export function toolRunCommand(repoRoot, args = {}) {
  const rawCmd = (args.command || '').trim();
  if (!rawCmd) {
    return Promise.resolve({ ok: false, error: 'Command cannot be empty' });
  }

  const parsed = parseDiagnosticCommand(rawCmd);
  if (!parsed.ok) {
    return Promise.resolve({
      ok: false,
      error: parsed.error
    });
  }

  const timeoutSec = Math.min(Math.max(args.timeout_sec || 30, 5), 60);
  const timeoutMs = timeoutSec * 1000;
  const start = Date.now();

  return new Promise((resolve) => {
    execFile(parsed.executable, parsed.args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const MAX_OUTPUT_CHARS = 4000;

      let outStr = (stdout || '').trim();
      let errStr = (stderr || '').trim();
      let truncated = false;

      if (outStr.length > MAX_OUTPUT_CHARS) {
        outStr = outStr.slice(0, MAX_OUTPUT_CHARS) + `\n[... Truncated ${outStr.length - MAX_OUTPUT_CHARS} chars ...]`;
        truncated = true;
      }
      if (errStr.length > MAX_OUTPUT_CHARS) {
        errStr = errStr.slice(0, MAX_OUTPUT_CHARS) + `\n[... Truncated ${errStr.length - MAX_OUTPUT_CHARS} chars ...]`;
        truncated = true;
      }

      if (error) {
        const isTimeout = error.killed || error.signal === 'SIGTERM';
        resolve({
          ok: false,
          exit_code: error.code || (isTimeout ? 124 : 1),
          error: isTimeout ? `Command timed out after ${timeoutSec}s` : error.message,
          stdout: outStr,
          stderr: errStr,
          duration_ms: durationMs,
          truncated
        });
        return;
      }

      resolve({
        ok: true,
        exit_code: 0,
        stdout: outStr,
        stderr: errStr,
        duration_ms: durationMs,
        truncated
      });
    });
  });
}

/**
 * Structural Repo-Map tool handler
 */
export function toolGetRepoMap(repoRoot, args = {}, context = {}) {
  const allowedDirs = args.dir ? [args.dir] : [];
  const rawScope = Array.isArray(args.scope_files)
    ? args.scope_files
    : (Array.isArray(context.allowedScope) && !context.allowedScope.includes('*') ? context.allowedScope : []);
  const mapStr = generateRepoMap(repoRoot, {
    allowedDirs,
    query: args.query || '',
    scopeFiles: rawScope,
    maxChars: Math.min(args.max_chars || 3500, 8000)
  });
  return {
    ok: true,
    map: mapStr || '(No matching symbols found)'
  };
}

/**
 * Universal Tool Dispatcher with RBAC Guard
 */
export async function executeTool(toolName, args = {}, context = {}) {
  const repoRoot = context.repoRoot || resolveRepoRoot();
  const allowedTools = context.allowedTools || [];

  // 1. Role RBAC Guard
  if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    return {
      ok: false,
      error: `PERMISSION_DENIED: Tool "${toolName}" is not allowed for role "${context.role || 'unknown'}". Allowed tools: [${allowedTools.join(', ')}]`
    };
  }

  // 2. Dispatch
  switch (toolName) {
    case 'list_files':
      return toolListFiles(repoRoot, args);
    case 'search_code':
      return toolSearchCode(repoRoot, args, context);
    case 'read_file':
      return toolReadFile(repoRoot, args, context);
    case 'get_repo_map':
      return toolGetRepoMap(repoRoot, args, context);
    case 'apply_patch':
      return toolApplyPatch(repoRoot, args, context);
    case 'run_validator':
      return await toolRunValidator(args);
    case 'run_command':
      return await toolRunCommand(repoRoot, args);
    default:
      return { ok: false, error: `Unknown tool: "${toolName}"` };
  }
}
