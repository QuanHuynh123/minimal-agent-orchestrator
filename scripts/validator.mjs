#!/usr/bin/env node
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  checkAllowedDirs,
  checkForbidden,
  isFileInScope,
  normalizeOrThrow,
  resolveRepoRoot
} from './applier.mjs';
import { getModifiedFiles } from './git-guard.mjs';
import {
  captureProcessSocketSnapshot,
  formatSocketSnapshotSummary,
  isEnobufsFailure
} from './lib/enobufs-diagnostics.mjs';
import { loadMergedPolicy, loadMergedProjectConfig } from './lib/policy-loader.mjs';
import { extractAstDeclaredIdentifiers, extractSymbolsFromCode, extractTreeSitterSymbolUsage } from '../runtime/repo-map.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = resolveRepoRoot();

/**
 * Strips volatile timing, memory addresses, ISO timestamps, raw output paths,
 * line numbers, and specific file names before hashing so identical error classes
 * (e.g. Truncated SEARCH-REPLACE block or SEARCH block N not found) produce the
 * exact same SHA-1 hash across files and runs.
 */
export function normalizeErrorForHash(str = '') {
  return String(str)
    .replace(/\r\n/g, '\n')
    .replace(/\s*\(raw output(?: saved)?:\s*[^)]+\)/gi, '')
    .replace(/Ran \d+ tests? in [\d.]+s/gi, 'Ran N tests in Xs')
    .replace(/\b\d+\.\d+\s*(?:ms|s|sec|seconds)\b/gi, '<DURATION>')
    .replace(/0x[0-9a-fA-F]{6,16}/g, '0x<ADDR>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ISO_TIME>')
    .replace(/\.tmp\.\d+/g, '.tmp.<TS>')
    .replace(/SEARCH block \d+/gi, 'SEARCH block <N>')
    .replace(/\bin\s+"[^"]+"/gi, 'in "<FILE>"')
    .replace(/\b(?:line|lines)\s+\d+(?:\s*-\s*\d+)?/gi, 'line <N>')
    .replace(/(?:[a-zA-Z]:[\\/]|(?:\.\.?[\\/])+)[\w.\-/\\]+/g, '<PATH>')
    .trim();
}

export function hashString(str) {
  return crypto.createHash('sha1').update(normalizeErrorForHash(str)).digest('hex');
}

export function loadProjectConfig(options = {}) {
  return loadMergedProjectConfig(options);
}

export function loadPolicyConfig(options = {}) {
  return loadMergedPolicy(options);
}

export function checkCommandGuardrails(cmd = '', timeoutMs = 60000, guardrails = {}) {
  const banUnbounded = guardrails.ban_unbounded_commands ?? true;
  const blockCurlAlias = guardrails.block_powershell_curl_alias ?? true;

  if (banUnbounded && (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs))) {
    return {
      ok: false,
      error: `GUARDRAIL (HR-1): Unbounded command without explicit timeout is forbidden: "${cmd}"`
    };
  }

  if (blockCurlAlias && process.platform === 'win32') {
    const hasBareCurl = /(?:^|[;&|]\s*)curl(?!\.exe)\b/i.test(cmd);
    if (hasBareCurl) {
      return {
        ok: false,
        error: `GUARDRAIL (HR-2): Bare PowerShell 'curl' alias is forbidden on Windows. Use 'curl.exe --connect-timeout 2 --max-time 5': "${cmd}"`
      };
    }
  }

  return { ok: true };
}

/**
 * Runtime Permission & Scope Audit Gate for IDE Direct / Quick Mode.
 * Inspects git modified files and verifies none violate protected_files, allowed_dirs, or declared scope.
 */
export function auditGitScope(declaredScope = [], options = {}) {
  const policyCfg = loadPolicyConfig();
  const projCfg = options.projectConfig || loadProjectConfig() || {};
  const repoRoot = resolveRepoRoot(policyCfg?.policy?.repo_root ? policyCfg : projCfg);
  const allowedDirs = options.allowedDirs
    || projCfg.project?.allowed_dirs
    || policyCfg.policy.scope_control.allowed_dirs;
  const protectedFiles = options.protectedFiles
    || policyCfg.policy?.scope_control?.protected_files
    || policyCfg.policy?.protected_files
    || projCfg.project?.protected_files
    || [];
  const targetFilter = options.checkAllWorktree ? [] : declaredScope;

  const modified = options.modifiedFiles || getModifiedFiles(targetFilter);
  const violations = [];

  for (const rawFile of modified) {
    let relPath;
    try {
      relPath = normalizeOrThrow(repoRoot, rawFile);
    } catch (err) {
      violations.push(`Illegal path "${rawFile}": ${err.message}`);
      continue;
    }

    const fCheck = checkForbidden(relPath, protectedFiles, options.forbiddenFiles || []);
    if (fCheck.forbidden) {
      violations.push(`SECURITY: Protected file modified "${relPath}" (matched "${fCheck.pattern}")`);
      continue;
    }

    if (!checkAllowedDirs(relPath, allowedDirs)) {
      violations.push(`Outside allowed_dirs: "${relPath}"`);
      continue;
    }

    if (declaredScope.length > 0 && !isFileInScope(relPath, declaredScope)) {
      violations.push(`Out-of-scope file modified: "${relPath}" (declared scope: ${declaredScope.join(', ')})`);
    }
  }

  return {
    ok: violations.length === 0,
    modified_files: modified,
    violations
  };
}

function collectDefinedSymbolNames(syms = {}) {
  const names = new Set();
  for (const fn of (syms.functions || [])) {
    if (fn?.name) names.add(fn.name);
  }
  for (const cls of (syms.classes || [])) {
    if (cls?.name) names.add(cls.name);
    for (const m of (cls.methods || [])) {
      if (m?.name) names.add(m.name);
    }
  }
  return names;
}

function dedentLines(lines = []) {
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join('\n');
  let minIndent = Infinity;
  for (const l of nonEmpty) {
    const m = l.match(/^[ \t]*/);
    const len = m ? m[0].length : 0;
    if (len < minIndent) minIndent = len;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return lines.join('\n');
  return lines.map(l => (l.length >= minIndent ? l.slice(minIndent) : l)).join('\n');
}

function isTestFileRelPath(filePath = '') {
  const clean = String(filePath || '').replace(/\\/g, '/');
  return /(?:^|\/)tests?\//i.test(clean)
    || /(?:^|\/)__tests__\//i.test(clean)
    || /\.(?:test|spec)\.(?:py|mjs|js|ts|tsx|jsx)$/i.test(clean)
    || /(?:^|\/)test[-_][^/]+\.(?:py|mjs|js|ts|tsx|jsx)$/i.test(clean);
}

function extractRemovedCodeSymbols(fileDiffs = [], options = {}) {
  const removedSymbols = new Set();
  if (options.beforeByFile && options.afterByFile) {
    for (const filePath of Object.keys(options.beforeByFile)) {
      if (isTestFileRelPath(filePath)) continue;
      const beforeNames = collectDefinedSymbolNames(extractSymbolsFromCode(filePath, options.beforeByFile[filePath] || ''));
      const afterNames = collectDefinedSymbolNames(extractSymbolsFromCode(filePath, options.afterByFile[filePath] || ''));
      for (const name of beforeNames) {
        if (!afterNames.has(name)) removedSymbols.add(name);
      }
    }
    return removedSymbols;
  }

  for (const block of fileDiffs) {
    const headerMatch = block.match(/^a\/([^\s]+)\s+b\/([^\s]+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2].replace(/\\/g, '/');
    if (isTestFileRelPath(filePath)) continue;

    const lines = block.split('\n');
    const removedLines = [];
    const addedLines = [];
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('-')) removedLines.push(line.slice(1));
      else if (line.startsWith('+')) addedLines.push(line.slice(1));
    }
    if (removedLines.length === 0) continue;

    const beforeNames = collectDefinedSymbolNames(extractSymbolsFromCode(filePath, dedentLines(removedLines)));
    const afterNames = collectDefinedSymbolNames(extractSymbolsFromCode(filePath, dedentLines(addedLines)));
    for (const name of beforeNames) {
      if (!afterNames.has(name)) removedSymbols.add(name);
    }
  }
  return removedSymbols;
}

