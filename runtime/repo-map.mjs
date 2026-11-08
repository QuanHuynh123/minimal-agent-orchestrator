#!/usr/bin/env node
/**
 * Zero-Dependency Regex Symbol Skeleton & Caller-Degree Ranking Engine
 * Part of Agent Squad Runtime v3.1 (agent-team/runtime/repo-map.mjs)
 * 
 * Extracts high-level class signatures, method/function headers, arrow functions,
 * and cross-file import dependencies from Python and JavaScript/TypeScript files
 * without requiring native C++ bindings (Tree-sitter).
 * Ranks files by keyword relevance + caller in-degree centrality.
 */

import fs from 'node:fs';
import path from 'node:path';

// In-memory cache keyed by filePath -> { mtime, symbols }
const SYMBOL_CACHE = new Map();

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.gemini', '.pytest_cache', '.mypy_cache', '.idea', '.vscode'
]);

const JS_CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'delete', 'await', 'super'
]);

/**
 * Extracts classes, methods, top-level functions, arrow functions, and imports from code.
 */
export function extractSymbolsFromCode(filePath, content = '') {
  const ext = path.extname(filePath).toLowerCase();
  const isPython = ext === '.py';
  const isJs = ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.jsx' || ext === '.tsx';

  if (!isPython && !isJs) {
    return { filePath, classes: [], functions: [], imports: [], callers: [] };
  }

  const lines = content.split(/\r?\n/);
  const classes = [];
  const functions = [];
  const imports = [];

  let currentClass = null;

  // Helper to join up to 6 continuation lines when a signature's parameter list spans multiple lines
  function getJoinedSignature(idx) {
    let joined = lines[idx] || '';
    if (joined.includes('(') && !joined.includes(')')) {
      for (let k = 1; k <= 6 && idx + k < lines.length; k++) {
        joined += ' ' + lines[idx + k].trim();
        if (joined.includes(')')) break;
      }
    }
    return joined;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isPython) {
      // Python imports
      const fromMatch = line.match(/^[ \t]*from\s+([A-Za-z0-9_.]+)\s+import\s+([^#\n]+)/);
      if (fromMatch) {
        const mod = fromMatch[1].trim();
        const syms = fromMatch[2].split(',').map(s => s.trim().replace(/\s+as\s+.*/, '')).filter(Boolean);
        imports.push({ module: mod, symbols: syms });
        continue;
      }
      const impMatch = line.match(/^[ \t]*import\s+([A-Za-z0-9_.]+)/);
      if (impMatch) {
        imports.push({ module: impMatch[1].trim(), symbols: ['*'] });
        continue;
      }

      // Python class definition
      const classMatch = line.match(/^[ \t]*class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        currentClass = {
          name: classMatch[1],
          inherits: classMatch[2] ? classMatch[2].trim() : '',
          methods: [],
          line: i + 1
        };
        classes.push(currentClass);
        continue;
      }

      // Python method (indented def, supports multi-line params)
      if (/^[ \t]+(?:async\s+)?def\s+[A-Za-z0-9_]+\s*\(/.test(line) && currentClass) {
        const sig = getJoinedSignature(i);
        const methodMatch = sig.match(/^[ \t]+(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
        if (methodMatch) {
          const name = methodMatch[1];
          if (!name.startsWith('__') || name === '__init__') {
            currentClass.methods.push({
              name,
              params: cleanParams(methodMatch[2]),
              returns: methodMatch[3] ? methodMatch[3].trim() : '',
              line: i + 1
            });
          }
          continue;
        }
      }

      // Python top-level def (supports multi-line params)
      if (/^(?:async\s+)?def\s+[A-Za-z0-9_]+\s*\(/.test(line)) {
        const sig = getJoinedSignature(i);
        const topDefMatch = sig.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
        if (topDefMatch) {
          currentClass = null; // Exit class context
          functions.push({
            name: topDefMatch[1],
            params: cleanParams(topDefMatch[2]),
            returns: topDefMatch[3] ? topDefMatch[3].trim() : '',
            line: i + 1
          });
          continue;
        }
      }

      // Reset class context on unindented non-comment, non-decorator lines
      if (/^[A-Za-z0-9_]/.test(line) && !line.startsWith('class ') && !line.startsWith('def ') && !line.startsWith('async def ')) {
        currentClass = null;
      }
    } else if (isJs) {
      // JS imports
      const jsImpMatch = line.match(/import\s+(?:\{([^}]+)\}|\*\s+as\s+([A-Za-z0-9_]+)|([A-Za-z0-9_]+))?\s*from\s*['"]([^'"]+)['"]/);
      if (jsImpMatch) {
        const rawSyms = jsImpMatch[1] ? jsImpMatch[1].split(',').map(s => s.trim().replace(/\s+as\s+.*/, '')).filter(Boolean) : (jsImpMatch[2] ? [jsImpMatch[2]] : (jsImpMatch[3] ? [jsImpMatch[3]] : []));
        imports.push({ module: jsImpMatch[4], symbols: rawSyms });
        continue;
      }

      // JS class (exported or internal)
      const jsClassMatch = line.match(/^[ \t]*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)(?:\s+extends\s+([A-Za-z0-9_.]+))?/);
      if (jsClassMatch) {
        currentClass = {
          name: jsClassMatch[1],
          inherits: jsClassMatch[2] ? jsClassMatch[2].trim() : '',
          methods: [],
          line: i + 1
        };
        classes.push(currentClass);
        continue;
      }

      // JS top-level or exported function (supports multi-line params)
      if (/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.test(line)) {
        const sig = getJoinedSignature(i);
        const jsFuncMatch = sig.match(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
        if (jsFuncMatch) {
          currentClass = null;
          functions.push({
            name: jsFuncMatch[1],
            params: cleanParams(jsFuncMatch[2]),
            returns: '',
            line: i + 1
          });
          continue;
        }
      }

      // JS arrow function (const/let foo = (...) => or async (...) =>)
      if (/^[ \t]*(?:export\s+)?(?:const|let)\s+[A-Za-z0-9_]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/.test(line)) {
        const arrowMatch = line.match(/^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z0-9_]+))\s*=>/);
        if (arrowMatch) {
          currentClass = null;
          functions.push({
            name: arrowMatch[1],
            params: cleanParams(arrowMatch[2] || arrowMatch[3] || ''),
            returns: '',
            line: i + 1
          });
          continue;
        }
      }

      // JS class method inside currentClass
      if (currentClass && /^[ \t]{2,}(?:static\s+)?(?:async\s+)?[A-Za-z0-9_]+\s*\([^;]*\{\s*$/.test(line)) {
        const mMatch = line.match(/^[ \t]{2,}(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*\{/);
        if (mMatch && !JS_CONTROL_KEYWORDS.has(mMatch[1])) {
          currentClass.methods.push({
            name: mMatch[1],
            params: cleanParams(mMatch[2]),
            returns: '',
            line: i + 1
          });
          continue;
        }
      }

      // Close class context on unindented closing brace
      if (currentClass && /^\}/.test(line)) {
        currentClass = null;
      }

      // JS exported const/let (non-arrow)
      const jsConstMatch = line.match(/^[ \t]*export\s+(?:const|let)\s+([A-Za-z0-9_]+)/);
      if (jsConstMatch) {
        functions.push({
          name: jsConstMatch[1],
          params: '(const)',
          returns: '',
          line: i + 1
        });
        continue;
      }
    }
  }

  return { filePath, classes, functions, imports, callers: [] };
}

function cleanParams(raw = '') {
  if (!raw) return '';
  return raw
    .split(',')
    .map(p => p.trim())
    .filter(p => p && p !== 'self' && p !== 'cls')
    .slice(0, 4)
    .join(', ')
    + (raw.split(',').length > 5 ? ', ...' : '');
}

/**
 * Scans workspace and builds or retrieves cached symbol table.
 */
export function scanWorkspaceSymbols(repoRoot, allowedDirs = []) {
  let dirs = (Array.isArray(allowedDirs) && allowedDirs.length > 0 && !allowedDirs.includes('*'))
    ? allowedDirs
    : [];
  if (dirs.length === 0) {
    try {
      dirs = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch {
      dirs = ['agent-team'];
    }
  }

  const fileMap = new Map();

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      const absPath = path.resolve(currentDir, ent.name);
      if (ent.isDirectory()) {
        walk(absPath);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (['.py', '.js', '.mjs', '.ts'].includes(ext)) {
          const relPath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
          try {
            const stat = fs.statSync(absPath);
            const cached = SYMBOL_CACHE.get(relPath);
            if (cached && cached.mtime === stat.mtimeMs) {
              fileMap.set(relPath, cached.symbols);
            } else {
              const content = fs.readFileSync(absPath, 'utf8');
              const symbols = extractSymbolsFromCode(relPath, content);
              SYMBOL_CACHE.set(relPath, { mtime: stat.mtimeMs, symbols });
              fileMap.set(relPath, symbols);
            }
          } catch {}
        }
      }
    }
  }

  for (const d of dirs) {
    const absD = path.resolve(repoRoot, d);
    walk(absD);
  }

  // Build reverse reference callers graph
  for (const [sourceFile, sym] of fileMap.entries()) {
    for (const imp of sym.imports) {
      const mod = imp.module.replace(/\./g, '/');
      for (const targetFile of fileMap.keys()) {
        if (targetFile.includes(mod) || targetFile.endsWith(`${mod}.py`) || targetFile.endsWith(`${mod}.js`)) {
          const targetSym = fileMap.get(targetFile);
          if (targetSym && !targetSym.callers.includes(sourceFile)) {
            targetSym.callers.push(sourceFile);
          }
        }
      }
    }
  }

  return fileMap;
}

/**
 * Computes relevance scores and formats a compact skeleton repo-map.
 * 
 * @param {string} repoRoot - Workspace root path
 * @param {Object} options
 * @param {Array<string>} [options.allowedDirs] - Dirs to scan
 * @param {string|Array<string>} [options.query] - Keywords to rank symbols
 * @param {number} [options.maxChars=3500] - Hard budget ceiling in chars
 * @returns {string} Formatted compact skeleton map
 */
export function generateRepoMap(repoRoot, options = {}) {
  const maxChars = options.maxChars || 3500;
  const rawQuery = options.query || '';
  const keywords = Array.isArray(rawQuery)
    ? rawQuery.map(k => String(k).toLowerCase())
    : String(rawQuery).toLowerCase().split(/[\s,._-]+/).filter(k => k.length >= 3);

  const fileMap = scanWorkspaceSymbols(repoRoot, options.allowedDirs);
  if (fileMap.size === 0) return '';

  // Calculate Relevance Scores (Keyword Hit + Caller In-Degree Centrality)
  const scoredFiles = [];
  for (const [relPath, sym] of fileMap.entries()) {
    let score = 0;
    const lowerPath = relPath.toLowerCase();

    // 1. Direct path match
    for (const kw of keywords) {
      if (lowerPath.includes(kw)) score += 15;
    }

    // 2. Symbol matches (classes & functions)
    for (const c of sym.classes) {
      const lowerName = c.name.toLowerCase();
      for (const kw of keywords) {
        if (lowerName.includes(kw)) score += 10;
      }
      for (const m of c.methods) {
        const lowerM = m.name.toLowerCase();
        for (const kw of keywords) {
          if (lowerM.includes(kw)) score += 5;
        }
      }
    }

    for (const f of sym.functions) {
      const lowerF = f.name.toLowerCase();
      for (const kw of keywords) {
        if (lowerF.includes(kw)) score += 8;
      }
    }

    // 3. Centrality boost (more callers = more important architecture hub)
    score += Math.min(sym.callers.length * 2, 10);

    scoredFiles.push({ relPath, sym, score });
  }

  // Sort descending by score, then alphabetically
  scoredFiles.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

  const sections = [];
  let currentChars = 0;

  for (const item of scoredFiles) {
    const { relPath, sym } = item;
    if (sym.classes.length === 0 && sym.functions.length === 0) continue;

    const blockLines = [];
    const callerInfo = sym.callers.length > 0
      ? ` (referenced by: ${sym.callers.slice(0, 3).map(c => path.basename(c)).join(', ')})`
      : '';

    blockLines.push(`[${relPath}]${callerInfo}`);

    for (const c of sym.classes.slice(0, 5)) {
      const inheritStr = c.inherits ? `(${c.inherits})` : '';
      blockLines.push(`  class ${c.name}${inheritStr}:`);
      for (const m of c.methods.slice(0, 6)) {
        const ret = m.returns ? ` -> ${m.returns}` : '';
        blockLines.push(`    def ${m.name}(${m.params})${ret}: ...`);
      }
    }

    for (const f of sym.functions.slice(0, 8)) {
      const ret = f.returns ? ` -> ${f.returns}` : '';
      blockLines.push(`  def ${f.name}(${f.params})${ret}: ...`);
    }

    const blockStr = blockLines.join('\n');
    if (currentChars + blockStr.length > maxChars) {
      sections.push('\n[... Additional symbols omitted to fit context budget ...]');
      break;
    }

    sections.push(blockStr);
    currentChars += blockStr.length + 2;
  }

  return sections.join('\n\n');
}
