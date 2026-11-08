#!/usr/bin/env node
/**
 * Tree-Sitter WASM AST & Personalized PageRank Repo-Map Engine
 * Part of Agent Squad Runtime v3.1 (agent-team/runtime/repo-map.mjs)
 *
 * Three-Pillar Architecture (Aider-grade Repo Map):
 * 1. Parser: Uses `web-tree-sitter` (WASM) for real AST symbol & import extraction
 *    across JavaScript, TypeScript/TSX, and Python (ignoring comments/strings/nested noise),
 *    with automatic zero-crash fallback to a lightweight Regex extractor if WASM is unavailable.
 * 2. Import Graph: `resolveImportTarget()` resolves `./`, `../`, extension probing
 *    (`.mjs`, `.js`, `.ts`, `.tsx`, `.py`), directory `/index.*` & `/__init__.py`, and Python dotted imports.
 * 3. Task-Scoped Ranking: Runs iterative Personalized PageRank (d = 0.85, 15 iterations)
 *    seeded by `scopeFiles` (`task.scope`) and `query` keywords, budgeted by `maxChars`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory cache keyed by filePath -> { mtime, parserMode, symbols }
const SYMBOL_CACHE = new Map();

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.gemini', '.pytest_cache', '.mypy_cache', '.idea', '.vscode'
]);

const BUILTIN_MODULES = new Set([
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'child_process',
  'assert', 'stream', 'events', 'net', 'tls', 'zlib', 'buffer', 'querystring',
  'sys', 're', 'json', 'math', 'time', 'datetime', 'typing', 'pathlib', 'collections',
  'itertools', 'functools', 'subprocess', 'threading', 'queue', 'unittest', 'logging'
]);

const JS_CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'delete', 'await', 'super'
]);

// ---------------------------------------------------------------------------
// 1. Tree-Sitter WASM Lifecycle (Pre-warmed at ESM load + Fallback Safe)
// ---------------------------------------------------------------------------
let wasmReady = false;
let wasmInitPromise = null;
let TsParserClass = null;
const wasmLanguages = new Map(); // ext -> Language
const wasmParsers = new Map();   // ext -> Parser instance

function resolveWasmFilePath(fileName, pkgDir = 'tree-sitter-wasms/out') {
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', pkgDir, fileName),
    path.resolve(process.cwd(), 'node_modules', pkgDir, fileName),
    path.resolve(process.cwd(), 'agent-team', 'node_modules', pkgDir, fileName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Initializes `web-tree-sitter` and loads JS, TS, TSX, and Python WASM grammars.
 * Safe to call multiple times (idempotent). Returns true if WASM is active.
 */
export async function initTreeSitterWasm() {
  if (wasmReady) return true;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    try {
      const mod = await import('web-tree-sitter');
      const Parser = mod.Parser || mod.default?.Parser || mod.default;
      if (!Parser || typeof Parser.init !== 'function') return false;

      await Parser.init();
      const Language = mod.Language || Parser.Language;
      if (!Language) return false;

      const grammarMap = {
        javascript: 'tree-sitter-javascript.wasm',
        typescript: 'tree-sitter-typescript.wasm',
        tsx: 'tree-sitter-tsx.wasm',
        python: 'tree-sitter-python.wasm'
      };

      const loadedLangs = {};
      for (const [key, wasmFile] of Object.entries(grammarMap)) {
        const fullPath = resolveWasmFilePath(wasmFile, 'tree-sitter-wasms/out');
        if (fullPath) {
          try {
            const bytes = new Uint8Array(fs.readFileSync(fullPath));
            loadedLangs[key] = await Language.load(bytes);
          } catch {}
        }
      }

      if (!loadedLangs.javascript && !loadedLangs.python) {
        return false;
      }

      TsParserClass = Parser;
      if (loadedLangs.javascript) {
        wasmLanguages.set('.js', loadedLangs.javascript);
        wasmLanguages.set('.mjs', loadedLangs.javascript);
        wasmLanguages.set('.cjs', loadedLangs.javascript);
        wasmLanguages.set('.jsx', loadedLangs.javascript);
      }
      if (loadedLangs.typescript) {
        wasmLanguages.set('.ts', loadedLangs.typescript);
      }
      if (loadedLangs.tsx) {
        wasmLanguages.set('.tsx', loadedLangs.tsx);
      } else if (loadedLangs.typescript) {
        wasmLanguages.set('.tsx', loadedLangs.typescript);
      }
      if (loadedLangs.python) {
        wasmLanguages.set('.py', loadedLangs.python);
      }

      wasmReady = true;
      SYMBOL_CACHE.clear(); // Invalidate any regex-cached entries so WASM AST takes over
      return true;
    } catch {
      return false;
    }
  })();

  return wasmInitPromise;
}