function extractDeletedTestFunctionBlocks(filePath = '', lines = []) {
  const deletedBlocks = [];
  const addedTestNames = new Set();
  let activeBlock = null;

  const testDefMatch = (code) => {
    const py = code.match(/^(?:async\s+)?def\s+(test_\w+)\b/);
    if (py) return py[1];
    const jsFn = code.match(/^(?:export\s+)?(?:async\s+)?function\s+(test\w*)\b/);
    if (jsFn) return jsFn[1];
    const jsCall = code.match(/^(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (jsCall) return jsCall[1];
    return null;
  };

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (activeBlock) {
        deletedBlocks.push(activeBlock);
        activeBlock = null;
      }
      const name = testDefMatch(line.slice(1).trim());
      if (name) addedTestNames.add(name);
    } else if (line.startsWith('-')) {
      const raw = line.slice(1);
      const name = testDefMatch(raw.trim());
      if (name) {
        if (activeBlock) deletedBlocks.push(activeBlock);
        activeBlock = { testName: name, lines: [raw] };
      } else if (activeBlock) {
        activeBlock.lines.push(raw);
      }
    } else {
      if (activeBlock) {
        deletedBlocks.push(activeBlock);
        activeBlock = null;
      }
    }
  }
  if (activeBlock) deletedBlocks.push(activeBlock);

  return deletedBlocks
    .filter(b => !addedTestNames.has(b.testName))
    .map(b => {
      const dedented = dedentLines(b.lines);
      const usage = extractTreeSitterSymbolUsage(filePath, dedented);
      return {
        testName: b.testName,
        refs: usage?.executableRefs || new Set()
      };
    });
}

/**
 * Deterministic 0-Token Test-Suite Preservation Guard.
 * Inspects git diffs on modified test files (`tests/**` or `test_*` or `*.test.*`) to ensure an agent
 * did not pass validation by gutting assertions (`assertTrue(True)`), skipping tests
 * (`@unittest.skip`, `pytest.skip`, `.skip(`), or deleting tests without explicit `kind: remove`
 * + Tree-sitter verification that deleted tests referenced removed code symbol(s).
 */
export function verifyTestDiffIntegrity(diffText = '', task = {}, options = {}) {
  if (!diffText || typeof diffText !== 'string') {
    return { ok: true, violations: [] };
  }

  const violations = [];
  const fileDiffs = diffText.split(/^diff --git /m).filter(Boolean);
  const removedCodeSymbols = extractRemovedCodeSymbols(fileDiffs, options);

  const rawDeclaredKind = String(task?.declared_kind ?? task?.kind ?? '').trim().toLowerCase();
  const kindSource = String(task?.kind_source || '').trim().toLowerCase();
  const isExplicitRemove = rawDeclaredKind === 'remove' && kindSource !== 'heuristic';

  for (const block of fileDiffs) {
    const headerMatch = block.match(/^a\/([^\s]+)\s+b\/([^\s]+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2].replace(/\\/g, '/');
    if (!isTestFileRelPath(filePath)) continue;

    const lines = block.split('\n');
    let addedAssertions = 0;
    let removedAssertions = 0;
    let addedTestFuncs = 0;
    let removedTestFuncs = 0;

    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) {
        const code = line.slice(1).trim();
        if (code.startsWith('#') || code.startsWith('//')) continue;

        // 1. Detect newly injected unconditional test skips
        if (/(?:@unittest\.skip\b|@pytest\.mark\.skip\b|\bpytest\.skip\s*\(|\b(?:it|test|describe)\.skip\s*\()/i.test(code)) {
          violations.push(`Test integrity violation in "${filePath}": Unconditional test skip added (${code.slice(0, 80)})`);
        }

        // 2. Detect trivial tautological assertions (e.g. assertTrue(True), assert True)
        if (/(?:self\.assertTrue\s*\(\s*True\s*\)|^\s*assert\s+True\b|expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\))/.test(code)) {
          violations.push(`Test integrity violation in "${filePath}": Tautological assertion added (${code.slice(0, 80)})`);
        }

        if (/(?:self\.assert\w+|assert\s+|expect\s*\()/.test(code)) addedAssertions++;
        if (/^(?:async\s+)?def\s+test_\w+|^(?:it|test)\s*\(|^(?:export\s+)?(?:async\s+)?function\s+test\w*/.test(code)) addedTestFuncs++;
      } else if (line.startsWith('-')) {
        const code = line.slice(1).trim();
        if (code.startsWith('#') || code.startsWith('//')) continue;
        if (/(?:self\.assert\w+|assert\s+|expect\s*\()/.test(code)) removedAssertions++;
        if (/^(?:async\s+)?def\s+test_\w+|^(?:it|test)\s*\(|^(?:export\s+)?(?:async\s+)?function\s+test\w*/.test(code)) removedTestFuncs++;
      }
    }

    // 3. Test deletion allowed ONLY when kind="remove" is explicitly declared (never regex heuristic)
    // AND deleted test(s) reference code symbol(s) actually removed in implementation diff via Tree-sitter AST.
    const deletedBlocks = extractDeletedTestFunctionBlocks(filePath, lines);
    const hasDeletedNamedTests = deletedBlocks.length > 0;
    const hasNetTestFunctionRemoval = removedTestFuncs > addedTestFuncs;
    const hasAssertionGutting = removedAssertions >= 5 && addedAssertions === 0;
    if (hasDeletedNamedTests || hasNetTestFunctionRemoval || hasAssertionGutting) {
      if (!isExplicitRemove) {
        const deletedNamesNote = hasDeletedNamedTests
          ? ` [deleted: ${deletedBlocks.map(b => b.testName).join(', ')}]`
          : '';
        violations.push(
          `Test integrity violation in "${filePath}": Deleting tests/assertions requires explicit kind="remove" (kind="${rawDeclaredKind || 'unset'}", never inferred by regex); removed ${removedTestFuncs} test(s), added ${addedTestFuncs}${deletedNamesNote}.`
        );
      } else {
        if (removedCodeSymbols.size === 0) {
          violations.push(
            `Test integrity violation in "${filePath}": kind="remove" deleted test(s) but Tree-sitter detected 0 removed symbols in implementation diff.`
          );
        } else {
          for (const tBlock of deletedBlocks) {
            const referencesRemovedSymbol = [...removedCodeSymbols].some(sym => tBlock.refs.has(sym));
            if (!referencesRemovedSymbol) {
              violations.push(
                `Test integrity violation in "${filePath}": Deleted test "${tBlock.testName}" does not reference any removed symbol via Tree-sitter AST (removed symbols: ${[...removedCodeSymbols].join(', ')}).`
              );
            }
          }
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}

const DELETED_ID_UTILITY_CLASS_RE = /^(?:text|bg|p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|w|h|size|min|max|gap|flex|grid|cols|rows|col|row|shrink|grow|basis|border|divide|ring|outline|rounded|shadow|hover|focus|active|dark|sm|md|lg|xl|2xl|space|items|justify|place|self|content|font|leading|tracking|decoration|underline|align|whitespace|break|z|top|left|right|bottom|inset|opacity|duration|transition|ease|delay|animate|overflow|object|aspect|box|float|clear|order|cursor|select|resize|appearance|pointer|truncate|fill|stroke|scale|rotate|translate|skew|origin|accent|caret|scroll|snap|touch|will|group|peer|sr|not|backdrop|brightness|contrast|drop|grayscale|hue|invert|saturate|sepia|from|via|to|mix)-/;

const GENERIC_LOCAL_VAR_NAMES = new Set([
  'cur', 'val', 'tmp', 'idx', 'key', 'ret', 'res', 'out', 'err', 'obj', 'arr',
  'str', 'num', 'cnt', 'len', 'msg', 'url', 'cfg', 'ctx', 'opt', 'opts', 'arg',
  'args', 'data', 'info', 'list', 'name', 'text', 'line', 'lines', 'mode', 'kind',
  'type', 'flag', 'done', 'item', 'node', 'elem', 'evt', 'btn', 'row', 'col',
  'box', 'rect', 'main', 'self', 'cls', 'this', 'that', 'prev', 'next', 'acc'
]);

const SCANNABLE_CODE_EXTS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.py', '.vue', '.svelte'
]);

const DELETED_ID_IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gemini', 'dist', 'build', 'artifacts', 'patches',
  'benchmarks', '.idea', '.vscode', '.claude', '.agents', '.agent'
]);

function escapeRegExpLiteral(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExcludedFromDeletedIdScan(relPath = '', extraExcludes = []) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return true;
  if (norm.startsWith('agent-team/') || norm === 'agent-team') return true;
  if (norm.startsWith('docs/') || norm === 'docs') return true;
  const segments = norm.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (DELETED_ID_IGNORED_DIRS.has(seg)) return true;
    if (/^fixtures?$/i.test(seg) || /_fixtures?$/i.test(seg)) return true;
  }
  for (const ex of extraExcludes) {
    const cleanEx = String(ex || '').replace(/\\/g, '/').replace(/\*.*$/, '').replace(/\/+$/, '');
    if (cleanEx && (norm === cleanEx || norm.startsWith(`${cleanEx}/`))) return true;
  }
  return false;
}

function walkScannableRepoFiles(repoRoot, extraExcludes = []) {
  const out = [];
  if (!repoRoot || !fs.existsSync(repoRoot)) return out;
  const walk = (absDir, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (rel === 'agent-team' || rel === 'docs') continue;
        if (DELETED_ID_IGNORED_DIRS.has(ent.name)) continue;
        if (/^fixtures?$/i.test(ent.name) || /_fixtures?$/i.test(ent.name)) continue;
        if (isExcludedFromDeletedIdScan(`${rel}/dummy`, extraExcludes)) continue;
        walk(path.join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!SCANNABLE_CODE_EXTS.has(ext)) continue;
        if (!isExcludedFromDeletedIdScan(rel, extraExcludes)) {
          out.push(rel);
        }
      }
    }
  };
  walk(repoRoot, '');
  return out;
}

function isCustomCssClassCandidate(token = '') {
  if (!token || token.length < 4) return false;
  if (/[:[\]/${}]/.test(token)) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_-]{3,}$/.test(token)) return false;
  if (!/[-_]/.test(token)) return false;
  if (DELETED_ID_UTILITY_CLASS_RE.test(token)) return false;
  return true;
}

