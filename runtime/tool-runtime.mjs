#!/usr/bin/env node
/**
 * Tool Execution Runtime ("Đôi Tay" của Agent)
 * Part of Agent Runtime (agent-team/runtime/tool-runtime.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, normalizeOrThrow, resolveRepoRoot } from '../scripts/applier.mjs';
import { validateFast, validateSuite } from '../scripts/validator.mjs';
import { isForbiddenAttachment } from './context-adapter.mjs';

export const MAX_READ_LINES = 300;
export const MAX_SEARCH_RESULTS = 50;

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
      description: 'Read contents of a text file within line range (max 300 lines per call).',
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

export function toolListFiles(repoRoot, args = {}) {
  const relDir = args.dir ? normalizeOrThrow(repoRoot, args.dir) : '';
  const maxResults = Math.min(args.max_results || 200, 500);
  const targetDir = path.resolve(repoRoot, relDir);

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { ok: false, error: `Directory not found: ${relDir || '.'}` };
  }

  const results = [];
  const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.gemini']);

  function walk(currentDir) {
    if (results.length >= maxResults) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      if (results.length >= maxResults) break;
      if (ent.isDirectory()) {
        if (!IGNORED_DIRS.has(ent.name)) {
          walk(path.join(currentDir, ent.name));
        }
      } else if (ent.isFile()) {
        const rel = path.relative(repoRoot, path.join(currentDir, ent.name)).split(path.sep).join('/');
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

export function toolSearchCode(repoRoot, args = {}) {
  const pattern = args.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return { ok: false, error: 'Search pattern is required' };
  }

  const listRes = toolListFiles(repoRoot, { dir: args.dir, max_results: 500 });
  if (!listRes.ok) return listRes;

  const matches = [];
  let regex = null;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = null;
  }

  for (const relFile of listRes.files) {
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    const fullPath = path.resolve(repoRoot, relFile);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isMatch = regex ? regex.test(line) : line.includes(pattern);
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

export function toolReadFile(repoRoot, args = {}) {
  const relPath = args.path;
  if (!relPath) return { ok: false, error: 'File path is required' };

  try {
    const safeRel = normalizeOrThrow(repoRoot, relPath);
    if (isForbiddenAttachment(safeRel)) {
      return { ok: false, error: `Access denied to sensitive file: ${safeRel}` };
    }

    const fullPath = path.resolve(repoRoot, safeRel);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return { ok: false, error: `File not found: ${safeRel}` };
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const startLine = Math.max(1, parseInt(args.start_line, 10) || 1);
    const endLine = Math.min(lines.length, parseInt(args.end_line, 10) || (startLine + MAX_READ_LINES - 1));

    if (startLine > lines.length) {
      return { ok: false, error: `start_line (${startLine}) exceeds total file lines (${lines.length})` };
    }

    const requestedCount = endLine - startLine + 1;
    if (requestedCount > MAX_READ_LINES) {
      return { ok: false, error: `Maximum read window is ${MAX_READ_LINES} lines per call (requested ${requestedCount})` };
    }

    const sliced = lines.slice(startLine - 1, endLine);
    const numbered = sliced.map((l, idx) => `${startLine + idx}: ${l}`).join('\n');

    return {
      ok: true,
      file: safeRel,
      total_lines: lines.length,
      start_line: startLine,
      end_line: endLine,
      content: numbered
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function toolApplyPatch(repoRoot, args = {}, context = {}) {
  const patch = args.patch;
  if (!patch || typeof patch !== 'string') {
    return { ok: false, error: 'Patch content cannot be empty' };
  }

  const allowedScope = context.allowedScope || [];
  const fakeTask = {
    task_id: context.sessionId || 'runtime-task',
    scope: allowedScope.length > 0 ? allowedScope : null
  };

  try {
    const applyRes = applyEdits(patch, fakeTask, {
      repoRoot,
      allowedDirs: context.allowedDirs || null
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
      return toolSearchCode(repoRoot, args);
    case 'read_file':
      return toolReadFile(repoRoot, args);
    case 'apply_patch':
      return toolApplyPatch(repoRoot, args, context);
    case 'run_validator':
      return await toolRunValidator(args);
    default:
      return { ok: false, error: `Unknown tool: "${toolName}"` };
  }
}