export function isTreeSitterWasmReady() {
  return wasmReady;
}

// Pre-warm WASM automatically when imported in ESM
try {
  await initTreeSitterWasm();
} catch {}

// ---------------------------------------------------------------------------
// 2. AST Symbol & Import Extraction (Tree-Sitter WASM + Regex Fallback)
// ---------------------------------------------------------------------------
function cleanParams(raw = '') {
  if (!raw) return '';
  const stripped = String(raw).trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!stripped) return '';
  const parts = stripped
    .split(',')
    .map(p => p.trim())
    .filter(p => p && p !== 'self' && p !== 'cls');
  return parts.slice(0, 4).join(', ') + (parts.length > 4 ? ', ...' : '');
}

function stripQuotes(str = '') {
  return String(str).trim().replace(/^['"`]|['"`]$/g, '');
}

function extractJsAstSymbols(rootNode, filePath) {
  const classes = [];
  const functions = [];
  const imports = [];

  function parseImportClause(importNode) {
    const sourceNode = importNode.childForFieldName('source');
    if (!sourceNode) return;
    const modName = stripQuotes(sourceNode.text);
    if (!modName) return;

    const syms = [];
    for (let i = 0; i < importNode.namedChildCount; i++) {
      const child = importNode.namedChild(i);
      if (!child || child.type === 'string') continue;
      if (child.type === 'identifier') {
        syms.push(child.text);
      } else if (child.type === 'import_clause') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const ic = child.namedChild(j);
          if (!ic) continue;
          if (ic.type === 'identifier') {
            syms.push(ic.text);
          } else if (ic.type === 'namespace_import') {
            syms.push('*');
          } else if (ic.type === 'named_imports') {
            for (let k = 0; k < ic.namedChildCount; k++) {
              const spec = ic.namedChild(k);
              if (spec?.type === 'import_specifier') {
                const nameNode = spec.childForFieldName('name') || spec.namedChild(0);
                if (nameNode) syms.push(nameNode.text);
              }
            }
          }
        }
      } else if (child.type === 'export_clause') {
        for (let k = 0; k < child.namedChildCount; k++) {
          const spec = child.namedChild(k);
          if (spec?.type === 'export_specifier') {
            const nameNode = spec.childForFieldName('name') || spec.namedChild(0);
            if (nameNode) syms.push(nameNode.text);
          }
        }
      }
    }
    imports.push({ module: modName, symbols: syms });
  }

  function parseClassNode(classNode) {
    const nameNode = classNode.childForFieldName('name');
    if (!nameNode) return;
    let inherits = '';
    for (let i = 0; i < classNode.namedChildCount; i++) {
      const ch = classNode.namedChild(i);
      if (ch?.type === 'class_heritage') {
        inherits = ch.text.replace(/^extends\s+/, '').replace(/^implements\s+/, '').trim();
        break;
      }
    }
    const clsObj = {
      name: nameNode.text,
      inherits,
      methods: [],
      line: classNode.startPosition.row + 1
    };

    const bodyNode = classNode.childForFieldName('body');
    if (bodyNode) {
      for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const member = bodyNode.namedChild(i);
        if (!member) continue;
        if (member.type === 'method_definition' || member.type === 'method_signature') {
          const mName = member.childForFieldName('name')?.text;
          const mParams = member.childForFieldName('parameters')?.text || '';
          const mRet = member.childForFieldName('return_type')?.text?.replace(/^:\s*/, '') || '';
          if (mName) {
            clsObj.methods.push({
              name: mName,
              params: cleanParams(mParams),
              returns: mRet,
              line: member.startPosition.row + 1
            });
          }
        }
      }
    }
    classes.push(clsObj);
  }

  function parseFunctionNode(fnNode) {
    const nameNode = fnNode.childForFieldName('name');
    if (!nameNode) return;
    const paramsText = fnNode.childForFieldName('parameters')?.text || '';
    const retText = fnNode.childForFieldName('return_type')?.text?.replace(/^:\s*/, '') || '';
    functions.push({
      name: nameNode.text,
      params: cleanParams(paramsText),
      returns: retText,
      line: fnNode.startPosition.row + 1
    });
  }

  function parseVarDeclaration(varNode, isExported = false) {
    for (let i = 0; i < varNode.namedChildCount; i++) {
      const decl = varNode.namedChild(i);
      if (decl?.type !== 'variable_declarator') continue;
      const nameNode = decl.childForFieldName('name');
      const valNode = decl.childForFieldName('value');
      if (!nameNode || nameNode.type !== 'identifier') continue;

      if (valNode && (valNode.type === 'arrow_function' || valNode.type === 'function_expression' || valNode.type === 'function')) {
        const paramsNode = valNode.childForFieldName('parameters') || valNode.childForFieldName('parameter');
        const retNode = valNode.childForFieldName('return_type');
        functions.push({
          name: nameNode.text,
          params: cleanParams(paramsNode ? paramsNode.text : ''),
          returns: retNode ? retNode.text.replace(/^:\s*/, '') : '',
          line: decl.startPosition.row + 1
        });
      } else if (isExported) {
        functions.push({
          name: nameNode.text,
          params: '(const)',
          returns: '',
          line: decl.startPosition.row + 1
        });
      }
    }
  }

  function visitTopLevel(node, isExported = false) {
    if (!node) return;
    switch (node.type) {
      case 'import_statement':
        parseImportClause(node);
        break;
      case 'export_statement': {
        if (node.childForFieldName('source')) {
          parseImportClause(node);
        }
        const decl = node.childForFieldName('declaration');
        if (decl) {
          visitTopLevel(decl, true);
        }
        break;
      }
      case 'class_declaration':
      case 'class':
        parseClassNode(node);
        break;
      case 'function_declaration':
      case 'generator_function_declaration':
        parseFunctionNode(node);
        break;
      case 'lexical_declaration':
      case 'variable_declaration':
        parseVarDeclaration(node, isExported);
        break;
      case 'interface_declaration':
      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          functions.push({
            name: nameNode.text,
            params: `(${node.type === 'interface_declaration' ? 'interface' : 'type'})`,
            returns: '',
            line: node.startPosition.row + 1
          });
        }
        break;
      }
      default:
        break;
    }
  }

  for (let i = 0; i < rootNode.namedChildCount; i++) {
    visitTopLevel(rootNode.namedChild(i), false);
  }

  return { filePath, classes, functions, imports, callers: [], parser: 'tree-sitter-wasm' };
}