function extractHtmlAndCssIdentifiers(text = '') {
  const found = [];
  const seen = new Set();
  const add = (name, kind) => {
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ name, kind });
    }
  };
  for (const m of String(text).matchAll(/\bid\s*=\s*["']([A-Za-z_][A-Za-z0-9_-]{2,})["']/g)) {
    add(m[1], 'id');
  }
  for (const m of String(text).matchAll(/\bclass\s*=\s*["']([^"']+)["']/g)) {
    if (m[1].includes('${') || m[1].includes('{{')) continue;
    for (const tok of m[1].trim().split(/\s+/)) {
      if (isCustomCssClassCandidate(tok)) {
        add(tok, 'class');
      }
    }
  }
  for (const m of String(text).matchAll(/(?:^|[\n}\s,;])#([A-Za-z_][A-Za-z0-9_-]{2,})\s*[{,:>+~[]/gm)) {
    if (!/^[0-9a-fA-F]{3,8}$/.test(m[1])) {
      add(m[1], 'id');
    }
  }
  for (const m of String(text).matchAll(/(?:^|[\n}\s,;])\.([A-Za-z_][A-Za-z0-9_-]{3,})\s*[{,:>+~[]/gm)) {
    if (isCustomCssClassCandidate(m[1])) {
      add(m[1], 'class');
    }
  }
  return found;
}

function extractScriptBodiesFromHtml(htmlText = '') {
  const bodies = [];
  for (const m of String(htmlText).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1] && m[1].trim()) bodies.push(m[1]);
  }
  return bodies;
}

function extractJsLinesFromDiffHtml(lines = []) {
  return lines.filter(line => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('<') || t.startsWith('<!--') || t.startsWith('-->')) return false;
    return true;
  });
}

function extractCodeDeclarationsFromDiffLines(filePath, lines = [], { isAfterFullFile = false } = {}) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const isMarkup = ['.html', '.htm', '.vue', '.svelte'].includes(ext);
  const isStyle = ['.css', '.scss'].includes(ext);
  const results = [];
  const seen = new Set();
  const add = (name, kind) => {
    if (!name || name.length < 3) return;
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ name, kind });
    }
  };

  if (isMarkup || isStyle) {
    for (const item of extractHtmlAndCssIdentifiers(lines.join('\n'))) {
      add(item.name, item.kind);
    }
  }
  if (isStyle) return results;

  const rawJoined = lines.join('\n');
  if (isMarkup) {
    const blocks = isAfterFullFile ? extractScriptBodiesFromHtml(rawJoined) : [dedentLines(extractJsLinesFromDiffHtml(lines))];
    const minJsIndent = (() => {
      let min = Infinity;
      for (const l of extractJsLinesFromDiffHtml(lines)) {
        if (!l.trim()) continue;
        const m = l.match(/^[ \t]*/);
        min = Math.min(min, m ? m[0].length : 0);
      }
      return Number.isFinite(min) ? min : 0;
    })();
    for (const body of blocks) {
      if (!body.trim()) continue;
      const parsed = extractAstDeclaredIdentifiers('inline.js', body);
      for (const d of parsed.identifiers || []) {
        if (d.kind === 'variable') {
          if (GENERIC_LOCAL_VAR_NAMES.has(d.name)) continue;
          if (!isAfterFullFile && !/^[A-Z][A-Z0-9_]{2,}$/.test(d.name)) {
            const rawDeclLine = lines.find(l => new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExpLiteral(d.name)}\\b`).test(l));
            const rawInd = rawDeclLine ? (rawDeclLine.match(/^[ \t]*/) || [''])[0].length : Infinity;
            if (rawInd > minJsIndent + 2) continue;
          }
        }
        add(d.name, d.kind);
      }
    }
    if (isAfterFullFile) {
      for (const m of rawJoined.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)) {
        add(m[1], 'variable');
      }
    }
    return results;
  }

  const parsed = extractAstDeclaredIdentifiers(filePath, isAfterFullFile ? rawJoined : dedentLines(lines));
  for (const d of parsed.identifiers || []) {
    if (d.kind === 'variable') {
      if (GENERIC_LOCAL_VAR_NAMES.has(d.name)) continue;
      if (!isAfterFullFile && !/^[A-Z][A-Z0-9_]{2,}$/.test(d.name)) {
        const rawDeclLine = lines.find(l => {
          const esc = escapeRegExpLiteral(d.name);
          return ext === '.py'
            ? new RegExp(`^[ \\t]*${esc}\\s*=`).test(l)
            : new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\b`).test(l);
        });
        const rawInd = rawDeclLine ? (rawDeclLine.match(/^[ \t]*/) || [''])[0].length : Infinity;
        if (rawInd > 0) continue;
      }
    }
    add(d.name, d.kind);
  }
  if (isAfterFullFile) {
    const declRe = ext === '.py'
      ? /(?:^|\n)[ \t]*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]{2,})\b|(?:^|\n)([A-Za-z_][A-Za-z0-9_]{2,})\s*=/g
      : /\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
    for (const m of rawJoined.matchAll(declRe)) {
      const sym = m[1] || m[2];
      if (sym) add(sym, 'variable');
    }
  }
  return results;
}

function isPureCommentLine(trimmedLine = '', ext = '') {
  if (!trimmedLine) return true;
  if (ext === '.py') return trimmedLine.startsWith('#');
  if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*') || trimmedLine.startsWith('-->') || trimmedLine.startsWith('<!--')) {
    if (trimmedLine.startsWith('<!--') && trimmedLine.includes('-->')) return true;
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*')) return true;
  }
  return false;
}

/**
 * 0-Token Deleted Identifier Gate for kind="remove"|"refactor".
 * Extracts identifiers declared in deleted lines (id, custom class, function, class, top-level var)
 * not re-declared in added lines or post-patch file, and scans the repo for remaining references:
 * - product code refs => fail with exact file:line for retry prompt
 * - test file refs => warning only (non-blocking)
 */