function extractPythonAstSymbols(rootNode, filePath) {
  const classes = [];
  const functions = [];
  const imports = [];

  function unwrapDecorated(node) {
    if (node?.type === 'decorated_definition') {
      return node.childForFieldName('definition');
    }
    return node;
  }

  function parsePyFunction(fnNode, targetArray, isMethod = false) {
    const nameNode = fnNode.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    if (isMethod && name.startsWith('__') && name !== '__init__') return;

    const paramsNode = fnNode.childForFieldName('parameters');
    const retNode = fnNode.childForFieldName('return_type');
    targetArray.push({
      name,
      params: cleanParams(paramsNode ? paramsNode.text : ''),
      returns: retNode ? retNode.text.trim() : '',
      line: fnNode.startPosition.row + 1
    });
  }

  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const rawNode = rootNode.namedChild(i);
    if (!rawNode) continue;
    const node = unwrapDecorated(rawNode);
    if (!node) continue;

    if (node.type === 'import_from_statement') {
      const modNode = node.childForFieldName('module_name');
      const modName = modNode ? modNode.text.trim() : '';
      const syms = [];
      for (let j = 0; j < node.namedChildCount; j++) {
        const ch = node.namedChild(j);
        if (!ch || ch === modNode) continue;
        if (ch.type === 'dotted_name') {
          syms.push(ch.text.trim());
        } else if (ch.type === 'aliased_import') {
          const orig = ch.childForFieldName('name') || ch.namedChild(0);
          if (orig) syms.push(orig.text.trim());
        } else if (ch.type === 'wildcard_import') {
          syms.push('*');
        }
      }
      if (modName) {
        imports.push({ module: modName, symbols: syms });
      }
    } else if (node.type === 'import_statement') {
      for (let j = 0; j < node.namedChildCount; j++) {
        const ch = node.namedChild(j);
        if (ch?.type === 'dotted_name') {
          imports.push({ module: ch.text.trim(), symbols: ['*'] });
        } else if (ch?.type === 'aliased_import') {
          const orig = ch.childForFieldName('name') || ch.namedChild(0);
          if (orig) imports.push({ module: orig.text.trim(), symbols: ['*'] });
        }
      }
    } else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const superNode = node.childForFieldName('superclasses');
      const clsObj = {
        name: nameNode.text,
        inherits: superNode ? superNode.text.replace(/^\(|\)$/g, '').trim() : '',
        methods: [],
        line: node.startPosition.row + 1
      };
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        for (let j = 0; j < bodyNode.namedChildCount; j++) {
          const mRaw = bodyNode.namedChild(j);
          const mNode = unwrapDecorated(mRaw);
          if (mNode?.type === 'function_definition') {
            parsePyFunction(mNode, clsObj.methods, true);
          }
        }
      }
      classes.push(clsObj);
    } else if (node.type === 'function_definition') {
      parsePyFunction(node, functions, false);
    }
  }

  return { filePath, classes, functions, imports, callers: [], parser: 'tree-sitter-wasm' };
}

/**
 * Fallback Regex Extractor (Used only if WASM is not yet initialized or unavailable)
 */
export function extractSymbolsWithRegex(filePath, content = '') {
  const ext = path.extname(filePath).toLowerCase();
  const isPython = ext === '.py';
  const isJs = ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext);

  if (!isPython && !isJs) {
    return { filePath, classes: [], functions: [], imports: [], callers: [], parser: 'regex-fallback' };
  }

  // Strip block comments before line scanning so commented-out code is ignored
  const cleanedContent = isJs
    ? content.replace(/\/\*[\s\S]*?\*\//g, match => '\n'.repeat((match.match(/\n/g) || []).length))
    : content;

  const lines = cleanedContent.split(/\r?\n/);
  const classes = [];
  const functions = [];
  const imports = [];
  let currentClass = null;

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
    if (isJs && /^\s*\/\//.test(line)) continue;
    if (isPython && /^\s*#/.test(line)) continue;

    if (isPython) {
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
      if (/^(?:async\s+)?def\s+[A-Za-z0-9_]+\s*\(/.test(line)) {
        const sig = getJoinedSignature(i);
        const topDefMatch = sig.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
        if (topDefMatch) {
          currentClass = null;
          functions.push({
            name: topDefMatch[1],
            params: cleanParams(topDefMatch[2]),
            returns: topDefMatch[3] ? topDefMatch[3].trim() : '',
            line: i + 1
          });
          continue;
        }
      }
      if (/^[A-Za-z0-9_]/.test(line) && !line.startsWith('class ') && !line.startsWith('def ') && !line.startsWith('async def ')) {
        currentClass = null;
      }
    } else if (isJs) {
      const jsImpMatch = line.match(/(?:import|export)\s+(?:\{([^}]+)\}|\*\s+as\s+([A-Za-z0-9_]+)|([A-Za-z0-9_]+))?\s*from\s*['"]([^'"]+)['"]/);
      if (jsImpMatch) {
        const rawSyms = jsImpMatch[1]
          ? jsImpMatch[1].split(',').map(s => s.trim().replace(/\s+as\s+.*/, '')).filter(Boolean)
          : (jsImpMatch[2] ? [jsImpMatch[2]] : (jsImpMatch[3] ? [jsImpMatch[3]] : []));
        imports.push({ module: jsImpMatch[4], symbols: rawSyms });
        continue;
      }
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
      if (currentClass && /^\}/.test(line)) {
        currentClass = null;
      }
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

  return { filePath, classes, functions, imports, callers: [], parser: 'regex-fallback' };
}

/**
 * Extracts classes, methods, functions, and imports from code.
 * Uses Tree-Sitter WASM AST when initialized; falls back to Regex otherwise.
 */
export function extractSymbolsFromCode(filePath, content = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (wasmReady && TsParserClass && wasmLanguages.has(ext)) {
    try {
      let parser = wasmParsers.get(ext);
      if (!parser) {
        parser = new TsParserClass();
        parser.setLanguage(wasmLanguages.get(ext));
        wasmParsers.set(ext, parser);
      }
      const tree = parser.parse(String(content || ''));
      if (tree && tree.rootNode) {
        const res = ext === '.py'
          ? extractPythonAstSymbols(tree.rootNode, filePath)
          : extractJsAstSymbols(tree.rootNode, filePath);
        tree.delete();
        return res;
      }
    } catch {}
  }

  return extractSymbolsWithRegex(filePath, content);
}

// ---------------------------------------------------------------------------
// 3. Pillar 2: Real Import Path Resolution (`resolveImportTarget`)
// ---------------------------------------------------------------------------
const PROBE_EXTENSIONS = ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.py'];
const INDEX_FILES = ['/index.mjs', '/index.js', '/index.ts', '/index.tsx', '/index.jsx', '/__init__.py'];

/**
 * Resolves an import specifier (`./lib/risk-policy.mjs`, `../runtime`, `core.eraser`, `.utils`)
 * from `sourceFile` against the known repository `fileKeys` (Set or Array of POSIX relative paths).
 *
 * @param {string} sourceFile - Importer's relative path (e.g. `agent-team/scripts/orchestrator.mjs`)
 * @param {string} rawModule - Imported specifier (e.g. `./lib/risk-policy.mjs` or `../runtime`)
 * @param {Iterable<string>} fileKeys - Known repository relative paths
 * @returns {string|null} Resolved target file key in `fileKeys`, or null if external/unresolved
 */
export function resolveImportTarget(sourceFile, rawModule, fileKeys) {
  if (!sourceFile || !rawModule) return null;
  const spec = String(rawModule).trim();
  if (!spec || spec.startsWith('node:')) return null;

  const bareFirstSegment = spec.split('/')[0].split('.')[0];
  if (!spec.startsWith('.') && BUILTIN_MODULES.has(bareFirstSegment)) {
    return null;
  }

  const fileSet = fileKeys instanceof Set ? fileKeys : new Set(fileKeys);
  const normSource = String(sourceFile).replace(/\\/g, '/');
  const sourceDir = path.posix.dirname(normSource);

  function matchCandidate(baseCandidate) {
    const clean = baseCandidate.replace(/^\/+/, '');
    if (fileSet.has(clean)) return clean;

    // TypeScript ESM convention: `import './foo.js'` -> resolves to `./foo.ts` or `./foo.tsx`
    if (clean.endsWith('.js') || clean.endsWith('.mjs')) {
      const stem = clean.replace(/\.(m?js)$/, '');
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        if (fileSet.has(stem + ext)) return stem + ext;
      }
    }

    // Extension probing (`import './foo'` -> `./foo.ts`, `./foo.mjs`, etc.)
    for (const ext of PROBE_EXTENSIONS) {
      if (fileSet.has(clean + ext)) return clean + ext;
    }

    // Directory index probing (`import './server'` -> `./server/index.ts`, etc.)
    const noTrailing = clean.replace(/\/+$/, '');
    for (const idxSuffix of INDEX_FILES) {
      if (fileSet.has(noTrailing + idxSuffix)) return noTrailing + idxSuffix;
    }

    return null;
  }

  // Case 1: JS/TS Relative Import (`./...` or `../...`)
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const joined = path.posix.normalize(path.posix.join(sourceDir === '.' ? '' : sourceDir, spec));
    return matchCandidate(joined);
  }

  // Case 2: Python Relative Import (`.utils`, `..common.helpers`)
  if (spec.startsWith('.')) {
    const dotMatch = spec.match(/^(\.+)(.*)$/);
    if (dotMatch) {
      const dotCount = dotMatch[1].length;
      const remainder = dotMatch[2].replace(/\./g, '/');
      let baseDir = sourceDir === '.' ? '' : sourceDir;
      for (let up = 1; up < dotCount; up++) {
        baseDir = path.posix.dirname(baseDir);
        if (baseDir === '.') baseDir = '';
      }
      const joined = path.posix.normalize(path.posix.join(baseDir, remainder));
      return matchCandidate(joined);
    }
  }

  // Case 3: Python Dotted Module or Workspace-Relative Import (`core.eraser`, `src/utils/math`)
  const slashSpec = spec.includes('/') ? spec : spec.replace(/\./g, '/');
  const direct = matchCandidate(slashSpec);
  if (direct) return direct;

  // Also check relative to the top-level subproject root of sourceFile (e.g. `agent-team/...`)
  const topSeg = normSource.split('/')[0];
  if (topSeg && topSeg !== normSource) {
    const scoped = matchCandidate(path.posix.join(topSeg, slashSpec));
    if (scoped) return scoped;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Workspace Scanner & Dependency Graph Construction
// ---------------------------------------------------------------------------
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
        if (['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
          const relPath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
          try {
            const stat = fs.statSync(absPath);
            const currentMode = wasmReady && wasmLanguages.has(ext) ? 'wasm' : 'regex';
            const cached = SYMBOL_CACHE.get(relPath);
            if (cached && cached.mtime === stat.mtimeMs && cached.parserMode === currentMode) {
              fileMap.set(relPath, {
                ...cached.symbols,
                callers: [],
                dependencies: [],
                referencedSymbols: new Set()
              });
            } else {
              const content = fs.readFileSync(absPath, 'utf8');
              const symbols = extractSymbolsFromCode(relPath, content);
              SYMBOL_CACHE.set(relPath, { mtime: stat.mtimeMs, parserMode: currentMode, symbols });
              fileMap.set(relPath, {
                ...symbols,
                callers: [],
                dependencies: [],
                referencedSymbols: new Set()
              });
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

  const knownKeys = new Set(fileMap.keys());

  // Build resolved bidirectional import & symbol reference graph
  for (const [sourceFile, sym] of fileMap.entries()) {
    for (const imp of sym.imports) {
      const targetFile = resolveImportTarget(sourceFile, imp.module, knownKeys);
      if (targetFile && targetFile !== sourceFile) {
        const targetSym = fileMap.get(targetFile);
        if (targetSym) {
          if (!targetSym.callers.includes(sourceFile)) {
            targetSym.callers.push(sourceFile);
          }
          if (!sym.dependencies.includes(targetFile)) {
            sym.dependencies.push(targetFile);
          }
          for (const s of (imp.symbols || [])) {
            if (s && s !== '*') {
              targetSym.referencedSymbols.add(s);
            }
          }
        }
      }
    }
  }

  return fileMap;
}

// ---------------------------------------------------------------------------
// 5. Pillar 3: Personalized PageRank (Task-Scope & Keyword Seeded)
// ---------------------------------------------------------------------------
export function computePersonalizedPageRank(fileMap, options = {}) {
  const nodes = Array.from(fileMap.keys());
  const N = nodes.length;
  if (N === 0) return new Map();

  const keywords = (options.keywords || []).map(k => String(k).toLowerCase());
  const normScope = new Set(
    (options.scopeFiles || []).map(s => String(s || '').replace(/\\/g, '/').replace(/^\/+/, ''))
  );

  function isFileInScope(relPath) {
    if (normScope.has(relPath)) return true;
    for (const sc of normScope) {
      if (sc && (relPath.endsWith(`/${sc}`) || sc.endsWith(`/${relPath}`))) return true;
    }
    return false;
  }

  // 1. Build Personalization Seed Vector p(v)
  const personalization = new Map();
  let totalSeed = 0;

  for (const relPath of nodes) {
    const sym = fileMap.get(relPath);
    let seed = 1.0; // Base uniform floor
    const lowerPath = relPath.toLowerCase();

    // Task Scope Seed Boost
    if (isFileInScope(relPath)) {
      seed += 50.0;
    }

    // 1-Hop Neighbor of Scope Boost
    const connectsToScope = (sym.callers || []).some(c => isFileInScope(c))
      || (sym.dependencies || []).some(d => isFileInScope(d));
    if (connectsToScope) {
      seed += 20.0;
    }

    // Keyword Relevance Boost
    for (const kw of keywords) {
      if (lowerPath.includes(kw)) seed += 15.0;
    }
    for (const c of sym.classes) {
      const lowerC = c.name.toLowerCase();
      for (const kw of keywords) {
        if (lowerC.includes(kw)) seed += 10.0;
      }
      for (const m of c.methods) {
        const lowerM = m.name.toLowerCase();
        for (const kw of keywords) {
          if (lowerM.includes(kw)) seed += 5.0;
        }
      }
    }
    for (const f of sym.functions) {
      const lowerF = f.name.toLowerCase();
      for (const kw of keywords) {
        if (lowerF.includes(kw)) seed += 8.0;
      }
    }

    personalization.set(relPath, seed);
    totalSeed += seed;
  }

  for (const relPath of nodes) {
    personalization.set(relPath, personalization.get(relPath) / totalSeed);
  }

  // 2. Build Weighted Adjacency List
  // Edge u -> v when u imports v (weight = 1 + imported symbol count), plus reverse edge (0.5)
  const outEdges = new Map();
  const outWeightSum = new Map();
  for (const relPath of nodes) {
    outEdges.set(relPath, new Map());
    outWeightSum.set(relPath, 0);
  }

  function addEdge(u, v, w) {
    const edges = outEdges.get(u);
    const prev = edges.get(v) || 0;
    edges.set(v, prev + w);
    outWeightSum.set(u, outWeightSum.get(u) + w);
  }

  for (const [u, sym] of fileMap.entries()) {
    for (const v of (sym.dependencies || [])) {
      if (!fileMap.has(v)) continue;
      const targetSym = fileMap.get(v);
      const refBonus = Math.min((targetSym?.referencedSymbols?.size || 0), 5);
      addEdge(u, v, 1.0 + refBonus * 0.5);
      addEdge(v, u, 0.5);
    }
  }

  // 3. Iterative Personalized PageRank (15 iterations, damping d = 0.85)
  const damping = 0.85;
  const iterations = 15;
  let ranks = new Map(personalization);

  for (let iter = 0; iter < iterations; iter++) {
    const nextRanks = new Map();
    let danglingMass = 0;

    for (const u of nodes) {
      if (outWeightSum.get(u) === 0) {
        danglingMass += ranks.get(u);
      }
      nextRanks.set(u, 0);
    }

    for (const u of nodes) {
      const totalW = outWeightSum.get(u);
      if (totalW > 0) {
        const uRank = ranks.get(u);
        for (const [v, w] of outEdges.get(u).entries()) {
          nextRanks.set(v, nextRanks.get(v) + uRank * (w / totalW));
        }
      }
    }

    for (const v of nodes) {
      const pV = personalization.get(v);
      const incoming = nextRanks.get(v) + danglingMass * pV;
      nextRanks.set(v, (1 - damping) * pV + damping * incoming);
    }

    ranks = nextRanks;
  }

  return ranks;
}

/**
 * Computes Personalized PageRank relevance scores and formats a compact token-budgeted repo-map.
 *
 * @param {string} repoRoot - Workspace root path
 * @param {Object} options
 * @param {Array<string>} [options.allowedDirs] - Dirs to scan
 * @param {string|Array<string>} [options.query] - Keywords to rank symbols
 * @param {Array<string>} [options.scopeFiles] - Task scope files used as PageRank seeds
 * @param {number} [options.maxChars=3500] - Hard budget ceiling in chars
 * @returns {string} Formatted compact skeleton map
 */
export function generateRepoMap(repoRoot, options = {}) {
  const maxChars = options.maxChars || 3500;
  const rawQuery = options.query || '';
  const keywords = Array.isArray(rawQuery)
    ? rawQuery.map(k => String(k).toLowerCase())
    : String(rawQuery).toLowerCase().split(/[\s,._-]+/).filter(k => k.length >= 3);
  const scopeFiles = Array.isArray(options.scopeFiles) ? options.scopeFiles : [];

  const fileMap = scanWorkspaceSymbols(repoRoot, options.allowedDirs);
  if (fileMap.size === 0) return '';

  const pageRanks = computePersonalizedPageRank(fileMap, { keywords, scopeFiles });
  const normScope = new Set(scopeFiles.map(s => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '')));

  function isScoped(relPath) {
    if (normScope.has(relPath)) return true;
    for (const sc of normScope) {
      if (sc && (relPath.endsWith(`/${sc}`) || sc.endsWith(`/${relPath}`))) return true;
    }
    return false;
  }

  const scoredFiles = [];
  for (const [relPath, sym] of fileMap.entries()) {
    if (sym.classes.length === 0 && sym.functions.length === 0) continue;
    scoredFiles.push({
      relPath,
      sym,
      inScope: isScoped(relPath),
      score: pageRanks.get(relPath) || 0
    });
  }

  // Sort: Task Scope files first, then descending by Personalized PageRank score, then alphabetically
  scoredFiles.sort((a, b) => {
    if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    return a.relPath.localeCompare(b.relPath);
  });

  function symbolPriority(name) {
    const lower = name.toLowerCase();
    let p = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) p += 10;
    }
    return p;
  }

  const sections = [];
  let currentChars = 0;
  let omittedFilesCount = 0;

  for (let idx = 0; idx < scoredFiles.length; idx++) {
    const { relPath, sym, inScope } = scoredFiles[idx];
    const refSet = sym.referencedSymbols || new Set();

    const blockLines = [];
    const scopeTag = inScope ? ' [SCOPE]' : '';
    const callerInfo = sym.callers.length > 0
      ? ` (referenced by: ${sym.callers.slice(0, 3).map(c => path.basename(c)).join(', ')})`
      : '';

    blockLines.push(`[${relPath}]${scopeTag}${callerInfo}`);

    for (const c of sym.classes.slice(0, 5)) {
      const inheritStr = c.inherits ? `(${c.inherits})` : '';
      blockLines.push(`  class ${c.name}${inheritStr}:`);
      const sortedMethods = [...c.methods].sort((m1, m2) => {
        const r1 = (refSet.has(m1.name) ? 5 : 0) + symbolPriority(m1.name);
        const r2 = (refSet.has(m2.name) ? 5 : 0) + symbolPriority(m2.name);
        return r2 - r1;
      });
      for (const m of sortedMethods.slice(0, 6)) {
        const ret = m.returns ? ` -> ${m.returns}` : '';
        blockLines.push(`    def ${m.name}(${m.params})${ret}: ...`);
      }
    }

    const sortedFuncs = [...sym.functions].sort((f1, f2) => {
      const r1 = (refSet.has(f1.name) ? 5 : 0) + symbolPriority(f1.name);
      const r2 = (refSet.has(f2.name) ? 5 : 0) + symbolPriority(f2.name);
      return r2 - r1;
    });
    for (const f of sortedFuncs.slice(0, 8)) {
      const ret = f.returns ? ` -> ${f.returns}` : '';
      blockLines.push(`  def ${f.name}(${f.params})${ret}: ...`);
    }

    const blockStr = blockLines.join('\n');
    if (currentChars + blockStr.length > maxChars) {
      omittedFilesCount = scoredFiles.length - idx;
      sections.push(`\n[... +${omittedFilesCount} additional files omitted to fit context budget ...]`);
      break;
    }

    sections.push(blockStr);
    currentChars += blockStr.length + 2;
  }

  return sections.join('\n\n');
}