export function evaluateDeletedIdentifierGate(diffText = '', task = {}, options = {}) {
  const kind = String(task?.kind || '').trim().toLowerCase();
  if (kind !== 'remove' && kind !== 'refactor') {
    return {
      ok: true,
      skipped: true,
      reason: 'kind_not_targeted',
      kind,
      deletedIdentifiers: [],
      orphanRefs: [],
      violations: [],
      warnings: [],
      retryPrompt: ''
    };
  }

  const repoRoot = options.repoRoot || REPO_ROOT;
  const extraExcludes = Array.isArray(options.excludeDirs) ? options.excludeDirs : [];
  const afterByFile = options.afterByFile && typeof options.afterByFile === 'object' ? options.afterByFile : {};
  const fileDiffs = String(diffText || '').split(/^diff --git /m).filter(Boolean);

  const deletedByName = new Map();
  const modifiedAfterContent = new Map();

  for (const block of fileDiffs) {
    const headerMatch = block.match(/^a\/([^\s]+)\s+b\/([^\s]+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2].replace(/\\/g, '/');
    if (isTestFileRelPath(filePath) || isExcludedFromDeletedIdScan(filePath, extraExcludes)) continue;

    const lines = block.split('\n');
    const removedLines = [];
    const addedLines = [];
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('-')) removedLines.push(line.slice(1));
      else if (line.startsWith('+')) addedLines.push(line.slice(1));
    }
    if (removedLines.length === 0) continue;

    let afterContent = afterByFile[filePath];
    if (typeof afterContent !== 'string') {
      const absTarget = path.resolve(repoRoot, filePath);
      afterContent = fs.existsSync(absTarget) ? fs.readFileSync(absTarget, 'utf8') : '';
    }
    modifiedAfterContent.set(filePath, afterContent);

    const removedDecls = extractCodeDeclarationsFromDiffLines(filePath, removedLines, { isAfterFullFile: false });
    if (removedDecls.length === 0) continue;

    const addedDecls = extractCodeDeclarationsFromDiffLines(filePath, addedLines, { isAfterFullFile: false });
    const afterDecls = extractCodeDeclarationsFromDiffLines(filePath, afterContent.replace(/\r\n/g, '\n').split('\n'), { isAfterFullFile: true });

    const stillDeclaredNames = new Set([
      ...addedDecls.map(d => d.name),
      ...afterDecls.map(d => d.name)
    ]);

    for (const decl of removedDecls) {
      if (stillDeclaredNames.has(decl.name)) continue;
      if (!deletedByName.has(decl.name)) {
        deletedByName.set(decl.name, { name: decl.name, kind: decl.kind, sourceFile: filePath });
      }
    }
  }

  const deletedIdentifiers = [...deletedByName.values()];
  if (deletedIdentifiers.length === 0) {
    return {
      ok: true,
      skipped: false,
      kind,
      deletedIdentifiers: [],
      orphanRefs: [],
      violations: [],
      warnings: [],
      retryPrompt: ''
    };
  }

  const repoFiles = walkScannableRepoFiles(repoRoot, extraExcludes);
  for (const extraRel of Object.keys(afterByFile)) {
    const cleanRel = String(extraRel || '').replace(/\\/g, '/');
    if (!repoFiles.includes(cleanRel) && !isExcludedFromDeletedIdScan(cleanRel, extraExcludes)) {
      repoFiles.push(cleanRel);
    }
  }

  const codeKinds = new Set(['function', 'class', 'method', 'variable']);
  const deletedCodeSyms = deletedIdentifiers.filter(d => codeKinds.has(d.kind));
  const deletedMarkupIds = deletedIdentifiers.filter(d => d.kind === 'id' || d.kind === 'class');

  const orphanRefs = [];
  const violations = [];
  const warnings = [];
  const seenRefKey = new Set();

  for (const relPath of repoFiles) {
    let content = typeof afterByFile[relPath] === 'string' ? afterByFile[relPath] : null;
    if (content === null) {
      try {
        content = fs.readFileSync(path.resolve(repoRoot, relPath), 'utf8');
      } catch {
        continue;
      }
    }
    const normText = content.replace(/\r\n/g, '\n');
    const ext = path.extname(relPath).toLowerCase();
    const isTest = isTestFileRelPath(relPath);
    const isMarkup = ['.html', '.htm', '.vue', '.svelte'].includes(ext);

    let executableRefs = null;
    const ensureExecutableRefs = () => {
      if (executableRefs) return executableRefs;
      executableRefs = new Set();
      if (isMarkup) {
        for (const body of extractScriptBodiesFromHtml(normText)) {
          const res = extractTreeSitterSymbolUsage('inline.js', body);
          for (const sym of res.executableRefs || []) executableRefs.add(sym);
        }
      } else {
        const res = extractTreeSitterSymbolUsage(relPath, normText);
        for (const sym of res.executableRefs || []) executableRefs.add(sym);
      }
      return executableRefs;
    };

    const lines = normText.split('\n');
    let inHtmlComment = false;
    for (let idx = 0; idx < lines.length; idx++) {
      const lineText = lines[idx];
      const trimmed = lineText.trim();
      if (!trimmed) continue;
      if (isMarkup) {
        if (inHtmlComment) {
          if (trimmed.includes('-->')) inHtmlComment = false;
          continue;
        }
        if (trimmed.startsWith('<!--')) {
          if (!trimmed.includes('-->')) inHtmlComment = true;
          continue;
        }
      }
      if (isPureCommentLine(trimmed, ext)) continue;

      for (const item of deletedMarkupIds) {
        const esc = escapeRegExpLiteral(item.name);
        let matched = false;
        if (item.kind === 'id') {
          if (new RegExp(`\\bid\\s*=\\s*["']${esc}["']`).test(lineText)) continue;
          const quoteOrSelectorRe = new RegExp(`['"\`]#?${esc}(?![A-Za-z0-9_-])`);
          const cssSelectorRe = new RegExp(`(?:^|[^\\w&#])#${esc}(?![A-Za-z0-9_-])`);
          matched = quoteOrSelectorRe.test(lineText) || ((isMarkup || ext === '.css' || ext === '.scss') && cssSelectorRe.test(lineText));
        } else {
          const classRefRe = new RegExp(`(?:['"\`]\\.?${esc}(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])\\.${esc}(?![A-Za-z0-9_-])|\\bclass\\s*=\\s*["'][^"']*\\b${esc}\\b[^"']*["'])`);
          matched = classRefRe.test(lineText);
        }
        if (matched) {
          const key = `${relPath}:${idx + 1}:${item.name}`;
          if (!seenRefKey.has(key)) {
            seenRefKey.add(key);
            const snippet = trimmed.slice(0, 120);
            const entry = { file: relPath, line: idx + 1, identifier: item.name, idKind: item.kind, snippet, isTest };
            orphanRefs.push(entry);
            if (isTest) {
              warnings.push(`[TEST_REF_WARNING] ${relPath}:${idx + 1} (${item.name}) -> ${snippet}`);
            } else {
              violations.push(`${relPath}:${idx + 1} (${item.name}) -> ${snippet}`);
            }
          }
        }
      }

      if (deletedCodeSyms.length > 0) {
        const execSet = isTest ? null : ensureExecutableRefs();
        for (const item of deletedCodeSyms) {
          const esc = escapeRegExpLiteral(item.name);
          const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`);
          if (!wordRe.test(lineText)) continue;
          const isImportLine = /^\s*(?:import|from)\b/.test(lineText);
          const isHtmlInlineHandler = isMarkup && new RegExp(`\\bon\\w+\\s*=\\s*["'][^"']*\\b${esc}\\b`, 'i').test(lineText);
          if (!isTest && !isImportLine && !isHtmlInlineHandler && execSet && !execSet.has(item.name)) {
            continue;
          }
          const key = `${relPath}:${idx + 1}:${item.name}`;
          if (!seenRefKey.has(key)) {
            seenRefKey.add(key);
            const snippet = trimmed.slice(0, 120);
            const entry = { file: relPath, line: idx + 1, identifier: item.name, idKind: item.kind, snippet, isTest };
            orphanRefs.push(entry);
            if (isTest) {
              warnings.push(`[TEST_REF_WARNING] ${relPath}:${idx + 1} (${item.name}) -> ${snippet}`);
            } else {
              violations.push(`${relPath}:${idx + 1} (${item.name}) -> ${snippet}`);
            }
          }
        }
      }
    }
  }

  let retryPrompt = '';
  if (violations.length > 0) {
    const shown = violations.slice(0, 25);
    retryPrompt = [
      '[DELETED_IDENTIFIER_ORPHAN_REFS]',
      `Deleted identifier(s) still referenced in product code (${violations.length} ref(s)):`,
      ...shown.map(v => `- ${v}`)
    ].join('\n');
    if (violations.length > shown.length) {
      retryPrompt += `\n... (+${violations.length - shown.length} more ref(s))`;
    }
  }

  return {
    ok: violations.length === 0,
    skipped: false,
    kind,
    deletedIdentifiers,
    orphanRefs,
    violations,
    warnings,
    retryPrompt,
    errorHash: retryPrompt ? hashString(retryPrompt) : ''
  };
}

function extractAddedTestDefinitionsFromLines(addedLines = [], removedLines = []) {
  const testDefMatch = (code) => {
    const py = code.match(/^(?:async\s+)?def\s+(test_\w+)\b/);
    if (py) return py[1];
    const jsFn = code.match(/^(?:export\s+)?(?:async\s+)?function\s+(test\w*)\b/);
    if (jsFn) return jsFn[1];
    const jsCall = code.match(/^(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (jsCall) return jsCall[1];
    return null;
  };
  const removedNames = new Set();
  for (const line of removedLines) {
    const n = testDefMatch(String(line || '').trim());
    if (n) removedNames.add(n);
  }
  const added = [];
  const seenAdded = new Set();
  for (const line of addedLines) {
    const n = testDefMatch(String(line || '').trim());
    if (n && !removedNames.has(n) && !seenAdded.has(n)) {
      seenAdded.add(n);
      added.push(n);
    }
  }
  return added;
}

/**
 * Extracts newly added test function names grouped by test file from a unified git diff.
 * Only tests present in `+` lines and absent from `-` lines are treated as newly added.
 */
export function extractNewlyAddedTestNamesByFile(diffText = '') {
  const fileDiffs = String(diffText || '').split(/^diff --git /m).filter(Boolean);
  const byFile = new Map();
  for (const block of fileDiffs) {
    const headerMatch = block.match(/^a\/([^\s]+)\s+b\/([^\s]+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2].replace(/\\/g, '/');
    if (!isTestFileRelPath(filePath)) continue;
    const addedLines = [];
    const removedLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) addedLines.push(line.slice(1));
      else if (line.startsWith('-')) removedLines.push(line.slice(1));
    }
    const added = extractAddedTestDefinitionsFromLines(addedLines, removedLines);
    if (added.length > 0) {
      if (!byFile.has(filePath)) byFile.set(filePath, new Set());
      for (const name of added) byFile.get(filePath).add(name);
    }
  }
  return byFile;
}

/**
 * Classifies WHY a newly added test failed on the parent checkout (HEAD):
 * - AssertionError: strong behavioral verification (existing code executed and assertion mismatched)
 * - AttributeError / ImportError: surface signature verification (new function/module absent on parent)
 * - TypeError / Other: signature mismatch or other runtime error
 */
export function classifyParentTestFailureKind(output = '') {
  const text = String(output || '');
  if (/\b(?:ModuleNotFoundError|ImportError)\b/.test(text)) return 'ImportError';
  if (/\bAttributeError\b/.test(text)) return 'AttributeError';
  if (/\bTypeError\b/.test(text)) return 'TypeError';
  if (/\bAssertionError\b|\bERR_ASSERTION\b/.test(text)) return 'AssertionError';
  return 'Other';
}

function classifyParentVerificationStrength(failureKind = '') {
  if (failureKind === 'AssertionError') return 'strong_behavior_check';
  if (failureKind === 'AttributeError' || failureKind === 'ImportError') return 'surface_signature_check';
  return 'other_failure_check';
}

function defaultRunSingleTestOnCheckout({ cwd, repoRoot, file, testName, pythonExe }) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.py') {
    const pyBin = pythonExe || 'python';
    const res = spawnSync(pyBin, ['-m', 'unittest', '-v', file, '-k', testName], {
      cwd,
      encoding: 'utf8',
      timeout: 30000
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    const nameRe = new RegExp(`\\b${escapeRegExpLiteral(testName)}\\b`);
    if (
      res.status === 0
      && /\bRan\s+[1-9]\d*\s+tests?/i.test(combined)
      && !/\(\s*skipped\s*=/i.test(combined)
      && nameRe.test(combined)
    ) {
      return { passed: true, runner: 'unittest', parentFailureKind: null, output: combined.slice(-1500) };
    }
    if (res.status === 5 || /Ran\s+0\s+tests/i.test(combined)) {
      const pyRes = spawnSync(pyBin, ['-m', 'pytest', '-q', file, '-k', testName], {
        cwd,
        encoding: 'utf8',
        timeout: 30000
      });
      const pyCombined = `${pyRes.stdout || ''}\n${pyRes.stderr || ''}`;
      if (pyRes.status === 0 && /[1-9]\d*\s+passed\b/i.test(pyCombined) && !/skipped/i.test(pyCombined)) {
        return { passed: true, runner: 'pytest', parentFailureKind: null, output: pyCombined.slice(-1500) };
      }
      return { passed: false, runner: 'pytest', parentFailureKind: classifyParentTestFailureKind(pyCombined), output: pyCombined.slice(-1500) };
    }
    return { passed: false, runner: 'unittest', parentFailureKind: classifyParentTestFailureKind(combined), output: combined.slice(-1500) };
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const pattern = `^${escapeRegExpLiteral(testName)}$`;
    const res = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
      cwd,
      encoding: 'utf8',
      timeout: 30000
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    const passLineRe = new RegExp(`(?:✔|ok\\s+\\d+)\\s+${escapeRegExpLiteral(testName)}\\b`);
    const passed = res.status === 0
      && passLineRe.test(combined)
      && !/ℹ\s+fail\s+[1-9]/.test(combined)
      && (/ℹ\s+skipped\s+0\b/.test(combined) || !/ℹ\s+skipped\s+[1-9]/.test(combined));
    return {
      passed,
      runner: 'node:test',
      parentFailureKind: passed ? null : classifyParentTestFailureKind(combined),
      output: combined.slice(-1500)
    };
  }

  return { passed: false, runner: 'unsupported', parentFailureKind: 'Other', output: '' };
}

/**
 * Checks whether newly added tests (for kind=remove|bugfix|feature) already PASS on parentRef (HEAD).
 * Warn-only (never blocks): records `vacuous_test` findings for steps[] and morning-report.md.
 */
export function detectVacuousNewTestsOnParent(diffText = '', task = {}, options = {}) {
  const startedAt = Date.now();
  const kind = String(task?.kind || '').trim().toLowerCase();
  if (!['remove', 'bugfix', 'feature'].includes(kind)) {
    return {
      ok: true,
      skipped: true,
      reason: 'kind_not_targeted',
      kind,
      newTests: [],
      vacuousTests: [],
      parentTestResults: [],
      parent_failure_kind: null,
      parent_failure_kinds: {},
      warnings: [],
      durationMs: Date.now() - startedAt
    };
  }

  const repoRoot = options.repoRoot || REPO_ROOT;
  const parentRef = String(options.parentRef || 'HEAD');
  const fileDiffs = String(diffText || '').split(/^diff --git /m).filter(Boolean);
  const candidateMap = new Map(); // filePath -> Set<testName>

  for (const block of fileDiffs) {
    const headerMatch = block.match(/^a\/([^\s]+)\s+b\/([^\s]+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[2].replace(/\\/g, '/');
    if (!isTestFileRelPath(filePath)) continue;
    const addedLines = [];
    const removedLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) addedLines.push(line.slice(1));
      else if (line.startsWith('-')) removedLines.push(line.slice(1));
    }
    const newlyAdded = extractAddedTestDefinitionsFromLines(addedLines, removedLines);
    if (newlyAdded.length > 0) {
      if (!candidateMap.has(filePath)) candidateMap.set(filePath, new Set());
      for (const n of newlyAdded) candidateMap.get(filePath).add(n);
    }
  }

  // Also inspect untracked / modified test files explicitly passed when absent from diffText
  for (const extraFile of (Array.isArray(options.actualModifiedFiles) ? options.actualModifiedFiles : [])) {
    const cleanRel = String(extraFile || '').replace(/\\/g, '/');
    if (!isTestFileRelPath(cleanRel) || candidateMap.has(cleanRel)) continue;
    const absExtra = path.resolve(repoRoot, cleanRel);
    if (!fs.existsSync(absExtra)) continue;
    try {
      execFileSync('git', ['cat-file', '-e', `${parentRef}:${cleanRel}`], { cwd: repoRoot, stdio: 'ignore' });
      continue; // File exists in parentRef without diff lines
    } catch {
      const content = fs.readFileSync(absExtra, 'utf8').replace(/\r\n/g, '\n').split('\n');
      const newlyAdded = extractAddedTestDefinitionsFromLines(content, []);
      if (newlyAdded.length > 0) {
        candidateMap.set(cleanRel, new Set(newlyAdded));
      }
    }
  }

  const newTests = [];
  for (const [file, nameSet] of candidateMap.entries()) {
    for (const testName of nameSet) newTests.push({ file, testName });
  }
  if (newTests.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_new_tests',
      kind,
      newTests: [],
      vacuousTests: [],
      warnings: [],
      durationMs: Date.now() - startedAt
    };
  }

  try {
    execFileSync('git', ['rev-parse', '--verify', parentRef], { cwd: repoRoot, stdio: 'ignore', timeout: 10000 });
  } catch {
    return {
      ok: true,
      skipped: true,
      reason: 'no_parent_commit',
      kind,
      newTests,
      vacuousTests: [],
      warnings: [],
      durationMs: Date.now() - startedAt
    };
  }

  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const wtDir = path.join(os.tmpdir(), `td-parent-test-${stamp}`);
  let createdViaWorktree = false;
  let tmpTarPath = null;

  const vacuousTests = [];
  const warnings = [];
  const parentTestResults = [];
  const parentFailureKinds = {};

  try {
    try {
      execFileSync('git', ['worktree', 'add', '--detach', wtDir, parentRef], {
        cwd: repoRoot,
        stdio: 'ignore',
        timeout: 30000
      });
      createdViaWorktree = true;
    } catch {
      fs.mkdirSync(wtDir, { recursive: true });
      tmpTarPath = path.join(os.tmpdir(), `td-parent-arch-${stamp}.tar`);
      execFileSync('git', ['archive', '--format=tar', parentRef, '-o', tmpTarPath], {
        cwd: repoRoot,
        stdio: 'ignore',
        timeout: 30000
      });
      execFileSync('tar', ['-xf', tmpTarPath, '-C', wtDir], { stdio: 'ignore', timeout: 30000 });
    }

    // Overlay modified/added test files from working tree onto parent checkout
    for (const relTestFile of candidateMap.keys()) {
      const src = path.resolve(repoRoot, relTestFile);
      const dst = path.resolve(wtDir, relTestFile);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }

    let pythonExe = options.pythonPath || null;
    if (!pythonExe && [...candidateMap.keys()].some(f => f.toLowerCase().endsWith('.py'))) {
      const detected = defaultDetectPythonPath([], repoRoot);
      if (detected) {
        const maybeAbs = path.resolve(repoRoot, detected);
        pythonExe = fs.existsSync(maybeAbs) ? maybeAbs : detected;
      }
    }

    for (const { file, testName } of newTests) {
      const runRes = typeof options.runTestOnParent === 'function'
        ? options.runTestOnParent({ cwd: wtDir, repoRoot, file, testName, parentRef, pythonExe })
        : defaultRunSingleTestOnCheckout({ cwd: wtDir, repoRoot, file, testName, pythonExe });
      if (runRes && runRes.passed) {
        vacuousTests.push({
          code: 'vacuous_test',
          test_name: testName,
          file,
          parent_ref: parentRef,
          status: 'passed_on_parent',
          runner: runRes.runner || 'unknown'
        });
        parentTestResults.push({
          file,
          test_name: testName,
          passed: true,
          parent_failure_kind: null,
          verification_strength: 'vacuous_pass_on_parent',
          runner: runRes.runner || 'unknown'
        });
        warnings.push(`[vacuous_test] ${file} -> ${testName} passed on parent ${parentRef} (expected to fail before patch)`);
      } else {
        const failureKind = runRes?.parent_failure_kind || runRes?.parentFailureKind || classifyParentTestFailureKind(runRes?.output || '');
        const verificationStrength = classifyParentVerificationStrength(failureKind);
        parentFailureKinds[failureKind] = Number(parentFailureKinds[failureKind] || 0) + 1;
        parentTestResults.push({
          file,
          test_name: testName,
          passed: false,
          parent_failure_kind: failureKind,
          verification_strength: verificationStrength,
          runner: runRes?.runner || 'unknown'
        });
      }
    }
  } finally {
    if (createdViaWorktree) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', wtDir], {
          cwd: repoRoot,
          stdio: 'ignore',
          timeout: 15000
        });
      } catch {}
    }
    try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
    if (tmpTarPath) {
      try { fs.unlinkSync(tmpTarPath); } catch {}
    }
  }

  const firstFailureEntry = parentTestResults.find(r => !r.passed) || null;
  const primaryParentFailureKind = firstFailureEntry ? firstFailureEntry.parent_failure_kind : null;

  return {
    ok: true,
    skipped: false,
    kind,
    parentRef,
    checkedCount: newTests.length,
    newTests,
    vacuousTests,
    parentTestResults,
    parent_failure_kind: primaryParentFailureKind,
    parent_failure_kinds: parentFailureKinds,
    warnings,
    durationMs: Date.now() - startedAt
  };
}

function killProcessTree(pid, killTree = true) {
  if (!pid) return;
  try {
    if (process.platform === 'win32' && killTree) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else if (process.platform !== 'win32' && killTree) {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export function runCommandAsync(cmd, cwd = REPO_ROOT, timeoutMs = 60000, guardrails = null) {
  const effectiveGuardrails = guardrails || loadPolicyConfig()?.policy?.execution_guardrails || {};
  const effectiveTimeout = timeoutMs || (effectiveGuardrails.default_cli_timeout_sec || 60) * 1000;
  const killTree = effectiveGuardrails.kill_process_tree_on_timeout ?? true;

  const guardCheck = checkCommandGuardrails(cmd, effectiveTimeout, effectiveGuardrails);
  if (!guardCheck.ok) {
    return Promise.resolve({
      ok: false,
      exitCode: 126,
      timedOut: false,
      stdout: '',
      stderr: guardCheck.error
    });
  }

  return new Promise(resolve => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, killTree);
    }, effectiveTimeout);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        timedOut,
        stdout,
        stderr: stderr || err.message || 'Process spawn error'
      });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          exitCode: 124,
          timedOut: true,
          stdout,
          stderr: `${stderr}\n[Validator] Command timed out after ${timeoutMs}ms and process tree was terminated.`.trim()
        });
      } else if (code !== 0) {
        resolve({
          ok: false,
          exitCode: code ?? 1,
          timedOut: false,
          stdout,
          stderr
        });
      } else {
        resolve({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout,
          stderr
        });
      }
    });
  });
}

function extractPythonCandidates(checks = [], repoRoot = REPO_ROOT) {
  const candidates = [];
  const list = Array.isArray(checks) ? checks : [];
  for (const item of list) {
    const cmd = typeof item?.run === 'string' ? item.run.trim() : '';
    if (!cmd) continue;
    const match = cmd.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const firstToken = match?.[1] || match?.[2] || match?.[3] || '';
    if (/python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(firstToken)) {
      candidates.push(firstToken);
    }
  }
  const venvRel = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
  candidates.push(venvRel, 'python3', 'python');
  return [...new Set(candidates)].map(token =>
    (/[\\/]/.test(token) ? path.resolve(repoRoot, token) : token)
  );
}

function defaultDetectPythonPath(checks = [], repoRoot = REPO_ROOT) {
  const candidates = extractPythonCandidates(checks, repoRoot);
  for (const cand of candidates) {
    if (path.isAbsolute(cand)) {
      if (fs.existsSync(cand)) return cand;
      continue;
    }
    try {
      const exe = execFileSync(cand, ['-c', 'import sys; print(sys.executable)'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (exe) return exe;
    } catch {}
    try {
      const locator = process.platform === 'win32' ? 'where.exe' : 'which';
      const firstLine = execFileSync(locator, [cand], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 1200,
        stdio: ['ignore', 'pipe', 'ignore']
      }).split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (firstLine) return firstLine;
    } catch {}
  }
  return null;
}

function defaultDetectAdmin() {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  try {
    const groupsOut = execFileSync('whoami.exe', ['/groups'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return /S-1-16-(?:12288|16384)\b/i.test(groupsOut);
  } catch {
    try {
      execFileSync('net.exe', ['session'], { timeout: 1500, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

export function checkLoopbackBindable({ host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const server = net.createServer();
    const finish = (bindable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      resolve(Boolean(bindable));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    server.once('error', () => finish(false));
    try {
      server.listen(0, host, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

function resolveValidationConfigAndChecks(projectConfig, stageName) {
  const policyCfg = projectConfig ? {} : (loadPolicyConfig() || {});
  const cfg = projectConfig || loadProjectConfig() || {};
  const repoRoot = resolveRepoRoot(cfg?.policy?.repo_root ? cfg : (policyCfg?.policy?.repo_root ? policyCfg : cfg));
  const fastChecks = cfg?.policy?.validation?.fast_checks
    || cfg?.validation?.fast_checks
    || cfg?.project?.validation?.fast_checks
    || policyCfg?.policy?.validation?.fast_checks
    || policyCfg?.validation?.fast_checks
    || [];
  const suiteChecks = cfg?.policy?.validation?.suite_checks
    || cfg?.validation?.suite_checks
    || cfg?.project?.validation?.suite_checks
    || policyCfg?.policy?.validation?.suite_checks
    || policyCfg?.validation?.suite_checks
    || [];
  const checks = stageName === 'suite_checks' ? suiteChecks : fastChecks;
  return { repoRoot, checks, allChecks: [...fastChecks, ...suiteChecks] };
}

const DEFAULT_ONNX_MODEL_NAMES = ['lama_fp32.onnx', 'ch_PP-OCRv4_det.onnx'];
const fileSha256Cache = new Map();

export function computeFileSha256Cached(filePath, sizeBytes, mtimeMs, options = {}) {
  const key = `${path.resolve(filePath)}::${sizeBytes}::${mtimeMs}`;
  if (fileSha256Cache.has(key)) {
    return fileSha256Cache.get(key);
  }
  if (typeof options.onModelHashCompute === 'function') {
    options.onModelHashCompute(filePath, sizeBytes, mtimeMs);
  }
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(256 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  fileSha256Cache.set(key, digest);
  return digest;
}

export function resolveOnnxModelsDir(options = {}) {
  if (options.modelsDir) return path.resolve(options.modelsDir);
  if (process.env.TOOLDOWNLOAD_MODELS_DIR) return path.resolve(process.env.TOOLDOWNLOAD_MODELS_DIR);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ToolDownload', 'models', 'inpaint');
  }
  return path.join(os.homedir(), '.tool-download', 'models', 'inpaint');
}

function defaultCollectOnnxModels(options = {}) {
  const modelsDir = resolveOnnxModelsDir(options);
  const names = new Set(Array.isArray(options.onnxModelNames) ? options.onnxModelNames : DEFAULT_ONNX_MODEL_NAMES);
  if (fs.existsSync(modelsDir)) {
    try {
      for (const entry of fs.readdirSync(modelsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.onnx')) {
          names.add(entry.name);
        }
      }
    } catch {}
  }

  return [...names].sort().map(name => {
    const filePath = path.join(modelsDir, name);
    if (!fs.existsSync(filePath)) {
      return { name, path: filePath, exists: false, size_bytes: null, sha256: null };
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return { name, path: filePath, exists: false, size_bytes: null, sha256: null };
      }
      return {
        name,
        path: filePath,
        exists: true,
        size_bytes: stat.size,
        sha256: computeFileSha256Cached(filePath, stat.size, stat.mtimeMs, options)
      };
    } catch {
      return { name, path: filePath, exists: false, size_bytes: null, sha256: null };
    }
  });
}

function isRunnablePythonBinary(pythonPath) {
  if (!pythonPath) return false;
  if (path.isAbsolute(pythonPath)) {
    try {
      const stat = fs.statSync(pythonPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }
  return true;
}

function defaultDetectOnnxRuntime(pythonPath, repoRoot) {
  if (!isRunnablePythonBinary(pythonPath)) {
    return { installed: false, import_ok: false, version: null, providers: [], error: 'python_not_available' };
  }
  const pyProbe = [
    'import importlib.metadata, json',
    'res = {"installed": False, "import_ok": False, "version": None, "providers": [], "error": None}',
    'for pkg in ("onnxruntime-directml", "onnxruntime"):',
    '  try:',
    '    res["version"] = importlib.metadata.version(pkg)',
    '    res["installed"] = True',
    '    break',
    '  except Exception:',
    '    pass',
    'try:',
    '  import onnxruntime as ort',
    '  res["installed"] = True',
    '  res["import_ok"] = True',
    '  res["version"] = getattr(ort, "__version__", res["version"])',
    '  res["providers"] = sorted(list(ort.get_available_providers()))',
    'except Exception as e:',
    '  res["error"] = f"{type(e).__name__}: {e}"',
    'print(json.dumps(res))'
  ].join('\n');

  try {
    const out = execFileSync(pythonPath, ['-c', pyProbe], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const parsed = JSON.parse(out);
    return {
      installed: Boolean(parsed.installed),
      import_ok: Boolean(parsed.import_ok),
      version: parsed.version || null,
      providers: Array.isArray(parsed.providers) ? [...parsed.providers].sort() : [],
      error: parsed.error || null
    };
  } catch (err) {
    return {
      installed: false,
      import_ok: false,
      version: null,
      providers: [],
      error: String(err?.message || 'probe_failed').slice(0, 200)
    };
  }
}

function defaultDetectPipFreeze(pythonPath, repoRoot) {
  if (!isRunnablePythonBinary(pythonPath)) {
    return { sha256: null, package_count: 0 };
  }
  try {
    const out = execFileSync(pythonPath, ['-m', 'pip', 'freeze'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const lines = out
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const normalized = lines.join('\n');
    const sha256 = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
    return { sha256, package_count: lines.length };
  } catch {
    return { sha256: null, package_count: 0 };
  }
}

/**
 * Captures runtime environment fingerprint (python, admin, loopback, ONNX models/runtime, pip freeze hash).
 */
export async function collectEnvironmentFingerprint(projectConfig = null, options = {}) {
  const { repoRoot, allChecks } = resolveValidationConfigAndChecks(projectConfig, 'fast_checks');
  const pythonPath = typeof options.detectPythonPath === 'function'
    ? options.detectPythonPath(allChecks, repoRoot)
    : defaultDetectPythonPath(allChecks, repoRoot);
  const isAdmin = typeof options.detectAdmin === 'function'
    ? Boolean(options.detectAdmin())
    : defaultDetectAdmin();
  const loopbackBindable = typeof options.checkLoopback === 'function'
    ? Boolean(await options.checkLoopback())
    : await checkLoopbackBindable();
  const onnxModels = typeof options.detectOnnxModels === 'function'
    ? options.detectOnnxModels(options)
    : defaultCollectOnnxModels(options);
  const onnxruntime = typeof options.detectOnnxRuntime === 'function'
    ? options.detectOnnxRuntime(pythonPath, repoRoot)
    : defaultDetectOnnxRuntime(pythonPath, repoRoot);
  const pipFreeze = typeof options.detectPipFreeze === 'function'
    ? options.detectPipFreeze(pythonPath, repoRoot)
    : defaultDetectPipFreeze(pythonPath, repoRoot);

  return {
    python_path: pythonPath || null,
    is_admin: isAdmin,
    loopback_bindable: loopbackBindable,
    onnx_models: onnxModels,
    onnxruntime,
    pip_freeze_hash: pipFreeze?.sha256 || null,
    pip_package_count: Number.isInteger(pipFreeze?.package_count) ? pipFreeze.package_count : 0,
    platform: process.platform,
    node_version: process.version,
    checked_at: new Date().toISOString()
  };
}

export function compareEnvironmentFingerprints(baselineFp, currentFp) {
  if (!baselineFp || !currentFp) {
    return { matched: true, mismatch_fields: [], diffs: [] };
  }
  const diffs = [];
  const pushDiff = (field, baseline, current) => {
    if (JSON.stringify(baseline ?? null) !== JSON.stringify(current ?? null)) {
      diffs.push({ field, baseline: baseline ?? null, current: current ?? null });
    }
  };

  // Intentionally excludes volatile timestamps (`checked_at`) so identical environments always match.
  for (const key of ['python_path', 'is_admin', 'loopback_bindable', 'pip_freeze_hash', 'platform', 'node_version']) {
    pushDiff(key, baselineFp[key], currentFp[key]);
  }

  const baseOrt = baselineFp.onnxruntime || {};
  const currOrt = currentFp.onnxruntime || {};
  pushDiff('onnxruntime.installed', Boolean(baseOrt.installed), Boolean(currOrt.installed));
  pushDiff('onnxruntime.import_ok', Boolean(baseOrt.import_ok), Boolean(currOrt.import_ok));
  pushDiff('onnxruntime.version', baseOrt.version || null, currOrt.version || null);
  const baseProviders = Array.isArray(baseOrt.providers) ? [...baseOrt.providers].sort() : [];
  const currProviders = Array.isArray(currOrt.providers) ? [...currOrt.providers].sort() : [];
  pushDiff('onnxruntime.providers', baseProviders, currProviders);

  const baseModelsMap = new Map((baselineFp.onnx_models || []).map(m => [m.name, m]));
  const currModelsMap = new Map((currentFp.onnx_models || []).map(m => [m.name, m]));
  const allModelNames = [...new Set([...baseModelsMap.keys(), ...currModelsMap.keys()])].sort();
  for (const name of allModelNames) {
    const bm = baseModelsMap.get(name) || { exists: false, size_bytes: null, sha256: null };
    const cm = currModelsMap.get(name) || { exists: false, size_bytes: null, sha256: null };
    pushDiff(`onnx_models[${name}].exists`, Boolean(bm.exists), Boolean(cm.exists));
    pushDiff(`onnx_models[${name}].sha256`, bm.sha256 || null, cm.sha256 || null);
    pushDiff(`onnx_models[${name}].size_bytes`, bm.size_bytes ?? null, cm.size_bytes ?? null);
  }

  return {
    matched: diffs.length === 0,
    mismatch_fields: diffs.map(d => d.field),
    diffs
  };
}

export function buildValidationResult({ fastVal, suiteVal, envFingerprint = null, baselineFingerprint = null } = {}) {
  const failed = (!fastVal?.ok && fastVal) ? fastVal : ((!suiteVal?.ok && suiteVal) ? suiteVal : null);
  const resolvedFingerprint = envFingerprint
    || failed?.env_fingerprint
    || suiteVal?.env_fingerprint
    || fastVal?.env_fingerprint
    || null;

  const cmp = (baselineFingerprint && resolvedFingerprint)
    ? compareEnvironmentFingerprints(baselineFingerprint, resolvedFingerprint)
    : null;
  const hasMismatch = cmp ? !cmp.matched : false;
  const mismatchMeta = {
    environment_mismatch: hasMismatch,
    ...(hasMismatch
      ? {
          environment_mismatch_fields: cmp.mismatch_fields,
          environment_diff: cmp.diffs
        }
      : {})
  };
  const mismatchSuffix = hasMismatch
    ? ` | Environment mismatch vs baseline: ${cmp.mismatch_fields.join(', ')}`
    : '';

  if (failed) {
    const baseNote = failed.checkName
      ? `Validation check failed: ${failed.checkName} (exit ${failed.exitCode ?? 'unknown'})`
      : 'Validation failed';
    return {
      passed: false,
      trusted: false,
      skipped: false,
      status: 'failed',
      stage: failed.stage || 'validation',
      check_name: failed.checkName || null,
      error_hash: failed.errorHash || null,
      note: `${baseNote}${mismatchSuffix}`,
      env_fingerprint: resolvedFingerprint,
      ...mismatchMeta
    };
  }

  const isValidationSkipped = Boolean(fastVal?.skipped && suiteVal?.skipped);
  if (hasMismatch) {
    return {
      passed: false,
      trusted: false,
      skipped: isValidationSkipped,
      raw_checks_passed: !isValidationSkipped,
      status: 'environment_mismatch',
      stage: 'validation_environment',
      check_name: 'environment_fingerprint_mismatch',
      error_hash: hashString(`environment_mismatch:${cmp.mismatch_fields.join(',')}`),
      note: `Untrusted validation result rejected due to environment mismatch vs baseline: ${cmp.mismatch_fields.join(', ')}`,
      env_fingerprint: resolvedFingerprint,
      ...mismatchMeta
    };
  }

  const baseNote = isValidationSkipped ? 'No validation checks configured in policy.yaml' : 'All validation checks passed';
  return {
    passed: !isValidationSkipped,
    trusted: true,
    skipped: isValidationSkipped,
    status: isValidationSkipped ? 'skipped' : 'passed',
    note: baseNote,
    env_fingerprint: resolvedFingerprint,
    ...mismatchMeta
  };
}

export async function runSingleValidationCheck(item, stageName, projectConfig, envFingerprint = null, defaultTimeoutMs = null, options = {}) {
  const { repoRoot } = resolveValidationConfigAndChecks(projectConfig, stageName);
  const resolvedDefaultMs = defaultTimeoutMs ?? (stageName === 'fast_checks' ? 30000 : 120000);
  const fp = envFingerprint || await collectEnvironmentFingerprint(projectConfig);
  const res = await runCommandAsync(item.run, repoRoot, item.timeout_sec ? item.timeout_sec * 1000 : resolvedDefaultMs);
  if (!res.ok) {
    const errCombined = `${res.stdout}\n${res.stderr}`.trim();
    let socketDiagnostics;
    if (isEnobufsFailure(errCombined)) {
      const captureFn = typeof options.captureSocketSnapshotFn === 'function'
        ? options.captureSocketSnapshotFn
        : captureProcessSocketSnapshot;
      socketDiagnostics = await captureFn();
      console.warn(`[Validator] ENOBUFS detected in "${item.name}" — socket snapshot: ${formatSocketSnapshotSummary(socketDiagnostics)}`);
    }
    return {
      ok: false,
      stage: stageName,
      checkName: item.name,
      command: item.run,
      exitCode: res.exitCode,
      errorCombined: errCombined,
      errorHash: hashString(errCombined),
      env_fingerprint: fp,
      ...(socketDiagnostics ? { socket_diagnostics: socketDiagnostics } : {})
    };
  }
  return {
    ok: true,
    stage: stageName,
    checkName: item.name,
    command: item.run,
    exitCode: res.exitCode ?? 0,
    env_fingerprint: fp
  };
}

export async function validateStageChecks(stageName, projectConfig, options = {}) {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? (stageName === 'fast_checks' ? 30000 : 120000);
  const { checks } = resolveValidationConfigAndChecks(projectConfig, stageName);
  const envFingerprint = options.envFingerprint || await collectEnvironmentFingerprint(projectConfig);

  if (!checks || checks.length === 0) {
    return {
      ok: true,
      skipped: true,
      stage: stageName,
      message: `No ${stageName} defined.`,
      checks: [],
      env_fingerprint: envFingerprint
    };
  }

  const results = [];
  for (const item of checks) {
    const res = await runSingleValidationCheck(item, stageName, projectConfig, envFingerprint, defaultTimeoutMs);
    results.push(res);
    if (!res.ok && options.stopOnFirstFailure) {
      return {
        ...res,
        checks: results
      };
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    return {
      ok: true,
      skipped: false,
      stage: stageName,
      checks: results,
      env_fingerprint: envFingerprint
    };
  }

  const errCombined = failed.map(f => f.errorCombined).filter(Boolean).join('\n\n');
  const firstSocketDiag = failed.find(f => f.socket_diagnostics)?.socket_diagnostics;
  return {
    ok: false,
    skipped: false,
    stage: stageName,
    checkName: failed[0].checkName,
    command: failed[0].command,
    exitCode: failed[0].exitCode,
    errorCombined: errCombined,
    errorHash: hashString(errCombined),
    checks: results,
    env_fingerprint: envFingerprint,
    ...(firstSocketDiag ? { socket_diagnostics: firstSocketDiag } : {})
  };
}

async function runCheckStage(stageName, projectConfig, defaultTimeoutMs) {
  return validateStageChecks(stageName, projectConfig, { defaultTimeoutMs, stopOnFirstFailure: true });
}

export async function validateFast(projectConfig) {
  return runCheckStage('fast_checks', projectConfig, 30000);
}

export async function validateSuite(projectConfig) {
  return runCheckStage('suite_checks', projectConfig, 120000);
}

// CLI direct execution (supports: node validator.mjs [fast|suite|scope] [--scope file1,file2])
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const mode = (args[0] && !args[0].startsWith('--')) ? args[0] : 'fast';
  const scopeIdx = args.indexOf('--scope');
  const scopeFiles = scopeIdx !== -1 && args[scopeIdx + 1]
    ? args[scopeIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  (async () => {
    console.log(`Running validator in "${mode}" mode${scopeFiles.length ? ` (scope: ${scopeFiles.join(', ')})` : ''}...`);
    if (scopeFiles.length > 0 || mode === 'scope') {
      const scopeAudit = auditGitScope(scopeFiles);
      if (!scopeAudit.ok) {
        console.log(JSON.stringify({ ok: false, stage: 'scope_audit', ...scopeAudit }, null, 2));
        process.exit(1);
      }
      if (mode === 'scope') {
        console.log(JSON.stringify({ ok: true, stage: 'scope_audit', ...scopeAudit }, null, 2));
        process.exit(0);
      }
    }
    const res = mode === 'suite' ? await validateSuite() : await validateFast();
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  })();
}
